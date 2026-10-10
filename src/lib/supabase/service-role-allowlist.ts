/**
 * Service-role allowlist — the single source of truth for which modules may
 * import/construct the privileged, RLS-bypassing Supabase client.
 *
 * Feature: google-oauth-authentication (Task 1.5 → tightened in Task 14)
 *
 * This array is consumed by BOTH:
 *   - the runtime hard-violation guard in `./service-role` (Req 10.5), and
 *   - the blocking CI static check (`scripts/check-service-role-usage.mjs`) and
 *     the ESLint `no-restricted-imports` override (`eslint.config.mjs`).
 *
 * ── TIGHTENED SCOPE (Task 14, hardening item 2) ─────────────────────────────
 *
 * The check now rejects importers of EITHER service-role provider module —
 * BOTH the guarded factory `@/src/lib/supabase/service-role`
 * (`createServiceRoleClient`) AND the legacy bridge
 * `@/src/lib/supabase/legacy-service-role` (`createServerSupabaseClient`, which
 * is itself a thin wrapper over the guarded factory) — anywhere OUTSIDE this
 * allowlist. Earlier, the legacy service-role client was constructed inline in
 * `src/lib/supabase/server.ts` and so escaped the check entirely; that blind
 * spot is now closed (the service-role key is only reachable through the two
 * provider modules below, both watched).
 *
 * ── FINAL ALLOWLIST (Task 17 hardening — "group (d-residual)" ELIMINATED) ────
 *
 * The pre-cutover ambiguity is resolved. There is NO LONGER a "d-residual"
 * group of not-yet-converted request-reachable engine internals: every one of
 * those modules (runV2GraphPlan, runIntelligenceEngine, assignNodeToNeighborhood,
 * retrieveGraphState, the SIE cutover-manager) now takes the INJECTED
 * user-scoped client (via `resolveDbClient`) and imports NO service-role
 * provider, so they are off this list entirely.
 *
 * Every remaining entry is a GENUINELY-PRIVILEGED operation that legitimately
 * requires RLS bypass. Per-entry justification:
 *
 *   (1) src/lib/migration/uuid-migration.ts
 *       The one-time UUID_Migration runner. Rewrites ownership columns across
 *       tables BEFORE RLS would admit the rows; invoked manually with the real
 *       Supabase user UUID, never from a request path (proven unreachable by
 *       check-service-role-reachability.mjs).
 *
 *   (2) src/lib/supabase/service-role.ts
 *       The guarded factory itself — the single construction site of the
 *       service-role client. It IS the privileged boundary.
 *
 *   (3) src/lib/supabase/service-role-allowlist.ts
 *       This allowlist helper (referenced by the factory + the CI check).
 *
 *   (4) src/lib/supabase/legacy-service-role.ts
 *       The single pre-cutover bridge. HARD-FAILS (throws) whenever
 *       isSupabaseCutoverEnabled() is true, so in cutover mode the legacy
 *       service-role client is IMPOSSIBLE to construct — the invariant's
 *       enforcement point. Deleted at the actual flag flip.
 *
 *   (5) app/api/debug/migrate-engine-state/route.ts
 *       requireDebugAccess()-gated schema/DDL maintenance (ALTER TABLE /
 *       exec_sql + a global zero-UUID probe row). Not conversation-scoped;
 *       must bypass RLS. Gated AND proven not imported by any other ordinary
 *       route.
 *
 *   (6) src/lib/intelligence-v2/incremental/update-runner.ts
 *       GENUINELY-OFFLINE background recovery sweep
 *       (recoverAbandonedWork/triggerRecoveryOnce). No request/auth.uid() to
 *       scope by, so it legitimately runs service-role. Constructs the GUARDED
 *       factory directly so it works in cutover mode. The REQUEST-triggered
 *       processing path (processFromCursor/markQueued) takes the injected
 *       user-scoped client — the module is split by entrypoint. Routes only
 *       ever call the fire-and-forget triggerRecoveryOnce (asserted in the
 *       reachability test).
 *
 *   (7) src/lib/db/calibration.ts
 *       GLOBAL-singleton maintenance. loadAllNodeEmbeddings + saveCalibration
 *       touch only a single global row (id='global') and a global
 *       id+embedding read — never a caller-supplied workspace/conversation, so
 *       they cannot leak another workspace's rows. Reached only from the
 *       requireDebugAccess()-gated calibrate-thresholds route; constructs the
 *       GUARDED factory directly (works in cutover mode). The request-reachable
 *       READ (getStoredCalibration) takes the injected client and is not on any
 *       ordinary request hot path.
 *
 *   (8) src/lib/db/request-client.ts  (9) src/lib/db/client.ts
 *   (10) src/lib/auth/authorization.ts
 *       The three FLAG-AWARE bridges. On the flag-TRUE branch they return/use
 *       the user-scoped client and NEVER reach the legacy bridge; on the
 *       flag-FALSE branch they use it for behavior parity. They import the
 *       legacy bridge (which hard-fails in cutover mode), so they are listed.
 *       At the flag flip they collapse to always using the user-scoped client
 *       and drop the legacy import.
 *
 * PROVISIONING IS DELIBERATELY ABSENT. Normal account provisioning runs through
 * the `auth.users` SECURITY DEFINER trigger or the `auth.uid()`-bound
 * `provision_self()` RPC via the user-scoped client — never a service-role
 * provider.
 *
 * Paths are workspace-root-relative, forward-slash, POSIX style.
 *
 * Requirements: 10.3, 10.5, 6.1
 */
