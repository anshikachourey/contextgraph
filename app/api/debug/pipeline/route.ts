import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";

type PipelineDebugResponse = {
  conversationId: string;
  messages: { total: number; mainThread: number; branches: number };
  segments: {
    engineState: {
      totalRuns: number;
      lastProcessedMessageId: string | null;
      hasWindowEmbedding: boolean;
    };
  };
  activeCandidates: Array<{
    id: string;
    segmentCount: number;
    messageCount: number;
    confidence: number;
    hasEmbedding: boolean;
  }>;
  blockedCandidates: Array<{
    id: string;
    status: string;
    segmentCount: number;
    messageCount: number;
    confidence: number;
  }>;
  nodes: Array<{
    id: string;
    title: string;
    summary: string;
    messageCount: number;
    hasEmbedding: boolean;
    neighborhoodId: string | null;
  }>;
  edges: Array<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    similarity: number;
  }>;
  neighborhoods: Array<{
    id: string;
    label: string | null;
    hue: number;
    memberCount: number;
  }>;
};

export async function GET(
  request: NextRequest,
): Promise<NextResponse<PipelineDebugResponse | { error: string }>> {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId");

  if (!conversationId) {
    return NextResponse.json(
      { error: "conversationId query parameter is required" },
      { status: 400 },
    );
  }

  const db = createServerSupabaseClient();

  try {
    // Messages
    const { data: allMsgs } = await db
      .from("messages")
      .select("id, parent_node_id")
      .eq("conversation_id", conversationId);

    const totalMsgs = (allMsgs ?? []).length;
    const mainThread = (allMsgs ?? []).filter(
      (m: any) => !m.parent_node_id,
    ).length;
    const branches = totalMsgs - mainThread;

    // Engine state
    const { data: stateData } = await db
      .from("conversation_engine_state")
      .select("*")
      .eq("conversation_id", conversationId)
      .single();

    const engineState = {
      totalRuns: stateData?.total_engine_runs ?? 0,
      lastProcessedMessageId:
        stateData?.last_processed_message_id ?? null,
      hasWindowEmbedding:
        Array.isArray(stateData?.last_window_embedding) &&
        stateData.last_window_embedding.length > 0,
    };

    // Candidates
    const { data: candData } = await db
      .from("topic_candidates")
      .select("id, status, segments, confidence, embedding")
      .eq("conversation_id", conversationId);

    const activeCandidates = (candData ?? [])
      .filter((c: any) => c.status === "accumulating")
      .map((c: any) => ({
        id: c.id,
        segmentCount: Array.isArray(c.segments)
          ? c.segments.length
          : 0,
        messageCount: Array.isArray(c.segments)
          ? c.segments.reduce(
              (sum: number, s: any) =>
                sum + (Array.isArray(s.messageIds) ? s.messageIds.length : 0),
              0,
            )
          : 0,
        confidence: c.confidence ?? 0,
        hasEmbedding:
          Array.isArray(c.embedding) && c.embedding.length > 0,
      }));

    const blockedCandidates = (candData ?? [])
      .filter((c: any) => c.status !== "accumulating")
      .map((c: any) => ({
        id: c.id,
        status: c.status,
        segmentCount: Array.isArray(c.segments)
          ? c.segments.length
          : 0,
        messageCount: Array.isArray(c.segments)
          ? c.segments.reduce(
              (sum: number, s: any) =>
                sum + (Array.isArray(s.messageIds) ? s.messageIds.length : 0),
              0,
            )
          : 0,
        confidence: c.confidence ?? 0,
      }));

    // Nodes
    const { data: nodeData } = await db
      .from("nodes")
      .select("id, title, summary, embedding, neighborhood_id")
      .eq("conversation_id", conversationId);

    const nodeIds = (nodeData ?? []).map((n: any) => n.id);
    let nodeMsgCounts = new Map<string, number>();
    if (nodeIds.length > 0) {
      const { data: nmData } = await db
        .from("node_messages")
        .select("node_id")
        .in("node_id", nodeIds);
      for (const nm of (nmData ?? []) as { node_id: string }[]) {
        nodeMsgCounts.set(
          nm.node_id,
          (nodeMsgCounts.get(nm.node_id) ?? 0) + 1,
        );
      }
    }

    const nodes = (nodeData ?? []).map((n: any) => ({
      id: n.id,
      title: n.title,
      summary: n.summary,
      messageCount: nodeMsgCounts.get(n.id) ?? 0,
      hasEmbedding:
        Array.isArray(n.embedding) && n.embedding.length > 0,
      neighborhoodId: n.neighborhood_id ?? null,
    }));

    // Edges
    const { data: edgeData } = await db
      .from("edges")
      .select(
        "id, source_node_id, target_node_id, similarity_score",
      )
      .eq("conversation_id", conversationId);

    const edges = (edgeData ?? []).map((e: any) => ({
      id: e.id,
      sourceNodeId: e.source_node_id,
      targetNodeId: e.target_node_id,
      similarity: e.similarity_score,
    }));

    // Neighborhoods
    const neighborhoodIds = [
      ...new Set(
        (nodeData ?? [])
          .map((n: any) => n.neighborhood_id)
          .filter(Boolean),
      ),
    ];
    let neighborhoods: Array<{
      id: string;
      label: string | null;
      hue: number;
      memberCount: number;
    }> = [];

    if (neighborhoodIds.length > 0) {
      const { data: nbData } = await db
        .from("neighborhoods")
        .select("id, label, hue")
        .in("id", neighborhoodIds);

      neighborhoods = (nbData ?? []).map((nb: any) => ({
        id: nb.id,
        label: nb.label ?? null,
        hue: nb.hue ?? 0,
        memberCount: (nodeData ?? []).filter(
          (n: any) => n.neighborhood_id === nb.id,
        ).length,
      }));
    }

    return NextResponse.json({
      conversationId,
      messages: { total: totalMsgs, mainThread, branches },
      segments: { engineState },
      activeCandidates,
      blockedCandidates,
      nodes,
      edges,
      neighborhoods,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Pipeline debug failed: ${message}` },
      { status: 500 },
    );
  }
}
