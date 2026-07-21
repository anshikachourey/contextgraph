/**
 * V2 Projection Tests
 *
 * Verifies that SIE authoritative state projects correctly to the V2
 * SnapshotPayload shape consumed by the React Flow UI:
 * - Concern status → ObjectStatus mapping (approved)
 * - Unapproved fields use explicit non-authoritative placeholders
 * - PropositionIds populated from active PRIMARY_OWNER associations
 * - V2 proposition has sourceUtteranceIds, normalizedContent, authoredBy
 * - No synthetic threads are invented (empty array)
 * - Parent hierarchy produces child_of relationships
 * - DerivedHierarchyNode and DerivedTree structure
 * - All placeholder values are behaviorally inert
 */
import { describe, it, expect } from "vitest";
import {
  projectToV2Snapshot,
  UNAPPROVED_MAPPING_FLAGS,
} from "../v2-projection";
import type { SIEGraphState } from "../types";
import type { components } from "../generated/transport-types";

type ConcernSummary = components["schemas"]["ConcernSummary"];
type Proposition = components["schemas"]["Proposition"];
type PropositionAssociation = components["schemas"]["PropositionAssociation"];
type SemanticPacket = components["schemas"]["SemanticPacket"];

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeConcern(id: string, overrides?: Partial<ConcernSummary>): ConcernSummary {
  return {
    concern_id: id,
    identity_summary: `Identity for ${id}`,
    display_title: `Title for ${id}`,
    current_summary: `Summary for ${id}`,
    status: "ACTIVE",
    aliases: [],
    canonical_parent_id: null,
    parent_resolution_state: "ROOT_CONFIRMED",
    last_active_at: "2024-06-01T10:00:00Z",
    semantic_version: 1,
    ...overrides,
  };
}

function makeProposition(id: string, overrides?: Partial<Proposition>): Proposition {
  return {
    proposition_id: id,
    proposition_creation_key: `conv-001:req:extract-${id}`,
    conversation_id: "conv-001",
    source_message_ids: ["msg-001"],
    speaker_role: "USER",
    canonical_meaning: `Meaning for ${id}`,
    proposition_type: "CLAIM",
    message_seq_range: [1, 1] as [number, number],
    provenance: "DIRECT",
    semantic_state: "ACTIVE",
    retention_levels: ["DURABLE_PROPOSITION"],
    created_at: "2024-06-01T10:00:00Z",
    extraction_version: "0.1.0",
    supersedes_proposition_id: null,
    ...overrides,
  };
}

function makeAssociation(
  id: string,
  propId: string,
  concernId: string,
  overrides?: Partial<PropositionAssociation>
): PropositionAssociation {
  return {
    association_id: id,
    association_creation_key: `conv-001:req:assoc-${id}`,
    proposition_id: propId,
    concern_id: concernId,
    role: "PRIMARY_OWNER",
    confidence: "HIGH",
    provenance: "identity_resolution",
    established_by_packet_id: null,
    semantic_state: "ACTIVE",
    created_at: "2024-06-01T10:00:00Z",
    version: 1,
    ...overrides,
  };
}

function makePacket(id: string, overrides?: Partial<SemanticPacket>): SemanticPacket {
  return {
    packet_id: id,
    packet_creation_key: `conv-001:req:partition-${id}`,
    conversation_id: "conv-001",
    source_message_ids: ["msg-001"],
    message_seq_range: [1, 1] as [number, number],
    user_grounded_meaning: `Meaning for packet ${id}`,
    assistant_context: null,
    continuation_origin: null,
    provenance: "extraction",
    packet_formation_version: "0.1.0",
    cohesion_status: "COHESIVE",
    provisional_boundaries: [],
    ...overrides,
  };
}

