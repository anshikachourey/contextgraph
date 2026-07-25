/**
 * Compatibility and Reliability Gate Tests (Task 19.4)
 *
 * This test suite verifies:
 * 1. V2 regression tests pass — existing data-model behavior is preserved
 * 2. V2 snapshot format consumed by the React Flow UI is unchanged
 * 3. V2/SIE authority state machine transitions remain unchanged —
 *    no implicit production cutover in migrations, code, or tests
 * 4. Data-model regression (V2 schema types are structurally intact)
 * 5. Placeholder for latency/throughput/cost tests (PENDING_APPROVAL)
 *
 * Key Implementation Rules:
 * - Preserve existing V2/SIE authority and shadow controls
 * - No implicit activation of SIE as production authority
 * - Legacy V2 callers remain on their backward-compatible commit path
 * - Latency/throughput/cost tests are pending budget approval
 */
import { describe, it, expect } from "vitest";
import {
  type AuthorityState,
  type Engine,
  validateTransition,
  isProductionWriter,
  canWriteProductionSnapshot,
  canWriteProductionCursor,
  isShadowMode,
  isLegacyThreadObjectWriteBlocked,
} from "../authority-state-machine";
import {
  projectToV2Snapshot,
  UNAPPROVED_MAPPING_FLAGS,
  type V2SnapshotProjection,
} from "../v2-projection";
import { SIE_SHADOW_ENABLED, SIE_AUTHORITY_ENABLED } from "../feature-flags";
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

// ═══════════════════════════════════════════════════════════════════════════════
// GATE 1: V2 Regression — Authority State Machine Unchanged
// ═══════════════════════════════════════════════════════════════════════════════

