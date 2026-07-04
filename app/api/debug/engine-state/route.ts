import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";

export async function GET(
  request: NextRequest,
): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("id");

  if (!conversationId) {
    return NextResponse.json(
      { error: "id query parameter is required" },
      { status: 400 },
    );
  }

  const db = createServerSupabaseClient();

  // Query ALL rows for this conversation (detect duplicates)
  const { data: allRows, error: allError } = await db
    .from("conversation_engine_state")
    .select("*")
    .eq("conversation_id", conversationId);

  // Also try maybeSingle (this is what loadPipelineContext uses)
  const { data: singleRow, error: singleError } = await db
    .from("conversation_engine_state")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  return NextResponse.json({
    conversationId,
    rowCount: allRows?.length ?? 0,
    allRows: allRows,
    allError: allError ? { message: allError.message, code: allError.code } : null,
    singleRow: singleRow,
    singleError: singleError ? { message: singleError.message, code: singleError.code } : null,
    diagnosis: allRows && allRows.length > 1
      ? "DUPLICATE ROWS DETECTED — maybeSingle() will return error/null when multiple rows exist"
      : allRows && allRows.length === 1
        ? "Single row exists — maybeSingle() should work"
        : "No rows found",
  });
}
