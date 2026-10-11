import { createServerClient } from "@supabase/ssr";

/**
 * USER-SCOPED server Supabase client (anon key, RLS applies).
 *
 * Feature: google-oauth-authentication (Task 1.2 → hardened in Task 14)
 *
 * ── CLEAN MODULE SEPARATION (Task 14, hardening item 1) ─────────────────────
 *
 * This module now exports EXACTLY ONE thing: `createUserScopedClient()`. It is
 * the obvious, safe server import. It uses the ANON key and the `@supabase/ssr`
 * cookie handler, so it runs *as the authenticated user* and Row Level Security
 * applies.
 *
 * The legacy service-role factory (`createServerSupabaseClient`) NO LONGER lives
 * here. During earlier scaffolding this module was a "mixed module" that
 * exported both the user-scoped client AND an inline service-role construction
 * (`createClient(url, SUPABASE_SERVICE_ROLE_KEY)`). That inline construction
 * bypassed the guarded `./service-role` factory entirely, so the blocking CI
 * import check — which only watched `supabase/service-role` — could never see
 * the legacy importers. That defeated the whole point of the check.
 *
 * The service-role construction now lives ONLY in `./service-role` (guarded,
 * allowlisted) and its thin pre-cutover bridge `./legacy-service-role` (also
 * allowlisted). Both are watched by the tightened CI check and the ESLint
 * `no-restricted-imports` rule. `src/lib/supabase/server.ts` is therefore a
 * pure user-scoped module with no path to the service role key.
 *
 * Requirements: 10.1, 10.3, 10.5, 12.1, 12.3
 */

/**
 * USER-SCOPED server client (anon key, RLS applies).
 *
 * Reads/writes Supabase auth cookies exclusively through the `@supabase/ssr`
 * cookie-handler interface bound to `next/headers` `cookies()`. Cookie writes
 * are tolerated-but-ignored when invoked from a Server Component (middleware
 * already refreshed them); writes that matter happen in route handlers / server
 * actions where setting cookies is allowed.
 *
 * Requirements: 10.1, 12.3
 */
export async function createUserScopedClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.",
    );
  }

  // Dynamically import `next/headers` so this module stays client-safe.
  // `cookies()` is only pulled in when a server path actually calls this fn.
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component where cookies cannot be set.
          // The middleware SSR client already refreshed the auth cookies.
        }
      },
    },
  });
}
