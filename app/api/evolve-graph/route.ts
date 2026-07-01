import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { loadEdges } from "@/src/lib/db/edges";
import { generateEmbedding, buildClusterEmbeddingText } from "@/src/lib/embeddings";
import {
  buildUnlinkedWindows,
  detectExtendNode,
  detectMergeCandidates,
  detectParentCandidates,
} from "@/src/lib/evolutionEngine";
import type { ChatMessage } from "@/src/types/message";
import type { DbMessage, DbNodeMessage } from "@/src/types/db";
import type {
  EvolveGraphRequest,
  EvolveGraphResponse,
  NodeWithEmbedding,
  EmbeddedWindow,
  EvolutionSuggestion,
} from "@/src/types/evolution";

type ErrorResponse = { error: string };

/**
 * POST /api/evolve-graph
 *
 * Analyzes the current graph state and produces evolution suggestions:
 * - extend_node: unlinked messages that belong to an existing node
 * - suggest_merge: two nodes that are near-duplicates
 * - suggest_parent: 3+ related nodes that could have a common parent
 *
 * v1: suggestions only, no auto-apply, no mutations.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<EvolveGraphResponse | ErrorResponse>> {
  const startTime = Date.now();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { conversationId } = body as EvolveGraphRequest;
  if (!conversationId) {
    return NextResponse.json(
      { error: "conversationId is required." },
      { status: 400 },
    );
  }

  try {
    const db = createServerSupabaseClient();

    // ─── Load state ─────────────────────────────────────────────────────

    // Nodes with embeddings
    const rawNodes = await loadNodesWithEmbeddings(conversationId);
    const nodes: NodeWithEmbedding[] = rawNodes
      .filter((n) => n.embedding !== null && n.embedding!.length > 0)
      .map((n) => ({
        id: n.id,
        title: n.title,
        summary: n.summary,
        evidenceSummary: n.evidenceSummary,
        embedding: n.embedding!,
        messageIds: [], // filled below
      }));

    // Load node_messages to get each node's linked message IDs
    if (nodes.length > 0) {
      const { data: nmData } = await db
        .from("node_messages")
        .select("node_id, message_id")
        .in("node_id", nodes.map((n) => n.id));

      const nodeMessages = (nmData ?? []) as DbNodeMessage[];
      for (const nm of nodeMessages) {
        const node = nodes.find((n) => n.id === nm.node_id);
        if (node) node.messageIds.push(nm.message_id);
      }
    }

    // Load all messages (only non-branch messages for evolution analysis)
    const { data: dbMessages, error: msgErr } = await db
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .is("parent_node_id", null)
      .order("created_at", { ascending: true });

    if (msgErr) {
      return NextResponse.json(
        { error: `Failed to load messages: ${msgErr.message}` },
        { status: 500 },
      );
    }

    const messages: ChatMessage[] = (dbMessages ?? []).map((m: DbMessage) => ({
      id: m.id,
      role: m.role,
      content: m.content,
    }));

    // Load edges for parent detection
    const edges = await loadEdges(conversationId);

    // ─── Identify unlinked messages ─────────────────────────────────────

    const linkedMessageIds = new Set<string>();
    for (const node of nodes) {
      for (const mid of node.messageIds) {
        linkedMessageIds.add(mid);
      }
    }

    const unlinkedWindows = buildUnlinkedWindows(messages, linkedMessageIds);

    // ─── Embed unlinked windows ─────────────────────────────────────────

    const embeddedWindows: EmbeddedWindow[] = [];

    // Cap at 5 windows to control API cost
    const windowsToProcess = unlinkedWindows.slice(0, 5);

    for (const window of windowsToProcess) {
      const text = window
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

      try {
        const embedding = await generateEmbedding(
          text.length > 7000 ? text.slice(0, 7000) : text,
        );
        embeddedWindows.push({
          messageIds: window.map((m) => m.id),
          embedding,
          text,
        });
      } catch {
        // Skip windows that fail to embed
      }
    }

    // ─── Run detection heuristics ───────────────────────────────────────

    const extendSuggestions = detectExtendNode(embeddedWindows, nodes);
    const mergeSuggestions = detectMergeCandidates(nodes);
    const parentSuggestions = detectParentCandidates(nodes, edges);

    // Combine and sort by confidence
    const suggestions: EvolutionSuggestion[] = [
      ...extendSuggestions,
      ...mergeSuggestions,
      ...parentSuggestions,
    ].sort((a, b) => b.confidence - a.confidence);

    return NextResponse.json({
      suggestions,
      meta: {
        unlinkedMessageCount: messages.length - linkedMessageIds.size,
        nodesAnalyzed: nodes.length,
        processingTimeMs: Date.now() - startTime,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Evolution analysis failed: ${message}` },
      { status: 500 },
    );
  }
}
