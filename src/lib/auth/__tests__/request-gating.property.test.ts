// Feature: google-oauth-authentication, Property 4: The request-gating decision follows the gating table and depends on current membership
//
// Validates: Requirements 8.1, 8.2, 8.3, 9.1, 9.2, 9.3
//
// `decideGate(path, hasSession, flagEnabled, currentMembershipRole)` is a pure
// function of its inputs. This asserts the full gating table — including
// no-store on API 401 and the debug-only allowance — and includes a
// revoke-and-re-evaluate case that flips to 404 purely from the changed
// current-membership input (no token refresh).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  decideGate,
  roleGrantsDebug,
  type RouteKind,
  type MembershipRole,
  type GateInput,
} from "../gating";

const kindArb = fc.constantFrom<RouteKind>(
  "auth",
  "static",
  "api-debug",
  "page-debug",
  "api",
  "page",
);
const roleArb = fc.constantFrom<MembershipRole>("owner", "admin", "member", null);

const inputArb: fc.Arbitrary<GateInput> = fc.record({
  kind: kindArb,
  hasSession: fc.boolean(),
  flagEnabled: fc.constant(true),
  currentRole: roleArb,
  debugFlag: fc.boolean(),
});

describe("Property 4: request-gating decision follows the table and uses current membership", () => {
  it("auth and static routes always allow", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        if (input.kind === "auth" || input.kind === "static") {
          expect(decideGate(input).action).toBe("allow");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("no session: API → 401+no-store, page → redirect /login", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        if (input.kind === "auth" || input.kind === "static") return;
        if (input.hasSession) return;

        const d = decideGate(input);
        const isApi = input.kind === "api" || input.kind === "api-debug";
        if (isApi) {
          expect(d).toEqual({ action: "unauthorized-api", noStore: true });
        } else {
          expect(d).toEqual({ action: "redirect-login" });
        }
      }),
      { numRuns: 200 },
    );
  });

  it("authenticated debug routes: 404 unless debug flag AND current role grants debug", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        if (input.kind !== "api-debug" && input.kind !== "page-debug") return;
        if (!input.hasSession) return;

        const d = decideGate(input);
        if (input.debugFlag && roleGrantsDebug(input.currentRole)) {
          expect(d.action).toBe("allow");
        } else {
          expect(d.action).toBe("not-found");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("authenticated ordinary routes allow with no-store only on API", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        if (input.kind !== "api" && input.kind !== "page") return;
        if (!input.hasSession) return;

        const d = decideGate(input);
        expect(d.action).toBe("allow");
        if (d.action === "allow") {
          expect(d.noStore).toBe(input.kind === "api");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("revoke-and-re-evaluate: a debug route flips allow→404 from the role change alone (no token refresh)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RouteKind>("api-debug", "page-debug"),
        fc.constantFrom<MembershipRole>("owner", "admin"),
        fc.constantFrom<MembershipRole>("member", null),
        (kind, grantingRole, revokedRole) => {
          const base = {
            kind,
            hasSession: true,
            flagEnabled: true,
            debugFlag: true,
          } as const;

          // Same session/token throughout; only the current membership changes.
          const before = decideGate({ ...base, currentRole: grantingRole });
          const after = decideGate({ ...base, currentRole: revokedRole });

          expect(before.action).toBe("allow");
          expect(after.action).toBe("not-found");
        },
      ),
      { numRuns: 100 },
    );
  });
});
