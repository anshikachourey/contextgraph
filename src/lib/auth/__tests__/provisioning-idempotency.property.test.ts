// Feature: google-oauth-authentication, Property 2: Provisioning is idempotent and gates access on all three records
//
// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 21.4
//
// Pure in-memory model of the ON CONFLICT DO NOTHING upsert performed by the
// provision_user trigger / provision_self() RPC. For any user id, any
// pre-existing subset of its three records, and any number of repeated
// invocations, provisioning yields exactly one User_Profile, one personal
// Account_Workspace, and one Workspace_Membership (no duplicates), reuses
// already-committed records, and reports "access granted" IFF all three are
// present.

import { describe, it, expect } from "vitest";
import fc from "fast-check";

// ─── Pure provisioning model ─────────────────────────────────────────────────

type Store = {
  profiles: Set<string>; // keyed by user id
  personalWorkspaces: Map<string, string>; // userId -> workspaceId (one per user)
  memberships: Set<string>; // keyed by `${workspaceId}:${userId}`
};

function emptyStore(): Store {
  return {
    profiles: new Set(),
    personalWorkspaces: new Map(),
    memberships: new Set(),
  };
}

/**
 * One idempotent provisioning pass for `uid`, mirroring the SQL:
 *   INSERT ... ON CONFLICT DO NOTHING for profile, personal workspace, membership.
 * `wsIdFactory` models gen_random_uuid() for a NEW workspace; existing ones are
 * reused (never a second one), honoring the uq_personal_workspace index.
 */
function provision(store: Store, uid: string, wsIdFactory: () => string): void {
  // profile
  store.profiles.add(uid); // Set add is itself ON CONFLICT DO NOTHING

  // personal workspace: exactly one per user (reuse if present)
  let wsId = store.personalWorkspaces.get(uid);
  if (wsId === undefined) {
    wsId = wsIdFactory();
    store.personalWorkspaces.set(uid, wsId);
  }

  // membership (owner) on that workspace
  store.memberships.add(`${wsId}:${uid}`);
}

/** Access gate: granted IFF all three records are durably present (Req 6.4). */
function accessGranted(store: Store, uid: string): boolean {
  const wsId = store.personalWorkspaces.get(uid);
  if (wsId === undefined) return false;
  return store.profiles.has(uid) && store.memberships.has(`${wsId}:${uid}`);
}

// A deterministic ws id source so "new" workspaces are observable per run.
function makeWsFactory() {
  let n = 0;
  return () => `ws-${n++}`;
}

describe("Property 2: provisioning is idempotent and gates access on all three", () => {
  it("yields exactly one of each record regardless of pre-existing subset and repeats", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("user-a", "user-b"),
        // pre-existing subset flags
        fc.record({ profile: fc.boolean(), workspace: fc.boolean(), membership: fc.boolean() }),
        fc.integer({ min: 1, max: 6 }), // repeat count
        (uid, pre, repeats) => {
          const store = emptyStore();
          const ws = makeWsFactory();

          // Seed an arbitrary pre-existing subset.
          let seededWs: string | undefined;
          if (pre.workspace) {
            seededWs = ws();
            store.personalWorkspaces.set(uid, seededWs);
          }
          if (pre.profile) store.profiles.add(uid);
          if (pre.membership && seededWs) store.memberships.add(`${seededWs}:${uid}`);

          for (let i = 0; i < repeats; i++) provision(store, uid, ws);

          // Exactly one of each for this user.
          expect(store.profiles.has(uid)).toBe(true);
          expect([...store.profiles].filter((p) => p === uid)).toHaveLength(1);

          const workspacesForUser = [...store.personalWorkspaces.keys()].filter(
            (k) => k === uid,
          );
          expect(workspacesForUser).toHaveLength(1);

          const wsId = store.personalWorkspaces.get(uid)!;
          const memsForUser = [...store.memberships].filter((m) =>
            m.endsWith(`:${uid}`),
          );
          expect(memsForUser).toEqual([`${wsId}:${uid}`]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("reuses an already-committed workspace rather than creating a second (Req 6.6)", () => {
    fc.assert(
      fc.property(fc.constant("user-x"), fc.integer({ min: 1, max: 5 }), (uid, repeats) => {
        const store = emptyStore();
        const ws = makeWsFactory();
        provision(store, uid, ws); // first pass creates ws-0
        const first = store.personalWorkspaces.get(uid);
        for (let i = 0; i < repeats; i++) provision(store, uid, ws);
        expect(store.personalWorkspaces.get(uid)).toBe(first); // never replaced
      }),
      { numRuns: 200 },
    );
  });

  it("access is granted iff all three records are present", () => {
    fc.assert(
      fc.property(
        fc.constant("user-g"),
        fc.record({ profile: fc.boolean(), workspace: fc.boolean(), membership: fc.boolean() }),
        (uid, pre) => {
          const store = emptyStore();
          const ws = makeWsFactory();
          let seededWs: string | undefined;
          if (pre.workspace) {
            seededWs = ws();
            store.personalWorkspaces.set(uid, seededWs);
          }
          if (pre.profile) store.profiles.add(uid);
          if (pre.membership && seededWs) store.memberships.add(`${seededWs}:${uid}`);

          const allThree = pre.profile && pre.workspace && pre.membership;
          expect(accessGranted(store, uid)).toBe(allThree);

          // After a full provisioning pass, access is always granted.
          provision(store, uid, ws);
          expect(accessGranted(store, uid)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
