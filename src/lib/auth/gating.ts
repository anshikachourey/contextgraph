/**
 * Pure request-gating decision for the Supabase middleware path.
 *
 * Feature: google-oauth-authentication (Task 6.7 support / Property 4)
 *
 * This encodes the gating table from the design's Middleware component as a pure
 * function of `(path, hasSession, flagEnabled, currentMembershipRole)`. The
 * middleware's control flow mirrors this decision; isolating it here makes the
 * gating semantics unit- and property-testable without a live request.
 *
 * The decision depends on CURRENT membership (not a JWT role claim): a role
 * revocation flips the debug decision immediately on the next evaluation, with
 * no token refresh (Req 9.2).
 */

export type RouteKind = "auth" | "static" | "api-debug" | "page-debug" | "api" | "page";

export type MembershipRole = "owner" | "admin" | "member" | null;

export type GateInput = {
  kind: RouteKind;
  hasSession: boolean;
  flagEnabled: boolean;
  /** Current (live) membership role of the caller, or null if none. */
  currentRole: MembershipRole;
  /** Whether the debug flag is enabled (DEBUG_ENDPOINTS or dev). */
  debugFlag: boolean;
};

export type GateDecision =
  | { action: "allow"; noStore: boolean }
  | { action: "unauthorized-api"; noStore: true } // 401 + no-store
  | { action: "redirect-login" }
  | { action: "not-found" }; // 404

/** Roles that currently grant debug access (mirrors has_debug_access()). */
export function roleGrantsDebug(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Decide how the Supabase middleware path gates a request.
 *
 * Note: this models the FLAG-ENABLED path. While the flag is disabled the
 * middleware uses the legacy owner/demo gate (unchanged); `flagEnabled` is kept
 * in the input so the table is explicit and the property test can assert the
 * disabled path is never evaluated here by callers.
 */
export function decideGate(input: GateInput): GateDecision {
  // Auth-namespace and static assets always pass without a session (Req 8.3).
  if (input.kind === "auth" || input.kind === "static") {
    const isApi = false; // auth/static here are not treated as /api/* for no-store
    return { action: "allow", noStore: isApi };
  }

  const isApi = input.kind === "api" || input.kind === "api-debug";

  // No session: API → 401+no-store; page → redirect /login (Req 8.1, 8.2).
  if (!input.hasSession) {
    return isApi
      ? { action: "unauthorized-api", noStore: true }
      : { action: "redirect-login" };
  }

  // Debug routes incur a current membership/role check (Req 9).
  if (input.kind === "api-debug" || input.kind === "page-debug") {
    if (!input.debugFlag) return { action: "not-found" };
    if (!roleGrantsDebug(input.currentRole)) return { action: "not-found" };
    return { action: "allow", noStore: input.kind === "api-debug" };
  }

  // Ordinary authenticated path: allow (no membership DB query in middleware).
  return { action: "allow", noStore: isApi };
}
