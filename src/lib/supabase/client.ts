import { createClient } from "@supabase/supabase-js";

// Browser-side client — uses the anon key, subject to Row Level Security.
// Safe to use in client components.
let client: ReturnType<typeof createClient> | null = null;

export function createBrowserSupabaseClient() {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.",
    );
  }

  client = createClient(url, anonKey);
  return client;
}