function makeGraphState(overrides?: Partial<SIEGraphState>): SIEGraphState {
  return {
    graphVersion: 5,
    concerns: [],
    propositions: [],
    associations: [],
    packets: [],
    ...overrides,
  };
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe("V2 Projection", () => {
  describe("concern status → ObjectStatus mapping (approved)", () => {
    it("ACTIVE concern projects to active ConversationalObject", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1", { status: "ACTIVE" })],
      });
      const projection = projectToV2Snapshot(state);
      expect(projection.objects[0].status).toBe("active");
    });

    it("DORMANT concern projects with status='deferred'", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1", { status: "DORMANT" })],
      });
      const projection = projectToV2Snapshot(state);
      expect(projection.objects[0].status).toBe("deferred");
    });

    it("RETIRED concern projects with status='resolved'", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1", { status: "RETIRED" })],
      });
      const projection = projectToV2Snapshot(state);
      expect(projection.objects[0].status).toBe("resolved");
    });

    it("MERGED concern projects with status='discarded'", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1", { status: "MERGED" })],
      });
      const projection = projectToV2Snapshot(state);
      expect(projection.objects[0].status).toBe("discarded");
    });
  });

  describe("unapproved fields use explicit non-authoritative placeholders", () => {
    it("objectType is constant 'unresolved' (requires product decision)", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1", { proposition_type: "GOAL" })],
        associations: [makeAssociation("a-1", "prop-1", "c-1")],
      });
      const projection = projectToV2Snapshot(state);

      // objectType must NOT be derived from proposition types — it's a placeholder
      expect(projection.objects[0].objectType).toBe("unresolved");
      expect(projection.objects[0].objectType).toBe(UNAPPROVED_MAPPING_FLAGS.objectType);
    });

    it("maturity is constant 'developing' (retired concept, structurally required)", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
      });
      const projection = projectToV2Snapshot(state);

      // maturity must NOT vary by proposition count — it's a constant placeholder
      expect(projection.objects[0].maturity).toBe("developing");
      expect(projection.objects[0].maturity).toBe(UNAPPROVED_MAPPING_FLAGS.maturity);
    });

    it("maturity does not change based on proposition count", () => {
      // With many propositions, maturity should still be the constant placeholder
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: Array.from({ length: 10 }, (_, i) => makeProposition(`p-${i}`)),
        associations: Array.from({ length: 10 }, (_, i) =>
          makeAssociation(`a-${i}`, `p-${i}`, "c-1")
        ),
      });
      const projection = projectToV2Snapshot(state);
      expect(projection.objects[0].maturity).toBe("developing");
    });

    it("parent relationship confidence is constant 1.0 (no ranking invented)", () => {
      const state = makeGraphState({
        concerns: [
          makeConcern("c-parent"),
          makeConcern("c-child", {
            canonical_parent_id: "c-parent",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
        ],
      });
      const projection = projectToV2Snapshot(state);
      const rel = projection.relationships[0];

      expect(rel.confidence).toBe(1.0);
      expect(rel.confidence).toBe(UNAPPROVED_MAPPING_FLAGS.parentRelationshipConfidence);
    });

    it("proposition confidence is constant 1.0 (no band-to-numeric mapping)", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1")],
        associations: [makeAssociation("a-1", "prop-1", "c-1")],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.propositions[0].confidence).toBe(1.0);
      expect(projection.propositions[0].confidence).toBe(
        UNAPPROVED_MAPPING_FLAGS.propositionConfidence
      );
    });
  });

  describe("no synthetic threads are invented", () => {
    it("threads array is empty regardless of packets present", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        packets: [makePacket("pkt-1"), makePacket("pkt-2")],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.threads).toEqual([]);
    });

    it("object threadIds are empty (no synthetic thread derivation)", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1")],
        associations: [makeAssociation("a-1", "prop-1", "c-1")],
        packets: [makePacket("pkt-1")],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.objects[0].threadIds).toEqual([]);
    });
  });

  describe("propositionIds from active PRIMARY_OWNER associations", () => {
    it("populates propositionIds from active PRIMARY_OWNER", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1"), makeProposition("prop-2")],
        associations: [
          makeAssociation("a-1", "prop-1", "c-1"),
          makeAssociation("a-2", "prop-2", "c-1"),
        ],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.objects[0].propositionIds).toContain("prop-1");
      expect(projection.objects[0].propositionIds).toContain("prop-2");
    });

    it("excludes SUPERSEDED associations from propositionIds", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1"), makeProposition("prop-2")],
        associations: [
          makeAssociation("a-1", "prop-1", "c-1"),
          makeAssociation("a-2", "prop-2", "c-1", { semantic_state: "SUPERSEDED" }),
        ],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.objects[0].propositionIds).toContain("prop-1");
      expect(projection.objects[0].propositionIds).not.toContain("prop-2");
    });

    it("excludes SUPPORTING_EVIDENCE from propositionIds", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1"), makeProposition("prop-2")],
        associations: [
          makeAssociation("a-1", "prop-1", "c-1"),
          makeAssociation("a-2", "prop-2", "c-1", { role: "SUPPORTING_EVIDENCE" }),
        ],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.objects[0].propositionIds).toContain("prop-1");
      expect(projection.objects[0].propositionIds).not.toContain("prop-2");
    });
  });

  describe("V2 proposition shape", () => {
    it("has sourceUtteranceIds, normalizedContent, authoredBy (lowercase)", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [
          makeProposition("prop-1", {
            source_message_ids: ["msg-001", "msg-002"],
            canonical_meaning: "User wants to move",
            speaker_role: "USER",
            provenance: "DIRECT",
          }),
        ],
        associations: [makeAssociation("a-1", "prop-1", "c-1")],
      });
      const projection = projectToV2Snapshot(state);
      const v2Prop = projection.propositions[0];

      expect(v2Prop.sourceUtteranceIds).toEqual(["msg-001", "msg-002"]);
      expect(v2Prop.normalizedContent).toBe("User wants to move");
      expect(v2Prop.authoredBy).toBe("user");
      expect(v2Prop.provenance).toBe("direct");
    });

    it("assistant propositions have authoredBy='assistant'", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-asst", { speaker_role: "ASSISTANT" })],
        associations: [makeAssociation("a-1", "prop-asst", "c-1")],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.propositions[0].authoredBy).toBe("assistant");
    });
  });

  describe("parent hierarchy produces child_of relationships", () => {
    it("creates child_of relationship for PARENT_ASSIGNED", () => {
      const state = makeGraphState({
        concerns: [
          makeConcern("c-parent"),
          makeConcern("c-child", {
            canonical_parent_id: "c-parent",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
        ],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.relationships).toHaveLength(1);
      const rel = projection.relationships[0];
      expect(rel.type).toBe("child_of");
      expect(rel.sourceObjectId).toBe("c-child");
      expect(rel.targetObjectId).toBe("c-parent");
      expect(rel.family).toBe("structural");
    });

    it("does not create relationship for ROOT_CONFIRMED", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-root", { parent_resolution_state: "ROOT_CONFIRMED" })],
      });
      const projection = projectToV2Snapshot(state);
      expect(projection.relationships).toHaveLength(0);
    });

    it("does not create relationship for PARENT_DEFERRED", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-deferred", { parent_resolution_state: "PARENT_DEFERRED" })],
      });
      const projection = projectToV2Snapshot(state);
      expect(projection.relationships).toHaveLength(0);
    });

    it("all parent relationships have equal confidence (no invented ranking)", () => {
      const state = makeGraphState({
        concerns: [
          makeConcern("c-root"),
          makeConcern("c-a", { canonical_parent_id: "c-root", parent_resolution_state: "PARENT_ASSIGNED" }),
          makeConcern("c-b", { canonical_parent_id: "c-root", parent_resolution_state: "PARENT_ASSIGNED" }),
        ],
      });
      const projection = projectToV2Snapshot(state);

      for (const rel of projection.relationships) {
        expect(rel.confidence).toBe(1.0);
      }
    });
  });

  describe("DerivedHierarchyNode and DerivedTree structure", () => {
    it("creates proper hierarchy nodes with depth and children", () => {
      const state = makeGraphState({
        concerns: [
          makeConcern("c-root"),
          makeConcern("c-child-a", { canonical_parent_id: "c-root", parent_resolution_state: "PARENT_ASSIGNED" }),
          makeConcern("c-child-b", { canonical_parent_id: "c-root", parent_resolution_state: "PARENT_ASSIGNED" }),
        ],
      });
      const projection = projectToV2Snapshot(state);

      const rootNode = projection.hierarchy.find((n) => n.objectId === "c-root");
      expect(rootNode).toBeDefined();
      expect(rootNode!.depth).toBe(0);
      expect(rootNode!.parentObjectId).toBeNull();
      expect(rootNode!.childObjectIds).toContain("c-child-a");
      expect(rootNode!.childObjectIds).toContain("c-child-b");

      const childA = projection.hierarchy.find((n) => n.objectId === "c-child-a");
      expect(childA!.depth).toBe(1);
      expect(childA!.parentObjectId).toBe("c-root");
    });

    it("creates one tree per root concern", () => {
      const state = makeGraphState({
        concerns: [
          makeConcern("c-root-1"),
          makeConcern("c-root-2"),
          makeConcern("c-child", { canonical_parent_id: "c-root-1", parent_resolution_state: "PARENT_ASSIGNED" }),
        ],
      });
      const projection = projectToV2Snapshot(state);

      expect(projection.trees.length).toBeGreaterThanOrEqual(2);
      const tree1 = projection.trees.find((t) => t.rootObjectId === "c-root-1");
      expect(tree1!.objectIds).toContain("c-child");
    });
  });

  describe("UNAPPROVED_MAPPING_FLAGS are explicitly documented", () => {
    it("objectType flag is 'unresolved'", () => {
      expect(UNAPPROVED_MAPPING_FLAGS.objectType).toBe("unresolved");
    });

    it("maturity flag is 'developing'", () => {
      expect(UNAPPROVED_MAPPING_FLAGS.maturity).toBe("developing");
    });

    it("parentRelationshipConfidence flag is 1.0", () => {
      expect(UNAPPROVED_MAPPING_FLAGS.parentRelationshipConfidence).toBe(1.0);
    });

    it("propositionConfidence flag is 1.0", () => {
      expect(UNAPPROVED_MAPPING_FLAGS.propositionConfidence).toBe(1.0);
    });
  });
});
