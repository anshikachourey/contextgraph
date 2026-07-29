/**
 * Server-only session management for the two-workspace login system.
 *
 * Issues and validates signed HTTP-only cookies containing workspace identity.
 * Never import this file from client components.
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
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
