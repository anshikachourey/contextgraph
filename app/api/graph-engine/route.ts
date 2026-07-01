import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { generateEmbedding, buildClusterEmbeddingText } from "@/src/lib/embeddings";
import { persistNode, loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { persistEdges } from "@/src/lib/db/edges";
import { computeSuggestedEdges } from "@/src/lib/edgeSuggestions";
import { STRONGLY_RELATED_THRESHOLD } from "@/src/lib/similarityThresholds";
import {
  loadActiveCandidates,
  createCandidate,
  updateCandidate,
  materializeCandidate,
} from "@/src/lib/db/candidates";
import {
  detectSegmentCompletion,
  decideSegmentAction,
  computeConfidence,
  computeCandidateCentroid,
  shouldMaterialize,
  discoverParents,
} from "@/src/lib/graphEngine";
import { parseJsonFromLLM, isTitleSummaryResponse } from "@/src/lib/llmJson";
import type { ChatMessage } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import type { DbMessage } from "@/src/types/db";
import type { GraphEngineRequest, GraphEngineResponse, NodeEmbedding } from "@/src/types/graphEngine";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ErrorResponse = { error: string };

/**
 * POST /api/graph-engine
 *
 * Evidence Accumulation Graph Engine.
 * Runs after every assistant response (called by the frontend, fire-and-forget).
 *
 * Pipeline:
 * 1. Detect if a semantic segment just completed
 * 2. If yes: decide action (extend existing node, accumulate in candidate, or new candidate)
 * 3. Check if any candidate should materialize into a visible node
 * 4. If a node was created: discover parent opportunities
 * 5. Recompute edges if topology changed
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<GraphEngineResponse | ErrorResponse>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const { conversationId } = body as GraphEngineRequest;
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required." }, { status: 400 });
  }

  const response: GraphEngineResponse = {
    actions: [],
    candidatesUpdated: 0,
    nodesCreated: 0,
    nodesExtended: 0,
    parentsCreated: 0,
  };

  try {
    const db = createServerSupabaseClient();

    // Load messages (non-branch only)
    const { data: dbMessages } = await db
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .is("parent_node_id", null)
      .order("created_at", { ascending: true });

    const messages: ChatMessage[] = (dbMessages ?? []).map((m: DbMessage) => ({
      id: m.id,
      role: m.role,
      content: m.content,
    }));

    if (messages.length < 6) {
      return NextResponse.json(response); // Not enough conversation yet
    }

    // ─── Step 1: Detect segment completion ──────────────────────────────

    const completedSegment = await detectSegmentCompletion(messages);

    if (!completedSegment) {
      // No boundary detected — conversation continues. Do nothing.
      response.actions.push({ type: "no_action" });
      return NextResponse.json(response);
    }

    // Embed the completed segment
    const segmentText = completedSegment
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    const segmentEmbedding = await generateEmbedding(segmentText.slice(0, 7000));
    const segmentMessageIds = completedSegment.map((m) => m.id);

    // ─── Step 2: Decide action ──────────────────────────────────────────

    const rawNodes = await loadNodesWithEmbeddings(conversationId);
    const nodeEmbeddings: NodeEmbedding[] = rawNodes
      .filter((n) => n.embedding !== null && n.embedding!.length > 0)
      .map((n) => ({ id: n.id, title: n.title, embedding: n.embedding! }));

    const candidates = await loadActiveCandidates(conversationId);

    const action = decideSegmentAction(
      segmentEmbedding,
      segmentMessageIds,
      nodeEmbeddings,
      candidates,
    );

    response.actions.push(action);

    // ─── Step 3: Execute action ─────────────────────────────────────────

    let topologyChanged = false;

    if (action.type === "extend_node") {
      // Silently link messages to existing node
      const links = action.messageIds.map((mid) => ({
        node_id: action.nodeId,
        message_id: mid,
      }));
      await db.from("node_messages").upsert(links, {
        onConflict: "node_id,message_id",
        ignoreDuplicates: true,
      });
      response.nodesExtended++;
      console.log(`[graph-engine] Extended node with ${action.messageIds.length} messages`);

    } else if (action.type === "accumulate") {
      // Add segment to existing candidate
      const candidate = candidates.find((c) => c.id === action.candidateId);
      if (candidate) {
        const newSegments = [...candidate.segments, action.segment];
        const newEmbedding = computeCandidateCentroid(newSegments);

        // Find best node match for confidence scoring
        let bestNodeScore = 0;
        for (const node of nodeEmbeddings) {
          if (newEmbedding.length > 0 && node.embedding.length > 0) {
            const score = cosineSimilarity(newEmbedding, node.embedding);
            if (score > bestNodeScore) bestNodeScore = score;
          }
        }

        const updatedCandidate = {
          ...candidate,
          segments: newSegments,
          embedding: newEmbedding,
        };
        const confidence = computeConfidence(updatedCandidate, bestNodeScore);

        await updateCandidate(action.candidateId, newSegments, newEmbedding, confidence);
        response.candidatesUpdated++;

        // Check materialization
        updatedCandidate.confidence = confidence;
        if (shouldMaterialize(updatedCandidate)) {
          const node = await materializeCandidateToNode(
            conversationId,
            updatedCandidate,
            messages,
          );
          if (node) {
            await materializeCandidate(action.candidateId, node.id);
            response.nodesCreated++;
            topologyChanged = true;
            console.log(`[graph-engine] Materialized node: "${node.title}"`);
          }
        }
      }

    } else if (action.type === "new_candidate") {
      // Create fresh candidate
      const embedding = action.segment.embedding;
      let bestNodeScore = 0;
      for (const node of nodeEmbeddings) {
        if (embedding.length > 0 && node.embedding.length > 0) {
          const score = cosineSimilarity(embedding, node.embedding);
          if (score > bestNodeScore) bestNodeScore = score;
        }
      }

      const tempCandidate = {
        id: "",
        conversationId,
        status: "accumulating" as const,
        segments: [action.segment],
        embedding,
        confidence: 0,
        materializedNodeId: null,
        lastUpdatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      const confidence = computeConfidence(tempCandidate, bestNodeScore);

      await createCandidate(conversationId, action.segment, embedding, confidence);
      response.candidatesUpdated++;
      console.log(`[graph-engine] New candidate created (confidence: ${confidence.toFixed(2)})`);

      // Check immediate materialization (high confidence on first evidence)
      tempCandidate.confidence = confidence;
      if (shouldMaterialize(tempCandidate)) {
        // Rare but possible with strong first segment
        // For now, let it accumulate — materialization needs 2+ segments typically
      }
    }

    // ─── Step 4: Parent discovery (if topology changed) ─────────────────

    if (topologyChanged) {
      const updatedNodes = await loadNodesWithEmbeddings(conversationId);
      const updatedNodeEmbs: NodeEmbedding[] = updatedNodes
        .filter((n) => n.embedding !== null && n.embedding!.length > 0)
        .map((n) => ({ id: n.id, title: n.title, embedding: n.embedding! }));

      const parentCandidates = discoverParents(updatedNodeEmbs, []);

      for (const pc of parentCandidates) {
        // Check if a parent already exists for this group
        // (simple check: is there a node whose embedding is very close to the group centroid?)
        const childEmbs = updatedNodeEmbs.filter((n) => pc.childNodeIds.includes(n.id));
        if (childEmbs.length < 3) continue;

        // Generate parent title
        const childTitles = childEmbs.map((n) => n.title).join(", ");
        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
              role: "user",
              content: `These topics are related: ${childTitles}\nGenerate a short parent category name (max 40 chars) that groups them:`,
            }],
            temperature: 0.3,
            max_tokens: 30,
          });
          const parentTitle = completion.choices[0]?.message?.content?.trim() ?? `Parent: ${childTitles.slice(0, 30)}`;

          const parentNode: ContextNode = {
            id: crypto.randomUUID(),
            title: parentTitle,
            summary: `Groups: ${childTitles}`,
            messageIds: [],
          };

          await persistNode(conversationId, parentNode, [], { createdBy: "ai" });
          response.parentsCreated++;
          topologyChanged = true;
          console.log(`[graph-engine] Parent created: "${parentTitle}"`);
        } catch {
          // Non-fatal
        }
      }

      // ─── Step 5: Recompute edges if topology changed ────────────────

      try {
        const allNodes = await loadNodesWithEmbeddings(conversationId);
        const suggestions = await computeSuggestedEdges(allNodes);
        const strong = suggestions.filter((s) => s.similarity >= STRONGLY_RELATED_THRESHOLD);
        await persistEdges(conversationId, strong);
      } catch {
        // Non-fatal
      }
    }

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[graph-engine] Error:", message);
    return NextResponse.json(
      { error: `Graph engine failed: ${message}` },
      { status: 500 },
    );
  }
}

// ─── Materialization helper ─────────────────────────────────────────────────

import { cosineSimilarity } from "@/src/lib/cosineSimilarity";

async function materializeCandidateToNode(
  conversationId: string,
  candidate: { segments: { messageIds: string[]; embedding: number[] }[] },
  allMessages: ChatMessage[],
): Promise<ContextNode | null> {
  // Collect all message IDs from the candidate's segments
  const messageIds = candidate.segments.flatMap((s) => s.messageIds);
  const uniqueIds = [...new Set(messageIds)];

  // Get the actual messages
  const linkedMessages = allMessages.filter((m) => uniqueIds.includes(m.id));
  if (linkedMessages.length === 0) return null;

  // Generate title + summary
  const formatted = linkedMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n")
    .slice(0, 3000);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "system",
        content: `Analyze these messages and return JSON: {"title":"<noun phrase, max 60 chars>","summary":"<what they discuss, max 200 chars>"}. Raw JSON only.`,
      }, {
        role: "user",
        content: formatted,
      }],
      temperature: 0.4,
      max_tokens: 150,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = parseJsonFromLLM(raw);
    if (!isTitleSummaryResponse(parsed)) return null;

    const node: ContextNode = {
      id: crypto.randomUUID(),
      title: parsed.title,
      summary: parsed.summary,
      messageIds: uniqueIds,
    };

    await persistNode(conversationId, node, linkedMessages, { createdBy: "ai" });
    return node;
  } catch {
    return null;
  }
}
