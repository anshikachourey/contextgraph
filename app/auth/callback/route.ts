import { NextRequest, NextResponse } from "next/server";
import { createUserScopedClient } from "@/src/lib/supabase/server";
import { ensureProvisioned } from "@/src/lib/auth/authorization";

/**
 * GET /auth/callback — OAuth authorization-code exchange (Task 8.1).
 *
 * Feature: google-oauth-authentication
 *
 * Google redirects here with `?code=...`. We exchange the code for a Supabase
 * session through the USER-SCOPED SSR server client — Supabase issues and
 * manages the tokens and writes the auth cookies through the SSR cookie handler
 * (Req 2.1, 2.2). On success we run the provisioning gate (profile + personal
 * workspace + membership must exist before any usable access, Req 6.4) and
 * redirect into the app. On failure we redirect to `/login?error=auth` with a
 * GENERIC message and grant NO access (Req 2.4, 20.5).
 *
 * This route mints no JWT, verifies no Google ID token, and derives identity
 * ONLY from the exchanged code — never from other browser-supplied params
 * (Req 2.3).
 *
 * MIDDLEWARE: this route sits under the `/auth/*` bypass in both the legacy and
 * Supabase middleware paths, so it runs without a prior session. While
 * `AUTH_SUPABASE_CUTOVER_ENABLED` is false the route is only ever exercised by
 * the Supabase OAuth flow (which is not enabled), so it does not interfere with
 * the legacy credential login.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 20.4, 20.5
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  // The post-login destination. Only accept a safe, same-origin relative path;
  // anything else falls back to the app root to avoid an open redirect.
  const next = safeNext(url.searchParams.get("next"));

  const loginError = () =>
    NextResponse.redirect(new URL("/login?error=auth", request.url));

  // No code → cannot derive identity. Reject (Req 2.3, 2.4).
  if (!code) {
    return loginError();
  }

  const supabase = await createUserScopedClient();

  // Exchange the code for a session via the SSR client (Req 2.1). Supabase owns
  // token issuance and cookie writes.
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // Generic auth error, no access (Req 2.4).
    return loginError();
  }

  // Provisioning gate — deny access until all three records are committed
  // (Req 6.4). Runs under the user-scoped client bound to auth.uid(); never
  // service-role.
  const provisioningError = await ensureProvisioned();
  if (provisioningError !== null) {
    return loginError();
  }

  return NextResponse.redirect(new URL(next, request.url));
}

/**
 * Only allow a same-origin, root-relative path as the post-auth destination.
 * Prevents an attacker-supplied `?next=` from redirecting off-site.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}
