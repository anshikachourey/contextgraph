/**
 * Server-only session management.
 *
 * This module hosts BOTH session mechanisms during the cutover window:
 *
 *   1. The LEGACY owner/demo HMAC `cg_session` cookie (create/get/destroy).
 *      Active while `AUTH_SUPABASE_CUTOVER_ENABLED` is false — the legacy login
 *      still runs. Per the cutover guardrail, actual REMOVAL of the HMAC path is
 *      deferred to Task 17 (the strict last step); see TODO(cutover) below.
 *
 *   2. The NEW Supabase identity resolver `getAuthClaims(client)` — identity
 *      ONLY, via Supabase `getClaims()`. No manual Google ID-token / self-JWT
 *      verification, no cache, no PG pool (Req 4, 5). This is what the converted
 *      request paths use once the flag is flipped.
 *
 * The two paths are selected by the cutover flag so runtime behavior is
 * unchanged while the flag is false. Never import this file from client
 * components.
 */

import { cookies } from "next/headers";
import { NextRequest } from "next/server";

export type Workspace = "owner" | "demo";

export type SessionPayload = {
  workspace: Workspace;
  iat: number; // issued-at (Unix seconds)
  exp: number; // expiry (Unix seconds)
};

const COOKIE_NAME = "cg_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 24; // 24 hours

// ─── Secret management ────────────────────────────────────────────────────────

function getSecret(): string {
  const secret = process.env.TEMP_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "TEMP_SESSION_SECRET is missing or too weak (must be at least 32 characters).",
    );
  }
  return secret;
}

// ─── HMAC-based signing (no external JWT library needed) ──────────────────────

async function sign(payload: SessionPayload): Promise<string> {
  const secret = getSecret();
  const encoder = new TextEncoder();
  const data = JSON.stringify(payload);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Format: base64(payload).signature
  const payloadB64 = btoa(data);
  return `${payloadB64}.${sigHex}`;
}

async function verify(token: string): Promise<SessionPayload | null> {
  const secret = getSecret();
  const encoder = new TextEncoder();

  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const payloadB64 = token.slice(0, dotIndex);
  const sigHex = token.slice(dotIndex + 1);

  let data: string;
  try {
    data = atob(payloadB64);
  } catch {
    return null;
  }

  // Verify HMAC
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const sigBytes = new Uint8Array(
    (sigHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)),
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    encoder.encode(data),
  );

  if (!valid) return null;

  // Parse and validate expiry
  let payload: SessionPayload;
  try {
    payload = JSON.parse(data) as SessionPayload;
  } catch {
    return null;
  }

  if (!payload.workspace || !payload.exp || !payload.iat) return null;
  if (payload.workspace !== "owner" && payload.workspace !== "demo") return null;

  const now = Math.floor(Date.now() / 1000);
  if (now > payload.exp) return null;

  return payload;
}

// ─── Cookie operations ────────────────────────────────────────────────────────

/**
 * Create a session cookie for the given workspace.
 * Call this after successful credential validation.
 */
export async function createSession(workspace: Workspace): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    workspace,
    iat: now,
    exp: now + SESSION_DURATION_SECONDS,
  };

  const token = await sign(payload);
  const isProduction = process.env.NODE_ENV === "production";

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
}

/**
 * Read and validate the current session from cookies.
 * Returns null if no valid session exists.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verify(token);
}

/**
 * Read and validate session from a NextRequest (for middleware use).
 * Does not use the cookies() API since middleware runs outside React context.
 */
export async function getSessionFromRequest(
  request: NextRequest,
): Promise<SessionPayload | null> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verify(token);
}

/**
 * Destroy the session by clearing the cookie.
 *
 * TODO(cutover, Task 17): the legacy HMAC `cg_session` create/get/destroy path
 * above is removed as the strict last step of the cutover, together with the
 * `TEMP_OWNER_*`/`TEMP_DEMO_*` credential login. It is retained UNCHANGED here
 * for now because the legacy login still runs while
 * `AUTH_SUPABASE_CUTOVER_ENABLED` is false. The design says "remove the HMAC";
 * that removal is intentionally deferred so there is no behavior change today.
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

// ─── Supabase identity resolver (Req 4, 5) ────────────────────────────────────

/**
 * The canonical authenticated identity derived from Supabase verified claims.
 * `userId` is `claims.sub` = the Supabase_User_Id (`auth.users.id`), NEVER the
 * Google provider subject.
 */
export type AuthClaims = { userId: string; email?: string };

/**
 * Minimal structural type for the Supabase client surface this resolver needs.
 * Both the user-scoped SSR client and the middleware client expose
 * `auth.getClaims()`.
 */
export type ClaimsCapableClient = {
  auth: {
    getClaims: () => Promise<{
      data?: { claims?: { sub?: string; email?: string } | null } | null;
      error?: unknown;
    }>;
  };
};

/**
 * Resolve the authenticated identity from Supabase verified claims — identity
 * ONLY. Used by middleware and route handlers once the cutover flag is enabled.
 *
 * - Canonical identity is `claims.sub` = Supabase_User_Id (Req 4.2). The Google
 *   provider subject is never used (Req 4.3).
 * - Performs NO manual Google ID-token verification and NO self-minted JWT
 *   validation (Req 4.5) — it trusts Supabase's `getClaims()` exclusively.
 * - Resolves context through Supabase only — no cache, no PG pool (Req 5).
 *
 * Returns `null` when there is no valid session / no `sub` claim (Req 4.4).
 */
export async function getAuthClaims(
  client: ClaimsCapableClient,
): Promise<AuthClaims | null> {
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return { userId: data.claims.sub, email: data.claims.email };
}
