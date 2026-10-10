/**
 * Supabase-delegated auth action handlers (Task 8.3).
 *
 * Feature: google-oauth-authentication
 *
 * These are the thin wrappers the Auth_Screens call. Every one of them
 * DELEGATES entirely to Supabase Auth — ContextGraph never stores, hashes, or
 * validates a password, never mints a JWT, and never touches auth cookies
 * outside the SSR cookie handler (Req 12.4, 12.5).
 *
 * The OAuth/email/password initiators run in the browser against the SSR
 * browser client (`createBrowserSupabaseClient`) so Supabase owns the PKCE
 * verifier/challenge/state and writes cookies through the shared SSR storage.
 * `signOut` additionally has a server-side confirmation path (see
 * `app/api/auth/supabase-logout/route.ts`) that reports logout as incomplete
 * until the server confirms the session is invalidated (Req 19.3).
 *
 * REDACTION: no handler returns, logs, or otherwise surfaces a password or any
 * Supabase token. Results are shaped as `{ ok, error? }` with only generic,
 * non-enumerating messages where the requirements demand it (Req 15.3, 16.2/3).
 *
 * These wrappers accept the Supabase client as a parameter so they stay pure,
 * testable, and unaware of whether they run in the browser or a server action.
 */

/**
 * The minimal Supabase auth surface these handlers depend on.
 *
 * Parameters are intentionally `any` (not `unknown`): because function
 * parameters are contravariant, the concrete `@supabase/supabase-js`
 * `SupabaseClient` — whose methods take specific credential types — must remain
 * assignable to this structural type. We only ever CALL these methods with
 * well-formed arguments from within this module, so the looseness is contained.
 * Return values keep their narrow shapes so callers stay type-safe.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AuthActionClient = {
  auth: {
    signInWithOAuth: (args: any) => Promise<{ data?: unknown; error: unknown }>;
    signUp: (args: any) => Promise<{
      data: { user?: unknown | null; session?: unknown | null } | null;
      error: unknown;
    }>;
    signInWithPassword: (args: any) => Promise<{ data?: unknown; error: unknown }>;
    resetPasswordForEmail: (
      email: string,
      options?: any,
    ) => Promise<{ data?: unknown; error: unknown }>;
    updateUser: (args: any) => Promise<{ data?: unknown; error: unknown }>;
    signOut: (...args: any[]) => Promise<{ error: unknown }>;
    getClaims: (...args: any[]) => Promise<{
      data: { claims?: { sub?: string } | null } | null;
      error: unknown;
    }>;
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Generic result shape — never carries a token or password. */
export type ActionResult = { ok: boolean; error?: string };

/**
 * Where callbacks live. The redirect targets are RELATIVE paths; the browser
 * client resolves them against the current origin, and the server callback
 * routes complete the exchange via the SSR client.
 */
export const CALLBACK_OAUTH = "/auth/callback";
export const CALLBACK_CONFIRM = "/auth/confirm";
export const CALLBACK_RECOVERY = "/auth/confirm?type=recovery";

const GENERIC_AUTH_ERROR =
  "We couldn't sign you in. Check your details and try again.";

/** Resolve an absolute redirect URL when running in the browser. */
function absolute(path: string): string {
  if (typeof window !== "undefined") {
    return new URL(path, window.location.origin).toString();
  }
  return path;
}

/**
 * Google sign-in (Req 1.1–1.4). Supabase owns the PKCE verifier/challenge and
 * the OAuth state; ContextGraph only names the provider and the redirect
 * target. The browser is redirected to Google by the Supabase client, so a
 * success path returns `{ ok: true }` just before navigation.
 */
export async function startGoogleSignIn(
  client: AuthActionClient,
): Promise<ActionResult> {
  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: absolute(CALLBACK_OAUTH),
      // Supabase generates & manages the PKCE verifier/challenge/state (Req 1.2/1.3).
      flowType: "pkce",
    },
  });
  if (error) return { ok: false, error: GENERIC_AUTH_ERROR };
  return { ok: true };
}

/**
 * Email/password signup (Req 13, 14.3, 14.6). Supabase stores/hashes the
 * password and sends the verification email to `emailRedirectTo` → /auth/confirm.
 *
 * Req 14.6: if signup succeeds but the verification email fails to send, detect
 * and surface it. Supabase surfaces a send failure as an error on an otherwise
 * created user; we treat "no identities / no session and an error-shaped send
 * failure" as a surfaced failure the caller can show or retry.
 */
