import { NextRequest, NextResponse } from "next/server";
import { complete } from "@/src/lib/ai";
import { STRUCTURE_MODEL } from "@/src/lib/ai/models";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { persistNode, loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { persistEdges } from "@/src/lib/db/edges";
import { generateEmbedding, buildNodeEmbeddingText, buildClusterEmbeddingText } from "@/src/lib/embeddings";
import { cosineSimilarity } from "@/src/lib/cosineSimilarity";
import { computeSuggestedEdges } from "@/src/lib/edgeSuggestions";
import { STRONGLY_RELATED_THRESHOLD } from "@/src/lib/similarityThresholds";
import { DRAFT_SUPPRESS_THRESHOLD } from "@/src/lib/aiDraftConfig";
import { parseJsonFromLLM, isTitleSummaryResponse } from "@/src/lib/llmJson";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import type { ChatMessage } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import type { DbMessage } from "@/src/types/db";

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? "http://127.0.0.1:8000";

// Minimum messages in a cluster to be worth creating a node
const MIN_CLUSTER_MESSAGES = 3;

type StructureRequest = {
  conversationId: string;
};

type StructureResponse = {
  nodesCreated: number;
  clustersSkipped: number;
  clustersProcessed: number;
  edgesCreated: number;
  clusteringMethod: string;
};

type ErrorResponse = { error: string };

// ML service response types
type MLCluster = {
  cluster_id: string;
  message_ids: string[];
  centroid_embedding: number[];
  representative_texts: string[];
};

type MLResponse = {
  clusters: MLCluster[];
  noise_message_ids: string[];
  total_messages: number;
  model_used: string;
  clustering_method: string;
};

/**
 * POST /api/structure-conversation
 *
 * End-to-end ML-powered conversation structuring:
 * 1. Load messages from DB
 * 2. Call Python ML service for semantic clustering
 * 3. Label each cluster using GPT
 * 4. Persist nodes (with duplicate suppression)
 * 5. Recompute semantic edges
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<StructureResponse | ErrorResponse>> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { conversationId } = body as StructureRequest;
  if (!conversationId) {
    return NextResponse.json(
      { error: "conversationId is required." },
      { status: 400 },
    );
  }

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  // ─── Step 1: Load messages from DB ──────────────────────────────────────

  const db = createServerSupabaseClient();
  const { data: dbMessages, error: msgError } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (msgError) {
    return NextResponse.json(
      { error: `Failed to load messages: ${msgError.message}` },
      { status: 500 },
    );
  }

  const messages: ChatMessage[] = (dbMessages ?? []).map((m: DbMessage) => ({
    id: m.id,
    role: m.role,
    content: m.content,
  }));

  if (messages.length < 3) {
    return NextResponse.json(
      { error: "Need at least 3 messages to structure." },
      { status: 400 },
    );
  }

  // ─── Step 2: Call Python ML service ─────────────────────────────────────

  let mlResponse: MLResponse;
  try {
    const res = await fetch(`${ML_SERVICE_URL}/cluster-conversation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ML service returned ${res.status}: ${text}`);
    }

    mlResponse = (await res.json()) as MLResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      return NextResponse.json(
        {
          error:
            "ML service is not running. Start it with: uvicorn app.main:app --reload --port 8000",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: `ML service error: ${message}` },
      { status: 502 },
    );
  }

  if (mlResponse.clusters.length === 0) {
    return NextResponse.json({
      nodesCreated: 0,
      clustersSkipped: 0,
      clustersProcessed: 0,
      edgesCreated: 0,
      clusteringMethod: mlResponse.clustering_method,
    });
  }

  // ─── Step 3: Load existing nodes for duplicate suppression ──────────────

  const existingNodes = await loadNodesWithEmbeddings(conversationId);

  // ─── Step 4: Process each cluster ──────────────────────────────────────

  // Build message lookup
  const messageMap = new Map(messages.map((m) => [m.id, m]));

  let nodesCreated = 0;
  let clustersSkipped = 0;
  let clustersProcessed = 0;

  for (const cluster of mlResponse.clusters) {
    // Filter to messages that actually exist
    const clusterMessages = cluster.message_ids
      .map((id) => messageMap.get(id))
      .filter((m): m is ChatMessage => m !== undefined);

    // Skip small clusters
    if (clusterMessages.length < MIN_CLUSTER_MESSAGES) {
      clustersSkipped++;
      continue;
    }

    clustersProcessed++;

    // ─── Duplicate suppression: embed cluster text, compare to existing ──

    const clusterText = buildClusterEmbeddingText(clusterMessages);

    let isDuplicate = false;
    try {
      const clusterEmbedding = await generateEmbedding(clusterText);

      for (const node of existingNodes) {
        if (!node.embedding || node.embedding.length === 0) continue;
        const score = cosineSimilarity(clusterEmbedding, node.embedding);
        if (score >= DRAFT_SUPPRESS_THRESHOLD) {
          console.log(
            `[structure] Cluster "${cluster.cluster_id}" suppressed — matches "${node.title}" (score: ${score.toFixed(4)})`,
          );
          isDuplicate = true;
          break;
        }
      }
    } catch (err) {
      console.error(`[structure] Duplicate check failed for ${cluster.cluster_id}:`, err);
      // Proceed anyway — better to create a potentially duplicate node than skip entirely
    }

    if (isDuplicate) {
      clustersSkipped++;
      continue;
    }

    // ─── Generate title + summary for this cluster ────────────────────────

    let title: string;
    let summary: string;

    try {
      const formatted = clusterMessages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

      const completionResult = await complete({
        model: STRUCTURE_MODEL,
        messages: [
          {
            role: "system",
            content: `You synthesize knowledge graph nodes from conversation segments. Each node captures what was REALIZED, LEARNED, or EMOTIONALLY UNDERSTOOD — not merely what was discussed.

Given a list of chat messages, return a JSON object:
- "title": the core insight, realization, or emotional theme — max 80 chars — NOT a topic label
- "summary": what was concluded, learned, or understood — max 300 chars — answer "What insight emerged?" not "What was discussed?"

BAD titles: "Exploring Rock Music", "Discussion About Art"
GOOD titles: "Searching for Art That Feels Exciting Again", "Rock as Authentic Emotional Expression"

BAD summaries: "They discussed how art has declined"
GOOD summaries: "A realization that mainstream art lost its emotional charge, prompting a search for creative forms that still provoke genuine feeling"

Respond with raw JSON only.`,
          },
          {
            role: "user",
            content: `Messages:\n\n${formatted}\n\nSynthesize the core insight. Return JSON with "title" and "summary".`,
          },
        ],
        temperature: 0.6,
        maxTokens: 300,
      });

      const raw = completionResult.content;
      if (!raw) throw new Error("Empty response");

      const parsed = parseJsonFromLLM(raw);
      if (!isTitleSummaryResponse(parsed)) {
        throw new Error("Model response missing title or summary fields");
      }
      title = parsed.title;
      summary = parsed.summary;
    } catch (err) {
      console.error(`[structure] Title generation failed for ${cluster.cluster_id}:`, err);
      // Skip this cluster rather than creating a bad node
      clustersSkipped++;
      continue;
    }

    // ─── Persist node using existing pipeline ─────────────────────────────

    const node: ContextNode = {
      id: crypto.randomUUID(),
      title,
      summary,
      messageIds: clusterMessages.map((m) => m.id),
    };

    try {
      await persistNode(conversationId, node, clusterMessages, {
        createdBy: "ai",
        messageCount: clusterMessages.length,
      });
      nodesCreated++;

      // Add to existing nodes list so subsequent clusters can check against it
      // (prevents creating two nodes for similar clusters in the same batch)
      const nodeEmbedding = await generateEmbedding(
        buildNodeEmbeddingText(title, summary, null),
      ).catch(() => null);

      if (nodeEmbedding) {
        existingNodes.push({
          id: node.id,
          title,
          summary,
          evidenceSummary: null,
          embedding: nodeEmbedding,
        });
      }
    } catch (err) {
      console.error(`[structure] Node creation failed for "${title}":`, err);
      // Soft-fail — continue with other clusters
    }
  }

  // ─── Step 5: Recompute semantic edges ───────────────────────────────────

  let edgesCreated = 0;
  try {
    const allNodes = await loadNodesWithEmbeddings(conversationId);
    const suggestions = await computeSuggestedEdges(allNodes);
    const strongEdges = suggestions.filter(
      (s) => s.similarity >= STRONGLY_RELATED_THRESHOLD,
    );
    edgesCreated = await persistEdges(conversationId, strongEdges);
    console.log(
      `[structure] Edges: ${edgesCreated} persisted (${strongEdges.length} strong, ${suggestions.length} total)`,
    );
  } catch (err) {
    console.error("[structure] Edge recomputation failed (non-fatal):", err);
  }

  return NextResponse.json({
    nodesCreated,
    clustersSkipped,
    clustersProcessed,
    edgesCreated,
    clusteringMethod: mlResponse.clustering_method,
  });
}
