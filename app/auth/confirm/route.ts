import { NextRequest, NextResponse } from "next/server";
import { createUserScopedClient } from "@/src/lib/supabase/server";
import { ensureProvisioned } from "@/src/lib/auth/authorization";

/**
 * GET /auth/confirm — email confirmation + password-recovery callback (Task 8.2).
 *
 * Feature: google-oauth-authentication
 *
 * Supabase sends verification / recovery links that land here carrying a
 * `token_hash` and a `type`. We complete the exchange SERVER-SIDE via
 * `verifyOtp({ type, token_hash })` through the SSR client (Req 14.1, 17.1,
 * 20.5). Supabase issues, validates, expires, and single-uses the token — we
 * implement no custom token logic (Req 14.5, 17.5).
 *
 *   - `type=signup` (or `email`): on success, run the provisioning gate and
 *     redirect into the app (Req 14.1–14.3, 6.4).
 *   - `type=recovery`: on success a Recovery_Session is established; redirect to
 *     `/reset-password` so the user can set a new password (Req 17.1, 17.2).
 *   - invalid / expired / already-used token: reject with a GENERIC error, no
 *     access, no session established (Req 14.4, 17.3, 17.4).
 *
 * MIDDLEWARE: under the `/auth/*` bypass; runs without a prior session. Only
 * exercised by the Supabase email flow, so it does not affect legacy login
 * while the cutover flag is false.
 *
 * Requirements: 14.1, 14.2, 14.4, 17.1, 17.3, 17.4, 20.3, 20.4, 20.5
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const next = safeNext(url.searchParams.get("next"));

  const isRecovery = type === "recovery";

  // On failure: recovery failures surface on the reset screen; verification
  // failures surface on the dedicated verification result screen. Both are
  // generic (do not reveal token state) and grant no access (Req 14.4, 17.4).
  const failure = () =>
    isRecovery
      ? NextResponse.redirect(new URL("/reset-password?error=recovery", request.url))
      : NextResponse.redirect(new URL("/verify-email?status=error", request.url));

  // Missing/garbled callback params → reject, no session (Req 14.4, 17.4).
  if (!tokenHash || !type || !isSupportedOtpType(type)) {
    return failure();
  }

  const supabase = await createUserScopedClient();

  const { error } = await supabase.auth.verifyOtp({
    type,
    token_hash: tokenHash,
  });

  // Invalid / expired / already-used token → generic error, no access/session
  // (Req 14.4, 17.3, 17.4).
  if (error) {
    return failure();
  }

  if (isRecovery) {
    // Recovery_Session established — allow the user to set a new password
    // (Req 17.1, 17.2). No provisioning gate here; the user is recovering an
    // existing account.
    return NextResponse.redirect(new URL("/reset-password", request.url));
  }

  // Signup / email confirmation succeeded — gate on provisioning before access
  // (Req 14.1–14.3, 6.4).
  const provisioningError = await ensureProvisioned();
  if (provisioningError !== null) {
    return NextResponse.redirect(new URL("/verify-email?status=error", request.url));
  }

  return NextResponse.redirect(new URL(next, request.url));
}

/**
 * The Supabase email OTP types this callback accepts. `signup`/`email` complete
 * verification; `recovery` establishes a Recovery_Session; `invite`/`email_change`
 * are included for completeness as they share the same `token_hash` exchange.
 */
const SUPPORTED_OTP_TYPES = new Set([
  "signup",
  "email",
  "recovery",
  "invite",
  "email_change",
]);

function isSupportedOtpType(
  type: string,
): type is "signup" | "email" | "recovery" | "invite" | "email_change" {
  return SUPPORTED_OTP_TYPES.has(type);
}

function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}
