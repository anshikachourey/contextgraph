import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client factory (SSR-aware).
 *
 * Feature: google-oauth-authentication (Task 1.2)
 *
 * Used by client components / Auth_Screens to call `signInWithOAuth`,
 * `signInWithPassword`, `signUp`, `resetPasswordForEmail`, `updateUser`, and
 * `signOut`. Built on `@supabase/ssr`'s `createBrowserClient` so it shares the
 * same cookie storage the server client reads, using the ANON key (RLS applies).
 *
 * This is additive scaffolding. The pre-existing plain `supabase-js` browser
 * client in `./client` is left untouched so current behavior is unchanged while
 * `AUTH_SUPABASE_CUTOVER_ENABLED` is false.
 *
 * Requirements: 10.1, 12.3
 */
export function createBrowserSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.",
    );
  }

  return createBrowserClient(url, anonKey);
}
