/**
 * Flag-aware request-path Supabase client resolver.
 *
 * Feature: google-oauth-authentication (Tasks 10–13 — route conversion)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Tasks 10–13 convert ordinary request paths (routes) off the legacy
 * service-role client and onto the user-scoped (`@supabase/ssr`) client so that
 * Row Level Security applies (Req 10.1). But the cutover is gated behind
 * `AUTH_SUPABASE_CUTOVER_ENABLED`, which stays `false` until the strict last
 * step (Task 17). The hard requirement for this batch is **behavior-neutrality**:
 * while the flag is false, every converted route must behave EXACTLY as it does
 * today — i.e. use the legacy service-role client / existing code path.
 *
 * This helper is the single, canonical place that encodes that choice:
 *
 *   - Flag FALSE (default today): returns the LEGACY service-role client
 *     (`createServerSupabaseClient`), exactly the client every route constructs
 *     inline today. Zero runtime change.
 *   - Flag TRUE (post-cutover):  returns the USER-SCOPED client
 *     (`createUserScopedClient`), so RLS applies and a non-member's queries see
 *     zero rows → the handler's existing not-found path yields 404/empty.
 *
 * Converted routes call `resolveRequestDbClient()` once, then thread the result
 * into the already-refactored `src/lib/db/*` / `src/lib/intelligence-v2/**`
 * helpers (which accept an optional trailing injected client). On the flag-true
 * branch they ALSO drop the manual `workspace_id` / `requireConversationAccess`
 * string checks and rely on RLS; on the flag-false branch they keep the legacy
 * manual checks so behavior is identical.
 *
 * NOTE on the service-role allowlist / CI static check (Task 14 hardening):
 * converted routes that call this helper do NOT import any service-role
 * provider themselves. This bridge module obtains the pre-cutover legacy client
 * via `createServerSupabaseClient` from `@/src/lib/supabase/legacy-service-role`
 * — a thin wrapper over the guarded `createServiceRoleClient`. Because this
 * module imports a service-role provider, it is itself on the service-role
 * allowlist (group (d), pre-cutover residual) and is covered by the tightened
 * CI check + ESLint rule. The legacy branch is removed at cutover (Task 17), at
 * which point this helper collapses to always returning the user-scoped client.
 *
 * Requirements: 7.4, 10.1, 10.2
 */

import type { DbClient } from "./client";
import { createUserScopedClient } from "@/src/lib/supabase/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/legacy-service-role";
import { isSupabaseCutoverEnabled } from "@/src/lib/config/cutover";

/**
 * Resolve the Supabase client a request handler should use for ordinary data
 * access, honoring the cutover flag.
 *
 * @returns the user-scoped client when the cutover is enabled (RLS applies), or
 *   the legacy service-role client when it is disabled (behavior-neutral today).
 */
export async function resolveRequestDbClient(): Promise<DbClient> {
  if (isSupabaseCutoverEnabled()) {
    return createUserScopedClient();
  }
  return createServerSupabaseClient();
}

/**
 * Convenience: whether converted routes should take the RLS-backed branch (drop
 * manual workspace_id / requireConversationAccess checks). Mirrors the cutover
 * flag; exposed as a named helper so route code reads intentionally.
 */
export function useRlsScopedAccess(): boolean {
  return isSupabaseCutoverEnabled();
}