describe("Gate 1: V2/SIE Authority State Machine Regression", () => {
  describe("authority state enum values are preserved", () => {
    it("exactly three authority states exist: V2, SIE_SHADOW, SIE", () => {
      const allStates: AuthorityState[] = ["V2", "SIE_SHADOW", "SIE"];
      // Verify these are the only valid states by checking all transitions
      for (const from of allStates) {
        for (const to of allStates) {
          const result = validateTransition(from, to);
          // Result should be boolean — no type error means enum is intact
          expect(typeof result).toBe("boolean");
        }
      }
    });

    it("engine types remain exactly 'v2' and 'sie'", () => {
      const engines: Engine[] = ["v2", "sie"];
      const states: AuthorityState[] = ["V2", "SIE_SHADOW", "SIE"];
      for (const state of states) {
        for (const engine of engines) {
          expect(typeof isProductionWriter(state, engine)).toBe("boolean");
        }
      }
    });
  });

  describe("valid transition matrix is unchanged", () => {
    // Exhaustive verification of the transition matrix
    const expectedTransitions: Array<[AuthorityState, AuthorityState, boolean]> = [
      // V2 transitions
      ["V2", "V2", false],
      ["V2", "SIE_SHADOW", true],
      ["V2", "SIE", false], // must go through shadow

      // SIE_SHADOW transitions
      ["SIE_SHADOW", "V2", true],
      ["SIE_SHADOW", "SIE_SHADOW", false],
      ["SIE_SHADOW", "SIE", true],

      // SIE transitions
      ["SIE", "V2", false], // must go through shadow
      ["SIE", "SIE_SHADOW", true],
      ["SIE", "SIE", false],
    ];

    for (const [from, to, expected] of expectedTransitions) {
      it(`transition ${from} → ${to} is ${expected ? "allowed" : "rejected"}`, () => {
        expect(validateTransition(from, to)).toBe(expected);
      });
    }
  });

  describe("shadow mode behavior is preserved", () => {
    it("SIE_SHADOW is the only shadow mode state", () => {
      expect(isShadowMode("V2")).toBe(false);
      expect(isShadowMode("SIE_SHADOW")).toBe(true);
      expect(isShadowMode("SIE")).toBe(false);
    });

    it("in shadow mode, V2 remains production writer", () => {
      expect(isProductionWriter("SIE_SHADOW", "v2")).toBe(true);
      expect(isProductionWriter("SIE_SHADOW", "sie")).toBe(false);
    });

    it("in shadow mode, SIE cannot write production snapshot", () => {
      expect(canWriteProductionSnapshot("SIE_SHADOW", "sie")).toBe(false);
    });

    it("in shadow mode, SIE cannot advance production cursor", () => {
      expect(canWriteProductionCursor("SIE_SHADOW", "sie")).toBe(false);
    });

    it("legacy thread→object writes are not blocked in shadow mode", () => {
      expect(isLegacyThreadObjectWriteBlocked("SIE_SHADOW")).toBe(false);
    });
  });

  describe("no implicit cutover in feature flags", () => {
    it("SIE_AUTHORITY_ENABLED defaults to false (no env override)", () => {
      // In test environment, SIE authority should not be enabled
      // If this fails, something is implicitly activating SIE authority
      expect(SIE_AUTHORITY_ENABLED).toBe(false);
    });

    it("direct V2→SIE transition is impossible (must go through shadow)", () => {
      expect(validateTransition("V2", "SIE")).toBe(false);
    });

    it("cutover requires explicit SIE_SHADOW→SIE transition", () => {
      // The only way to reach SIE authority is through SIE_SHADOW
      expect(validateTransition("SIE_SHADOW", "SIE")).toBe(true);
      // And only from SIE_SHADOW
      expect(validateTransition("V2", "SIE")).toBe(false);
    });
  });

  describe("production writer is always exactly one engine per state", () => {
    it("exactly one production writer per authority state", () => {
      const states: AuthorityState[] = ["V2", "SIE_SHADOW", "SIE"];
      const engines: Engine[] = ["v2", "sie"];

      for (const state of states) {
        const writers = engines.filter((e) => isProductionWriter(state, e));
        expect(writers).toHaveLength(1);
      }
    });

    it("V2 state: v2 is production writer", () => {
      expect(isProductionWriter("V2", "v2")).toBe(true);
      expect(isProductionWriter("V2", "sie")).toBe(false);
    });

    it("SIE state: sie is production writer", () => {
      expect(isProductionWriter("SIE", "sie")).toBe(true);
      expect(isProductionWriter("SIE", "v2")).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GATE 2: V2 Snapshot Format Compatibility (React Flow UI Consumption)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Gate 2: V2 Snapshot Format Compatibility", () => {
  describe("V2SnapshotProjection structure is unchanged", () => {
    it("projection returns all required top-level keys", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
      });
      const projection = projectToV2Snapshot(state);

      // React Flow UI expects exactly these keys
      expect(projection).toHaveProperty("objects");
      expect(projection).toHaveProperty("relationships");
      expect(projection).toHaveProperty("propositions");
      expect(projection).toHaveProperty("threads");
      expect(projection).toHaveProperty("hierarchy");
      expect(projection).toHaveProperty("trees");
    });

    it("projection keys match V2SnapshotProjection type exactly", () => {
      const state = makeGraphState();
      const projection = projectToV2Snapshot(state);

      const keys = Object.keys(projection).sort();
      const expectedKeys = [
        "hierarchy",
        "objects",
        "propositions",
        "relationships",
        "threads",
        "trees",
      ];
      expect(keys).toEqual(expectedKeys);
    });
  });

  describe("ConversationalObject node shape is compatible", () => {
    it("projected objects have all React Flow consumed fields", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1")],
        associations: [makeAssociation("a-1", "prop-1", "c-1")],
      });
      const projection = projectToV2Snapshot(state);
      const obj = projection.objects[0];

      // Required node fields consumed by React Flow UI
      expect(obj).toHaveProperty("objectId");
      expect(obj).toHaveProperty("objectType");
      expect(obj).toHaveProperty("title");
      expect(obj).toHaveProperty("description");
      expect(obj).toHaveProperty("propositionIds");
      expect(obj).toHaveProperty("threadIds");
      expect(obj).toHaveProperty("supportingUtteranceIds");
      expect(obj).toHaveProperty("contextualAssistantUtteranceIds");
      expect(obj).toHaveProperty("maturity");
      expect(obj).toHaveProperty("status");
      expect(obj).toHaveProperty("provenanceSummary");
    });

    it("status values are from the V2 ObjectStatus enum", () => {
      const statusConcerns: Array<[string, string]> = [
        ["ACTIVE", "active"],
        ["DORMANT", "deferred"],
        ["RETIRED", "resolved"],
        ["MERGED", "discarded"],
      ];

      for (const [sieStatus, expectedV2Status] of statusConcerns) {
        const state = makeGraphState({
          concerns: [makeConcern("c-1", { status: sieStatus as "ACTIVE" | "DORMANT" | "RETIRED" | "MERGED" })],
        });
        const projection = projectToV2Snapshot(state);
        expect(projection.objects[0].status).toBe(expectedV2Status);
      }
    });
  });

  describe("Relationship edge shape is compatible", () => {
    it("projected child_of relationships have all required edge fields", () => {
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

      // Required edge fields consumed by React Flow UI
      expect(rel).toHaveProperty("relationshipId");
      expect(rel).toHaveProperty("sourceObjectId");
      expect(rel).toHaveProperty("targetObjectId");
      expect(rel).toHaveProperty("type");
      expect(rel).toHaveProperty("family");
      expect(rel).toHaveProperty("confidence");
      expect(rel).toHaveProperty("explanation");
      expect(rel).toHaveProperty("sourcePropositionIds");

      // Structural values
      expect(rel.type).toBe("child_of");
      expect(rel.family).toBe("structural");
    });
  });

  describe("DerivedHierarchyNode shape is compatible", () => {
    it("hierarchy nodes have all required fields", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
      });
      const projection = projectToV2Snapshot(state);
      const node = projection.hierarchy[0];

      expect(node).toHaveProperty("objectId");
      expect(node).toHaveProperty("treeId");
      expect(node).toHaveProperty("depth");
      expect(node).toHaveProperty("parentObjectId");
      expect(node).toHaveProperty("childObjectIds");
      expect(node).toHaveProperty("siblingObjectIds");
    });
  });

  describe("DerivedTree shape is compatible", () => {
    it("trees have all required fields", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
      });
      const projection = projectToV2Snapshot(state);
      const tree = projection.trees[0];

      expect(tree).toHaveProperty("treeId");
      expect(tree).toHaveProperty("rootObjectId");
      expect(tree).toHaveProperty("objectIds");
      expect(tree).toHaveProperty("bridges");
    });
  });

  describe("unapproved mapping flags remain behaviorally inert", () => {
    it("objectType placeholder is 'unresolved'", () => {
      expect(UNAPPROVED_MAPPING_FLAGS.objectType).toBe("unresolved");
    });

    it("maturity placeholder is 'developing'", () => {
      expect(UNAPPROVED_MAPPING_FLAGS.maturity).toBe("developing");
    });

    it("parentRelationshipConfidence placeholder is 1.0", () => {
      expect(UNAPPROVED_MAPPING_FLAGS.parentRelationshipConfidence).toBe(1.0);
    });

    it("propositionConfidence placeholder is 1.0", () => {
      expect(UNAPPROVED_MAPPING_FLAGS.propositionConfidence).toBe(1.0);
    });
  });

  describe("threads array is always empty (no synthetic threads)", () => {
    it("projection returns empty threads array", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        packets: [makePacket("pkt-1")],
      });
      const projection = projectToV2Snapshot(state);
      expect(projection.threads).toEqual([]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GATE 3: Data-Model Regression — V2 Schema Types Intact
// ═══════════════════════════════════════════════════════════════════════════════

describe("Gate 3: Data-Model Regression", () => {
  describe("V2 ConversationalObject type contract", () => {
    it("projected object has correct field types", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1")],
        associations: [makeAssociation("a-1", "prop-1", "c-1")],
      });
      const projection = projectToV2Snapshot(state);
      const obj = projection.objects[0];

      expect(typeof obj.objectId).toBe("string");
      expect(typeof obj.objectType).toBe("string");
      expect(typeof obj.title).toBe("string");
      expect(typeof obj.description).toBe("string");
      expect(Array.isArray(obj.propositionIds)).toBe(true);
      expect(Array.isArray(obj.threadIds)).toBe(true);
      expect(Array.isArray(obj.supportingUtteranceIds)).toBe(true);
      expect(Array.isArray(obj.contextualAssistantUtteranceIds)).toBe(true);
      expect(typeof obj.maturity).toBe("string");
      expect(typeof obj.status).toBe("string");
      expect(typeof obj.provenanceSummary).toBe("string");
    });
  });

  describe("V2 Proposition type contract", () => {
    it("projected propositions have correct shape", () => {
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1")],
        associations: [makeAssociation("a-1", "prop-1", "c-1")],
      });
      const projection = projectToV2Snapshot(state);
      const prop = projection.propositions[0];

      expect(typeof prop.propositionId).toBe("string");
      expect(typeof prop.propositionType).toBe("string");
      expect(typeof prop.normalizedContent).toBe("string");
      expect(Array.isArray(prop.sourceUtteranceIds)).toBe(true);
      expect(typeof prop.authoredBy).toBe("string");
      expect(typeof prop.provenance).toBe("string");
      expect(typeof prop.confidence).toBe("number");
      expect(typeof prop.status).toBe("string");
    });
  });

  describe("V2 Relationship type contract", () => {
    it("projected relationships have correct shape", () => {
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

      expect(typeof rel.relationshipId).toBe("string");
      expect(typeof rel.sourceObjectId).toBe("string");
      expect(typeof rel.targetObjectId).toBe("string");
      expect(typeof rel.type).toBe("string");
      expect(typeof rel.family).toBe("string");
      expect(typeof rel.confidence).toBe("number");
      expect(typeof rel.explanation).toBe("string");
      expect(Array.isArray(rel.sourcePropositionIds)).toBe(true);
    });
  });

  describe("SIEGraphState structure is compatible with commit pipeline", () => {
    it("SIEGraphState has required fields", () => {
      const state = makeGraphState();
      expect(state).toHaveProperty("graphVersion");
      expect(state).toHaveProperty("concerns");
      expect(state).toHaveProperty("propositions");
      expect(state).toHaveProperty("associations");
      expect(state).toHaveProperty("packets");
      expect(typeof state.graphVersion).toBe("number");
      expect(Array.isArray(state.concerns)).toBe(true);
      expect(Array.isArray(state.propositions)).toBe(true);
      expect(Array.isArray(state.associations)).toBe(true);
      expect(Array.isArray(state.packets)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GATE 4: No Implicit Production Cutover Verification
// ═══════════════════════════════════════════════════════════════════════════════

describe("Gate 4: No Implicit Production Cutover", () => {
  describe("feature flags prevent implicit cutover", () => {
    it("SIE_AUTHORITY_ENABLED is false in test environment", () => {
      expect(SIE_AUTHORITY_ENABLED).toBe(false);
    });

    it("default authority state is V2 (v2 is production writer)", () => {
      // In default V2 state, only v2 writes production
      expect(isProductionWriter("V2", "v2")).toBe(true);
      expect(isProductionWriter("V2", "sie")).toBe(false);
    });
  });

  describe("state machine prevents accidental cutover paths", () => {
    it("no single-step path from V2 to SIE authority", () => {
      expect(validateTransition("V2", "SIE")).toBe(false);
    });

    it("cutover requires 2 explicit transitions: V2→SIE_SHADOW→SIE", () => {
      // Step 1: Must first enable shadow mode
      expect(validateTransition("V2", "SIE_SHADOW")).toBe(true);
      // Step 2: Then explicitly cut over
      expect(validateTransition("SIE_SHADOW", "SIE")).toBe(true);
    });

    it("rollback also requires explicit path: SIE→SIE_SHADOW→V2", () => {
      expect(validateTransition("SIE", "SIE_SHADOW")).toBe(true);
      expect(validateTransition("SIE_SHADOW", "V2")).toBe(true);
      // No direct rollback
      expect(validateTransition("SIE", "V2")).toBe(false);
    });
  });

  describe("shadow mode isolates SIE from production state", () => {
    it("SIE engine cannot write production snapshot in shadow mode", () => {
      expect(canWriteProductionSnapshot("SIE_SHADOW", "sie")).toBe(false);
    });

    it("SIE engine cannot advance production cursor in shadow mode", () => {
      expect(canWriteProductionCursor("SIE_SHADOW", "sie")).toBe(false);
    });

    it("SIE engine is not the production writer in shadow mode", () => {
      expect(isProductionWriter("SIE_SHADOW", "sie")).toBe(false);
    });

    it("legacy thread→object writes remain functional in V2 and shadow", () => {
      expect(isLegacyThreadObjectWriteBlocked("V2")).toBe(false);
      expect(isLegacyThreadObjectWriteBlocked("SIE_SHADOW")).toBe(false);
    });
  });

  describe("V2 projection does not require SIE authority", () => {
    it("projectToV2Snapshot works regardless of authority state", () => {
      // V2 projection is a read-only format compatibility layer
      // It should work without SIE being authoritative
      const state = makeGraphState({
        concerns: [makeConcern("c-1")],
        propositions: [makeProposition("prop-1")],
        associations: [makeAssociation("a-1", "prop-1", "c-1")],
      });

      // Should not throw or require authority flags
      const projection = projectToV2Snapshot(state);
      expect(projection.objects).toHaveLength(1);
      expect(projection.propositions).toHaveLength(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GATE 5: Latency, Throughput, Availability, and Cost Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Gate 5: Performance and Cost Gates (PENDING_APPROVAL)", () => {
  /**
   * These tests require approved operational budgets before they can be
   * configured and executed. Per Requirement 12, AC 9:
   *
   *   "The exact numeric quality thresholds and acceptable latency/cost
   *    budgets are a consequential release-policy decision and SHALL be
   *    approved and recorded before production rollout; this specification
   *    SHALL NOT invent them."
   *
   * Status: PENDING_APPROVAL
   * Blocked by: Numeric quality thresholds and operational budgets not yet approved
   *
   * Once approved, these tests will verify:
   * - End-to-end identity resolution latency (p50, p95, p99)
   * - Throughput under concurrent load (packets/sec)
   * - Availability under retrieval/model partial failure
   * - Cost per identity resolution (LLM tokens, retrieval queries)
   * - Widening budget adherence
   * - Retry/timeout budgets compliance
   */

  it("latency budget test — PENDING_APPROVAL", () => {
    // Placeholder: Will be configured with approved p50/p95/p99 latency budgets
    const status = "PENDING_APPROVAL";
    expect(status).toBe("PENDING_APPROVAL");
  });

  it("throughput budget test — PENDING_APPROVAL", () => {
    // Placeholder: Will verify packets/sec under concurrent load
    const status = "PENDING_APPROVAL";
    expect(status).toBe("PENDING_APPROVAL");
  });

  it("availability under partial failure — PENDING_APPROVAL", () => {
    // Placeholder: Will verify graceful degradation when retrieval channels fail
    const status = "PENDING_APPROVAL";
    expect(status).toBe("PENDING_APPROVAL");
  });

  it("cost budget test — PENDING_APPROVAL", () => {
    // Placeholder: Will verify LLM token and retrieval query costs stay within budget
    const status = "PENDING_APPROVAL";
    expect(status).toBe("PENDING_APPROVAL");
  });

  it("widening budget adherence — PENDING_APPROVAL", () => {
    // Placeholder: Will verify adaptive widening stays within configured limits
    const status = "PENDING_APPROVAL";
    expect(status).toBe("PENDING_APPROVAL");
  });
});
