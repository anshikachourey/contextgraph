/**
 * UUID_Migration runner — one-time, privileged, allowlisted (group (d)).
 *
 * Feature: google-oauth-authentication (Task 15.2)
 * Requirements: 11.2, 11.3, 11.4, 10.3
 *
 * Reassociates all Owner_Workspace_Data to the authenticated user's personal
 * Account_Workspace by invoking the `migrate_owner_data_to_user(target_user)`
 * SQL function (defined in migration 20260824000600). That function:
 *   - calls a fail-closed schema PREFLIGHT first (aborts on schema drift),
 *   - re-parents graph_workspaces + conversations (owner only; demo untouched),
 *   - preserves each graph's id (no flatten); dependents follow by unchanged ids,
 *   - is idempotent via the migration_runs bookkeeping table (skip-if-done).
 *
 * ── PRIVILEGE ───────────────────────────────────────────────────────────────
 * This runner is the canonical group (d) service-role path. It constructs the
 * guarded service-role client with the conspicuous `{ allowServiceRole: true }`
 * opt-in marker. It is on the service-role allowlist
 * (`src/lib/supabase/service-role-allowlist.ts`) and in the ESLint override; the
 * blocking CI check verifies no OTHER request path imports a service-role
 * provider. The service-role client is required because the migration rewrites
 * ownership columns across tables before RLS would admit the rows.
 *
 * ── GATING (Req 11.2, 11.3) ───────────────────────────────────────────────────
 * The migration MUST NOT run before the real Supabase_User_Id is known. The real
 * UUID is obtained AFTER the user's first sign-in and supplied manually. This
 * module validates that a well-formed UUID was provided and refuses otherwise.
 * It is NEVER invoked automatically, from a request path, or against prod from
 * CI — it is a manual, one-time operation.
 */

import { createServiceRoleClient } from "@/src/lib/supabase/service-role";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Canonical v4-ish UUID shape check (also accepts other RFC-4122 versions). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * TypeScript PREFLIGHT (Task 14, hardening item 4 — user-requested).
 *
 * Several live tables (messages, nodes, edges, conversation_node_positions,
 * graph_workspace_conversations, and the owner/demo discriminator columns on
 * graph_workspaces/conversations) were created directly in the live DB without
 * a version-controlled baseline. Before the runner invokes the mutating RPC, it
 * asserts — from the TypeScript side — that the exact tables + columns the
 * UUID_Migration depends on actually exist in the real schema, and FAILS FAST
 * (throws) BEFORE any mutation if the real schema differs.
 *
 * This is defense-in-depth that complements the SQL preflight
 * (`assert_owner_migration_preflight()`), which the mutating RPC itself PERFORMs
 * first (fail-closed RAISE). The TS check gives an early, readable failure at the
 * call site BEFORE the network round-trip into the mutating function.
 *
 * ── INTERFACE DECISION (Task 17 hardening item 4): RPC, not information_schema ──
 *
 * The TS runner CANNOT read `information_schema` directly through the Supabase
 * client. PostgREST only exposes the schemas in its `db-schemas` setting — by
 * default `public` (plus `storage`/`graphql_public`). `information_schema` is NOT
 * exposed over the REST interface, so `db.schema("information_schema").from(...)`
 * fails with PGRST106 ("The schema must be one of the following: public") rather
 * than returning catalog rows. The preflight is therefore performed through a
 * read-only authenticated RPC `public.assert_owner_migration_preflight_report()`
 * (migration 20260824000700), which runs the information_schema checks INSIDE
 * Postgres (where they are available) and RETURNS a `{ ok, missing[] }` jsonb
 * report over the supported `.rpc()` interface. The SQL function's internal
 * fail-before-mutation RAISE assertions are RETAINED regardless.
 */

type PreflightReport = { ok: boolean; missing: string[] };

/**
 * Verify every required table/column/constraint exists in the real `public`
 * schema BEFORE any mutation, via the read-only preflight REPORT RPC (callable
 * over PostgREST — unlike a direct information_schema query). Throws (fail-fast)
 * if the RPC errors or reports any missing item.
 *
 * Exported for unit testing against a stubbed client.
 */
export async function assertSchemaPreflight(db: SupabaseClient): Promise<void> {
  const { data, error } = await db.rpc("assert_owner_migration_preflight_report");

  if (error) {
    throw new Error(
      `UUID_Migration preflight: could not run assert_owner_migration_preflight_report() ` +
        `(${error.message}); aborting before any mutation. Ensure migration ` +
        "20260824000700_preflight_report_rpc.sql has been applied.",
    );
  }

  const report = (data ?? null) as PreflightReport | null;
  if (!report || typeof report.ok !== "boolean") {
    throw new Error(
      "UUID_Migration preflight: preflight report RPC returned an unexpected shape; " +
        "aborting before any mutation.",
    );
  }

  if (!report.ok) {
    const missing = Array.isArray(report.missing) ? report.missing : [];
    throw new Error(
      "UUID_Migration preflight FAILED (schema drift) — the real schema is missing required " +
        `objects, aborting BEFORE any mutation: ${missing.join(", ")}. ` +
        "Run the schema migrations (identity/workspace tables + reparent) first.",
    );
  }
}

export type UuidMigrationResult = {
  /** The target user the migration ran for. */
  targetUserId: string;
  /**
   * Whether the SQL function reported success (no error). Because the function
   * is idempotent and skip-if-done, a `true` result covers both "performed the
   * reassociation" and "already done, no-op".
   */
  ok: true;
};

/**
 * Run the one-time owner UUID_Migration for `targetUserId`.
 *
 * @param targetUserId - The REAL Supabase user UUID obtained after first sign-in
 *   (Req 11.2). Must be a well-formed UUID; otherwise the migration refuses to
 *   run (Req 11.3 — never run before the real UUID is known).
 * @throws Error if the UUID is missing/malformed, or if the SQL function errors.
 */
export async function runOwnerUuidMigration(
  targetUserId: string,
): Promise<UuidMigrationResult> {
  if (typeof targetUserId !== "string" || !UUID_RE.test(targetUserId.trim())) {
    throw new Error(
      "runOwnerUuidMigration: a well-formed real Supabase user UUID is required. " +
        "The migration must not run before the real UUID (obtained after first sign-in) is known (Req 11.3).",
    );
  }

  const target = targetUserId.trim();

  // Guarded, allowlisted service-role construction (group (d)).
  const db = createServiceRoleClient({ allowServiceRole: true });

  // TS-side PREFLIGHT: verify the real schema has the tables/columns this
  // migration depends on and FAIL FAST before any mutation (defense-in-depth
  // alongside the SQL preflight the RPC runs first).
  await assertSchemaPreflight(db);

  // The SQL function performs its own preflight + parent-first reassociation +
  // idempotency bookkeeping atomically on the server (Req 11.4, 11.5).
  const { error } = await db.rpc("migrate_owner_data_to_user", {
    target_user: target,
  });

  if (error) {
    throw new Error(
      `runOwnerUuidMigration: migrate_owner_data_to_user failed for ${target}: ${error.message}`,
    );
  }

  return { targetUserId: target, ok: true };
}