export const SERVICE_ROLE_ALLOWLIST: readonly string[] = [
  // Group (d) — genuinely privileged / offline
  "src/lib/migration/uuid-migration.ts",
  "src/lib/supabase/service-role.ts",
  "src/lib/supabase/service-role-allowlist.ts",
  "src/lib/supabase/legacy-service-role.ts",
  "app/api/debug/migrate-engine-state/route.ts",
  // Group (d) — genuinely-offline background / global-singleton maintenance
  // (construct the GUARDED factory directly; work in cutover mode)
  "src/lib/intelligence-v2/incremental/update-runner.ts",
  "src/lib/db/calibration.ts",
  // Flag-aware bridges — use the user-scoped client on the flag-TRUE branch and
  // the legacy (hard-failing) bridge only on the flag-FALSE branch
  "src/lib/db/request-client.ts",
  "src/lib/db/client.ts",
  "src/lib/auth/authorization.ts",
] as const;

/**
 * Normalizes a module path to the same POSIX, workspace-root-relative,
 * extension-tolerant form used for allowlist comparison. Exposed so the runtime
 * guard and the static-check script compare paths identically.
 */
export function normalizeAllowlistPath(p: string): string {
  return p
    .replace(/\\/g, "/") // Windows → POSIX separators
    .replace(/^\.\//, "") // leading ./
    .replace(/^\/+/, ""); // leading slashes
}

/**
 * Returns true iff `modulePath` (any reasonable form) is on the allowlist.
 * Matches on suffix so absolute paths, `./`-relative paths, and
 * extension-trimmed paths all resolve against the canonical entries.
 */
export function isAllowlistedModule(modulePath: string): boolean {
  const candidate = normalizeAllowlistPath(modulePath);
  const stripExt = (s: string) => s.replace(/\.(mts|cts|tsx|ts|mjs|cjs|jsx|js)$/, "");
  const candNoExt = stripExt(candidate);

  return SERVICE_ROLE_ALLOWLIST.some((allowed) => {
    const a = normalizeAllowlistPath(allowed);
    const aNoExt = stripExt(a);
    return (
      candidate === a ||
      candidate.endsWith(`/${a}`) ||
      candNoExt === aNoExt ||
      candNoExt.endsWith(`/${aNoExt}`)
    );
  });
}
