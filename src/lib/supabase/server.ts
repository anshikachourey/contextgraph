import { createClient } from "@supabase/supabase-js";

// Server-side client — uses the service role key to bypass RLS.
// Only import this in API routes, never in client components.
// The service role key must NEVER be prefixed with NEXT_PUBLIC_.
export function createServerSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }

  return createClient(url, key);
}
