import { NextResponse } from "next/server";
import { createUserScopedClient } from "@/src/lib/supabase/server";
import { signOutAndConfirm } from "@/src/lib/auth/actions";

/**
 * POST /api/auth/supabase-logout — server-side Supabase sign-out (Task 8.3).
 *
 * Feature: google-oauth-authentication
 *
 * Calls `signOut()` through the USER-SCOPED SSR client (cookies cleared only via
 * the SSR cookie handler, Req 19.2/19.4), then CONFIRMS no valid session remains
 * via `getClaims()`. Logout is reported as failed/incomplete until the server
 * confirms the session is invalidated (Req 19.3), so a subsequent request
 * presenting the cleared session is treated as unauthenticated.
 *
 * This is ADDITIVE and lives under the `/api/auth` bypass. The legacy
 * `/api/auth/logout` (HMAC `cg_session`) is untouched; while
 * `AUTH_SUPABASE_CUTOVER_ENABLED` is false the legacy logout remains the active
 * path and this route simply no-ops on sessions that do not exist.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4
 */
export async function POST(): Promise<NextResponse<{ ok: boolean; error?: string }>> {
  const supabase = await createUserScopedClient();
  const result = await signOutAndConfirm(supabase);

  return NextResponse.json(result, {
    status: result.ok ? 200 : 500,
    headers: { "Cache-Control": "no-store" },
  });
}
