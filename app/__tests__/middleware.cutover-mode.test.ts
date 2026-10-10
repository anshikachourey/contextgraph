/**
 * MIDDLEWARE CUTOVER-MODE PROOFS (Task 17 hardening — proofs (c) and (d)).
 *
 * Feature: google-oauth-authentication
 *
 * Runs the middleware with `AUTH_SUPABASE_CUTOVER_ENABLED` TRUE and an
 * UNAUTHENTICATED session (the SSR client reports no claims), proving:
 *   (c) an unauthenticated API request → 401 + Cache-Control: no-store, and
 *   (d) an unauthenticated page request → redirect to /login.
 *
 * The flag is forced true via a mock so the proof holds under a normal
 * `vitest run` and under `test:cutover` (where the real env agrees). This file
 * is isolated from the route cross-workspace proofs because here getAuthClaims
 * must resolve to NULL (no session), whereas those need a valid user.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Force cutover mode TRUE so middleware() selects supabaseMiddleware().
vi.mock("@/src/lib/config/cutover", () => ({
  isSupabaseCutoverEnabled: () => true,
  AUTH_SUPABASE_CUTOVER_ENABLED: true,
}));

// SSR client that reports NO claims (unauthenticated).
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: vi.fn(async () => ({ data: null, error: null })) },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }),
}));

// Ensure the env mirrors the mock when run under `test:cutover` as well.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

beforeEach(() => vi.clearAllMocks());

describe("middleware cutover mode — unauthenticated gating", () => {
  it("(c) unauthenticated API request → 401 + Cache-Control: no-store", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(new NextRequest(new URL("http://t/api/conversations")));
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Authentication required." });
  });

  it("(d) unauthenticated page request → redirect to /login", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(new NextRequest(new URL("http://t/graph-dashboard")));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/login$/);
  });

  it("auth routes and /login are allowed without a session", async () => {
    const { middleware } = await import("@/middleware");
    const login = await middleware(new NextRequest(new URL("http://t/login")));
    expect(login.status).toBe(200);
    const authApi = await middleware(new NextRequest(new URL("http://t/api/auth/login")));
    expect(authApi.status).toBe(200);
  });
});
