// Feature: google-oauth-authentication — auth action handlers (Task 8.5)
//
// Validates: Requirements 2.4, 12.2, 12.5, 13.4, 14.6, 15.3, 16.2, 16.3,
//            17.2, 18.1, 18.2, 18.4, 19.3
//
// Example/integration tests against a MOCKED Supabase client. We assert the
// exact Supabase call shapes (google/pkce/redirectTo, signUp, signInWithPassword
// generic error, resetPasswordForEmail non-enumerating response, updateUser
// change-vs-set + failure, signOut success + invalidation confirmation) and that
// no password/token leaks into any returned payload (redaction).

import { describe, it, expect, vi } from "vitest";
import {
  startGoogleSignIn,
  signUpWithEmail,
  signInWithEmail,
  requestPasswordReset,
  updatePassword,
  passwordActionLabel,
  signOutAndConfirm,
  type AuthActionClient,
} from "../actions";

/** Build a mock client; override individual auth methods per test. */
function mockClient(overrides: Partial<AuthActionClient["auth"]> = {}): {
  client: AuthActionClient;
  auth: Record<string, ReturnType<typeof vi.fn>>;
} {
  const auth = {
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
    signUp: vi.fn(async () => ({ data: { user: { id: "u1" }, session: null }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
    updateUser: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    getClaims: vi.fn(async () => ({ data: { claims: null }, error: null })),
    ...overrides,
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return { client: { auth } as unknown as AuthActionClient, auth };
}

/** Deep-scan any value for a forbidden substring (token/password leakage). */
function containsSubstring(value: unknown, needle: string): boolean {
  return JSON.stringify(value ?? "").toLowerCase().includes(needle.toLowerCase());
}

describe("startGoogleSignIn — google/pkce/redirectTo call shape (Req 1.x)", () => {
  it("calls signInWithOAuth with provider google, pkce flow, and the callback redirect", async () => {
    const { client, auth } = mockClient();
    const result = await startGoogleSignIn(client);

    expect(result.ok).toBe(true);
    expect(auth.signInWithOAuth).toHaveBeenCalledTimes(1);
    const arg = auth.signInWithOAuth.mock.calls[0][0];
    expect(arg.provider).toBe("google");
    expect(arg.options.flowType).toBe("pkce");
    expect(String(arg.options.redirectTo)).toContain("/auth/callback");
  });

  it("returns a generic error on failure and leaks nothing", async () => {
    const { client } = mockClient({
      signInWithOAuth: vi.fn(async () => ({ data: null, error: { message: "boom" } })),
    });
    const result = await startGoogleSignIn(client);
    expect(result.ok).toBe(false);
    expect(containsSubstring(result, "boom")).toBe(false);
  });
});

describe("signUpWithEmail (Req 13, 14.3, 14.6)", () => {
  it("calls signUp with emailRedirectTo=/auth/confirm and flags verification needed", async () => {
    const { client, auth } = mockClient();
    const result = await signUpWithEmail(client, "a@b.com", "sekret-pw");

    expect(result.ok).toBe(true);
    expect(result.needsVerification).toBe(true);
    const arg = auth.signUp.mock.calls[0][0];
    expect(arg.email).toBe("a@b.com");
    expect(arg.password).toBe("sekret-pw"); // passed through to Supabase only
    expect(String(arg.options.emailRedirectTo)).toContain("/auth/confirm");
  });

  it("rejects on signUp failure without granting access (Req 13.4)", async () => {
    const { client } = mockClient({
      signUp: vi.fn(async () => ({ data: null, error: { message: "already registered" } })),
    });
    const result = await signUpWithEmail(client, "a@b.com", "sekret-pw");
    expect(result.ok).toBe(false);
  });

  it("surfaces a failed verification-email send specifically (Req 14.6)", async () => {
    const { client } = mockClient({
      signUp: vi.fn(async () => ({
        data: null,
        error: { message: "Error sending confirmation email" },
      })),
    });
    const result = await signUpWithEmail(client, "a@b.com", "sekret-pw");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verification email/i);
  });

  it("never leaks the password in the returned payload (Req 12.5)", async () => {
    const { client } = mockClient();
    const result = await signUpWithEmail(client, "a@b.com", "sekret-pw");
    expect(containsSubstring(result, "sekret-pw")).toBe(false);
  });
});

describe("signInWithEmail — generic error on rejection (Req 15.3)", () => {
  it("returns ok on success", async () => {
    const { client, auth } = mockClient();
    const result = await signInWithEmail(client, "a@b.com", "pw");
    expect(result.ok).toBe(true);
    const arg = auth.signInWithPassword.mock.calls[0][0];
    expect(arg).toEqual({ email: "a@b.com", password: "pw" });
  });

  it("returns a generic error that reveals neither field, nor the password", async () => {
    const { client } = mockClient({
      signInWithPassword: vi.fn(async () => ({ data: null, error: { message: "Invalid login credentials" } })),
    });
    const result = await signInWithEmail(client, "a@b.com", "pw");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(/email|password/i.test(result.error!)).toBe(false);
    expect(containsSubstring(result, "pw")).toBe(false);
  });
});

describe("requestPasswordReset — non-enumerating identical response (Req 16.2/16.3)", () => {
  it("returns the identical result whether or not Supabase errors", async () => {
    const ok = mockClient();
    const errored = mockClient({
      resetPasswordForEmail: vi.fn(async () => ({ data: null, error: { message: "user not found" } })),
    });

    const a = await requestPasswordReset(ok.client, "exists@b.com");
    const b = await requestPasswordReset(errored.client, "missing@b.com");

    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    // Call shape: redirectTo carries the recovery type.
    const arg = ok.auth.resetPasswordForEmail.mock.calls[0];
    expect(arg[0]).toBe("exists@b.com");
    expect(String(arg[1].redirectTo)).toContain("type=recovery");
  });
});

describe("updatePassword — change vs set-password + failure (Req 18)", () => {
  it("calls updateUser with the new password", async () => {
    const { client, auth } = mockClient();
    const result = await updatePassword(client, "new-pw");
    expect(result.ok).toBe(true);
    expect(auth.updateUser.mock.calls[0][0]).toEqual({ password: "new-pw" });
  });

  it("reports an error and does not leak the password on failure (Req 18.4)", async () => {
    const { client } = mockClient({
      updateUser: vi.fn(async () => ({ data: null, error: { message: "weak password: new-pw" } })),
    });
    const result = await updatePassword(client, "new-pw");
    expect(result.ok).toBe(false);
    expect(containsSubstring(result, "new-pw")).toBe(false);
  });

  it("labels the action Set vs Change based on whether a password exists (Req 18.1/18.2)", () => {
    expect(passwordActionLabel(false)).toBe("Set Password");
    expect(passwordActionLabel(true)).toBe("Change Password");
  });
});

describe("signOutAndConfirm — success + invalidation confirmation (Req 19.3)", () => {
  it("returns ok only after getClaims confirms no remaining session", async () => {
    const { client, auth } = mockClient();
    const result = await signOutAndConfirm(client);
    expect(result.ok).toBe(true);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(auth.getClaims).toHaveBeenCalledTimes(1);
  });

  it("reports incomplete when a session still resolves after sign-out (Req 19.3)", async () => {
    const { client } = mockClient({
      getClaims: vi.fn(async () => ({ data: { claims: { sub: "still-here" } }, error: null })),
    });
    const result = await signOutAndConfirm(client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/incomplete/i);
  });

  it("reports failure when signOut errors", async () => {
    const { client } = mockClient({
      signOut: vi.fn(async () => ({ error: { message: "network" } })),
    });
    const result = await signOutAndConfirm(client);
    expect(result.ok).toBe(false);
  });
});
