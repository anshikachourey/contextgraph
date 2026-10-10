import { requireDebugAccess } from "@/src/lib/auth/debug";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/src/lib/supabase/service-role";

/**
 * POST /api/debug/migrate-engine-state
 *
 * Adds the v2 engine state columns (cursor, open_segment) to conversation_engine_state.
 * Safe to run multiple times — uses IF NOT EXISTS semantics via individual column adds.
 *
 * GROUP (d) — PRIVILEGED, RLS-BYPASSING. This is a schema/DDL maintenance
 * diagnostic (ALTER TABLE / exec_sql + a global zero-UUID probe row); it is NOT
 * conversation-scoped and must bypass RLS. It is therefore gated by
 * requireDebugAccess() AND explicitly placed on the service-role allowlist
 * (src/lib/supabase/service-role-allowlist.ts + eslint.config.mjs), constructing
 * the service-role client with the conspicuous opt-in marker. Google OAuth
 * design — Debug routes note: "any genuinely cross-workspace diagnostic that
 * must bypass RLS is explicitly allowlisted as a group (d) privileged operation."
 */
export async function POST(): Promise<NextResponse> {
  const debugAuthError = await requireDebugAccess();
  if (debugAuthError) return debugAuthError;

  const db = createServiceRoleClient({ allowServiceRole: true });
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
