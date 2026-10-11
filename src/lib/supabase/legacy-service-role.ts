/**
 * LEGACY service-role bridge — thin, guarded, allowlisted.
 *
 * Feature: google-oauth-authentication (Task 14, hardening item 1)
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * Before the cutover flag is flipped (Task 17), the app must behave EXACTLY as
 * it did pre-feature: ordinary request paths resolve their DB client through the
 * flag-aware bridges (`resolveRequestDbClient()` / `resolveDbClient()`), whose
 * flag-FALSE branch returns the legacy service-role client. Historically that
 * client was constructed inline inside `./server.ts` via
 * `createClient(url, SUPABASE_SERVICE_ROLE_KEY)` — a construction that NEVER
 * passed through the guarded `./service-role` factory and was therefore
 * invisible to the blocking CI import check.
 *
 * This module removes that blind spot. `createServerSupabaseClient()` is now a
 * THIN WRAPPER that delegates to the guarded `createServiceRoleClient` factory
 * from `./service-role`, passing the explicit `{ allowServiceRole: true }`
 * opt-in marker. Because this wrapper imports the guarded factory, it is itself
 * subject to:
 *   - the runtime hard-violation guard (the guard resolves the caller frame; see
 *     below for how this module is allowlisted), and
 *   - the tightened CI static check + ESLint rule, which now reject BOTH the old
 *     `createServerSupabaseClient` style AND the `createServiceRoleClient` style
 *     anywhere outside the allowlist.
 *
 * This module (`src/lib/supabase/legacy-service-role.ts`) is on the service-role
 * allowlist (group (d)) as the single pre-cutover service-role bridge. At cutover
 * (Task 17) the bridges collapse to always returning the user-scoped client and
 * this module is deleted.
 *
 * Requirements: 10.3, 10.5, 12.1
 */

import { createServiceRoleClient } from "./service-role";
import { isSupabaseCutoverEnabled } from "@/src/lib/config/cutover";

/**
 * CUTOVER HARD-FAIL GUARD (Task 17 hardening — the HARD INVARIANT).
 *
 * This is the single legacy service-role bridge for ordinary (request-reachable)
 * pre-cutover paths. When `AUTH_SUPABASE_CUTOVER_ENABLED` is true, constructing a
 * legacy service-role client is not merely unused — it is IMPOSSIBLE: this guard
 * throws. Combined with the fact that both flag-aware resolvers
 * (`resolveRequestDbClient()` / `resolveDbClient()`) return the user-scoped
 * client on the flag-true branch (and therefore never reach this function), the
 * invariant holds: in cutover mode NO ordinary request can construct OR receive
 * a service-role client. Any residual that still calls this unconditionally will
 * hard-fail the instant it runs in cutover mode, which also PROVES at runtime
 * that such a residual is not on any request's hot path (if it were, cutover-mode
 * tests exercising that path would throw).
 *
 * Genuinely offline/background service-role paths (the UUID_Migration runner, the
 * recovery sweep, scheduled jobs, the global-singleton calibration) do NOT call
 * this bridge — they construct the guarded factory directly with the opt-in
 * marker, so they are unaffected by this guard and keep working in both modes.
 *
 * Requirements: 10.2, 10.3, 10.5
 */
export function createServerSupabaseClient() {
  if (isSupabaseCutoverEnabled()) {
    throw new Error(
      "[legacy-service-role] Hard violation: the legacy service-role client is " +
        "IMPOSSIBLE to construct while AUTH_SUPABASE_CUTOVER_ENABLED is true. In " +
        "cutover mode every request-reachable module must run under the user-scoped " +
        "client (RLS applies). If you reached this throw, a request path still " +
        "depends on the legacy service-role bridge and must be converted to the " +
        "injected user-scoped client (resolveRequestDbClient / resolveDbClient).",
    );
  }
  return createServiceRoleClient({ allowServiceRole: true });
}
