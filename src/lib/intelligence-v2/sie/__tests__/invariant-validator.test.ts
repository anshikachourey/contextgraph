/**
 * Invariant Validator Tests
 *
 * Verifies deterministic structural invariant validation for the SIE pipeline:
 * - Cycle detection in parent hierarchy
 * - Multiple active PRIMARY_OWNER rejection
 * - Cross-conversation boundary violation
 * - Stale graph version detection (version_conflict)
 * - Dangling reference detection
 * - Parent-resolution consistency
 * - Valid state passes all invariants
 * - ALL_OR_NONE dependency group completeness
 */
import { describe, it, expect } from "vitest";
import { validateInvariants } from "../invariant-validator";
import type { SIEGraphState, ProcessResult } from "../types";
import type { components } from "../generated/transport-types";

type ConcernSummary = components["schemas"]["ConcernSummary"];
type Proposition = components["schemas"]["Proposition"];
type PropositionAssociation = components["schemas"]["PropositionAssociation"];
type SemanticPacket = components["schemas"]["SemanticPacket"];

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeEmptyGraphState(overrides?: Partial<SIEGraphState>): SIEGraphState {
  return {
    graphVersion: 5,
    concerns: [],
    propositions: [],
    associations: [],
    packets: [],
    ...overrides,
  };
}

function makeMinimalProcessResult(
  overrides?: Partial<ProcessResult>
): ProcessResult {
  return {
    api_contract_version: "1.1.0",
    pipeline_version: "0.1.0",
    model_version: "gpt-4o",
    extraction_version: "0.1.0",
    request_id: "req-test-001",
    idempotency_key: "conv-001:seq-1-5:pipe-0.1.0",
    conversation_id: "conv-001",
    base_graph_version: 5,
    lowest_seq: 1,
    highest_seq: 5,
    retention_decisions: [],
    propositions: [],
    packets: [],
    packet_memberships: [],
    splits: [],
    identity_resolutions: [],
    new_concern_proposals: [],
    proposed_associations: [],
    dependency_groups: [],
    diagnostics: {
      stage_versions: { retention: "0.1.0" },
      warnings: [],
      deferred_entity_ids: [],
    },
    ...overrides,
  };
}

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
    message_seq_range: [1, 1],
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

// ─── Test Suites ────────────────────────────────────────────────────────────

