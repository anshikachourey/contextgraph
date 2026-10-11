/**
 * Shared DB-helper client transition utilities.
 *
 * Feature: google-oauth-authentication (Task 5.1 / 5.2)
 *
 * ── The transition pattern ──────────────────────────────────────────────────
 *
 * Before this feature, every `src/lib/db/*` helper (and several request-reachable
 * `src/lib/intelligence-v2/**` helpers) imported the legacy service-role client
 * internally via `createServerSupabaseClient()`. That client bypasses RLS, which
 * is incompatible with the membership/RLS authorization model this feature
 * introduces.
 *
 * The target end-state (post-cutover) is that every request-reachable helper
 * runs under a **user-scoped** Supabase client (`createUserScopedClient()`), so
 * RLS applies. But we must NOT flip any route yet (that is Tasks 10–13), and the
 * app must behave EXACTLY as before while `AUTH_SUPABASE_CUTOVER_ENABLED` is
 * false.
 *
 * To bridge those two facts, each helper now takes an **optional injected
 * client** as a trailing parameter:
 *
 *   - When a caller passes a client (converted/new callers, Tasks 10–13), the
 *     helper uses that injected client — no service-role import on that path.
 *   - When a caller omits it (every current route handler, unchanged), the
 *     helper falls back to the legacy service-role client via `resolveDbClient`.
 *     This preserves identical pre-cutover behavior with zero route changes.
 *
 * `resolveDbClient()` is the SINGLE place the legacy fallback import is wired.
 * Request-reachable helpers no longer `import { createServerSupabaseClient }`
 * directly; they call `resolveDbClient(injected)` instead. That keeps the
 * injected path free of any static dependency on the service-role factory while
 * still giving current callers the exact same client they used to construct
 * inline.
 *
 * NOTE (Task 14 hardening): the fallback now uses the LEGACY service-role
 * bridge `createServerSupabaseClient` from `@/src/lib/supabase/legacy-service-role`.
 * That bridge is a thin wrapper over the guarded `createServiceRoleClient`
 * factory, so the privilege is conspicuous and visible to the runtime guard,
 * the ESLint rule, and the blocking CI check. This module (`src/lib/db/client.ts`)
 * is therefore on the service-role allowlist (group (d), pre-cutover residual).
 * The legacy bridge is the behavior-neutral path for the pre-cutover window; it
 * is removed when routes are fully converted and the flag is flipped (Task 17),
 * at which point this fallback collapses to always using the user-scoped client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/src/lib/supabase/legacy-service-role";

/**
 * The Supabase client surface the DB helpers use.
 *
 * Both the legacy service-role client (`@supabase/supabase-js` `createClient`)
 * and the user-scoped SSR server client (`@supabase/ssr` `createServerClient`)
 * are `SupabaseClient` instances, so this is exactly the shape every helper
 * already consumed. Using the real type (rather than a hand-rolled structural
 * stub) preserves the query-builder/storage generics the helpers depend on, so
 * the refactor stays behavior- AND type-neutral.
 */
export type DbClient = SupabaseClient;

/**
 * Resolve the Supabase client a DB helper should use.
 *
 * @param injected - A caller-supplied client (user-scoped, post-conversion). If
 *   provided, it is returned verbatim and NO service-role client is constructed.
 * @returns the injected client, or — when omitted — the legacy service-role
 *   client, preserving pre-cutover behavior for unconverted callers.
 */
export function resolveDbClient(injected?: DbClient): DbClient {
  if (injected) return injected;
  return createServerSupabaseClient();
}
