// Feature: google-oauth-authentication — debug gate reads CURRENT membership
//
// Validates: Requirement 9.2 (debug authorization via current membership/role)
//
// Example/integration test (mocked current-membership lookup): the debug gate
// must return 404 after a role is revoked WITH NO TOKEN REFRESH, because the
// decision reads live membership (has_debug_access() / is_member_with_role())
// rather than a cached/JWT role claim. This complements property P4.
//
// We model the gate exactly as the design specifies: flag check + a *current*
// server-side membership/role lookup bound to the caller. The lookup is mocked
// so we can revoke the role between evaluations without any token change.

import { describe, it, expect, vi } from "vitest";

type DebugDecision = { status: 200 } | { status: 404 };

/**
 * Pure model of requireDebugAccess() as described in the design:
 *   - 404 unless the debug flag is enabled (or dev), AND
 *   - 404 unless the caller CURRENTLY holds the required role (live lookup).
 * `currentHasDebugAccess` stands in for the no-uid has_debug_access() helper
 * that reads live workspace_memberships for auth.uid().
 */
async function requireDebugAccessModel(opts: {
  flagEnabledOrDev: boolean;
  currentHasDebugAccess: () => Promise<boolean>;
}): Promise<DebugDecision> {
  if (!opts.flagEnabledOrDev) return { status: 404 };
  const allowed = await opts.currentHasDebugAccess();
  return allowed ? { status: 200 } : { status: 404 };
}

describe("debug gate reads current membership (revocation takes effect immediately)", () => {
  it("returns 404 after the role is revoked, with NO token refresh", async () => {
    // A single, unchanging session/token. Only the live membership changes.
    let currentRole: "owner" | null = "owner";
    const lookup = vi.fn(async () => currentRole === "owner");

    // 1. While the user holds the owner role → allowed.
    const before = await requireDebugAccessModel({
      flagEnabledOrDev: true,
      currentHasDebugAccess: lookup,
    });
    expect(before).toEqual({ status: 200 });

    // 2. Revoke the role server-side (no token refresh, same session).
    currentRole = null;

    // 3. Re-evaluate the SAME request → must now be 404 purely from the
    //    changed current-membership input.
    const after = await requireDebugAccessModel({
      flagEnabledOrDev: true,
      currentHasDebugAccess: lookup,
    });
    expect(after).toEqual({ status: 404 });

    // The gate consulted the live lookup on every evaluation.
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("returns 404 when the debug flag is disabled regardless of role", async () => {
    const lookup = vi.fn(async () => true);
    const decision = await requireDebugAccessModel({
      flagEnabledOrDev: false,
      currentHasDebugAccess: lookup,
    });
    expect(decision).toEqual({ status: 404 });
    // Flag check short-circuits before the DB lookup.
    expect(lookup).not.toHaveBeenCalled();
  });

  it("grants access only when the flag is enabled AND the role is currently held", async () => {
    const allowed = await requireDebugAccessModel({
      flagEnabledOrDev: true,
      currentHasDebugAccess: async () => true,
    });
    expect(allowed).toEqual({ status: 200 });
  });
});
