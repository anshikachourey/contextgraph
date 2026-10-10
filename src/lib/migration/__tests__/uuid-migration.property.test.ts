/**
 * Property-based tests for the UUID_Migration (Tasks 15.3–15.6).
 *
 * Feature: google-oauth-authentication
 *
 * Library: fast-check under Vitest, Node 22, minimum 100 runs each. Each property
 * runs against the PURE in-memory relational-dataset transform model
 * (`uuid-migration-model.ts`) that mirrors the `migrate_owner_data_to_user` SQL
 * function — no live Supabase/Postgres.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  type Dataset,
  type DependentRow,
  cloneDataset,
  migrateOwnerDataToUser,
} from "./uuid-migration-model";

const RUNS = { numRuns: 100 } as const;

// ─── Smart generator ─────────────────────────────────────────────────────────
//
// Builds a self-consistent owner/demo dataset for ONE target user:
//   - a personal account_workspace for the target user (provisioned),
//   - optionally some pre-existing unrelated personal workspaces,
//   - graph_workspaces + conversations tagged 'owner' | 'demo' | 'other',
//   - dependent rows (messages/nodes/edges/positions) each keyed to an existing
//     conversation, and graph↔conversation join rows referencing existing ids.
//
// Constraining generation to the real input space (valid FKs, valid
// discriminators) keeps the properties meaningful rather than exercising
// impossible states.

const discriminator = fc.constantFrom("owner", "demo", "other");

function dependentArb(
  prefix: string,
  conversationIds: string[],
): fc.Arbitrary<DependentRow[]> {
  if (conversationIds.length === 0) return fc.constant<DependentRow[]>([]);
  return fc
    .array(
      fc.record({
        id: fc.uuid(),
        conversationId: fc.constantFrom(...conversationIds),
      }),
      { maxLength: 12 },
    )
    .map((rows): DependentRow[] =>
      // Ensure unique ids by prefixing the index.
      rows.map((r, idx) => ({ ...r, id: `${prefix}-${idx}-${r.id}` })),
    );
}

const datasetAndTargetArb = fc
  .record({
    targetUser: fc.uuid(),
    targetWsId: fc.uuid(),
    // Extra unrelated personal workspaces (other users).
    otherWorkspaces: fc.array(
      fc.record({ id: fc.uuid(), ownerUserId: fc.uuid() }),
      { maxLength: 3 },
    ),
    graphs: fc.array(
      fc.record({ id: fc.uuid(), workspaceId: discriminator }),
      { maxLength: 8 },
    ),
    convs: fc.array(
      fc.record({ id: fc.uuid(), legacyWorkspaceId: discriminator }),
      { maxLength: 8 },
    ),
    alreadyDone: fc.boolean(),
  })
  .chain((base) => {
    // Deduplicate ids across graphs/convs/workspaces to keep FKs sane.
    const graphIds = Array.from(new Set(base.graphs.map((g) => g.id)));
    const convIds = Array.from(new Set(base.convs.map((c) => c.id)));

    const graphs = graphIds.map((id) => {
      const g = base.graphs.find((x) => x.id === id)!;
      return { id, workspaceId: g.workspaceId, accountWorkspaceId: null as string | null };
    });
    const convs = convIds.map((id) => {
      const c = base.convs.find((x) => x.id === id)!;
      return {
        id,
        legacyWorkspaceId: c.legacyWorkspaceId,
        accountWorkspaceId: null as string | null,
      };
    });

    return fc
      .record({
        messages: dependentArb("m", convIds),
        nodes: dependentArb("n", convIds),
        edges: dependentArb("e", convIds),
        positions: dependentArb("p", convIds),
        links: fc.array(
          fc.record({
            graphWorkspaceId: graphIds.length ? fc.constantFrom(...graphIds) : fc.constant("none"),
            conversationId: convIds.length ? fc.constantFrom(...convIds) : fc.constant("none"),
          }),
          { maxLength: 10 },
        ),
      })
      .map(({ messages, nodes, edges, positions, links }) => {
        const dataset: Dataset = {
          accountWorkspaces: [
            { id: base.targetWsId, ownerUserId: base.targetUser, kind: "personal" },
            ...base.otherWorkspaces
              .filter((w) => w.ownerUserId !== base.targetUser && w.id !== base.targetWsId)
              .map((w) => ({ id: w.id, ownerUserId: w.ownerUserId, kind: "personal" as const })),
          ],
          graphWorkspaces: graphs,
          conversations: convs,
          graphWorkspaceConversations: links.filter(
            (l) => l.graphWorkspaceId !== "none" && l.conversationId !== "none",
          ),
          messages,
          nodes,
          edges,
          conversationNodePositions: positions,
          migrationRuns: new Set(base.alreadyDone ? [base.targetUser] : []),
        };
        return { dataset, targetUser: base.targetUser, targetWsId: base.targetWsId };
      });
  });

// Serialize dependents+links for byte-for-byte comparison.
function serializeDeps(d: Dataset): string {
  const sortRows = (rows: DependentRow[]) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({
    messages: sortRows(d.messages),
    nodes: sortRows(d.nodes),
    edges: sortRows(d.edges),
    positions: sortRows(d.conversationNodePositions),
    links: [...d.graphWorkspaceConversations].sort((a, b) =>
      (a.graphWorkspaceId + a.conversationId).localeCompare(
        b.graphWorkspaceId + b.conversationId,
      ),
    ),
  });
}

function serializeFull(d: Dataset): string {
  return JSON.stringify({
    aw: [...d.accountWorkspaces].sort((a, b) => a.id.localeCompare(b.id)),
    gw: [...d.graphWorkspaces].sort((a, b) => a.id.localeCompare(b.id)),
    conv: [...d.conversations].sort((a, b) => a.id.localeCompare(b.id)),
    deps: serializeDeps(d),
    runs: [...d.migrationRuns].sort(),
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Feature: google-oauth-authentication, Property 5: The UUID_Migration is idempotent
// ───────────────────────────────────────────────────────────────────────────────
describe("Property 5 — UUID_Migration idempotency (Req 11.3, 11.4)", () => {
  it("running once then again with the same target yields identical state", () => {
    fc.assert(
      fc.property(datasetAndTargetArb, ({ dataset, targetUser }) => {
        const once = migrateOwnerDataToUser(dataset, targetUser);
        const twice = migrateOwnerDataToUser(once, targetUser);
        expect(serializeFull(twice)).toBe(serializeFull(once));
      }),
      RUNS,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Feature: google-oauth-authentication, Property 6: The UUID_Migration reassociates
// all owner data with referential integrity preserved
// ───────────────────────────────────────────────────────────────────────────────
describe("Property 6 — reassociation completeness + referential integrity (Req 11.1, 11.2, 11.5, 11.10)", () => {
  it("every owner graph/conversation is parented to the target personal workspace and all FKs stay valid", () => {
    fc.assert(
      fc.property(datasetAndTargetArb, ({ dataset, targetUser, targetWsId }) => {
        const wasDone = dataset.migrationRuns.has(targetUser);
        const out = migrateOwnerDataToUser(dataset, targetUser);

        if (!wasDone) {
          // Completeness: all owner rows now point at the target workspace.
          for (const g of out.graphWorkspaces) {
            if (g.workspaceId === "owner") {
              expect(g.accountWorkspaceId).toBe(targetWsId);
            }
          }
          for (const c of out.conversations) {
            if (c.legacyWorkspaceId === "owner") {
              expect(c.accountWorkspaceId).toBe(targetWsId);
            }
          }
        }

        // Referential integrity: every dependent row still references an existing
        // conversation, and every join row references existing graph + conversation.
        const convIds = new Set(out.conversations.map((c) => c.id));
        const graphIds = new Set(out.graphWorkspaces.map((g) => g.id));
        for (const rows of [out.messages, out.nodes, out.edges, out.conversationNodePositions]) {
          for (const r of rows) expect(convIds.has(r.conversationId)).toBe(true);
        }
        for (const l of out.graphWorkspaceConversations) {
          expect(graphIds.has(l.graphWorkspaceId)).toBe(true);
          expect(convIds.has(l.conversationId)).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Feature: google-oauth-authentication, Property 7: The UUID_Migration preserves
// each Dashboard_Graph as a distinct child
// ───────────────────────────────────────────────────────────────────────────────
describe("Property 7 — distinct Dashboard_Graph preservation / no-flatten (Req 11.8, 11.9)", () => {
  it("graph count and graph ids are unchanged; no two graphs are merged", () => {
    fc.assert(
      fc.property(datasetAndTargetArb, ({ dataset, targetUser }) => {
        const before = dataset.graphWorkspaces.map((g) => g.id).sort();
        const out = migrateOwnerDataToUser(dataset, targetUser);
        const after = out.graphWorkspaces.map((g) => g.id).sort();

        // Same number of graphs, same set of ids (ids retained — Req 11.8; no
        // merge/flatten — Req 11.9).
        expect(after.length).toBe(before.length);
        expect(after).toEqual(before);
        // Ids remain unique (no collapse into one).
        expect(new Set(after).size).toBe(after.length);
      }),
      RUNS,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Feature: google-oauth-authentication, Property 8: The UUID_Migration never touches
// demo data
// ───────────────────────────────────────────────────────────────────────────────
describe("Property 8 — demo data untouched (Req 11.6, 11.7)", () => {
  it("every demo graph/conversation is byte-for-byte unchanged after migration", () => {
    fc.assert(
      fc.property(datasetAndTargetArb, ({ dataset, targetUser }) => {
        const demoGraphsBefore = JSON.stringify(
          dataset.graphWorkspaces.filter((g) => g.workspaceId === "demo"),
        );
        const demoConvsBefore = JSON.stringify(
          dataset.conversations.filter((c) => c.legacyWorkspaceId === "demo"),
        );

        const out = migrateOwnerDataToUser(dataset, targetUser);

        const demoGraphsAfter = JSON.stringify(
          out.graphWorkspaces.filter((g) => g.workspaceId === "demo"),
        );
        const demoConvsAfter = JSON.stringify(
          out.conversations.filter((c) => c.legacyWorkspaceId === "demo"),
        );

        expect(demoGraphsAfter).toBe(demoGraphsBefore);
        expect(demoConvsAfter).toBe(demoConvsBefore);
      }),
      RUNS,
    );
  });
});

// Sanity: the transform never mutates its input dataset.
describe("UUID_Migration model purity", () => {
  it("does not mutate the input dataset", () => {
    fc.assert(
      fc.property(datasetAndTargetArb, ({ dataset, targetUser }) => {
        const snapshot = serializeFull(cloneDataset(dataset));
        migrateOwnerDataToUser(dataset, targetUser);
        expect(serializeFull(dataset)).toBe(snapshot);
      }),
      RUNS,
    );
  });
});