export async function signUpWithEmail(
  client: AuthActionClient,
  email: string,
  password: string,
): Promise<ActionResult & { needsVerification?: boolean }> {
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: absolute(CALLBACK_CONFIRM) },
  });

  // Req 13.4: signUp failure → reject, no access.
  if (error) {
    return { ok: false, error: describeSendFailure(error) };
  }

  // Supabase convention: a successful signUp that requires confirmation returns
  // a user with no session. If the verification email send failed, Supabase
  // reports it as an error (handled above). A created user with no session means
  // "check your email to verify" (Req 14.3).
  const session = data?.session ?? null;
  const user = data?.user ?? null;
  if (user && !session) {
    return { ok: true, needsVerification: true };
  }

  // User + session (confirmation disabled in the project) — provisioning gate
  // runs on the next authenticated request.
  return { ok: true, needsVerification: false };
}

/**
 * Email/password login (Req 15). On rejection, return a GENERIC error that does
 * not reveal whether the email or the password was wrong (Req 15.3).
 */
export async function signInWithEmail(
  client: AuthActionClient,
  email: string,
  password: string,
): Promise<ActionResult> {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: GENERIC_AUTH_ERROR };
  return { ok: true };
}

/**
 * Forgot password (Req 16). The response is INDISTINGUISHABLE with respect to
 * account existence: whether or not an account exists — and even if Supabase
 * returns an error — we return the exact same non-committal success result so a
 * caller cannot enumerate accounts (Req 16.2, 16.3). Supabase owns generation,
 * send, and expiry of the reset token (Req 16.4).
 */
export async function requestPasswordReset(
  client: AuthActionClient,
  email: string,
): Promise<ActionResult> {
  // Fire-and-forget with respect to the OUTCOME: we deliberately ignore the
  // error so the response cannot reveal account existence.
  await client.auth.resetPasswordForEmail(email, {
    redirectTo: absolute(CALLBACK_RECOVERY),
  });
  return { ok: true };
}

/**
 * Set or change the password for the current (or recovery) session (Req 17.2,
 * 18). The caller decides the label ("Set Password" vs "Change Password") via
 * {@link passwordActionLabel}; the underlying Supabase call is identical.
 * On failure, report an error and DO NOT change credential state (Req 18.4).
 */
export async function updatePassword(
  client: AuthActionClient,
  newPassword: string,
): Promise<ActionResult> {
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) {
    return { ok: false, error: "We couldn't update your password. Please try again." };
  }
  return { ok: true };
}

/**
 * Change-vs-set branch (Req 18.1/18.2). A Google user with no password set sees
 * "Set Password"; everyone else sees "Change Password". `hasPassword` reflects
 * whether the account already has a password credential.
 */
export function passwordActionLabel(hasPassword: boolean): "Set Password" | "Change Password" {
  return hasPassword ? "Change Password" : "Set Password";
}

/**
 * Logout (Req 19). Calls `signOut()` (cookies cleared via the SSR handler), then
 * CONFIRMS no valid session remains via `getClaims()`. Logout is reported as
 * incomplete until invalidation is confirmed (Req 19.3) so a subsequent request
 * presenting the cleared session is treated as unauthenticated.
 */
export async function signOutAndConfirm(
  client: AuthActionClient,
): Promise<ActionResult> {
  const { error } = await client.auth.signOut();
  if (error) {
    return { ok: false, error: "Logout failed. Please try again." };
  }

  // Confirm server-held session state is invalidated (Req 19.3). If claims still
  // resolve to a subject, report incomplete rather than success.
  const { data } = await client.auth.getClaims();
  if (data?.claims?.sub) {
    return { ok: false, error: "Logout incomplete. Please try again." };
  }
  return { ok: true };
}

/**
 * Map a signUp error to a user-facing message, detecting the verification-email
 * send failure specifically (Req 14.6) so the UI can surface or offer a retry,
 * while never leaking token/credential detail.
 */
function describeSendFailure(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  if (/email|send|smtp|confirmation/i.test(message)) {
    return "We couldn't send your verification email. Please try again.";
  }
  return "We couldn't create your account. Please try again.";
}
