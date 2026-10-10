// Feature: google-oauth-authentication, Property 3: Workspace data access is membership-scoped with default-deny
//
// Validates: Requirements 7.4, 7.5, 10.4
//
// Pure in-memory model of the `is_member(ws)` RLS predicate over generated
// users / workspaces / membership sets and target rows. A request may access a
// workspace-scoped row IFF the user holds a membership linking them to that
// row's workspace; a user with no membership can access no workspace data.

import { describe, it, expect } from "vitest";
import fc from "fast-check";

// ─── Pure model of the membership predicate + row-access decision ────────────

type Membership = { workspaceId: string; userId: string };
type WorkspaceRow = { workspaceId: string };

/** Mirrors public.is_member(ws): does `userId` hold a membership in `ws`? */
function isMember(memberships: Membership[], userId: string, ws: string): boolean {
  return memberships.some((m) => m.userId === userId && m.workspaceId === ws);
}

/** Row-level access decision under the membership RLS policies. */
function canAccessRow(
  memberships: Membership[],
  userId: string,
  row: WorkspaceRow,
): boolean {
  return isMember(memberships, userId, row.workspaceId);
}

// ─── Generators ──────────────────────────────────────────────────────────────

const userId = fc.constantFrom("u1", "u2", "u3", "u4");
const workspaceId = fc.constantFrom("w1", "w2", "w3", "w4");

const membershipArb: fc.Arbitrary<Membership> = fc.record({
  workspaceId,
  userId,
});

const membershipsArb = fc.array(membershipArb, { maxLength: 12 });
const rowsArb = fc.array(fc.record({ workspaceId }), { maxLength: 12 });

describe("Property 3: membership-scoped access with default-deny", () => {
  it("grants row access iff a linking membership exists", () => {
    fc.assert(
      fc.property(membershipsArb, userId, rowsArb, (memberships, uid, rows) => {
        for (const row of rows) {
          const expected = memberships.some(
            (m) => m.userId === uid && m.workspaceId === row.workspaceId,
          );
          expect(canAccessRow(memberships, uid, row)).toBe(expected);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a user with no membership can access no workspace data (default-deny)", () => {
    fc.assert(
      fc.property(membershipsArb, userId, rowsArb, (memberships, uid, rows) => {
        const withoutUser = memberships.filter((m) => m.userId !== uid);
        for (const row of rows) {
          expect(canAccessRow(withoutUser, uid, row)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("access to a workspace never leaks to a non-member of that workspace", () => {
    fc.assert(
      fc.property(
        membershipsArb,
        userId,
        userId,
        workspaceId,
        (memberships, a, b, ws) => {
          fc.pre(a !== b);
          // Give A membership in ws, ensure B has none in ws.
          const ms = [
            ...memberships.filter((m) => !(m.userId === b && m.workspaceId === ws)),
            { userId: a, workspaceId: ws },
          ];
          expect(canAccessRow(ms, a, { workspaceId: ws })).toBe(true);
          expect(canAccessRow(ms, b, { workspaceId: ws })).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
