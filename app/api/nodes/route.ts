import { NextRequest, NextResponse } from "next/server";
import { persistNode, loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { persistEdges } from "@/src/lib/db/edges";
import { computeSuggestedEdges } from "@/src/lib/edgeSuggestions";
import { STRONGLY_RELATED_THRESHOLD } from "@/src/lib/similarityThresholds";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import type { ContextNode } from "@/src/types/node";
import type { ChatMessage } from "@/src/types/message";
import type { NodeMetadata } from "@/src/types/db";

type ErrorResponse = { error: string };

export async function POST(
  request: NextRequest,
): Promise<NextResponse<Record<string, never> | ErrorResponse>> {
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

  const b = body as Record<string, unknown>;

  if (
    typeof b.conversationId !== "string" ||
    typeof b.node !== "object" ||
    !b.node ||
    !Array.isArray(b.linkedMessages)
  ) {
    return NextResponse.json(
      { error: "Request must include conversationId, node, and linkedMessages." },
      { status: 400 },
    );
  }

  const conversationId = b.conversationId as string;

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  // ─── Step 1: Persist the node (with evidence summary + embedding) ───────
  try {
    await persistNode(
      conversationId,
      b.node as ContextNode,
      b.linkedMessages as ChatMessage[],
      (b.metadata as NodeMetadata) ?? {},
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to persist node: ${message}` },
      { status: 500 },
    );
  }

  // ─── Step 2: Recompute semantic edges for the conversation (soft-fail) ──
  // Uses the delete-then-insert cache pattern:
  //   1. Delete all status='suggested' edges for this conversation
  //   2. Compute fresh suggestions from all nodes (including the new one)
  //   3. Insert only strongly related edges
  // If this fails, the node is still saved — edges are additive enrichment.
  try {
    const allNodes = await loadNodesWithEmbeddings(conversationId);
    const suggestions = await computeSuggestedEdges(allNodes);
    const strongEdges = suggestions.filter(
      (s) => s.similarity >= STRONGLY_RELATED_THRESHOLD,
    );
    const persisted = await persistEdges(conversationId, strongEdges);
    console.log(
      `[nodes/route] Auto-computed edges: ${persisted} persisted (${strongEdges.length} strongly related, ${suggestions.length} total candidates)`,
    );
  } catch (err) {
    // Log but don't fail the request — the node was already saved successfully
    console.error("[nodes/route] Edge recomputation failed (non-fatal):", err);
  }

  return NextResponse.json({}, { status: 200 });
}
