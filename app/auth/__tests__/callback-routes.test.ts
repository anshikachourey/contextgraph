// Feature: google-oauth-authentication — callback routes (Task 8.5)
//
// Validates: Requirements 2.1, 2.3, 2.4, 14.1, 14.4, 17.1, 17.3, 17.4, 20.5
//
// Example/integration tests for /auth/callback and /auth/confirm with a MOCKED
// Supabase user-scoped client and a mocked provisioning gate. We assert:
//   - callback: success (exchange + provisioning → redirect into app),
//     exchange failure → /login?error=auth, missing code → /login?error=auth,
//     and that identity is derived ONLY from the code (exchange is called with
//     exactly the code).
//   - confirm: signup valid → app; recovery valid → /reset-password; invalid/
//     expired/used token → generic error, no app access.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();
const ensureProvisioned = vi.fn();

vi.mock("@/src/lib/supabase/server", () => ({
  createUserScopedClient: async () => ({
    auth: { exchangeCodeForSession, verifyOtp },
  }),
}));

vi.mock("@/src/lib/auth/authorization", () => ({
  ensureProvisioned: () => ensureProvisioned(),
}));

import { GET as callbackGET } from "../callback/route";
import { GET as confirmGET } from "../confirm/route";
import { NextRequest } from "next/server";

function req(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

function locationOf(res: Response): string {
  return res.headers.get("location") ?? "";
}

beforeEach(() => {
  exchangeCodeForSession.mockReset();
  verifyOtp.mockReset();
  ensureProvisioned.mockReset();
  ensureProvisioned.mockResolvedValue(null); // provisioned by default
});

describe("/auth/callback (OAuth code exchange)", () => {
  it("exchanges the code and redirects into the app on success", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await callbackGET(req("https://app.test/auth/callback?code=abc123"));

    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123");
    expect(res.status).toBe(307);
    expect(locationOf(res)).toBe("https://app.test/");
  });

  it("rejects to /login?error=auth when the exchange fails, granting no access", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });
    const res = await callbackGET(req("https://app.test/auth/callback?code=bad"));

    expect(locationOf(res)).toContain("/login?error=auth");
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it("rejects when no code is present (identity only from the code, Req 2.3)", async () => {
    const res = await callbackGET(req("https://app.test/auth/callback"));
    expect(locationOf(res)).toContain("/login?error=auth");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("denies access when provisioning is incomplete", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    ensureProvisioned.mockResolvedValue(new Response(null)); // non-null = denial
    const res = await callbackGET(req("https://app.test/auth/callback?code=ok"));
    expect(locationOf(res)).toContain("/login?error=auth");
  });

  it("honors a safe same-origin ?next and ignores an off-site one", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const safe = await callbackGET(
      req("https://app.test/auth/callback?code=ok&next=/graph-dashboard"),
    );
    expect(locationOf(safe)).toBe("https://app.test/graph-dashboard");

    const unsafe = await callbackGET(
      req("https://app.test/auth/callback?code=ok&next=https://evil.test"),
    );
    expect(locationOf(unsafe)).toBe("https://app.test/");
  });
});

describe("/auth/confirm (email confirmation + recovery)", () => {
  it("verifies a signup token and redirects into the app", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await confirmGET(
      req("https://app.test/auth/confirm?token_hash=h1&type=signup"),
    );
    expect(verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "h1" });
    expect(locationOf(res)).toBe("https://app.test/");
  });

  it("verifies a recovery token and redirects to /reset-password", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await confirmGET(
      req("https://app.test/auth/confirm?token_hash=h2&type=recovery"),
    );
    expect(verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "h2" });
    expect(locationOf(res)).toBe("https://app.test/reset-password");
    // No provisioning on recovery.
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it("rejects an invalid/expired/used signup token to the error screen", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "token expired" } });
    const res = await confirmGET(
      req("https://app.test/auth/confirm?token_hash=old&type=signup"),
    );
    expect(locationOf(res)).toContain("/verify-email?status=error");
  });

  it("rejects an invalid recovery token to a generic recovery error, no session", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "used" } });
    const res = await confirmGET(
      req("https://app.test/auth/confirm?token_hash=used&type=recovery"),
    );
    expect(locationOf(res)).toContain("/reset-password?error=recovery");
  });

  it("rejects when the callback params are missing", async () => {
    const res = await confirmGET(req("https://app.test/auth/confirm"));
    expect(locationOf(res)).toContain("/verify-email?status=error");
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});
