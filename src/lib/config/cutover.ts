/**
 * Server-only typed accessor for the Supabase Auth cutover feature flag.
 *
 * Feature: google-oauth-authentication (Task 1.1)
 *
 * `AUTH_SUPABASE_CUTOVER_ENABLED` gates enabling production Supabase Auth and
 * real multi-user sessions. While it is `false` (the default), ContextGraph
 * continues to run on the legacy owner/demo HMAC session and the service-role
 * client; real Supabase sign-in sessions are NOT accepted for ordinary access.
 * The flip to `true` is the strict last step of the cutover and is performed
 * only after the full enable checklist is green (see the design's Cutover gate).
 *
 * This is a SERVER-SIDE env var (NOT prefixed with `NEXT_PUBLIC_`), so it is
 * never exposed to the browser bundle. Reading it from a client component will
 * always yield the disabled default.
 *
 * Requirements: 5.1, 5.2, 5.3
 */

/**
 * Returns whether the Supabase Auth cutover is enabled.
 *
 * Default: `false`. Only the exact string `"true"` (case-insensitive, trimmed)
 * enables the flag; any other value — including unset — keeps it disabled. This
 * fail-closed parsing ensures a typo never silently enables the cutover.
 */
export function isSupabaseCutoverEnabled(): boolean {
  const raw = process.env.AUTH_SUPABASE_CUTOVER_ENABLED;
  if (typeof raw !== "string") return false;
  return raw.trim().toLowerCase() === "true";
}

/**
 * Convenience constant snapshot of {@link isSupabaseCutoverEnabled} evaluated at
 * module load. Prefer the function in long-lived server processes where the env
 * could theoretically change; this constant is handy for simple gate checks.
 */
export const AUTH_SUPABASE_CUTOVER_ENABLED = isSupabaseCutoverEnabled();
