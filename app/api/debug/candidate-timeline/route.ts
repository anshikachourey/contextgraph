import { requireDebugAccess } from "@/src/lib/auth/debug";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";

/**
 * GET /api/debug/candidate-timeline?conversationId=<id>
 *
 * Returns the full chronological lifecycle of every candidate
 * in a conversation: created, accumulated, blocked, materialized.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const debugAuthError = await requireDebugAccess();
  if (debugAuthError) return debugAuthError;

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId");

  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("topic_candidates")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Engine state for context
  const { data: engineState } = await db
    .from("conversation_engine_state")
    .select("total_engine_runs")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  const currentRun = engineState?.total_engine_runs ?? 0;

  const timeline = (data ?? []).map((c: any) => {
    const segments = Array.isArray(c.segments) ? c.segments : [];
    const totalMessages = segments.reduce(
      (sum: number, s: any) => sum + (Array.isArray(s.messageIds) ? s.messageIds.length : 0),
      0,
    );
    const embeddingDim = Array.isArray(c.embedding) ? c.embedding.length : 0;
    const lastTouchedRun = c.last_touched_run ?? 0;
    const runsSinceTouch = currentRun - lastTouchedRun;

    let lifecycleState: string;
    if (c.status === "materialized") {
      lifecycleState = "MATERIALIZED";
    } else if (c.status === "blocked") {
      lifecycleState = "BLOCKED";
    } else if (runsSinceTouch >= 5) {
      lifecycleState = "STUCK";
    } else if (segments.length > 1) {
      lifecycleState = "ACCUMULATING";
    } else {
      lifecycleState = "CREATED";
    }

    return {
      id: c.id,
      status: c.status,
      lifecycleState,
      segmentCount: segments.length,
      totalMessages,
      confidence: c.confidence,
      embeddingDim,
      lastTouchedRun,
      runsSinceTouch,
      createdAt: c.created_at,
      lastUpdatedAt: c.last_updated_at,
      materializedNodeId: c.materialized_node_id ?? null,
    };
  });

  return NextResponse.json({
    conversationId,
    currentEngineRun: currentRun,
    totalCandidates: timeline.length,
    active: timeline.filter((t: any) => t.status === "accumulating").length,
    blocked: timeline.filter((t: any) => t.status === "blocked").length,
    materialized: timeline.filter((t: any) => t.status === "materialized").length,
    stuck: timeline.filter((t: any) => t.lifecycleState === "STUCK").length,
    timeline,
  });
}
