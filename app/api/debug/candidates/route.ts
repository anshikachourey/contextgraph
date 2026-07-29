import { requireDebugAccess } from "@/src/lib/auth/debug";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";

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

  const { data, error } = await db
    .from("topic_candidates")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({
      conversationId,
      error: { message: error.message, code: error.code, details: error.details },
    });
  }

  const candidates = (data ?? []).map((c: any) => ({
    id: c.id,
    status: c.status,
    segmentCount: Array.isArray(c.segments) ? c.segments.length : 0,
    totalMessageCount: Array.isArray(c.segments)
      ? c.segments.reduce(
          (sum: number, s: any) => sum + (Array.isArray(s.messageIds) ? s.messageIds.length : 0),
          0,
        )
      : 0,
    confidence: c.confidence,
    lastTouchedRun: c.last_touched_run,
    createdAt: c.created_at,
    lastUpdatedAt: c.last_updated_at,
  }));

  const accumulating = candidates.filter((c: any) => c.status === "accumulating").length;
  const blocked = candidates.filter((c: any) => c.status === "blocked").length;
  const materialized = candidates.filter((c: any) => c.status === "materialized").length;

  return NextResponse.json({
    conversationId,
    total: candidates.length,
    accumulating,
    blocked,
    materialized,
    candidates,
  });
}