describe("Invariant Validator", () => {
  describe("cycle detection in parent hierarchy", () => {
    it("detects a direct cycle (A→B→A)", () => {
      const graphState = makeEmptyGraphState({
        concerns: [
          makeConcern("c-a", {
            canonical_parent_id: "c-b",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
          makeConcern("c-b", {
            canonical_parent_id: "c-a",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
        ],
      });

      const result = validateInvariants(
        makeMinimalProcessResult(),
        graphState,
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some((v) => v.type === "cycle_detected")
      ).toBe(true);
    });

    it("detects an indirect cycle (A→B→C→A)", () => {
      const graphState = makeEmptyGraphState({
        concerns: [
          makeConcern("c-a", {
            canonical_parent_id: "c-b",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
          makeConcern("c-b", {
            canonical_parent_id: "c-c",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
          makeConcern("c-c", {
            canonical_parent_id: "c-a",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
        ],
      });

      const result = validateInvariants(
        makeMinimalProcessResult(),
        graphState,
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some((v) => v.type === "cycle_detected")
      ).toBe(true);
    });

    it("detects cycle introduced by a new concern proposal", () => {
      const graphState = makeEmptyGraphState({
        concerns: [
          makeConcern("c-existing", {
            canonical_parent_id: "c-new",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
        ],
      });

      const processResult = makeMinimalProcessResult({
        new_concern_proposals: [
          {
            concern_creation_key: "key-new",
            proposed_concern_id: "c-new",
            identity_summary: "New concern",
            display_title: "New",
            initial_summary: "New concern summary",
            proposed_parent_id: "c-existing",
            parent_resolution_state: "PARENT_ASSIGNED",
          },
        ],
      });

      const result = validateInvariants(processResult, graphState, 5);

      expect(result.valid).toBe(false);
      expect(
        result.violations.some((v) => v.type === "cycle_detected")
      ).toBe(true);
    });
  });

  describe("multiple active PRIMARY_OWNER rejection", () => {
    it("rejects proposition with multiple active PRIMARY_OWNER associations", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        proposed_associations: [
          makeAssociation("assoc-1", "prop-001", "concern-a"),
          makeAssociation("assoc-2", "prop-001", "concern-b"),
        ],
      });

      const graphState = makeEmptyGraphState({
        concerns: [
          makeConcern("concern-a"),
          makeConcern("concern-b"),
        ],
      });

      const result = validateInvariants(processResult, graphState, 5);

      expect(result.valid).toBe(false);
      expect(
        result.violations.some((v) => v.type === "multi_parent")
      ).toBe(true);
      expect(
        result.violations.some((v) =>
          v.description.includes("PRIMARY_OWNER")
        )
      ).toBe(true);
    });

    it("allows one PRIMARY_OWNER plus other roles for same proposition", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        proposed_associations: [
          makeAssociation("assoc-1", "prop-001", "concern-a"),
          makeAssociation("assoc-2", "prop-001", "concern-b", {
            role: "SUPPORTING_EVIDENCE",
          }),
        ],
      });

      const graphState = makeEmptyGraphState({
        concerns: [
          makeConcern("concern-a"),
          makeConcern("concern-b"),
        ],
      });

      const result = validateInvariants(processResult, graphState, 5);

      // Should NOT have a multi_parent violation
      expect(
        result.violations.filter((v) => v.type === "multi_parent")
      ).toHaveLength(0);
    });
  });

  describe("cross-conversation boundary violation", () => {
    it("rejects proposition with different conversation_id", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [
          makeProposition("prop-001", { conversation_id: "conv-OTHER" }),
        ],
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState(),
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) => v.entityId === "prop-001" && v.description.includes("conversation_id")
        )
      ).toBe(true);
    });

    it("rejects packet with different conversation_id", () => {
      const processResult = makeMinimalProcessResult({
        packets: [
          {
            packet_id: "pkt-001",
            packet_creation_key: "conv-OTHER:req:partition-0",
            conversation_id: "conv-OTHER",
            source_message_ids: ["msg-001"],
            message_seq_range: [1, 1] as [number, number],
            user_grounded_meaning: "Test",
            assistant_context: null,
            continuation_origin: null,
            provenance: "extraction",
            packet_formation_version: "0.1.0",
            cohesion_status: "COHESIVE",
            provisional_boundaries: [],
          },
        ],
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState(),
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) => v.entityId === "pkt-001" && v.description.includes("conversation_id")
        )
      ).toBe(true);
    });
  });

  describe("stale graph version detection (version_conflict)", () => {
    it("rejects when base_graph_version does not match expected", () => {
      const processResult = makeMinimalProcessResult({
        base_graph_version: 3,
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState({ graphVersion: 5 }),
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some((v) => v.type === "version_conflict")
      ).toBe(true);
      expect(
        result.violations.some((v) =>
          v.description.includes("does not match expected version")
        )
      ).toBe(true);
    });

    it("passes when base_graph_version matches expected", () => {
      const processResult = makeMinimalProcessResult({
        base_graph_version: 5,
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState({ graphVersion: 5 }),
        5
      );

      expect(
        result.violations.filter((v) => v.type === "version_conflict")
      ).toHaveLength(0);
    });
  });

  describe("dangling reference detection", () => {
    it("rejects association referencing non-existent proposition", () => {
      const processResult = makeMinimalProcessResult({
        proposed_associations: [
          makeAssociation("assoc-1", "prop-MISSING", "concern-a"),
        ],
      });

      const graphState = makeEmptyGraphState({
        concerns: [makeConcern("concern-a")],
      });

      const result = validateInvariants(processResult, graphState, 5);

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.type === "dangling_reference" &&
            v.description.includes("non-existent proposition")
        )
      ).toBe(true);
    });

    it("rejects association referencing non-existent concern", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        proposed_associations: [
          makeAssociation("assoc-1", "prop-001", "concern-MISSING"),
        ],
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState(),
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.type === "dangling_reference" &&
            v.description.includes("non-existent concern")
        )
      ).toBe(true);
    });

    it("rejects packet membership referencing non-existent proposition", () => {
      const processResult = makeMinimalProcessResult({
        packets: [
          {
            packet_id: "pkt-001",
            packet_creation_key: "conv-001:req:partition-0",
            conversation_id: "conv-001",
            source_message_ids: ["msg-001"],
            message_seq_range: [1, 1] as [number, number],
            user_grounded_meaning: "Test",
            assistant_context: null,
            continuation_origin: null,
            provenance: "extraction",
            packet_formation_version: "0.1.0",
            cohesion_status: "COHESIVE",
            provisional_boundaries: [],
          },
        ],
        packet_memberships: [
          {
            membership_id: "mem-001",
            membership_creation_key: "pkt-001:prop-GONE:ord-0",
            packet_id: "pkt-001",
            proposition_id: "prop-GONE",
            ordinal: 0,
            created_at: "2024-06-01T10:00:00Z",
          },
        ],
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState(),
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.type === "dangling_reference" &&
            v.entityId === "mem-001" &&
            v.description.includes("non-existent proposition")
        )
      ).toBe(true);
    });
  });

  describe("parent-resolution consistency", () => {
    it("rejects PARENT_ASSIGNED without parent_id", () => {
      const processResult = makeMinimalProcessResult({
        new_concern_proposals: [
          {
            concern_creation_key: "key-1",
            proposed_concern_id: "c-new",
            identity_summary: "New concern",
            display_title: "New",
            initial_summary: "Summary",
            proposed_parent_id: null,
            parent_resolution_state: "PARENT_ASSIGNED",
          },
        ],
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState(),
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.entityId === "c-new" &&
            v.description.includes("PARENT_ASSIGNED") &&
            v.description.includes("null")
        )
      ).toBe(true);
    });

    it("rejects ROOT_CONFIRMED with parent_id set", () => {
      const processResult = makeMinimalProcessResult({
        new_concern_proposals: [
          {
            concern_creation_key: "key-1",
            proposed_concern_id: "c-new",
            identity_summary: "New concern",
            display_title: "New",
            initial_summary: "Summary",
            proposed_parent_id: "c-parent",
            parent_resolution_state: "ROOT_CONFIRMED",
          },
        ],
      });

      const graphState = makeEmptyGraphState({
        concerns: [makeConcern("c-parent")],
      });

      const result = validateInvariants(processResult, graphState, 5);

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.entityId === "c-new" &&
            v.description.includes("ROOT_CONFIRMED")
        )
      ).toBe(true);
    });
  });

  describe("valid state passes all invariants", () => {
    it("returns valid=true for a well-formed process result", () => {
      const graphState = makeEmptyGraphState({
        concerns: [
          makeConcern("concern-a"),
          makeConcern("concern-b", {
            canonical_parent_id: "concern-a",
            parent_resolution_state: "PARENT_ASSIGNED",
          }),
        ],
      });

      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        packets: [
          {
            packet_id: "pkt-001",
            packet_creation_key: "conv-001:req:partition-0",
            conversation_id: "conv-001",
            source_message_ids: ["msg-001"],
            message_seq_range: [1, 1] as [number, number],
            user_grounded_meaning: "Test meaning",
            assistant_context: null,
            continuation_origin: null,
            provenance: "extraction",
            packet_formation_version: "0.1.0",
            cohesion_status: "COHESIVE",
            provisional_boundaries: [],
          },
        ],
        packet_memberships: [
          {
            membership_id: "mem-001",
            membership_creation_key: "pkt-001:prop-001:ord-0",
            packet_id: "pkt-001",
            proposition_id: "prop-001",
            ordinal: 0,
            created_at: "2024-06-01T10:00:00Z",
          },
        ],
        proposed_associations: [
          makeAssociation("assoc-1", "prop-001", "concern-a"),
        ],
        identity_resolutions: [
          {
            packet_id: "pkt-001",
            outcome: "YES",
            confidence: "HIGH",
            matched_concern_id: "concern-a",
            new_concern_proposal: null,
            candidates_considered: ["concern-a"],
            rationale: "Matches existing concern",
          },
        ],
      });

      const result = validateInvariants(processResult, graphState, 5);

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe("ALL_OR_NONE dependency group completeness", () => {
    it("rejects when ALL_OR_NONE group has missing mutation refs", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        dependency_groups: [
          {
            group_id: "grp-001",
            mutation_refs: ["prop-001", "assoc-MISSING"],
            failure_policy: "ALL_OR_NONE",
          },
        ],
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState(),
        5
      );

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.entityId === "grp-001" &&
            v.description.includes("ALL_OR_NONE") &&
            v.description.includes("assoc-MISSING")
        )
      ).toBe(true);
    });

    it("passes when ALL_OR_NONE group has all refs present", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        proposed_associations: [
          makeAssociation("assoc-001", "prop-001", "concern-a"),
        ],
        dependency_groups: [
          {
            group_id: "grp-001",
            mutation_refs: ["prop-001", "assoc-001"],
            failure_policy: "ALL_OR_NONE",
          },
        ],
      });

      const graphState = makeEmptyGraphState({
        concerns: [makeConcern("concern-a")],
      });

      const result = validateInvariants(processResult, graphState, 5);

      // No dependency-group violations
      expect(
        result.violations.filter(
          (v) => v.entityId === "grp-001"
        )
      ).toHaveLength(0);
    });

    it("rejects INDEPENDENT groups with missing refs (dangling references are never acceptable)", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        dependency_groups: [
          {
            group_id: "grp-independent",
            mutation_refs: ["prop-001", "something-else"],
            failure_policy: "INDEPENDENT",
          },
        ],
      });

      const result = validateInvariants(
        processResult,
        makeEmptyGraphState(),
        5
      );

      // INDEPENDENT means mutations may commit/fail independently at execution
      // time, but every referenced mutation ID must still exist in the result.
      // Dangling references indicate a structurally incomplete ProcessResult.
      expect(
        result.violations.filter(
          (v) => v.entityId === "grp-independent"
        )
      ).toHaveLength(1);
      expect(
        result.violations.some(
          (v) =>
            v.entityId === "grp-independent" &&
            v.description.includes("something-else")
        )
      ).toBe(true);
    });
  });
});
