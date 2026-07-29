import { requireDebugAccess } from "@/src/lib/auth/debug";
import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";

/**
 * POST /api/debug/migrate-engine-state
 *
 * Adds the v2 engine state columns (cursor, open_segment) to conversation_engine_state.
 * Safe to run multiple times — uses IF NOT EXISTS semantics via individual column adds.
 */
export async function POST(): Promise<NextResponse> {
  const debugAuthError = await requireDebugAccess();
  if (debugAuthError) return debugAuthError;

  const db = createServerSupabaseClient();
  const results: string[] = [];

  // Add cursor column
  const { error: cursorError } = await db.rpc("exec_sql", {
    sql: `ALTER TABLE conversation_engine_state ADD COLUMN IF NOT EXISTS cursor text;`,
  });

  if (cursorError) {
    // rpc may not exist — try raw SQL via Supabase's pg_net or just report
    results.push(`cursor column: rpc failed (${cursorError.message}) — run SQL manually`);
  } else {
    results.push("cursor column: added or already exists");
  }

  // Add open_segment column
  const { error: segError } = await db.rpc("exec_sql", {
    sql: `ALTER TABLE conversation_engine_state ADD COLUMN IF NOT EXISTS open_segment jsonb;`,
  });

  if (segError) {
    results.push(`open_segment column: rpc failed (${segError.message}) — run SQL manually`);
  } else {
    results.push("open_segment column: added or already exists");
  }

  // Test: try to insert/upsert a test row and then delete it
  const testId = "00000000-0000-0000-0000-000000000000";
  const { error: testError } = await db
    .from("conversation_engine_state")
    .upsert({
      conversation_id: testId,
      cursor: "test",
      open_segment: { test: true },
      total_engine_runs: 0,
      last_engine_run_at: new Date().toISOString(),
    }, { onConflict: "conversation_id" });

  if (testError) {
    results.push(`test upsert: FAILED — ${testError.message}`);
    results.push("REQUIRED SQL (run in Supabase SQL editor):");
    results.push("ALTER TABLE conversation_engine_state ADD COLUMN IF NOT EXISTS cursor text;");
    results.push("ALTER TABLE conversation_engine_state ADD COLUMN IF NOT EXISTS open_segment jsonb;");
  } else {
    // Clean up test row
    await db.from("conversation_engine_state").delete().eq("conversation_id", testId);
    results.push("test upsert: SUCCESS — columns exist and are writable");
  }

  return NextResponse.json({ results });
}
