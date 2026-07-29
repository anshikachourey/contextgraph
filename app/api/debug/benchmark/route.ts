import { requireDebugAccess } from "@/src/lib/auth/debug";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { evaluateGraphQuality } from "@/src/lib/intelligence/benchmark";
import type { GraphSnapshot } from "@/src/lib/intelligence/benchmark";

/**
 * GET /api/debug/benchmark?id=<conversationId>
 *
 * Evaluates the current graph quality for a conversation.
 * Returns rubric scores: title quality, summary quality, edge quality,
 * segmentation, recall test, and detailed per-node/per-edge breakdowns.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const debugAuthError = await requireDebugAccess();
  if (debugAuthError) return debugAuthError;

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("id");

  if (!conversationId) {
    return NextResponse.json(
      { error: "id query parameter is required" },
      { status: 400 },
    );
  }

  const db = createServerSupabaseClient();

  // Load nodes
  const { data: nodeData, error: nodeError } = await db
    .from("nodes")
    .select("id, title, summary")
    .eq("conversation_id", conversationId);

  if (nodeError) {
    return NextResponse.json(
      { error: `Failed to load nodes: ${nodeError.message}` },
      { status: 500 },
    );
  }

  // Load edges
  const { data: edgeData, error: edgeError } = await db
    .from("edges")
    .select("source_node_id, target_node_id, relationship_type, explanation")
    .eq("conversation_id", conversationId);

  if (edgeError) {
    return NextResponse.json(
      { error: `Failed to load edges: ${edgeError.message}` },
      { status: 500 },
    );
  }

  const graph: GraphSnapshot = {
    nodes: (nodeData ?? []).map((n: any) => ({
      id: n.id,
      title: n.title ?? "",
      summary: n.summary ?? "",
    })),
    edges: (edgeData ?? []).map((e: any) => ({
      sourceNodeId: e.source_node_id,
      targetNodeId: e.target_node_id,
      relationshipType: e.relationship_type ?? "related",
      explanation: e.explanation ?? "",
    })),
  };

  const scores = evaluateGraphQuality(graph);

  return NextResponse.json({
    conversationId,
    scores,
    graph: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      nodes: graph.nodes.map((n) => ({ title: n.title, summary: n.summary.slice(0, 100) })),
      edges: graph.edges.map((e) => ({ type: e.relationshipType, explanation: e.explanation.slice(0, 60) })),
    },
  });
}
