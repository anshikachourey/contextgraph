import { requireDebugAccess } from "@/src/lib/auth/debug";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";

/**
 * GET /api/debug/pipeline-health?id=<conversationId>
 *
 * Returns a full diagnostic snapshot of the graph pipeline state
 * for a conversation. Shows where the pipeline is stopped.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const debugAuthError = await requireDebugAccess();
  if (debugAuthError) return debugAuthError;

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("id");

  if (!conversationId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const db = createServerSupabaseClient();

  // Messages
  const { data: msgs } = await db
    .from("messages")
    .select("id, role, parent_node_id")
    .eq("conversation_id", conversationId);
  const totalMessages = (msgs ?? []).length;
  const mainThreadMessages = (msgs ?? []).filter((m: any) => !m.parent_node_id).length;

  // Engine state
  const { data: engineState } = await db
    .from("conversation_engine_state")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  const openSegment = engineState?.open_segment;
  const cursor = engineState?.cursor;
  const totalRuns = engineState?.total_engine_runs ?? 0;

  // Candidates
  const { data: candidates } = await db
    .from("topic_candidates")
    .select("id, status, segments, confidence, embedding, last_touched_run")
    .eq("conversation_id", conversationId);

  const activeCandidates = (candidates ?? []).filter((c: any) => c.status === "accumulating");
  const candidateDetails = activeCandidates.map((c: any) => {
    const segments = Array.isArray(c.segments) ? c.segments : [];
    const totalMsgs = segments.reduce(
      (sum: number, s: any) => sum + (Array.isArray(s.messageIds) ? s.messageIds.length : 0),
      0,
    );
    const embeddingDim = Array.isArray(c.embedding) ? c.embedding.length : 0;
    return {
      id: c.id,
      segmentCount: segments.length,
      messageCount: totalMsgs,
      confidence: c.confidence,
      embeddingDim,
      lastTouchedRun: c.last_touched_run,
    };
  });

  // Nodes
  const { data: nodes } = await db
    .from("nodes")
    .select("id, title, embedding")
    .eq("conversation_id", conversationId);

  const nodeDetails = (nodes ?? []).map((n: any) => ({
    id: n.id,
    title: n.title,
    embeddingDim: Array.isArray(n.embedding) ? n.embedding.length : 0,
  }));

  // Edges
  const { data: edges } = await db
    .from("edges")
    .select("id")
    .eq("conversation_id", conversationId);

  // Dimension mismatch detection
  const allEmbeddingDims = new Set<number>();
  for (const c of candidateDetails) {
    if (c.embeddingDim > 0) allEmbeddingDims.add(c.embeddingDim);
  }
  for (const n of nodeDetails) {
    if (n.embeddingDim > 0) allEmbeddingDims.add(n.embeddingDim);
  }
  if (openSegment?.embedding && Array.isArray(openSegment.embedding)) {
    allEmbeddingDims.add(openSegment.embedding.length);
  }

  const hasDimensionMismatch = allEmbeddingDims.size > 1;

  return NextResponse.json({
    conversationId,
    messages: { total: totalMessages, mainThread: mainThreadMessages },
    engineState: {
      cursor: cursor ?? null,
      openSegmentExchangeCount: openSegment?.exchangeCount ?? 0,
      openSegmentEmbeddingDim: openSegment?.embedding?.length ?? 0,
      openSegmentUserEmbeddingDim: openSegment?.userEmbedding?.length ?? 0,
      totalRuns,
    },
    candidates: {
      active: activeCandidates.length,
      total: (candidates ?? []).length,
      details: candidateDetails,
    },
    nodes: {
      count: nodeDetails.length,
      details: nodeDetails,
    },
    edges: { count: (edges ?? []).length },
    diagnostics: {
      hasDimensionMismatch,
      embeddingDimensionsFound: [...allEmbeddingDims],
      stalePreSwitchCandidates: candidateDetails.filter((c) => c.embeddingDim === 1536).length,
      stalePreSwitchNodes: nodeDetails.filter((n) => n.embeddingDim === 1536).length,
    },
  });
}
