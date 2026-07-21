/**
 * Commit Manager Tests
 *
 * Tests for the SIE commit manager covering:
 * - Bundle generation from ProcessResult
 * - Commit flow with mocked RPC
 * - Payload fingerprint determinism (idempotency)
 * - Error injection / handling paths
 *
 * These tests mock the Supabase RPC layer to validate commit manager logic
 * without requiring a real PostgreSQL database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildCommitBundle,
  computePayloadFingerprint,
  commitSIEResult,
} from "../commit-manager";
import type { SIEGraphState, ProcessResult } from "../types";
import type { components } from "../generated/transport-types";

type ConcernSummary = components["schemas"]["ConcernSummary"];
type Proposition = components["schemas"]["Proposition"];
type PropositionAssociation = components["schemas"]["PropositionAssociation"];
type SemanticPacket = components["schemas"]["SemanticPacket"];
type ConcernProposal = components["schemas"]["ConcernProposal"];
type IdentityResolutionResult = components["schemas"]["IdentityResolutionResult"];
type RetentionDecision = components["schemas"]["RetentionDecision"];
type PacketMembership = components["schemas"]["PacketMembership"];
type PacketSplitRecord = components["schemas"]["PacketSplitRecord"];

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRpc = vi.fn();

vi.mock("@/src/lib/supabase/server", () => ({
  createServerSupabaseClient: () => ({
    rpc: mockRpc,
  }),
}));

vi.mock("../invariant-validator", () => ({
  validateInvariants: vi.fn(() => ({ valid: true, violations: [] })),
}));

vi.mock("../v2-projection", () => ({
  projectToV2Snapshot: vi.fn(() => ({ objects: [], propositions: [], threads: [] })),
}));


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


function makePacket(id: string, overrides?: Partial<SemanticPacket>): SemanticPacket {
  return {
    packet_id: id,
    packet_creation_key: `conv-001:req:partition-${id}`,
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
    ...overrides,
  };
}

function makeConcernProposal(
  id: string,
  overrides?: Partial<ConcernProposal>
): ConcernProposal {
  return {
    concern_creation_key: `conv-001:req:concern-${id}`,
    proposed_concern_id: id,
    identity_summary: `Identity for ${id}`,
    display_title: `Title for ${id}`,
    initial_summary: `Summary for ${id}`,
    proposed_parent_id: null,
    parent_resolution_state: "PARENT_DEFERRED",
    ...overrides,
  };
}

function makeMembership(
  id: string,
  packetId: string,
  propId: string,
  ordinal: number
): PacketMembership {
  return {
    membership_id: id,
    membership_creation_key: `${packetId}:${propId}:ord-${ordinal}`,
    packet_id: packetId,
    proposition_id: propId,
    ordinal,
    created_at: "2024-06-01T10:00:00Z",
  };
}


function makeSplit(
  id: string,
  originalPacketId: string,
  resultingPacketIds: string[]
): PacketSplitRecord {
  return {
    split_id: id,
    split_creation_key: `conv-001:req:split-${id}`,
    original_packet_id: originalPacketId,
    resulting_packet_ids: resultingPacketIds,
    split_reason: "mixed_cohesion",
    created_at: "2024-06-01T10:00:00Z",
  };
}

function makeRetentionDecision(
  id: string,
  overrides?: Partial<RetentionDecision>
): RetentionDecision {
  return {
    decision_id: id,
    decision_creation_key: `conv-001:req:retention-${id}`,
    conversation_id: "conv-001",
    primary_level: "DURABLE_PROPOSITION",
    secondary_roles: [],
    confidence: "HIGH",
    outcome: "YES",
    source_message_ids: ["msg-001"],
    speaker_role: "USER",
    sequence_position: 1,
    extraction_version: "0.1.0",
    assessment_version: "0.1.0",
    rationale: null,
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


// ─── Test Suites ────────────────────────────────────────────────────────────

describe("Commit Manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Bundle Generation Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("bundle generation", () => {
    it("produces correct bundle structure from a valid ProcessResult", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        packets: [makePacket("pkt-001")],
        new_concern_proposals: [makeConcernProposal("concern-new")],
        proposed_associations: [
          makeAssociation("assoc-001", "prop-001", "concern-new"),
        ],
        packet_memberships: [
          makeMembership("mem-001", "pkt-001", "prop-001", 0),
        ],
        retention_decisions: [makeRetentionDecision("ret-001")],
      });

      const graphState = makeEmptyGraphState();
      const bundle = buildCommitBundle(processResult, graphState);

      expect(bundle.conversationId).toBe("conv-001");
      expect(bundle.requestId).toBe("req-test-001");
      expect(bundle.idempotencyKey).toBe("conv-001:seq-1-5:pipe-0.1.0");
      expect(bundle.baseGraphVersion).toBe(5);
      expect(bundle.targetGraphVersion).toBe(6);
      expect(bundle.lowestSeq).toBe(1);
      expect(bundle.highestSeq).toBe(5);
      expect(bundle.propositions).toHaveLength(1);
      expect(bundle.packets).toHaveLength(1);
      expect(bundle.concerns).toHaveLength(1);
      expect(bundle.associations).toHaveLength(1);
      expect(bundle.memberships).toHaveLength(1);
      expect(bundle.retentionDecisions).toHaveLength(1);
      expect(bundle.payloadFingerprint).toMatch(/^fp_[0-9a-f]{8}$/);
    });

    it("entity registrations include all entity types", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001"), makeProposition("prop-002")],
        packets: [makePacket("pkt-001")],
        new_concern_proposals: [makeConcernProposal("concern-new")],
        proposed_associations: [
          makeAssociation("assoc-001", "prop-001", "concern-new"),
        ],
        packet_memberships: [
          makeMembership("mem-001", "pkt-001", "prop-001", 0),
        ],
        splits: [makeSplit("split-001", "pkt-001", ["pkt-001"])],
        retention_decisions: [makeRetentionDecision("ret-001")],
      });

      const bundle = buildCommitBundle(processResult, makeEmptyGraphState());

      // Should include registrations for all entity kinds
      const kindSet = new Set(bundle.entityRegistrations.map((r) => r.entity_kind));
      expect(kindSet).toContain("proposition");
      expect(kindSet).toContain("packet");
      expect(kindSet).toContain("concern");
      expect(kindSet).toContain("association");
      expect(kindSet).toContain("membership");
      expect(kindSet).toContain("split");
      expect(kindSet).toContain("retention_decision");

      // Correct count: 2 props + 1 pkt + 1 concern + 1 assoc + 1 mem + 1 split + 1 ret = 8
      expect(bundle.entityRegistrations).toHaveLength(8);
    });

    it("creates pending decisions from unresolved identity resolutions", () => {
      const processResult = makeMinimalProcessResult({
        packets: [makePacket("pkt-001"), makePacket("pkt-002")],
        identity_resolutions: [
          {
            packet_id: "pkt-001",
            outcome: "UNRESOLVED",
            confidence: "LOW",
            matched_concern_id: null,
            new_concern_proposal: null,
            candidates_considered: [],
            rationale: "Could not determine identity",
          },
          {
            packet_id: "pkt-002",
            outcome: "DEFER",
            confidence: "MEDIUM",
            matched_concern_id: null,
            new_concern_proposal: null,
            candidates_considered: ["c-a", "c-b"],
            rationale: "Awaiting more context",
          },
        ],
      });

      const bundle = buildCommitBundle(processResult, makeEmptyGraphState());

      expect(bundle.pendingDecisionCreations).toHaveLength(2);
      expect(bundle.pendingDecisionCreations[0].entity_id).toBe("pkt-001");
      expect(bundle.pendingDecisionCreations[0].stage).toBe("identity_resolution");
      expect(bundle.pendingDecisionCreations[0].outcome).toBe("UNRESOLVED");
      expect(bundle.pendingDecisionCreations[1].entity_id).toBe("pkt-002");
      expect(bundle.pendingDecisionCreations[1].outcome).toBe("DEFER");
    });

    it("creates pending decision resolutions from successful matches of previously-deferred entities", () => {
      const processResult = makeMinimalProcessResult({
        packets: [makePacket("pkt-deferred")],
        identity_resolutions: [
          {
            packet_id: "pkt-deferred",
            outcome: "YES",
            confidence: "HIGH",
            matched_concern_id: "concern-existing",
            new_concern_proposal: null,
            candidates_considered: ["concern-existing"],
            rationale: "Matched existing concern",
          },
        ],
        diagnostics: {
          stage_versions: { retention: "0.1.0" },
          warnings: [],
          deferred_entity_ids: ["pkt-deferred"],
        },
      });

      const graphState = makeEmptyGraphState({
        concerns: [makeConcern("concern-existing")],
      });

      const bundle = buildCommitBundle(processResult, graphState);

      expect(bundle.pendingDecisionResolutions).toHaveLength(1);
      expect(bundle.pendingDecisionResolutions[0].entity_id).toBe("pkt-deferred");
      expect(bundle.pendingDecisionResolutions[0].resolved_by_request_id).toBe("req-test-001");
    });

    it("generates audit entries for new concerns and associations", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        new_concern_proposals: [makeConcernProposal("concern-new")],
        proposed_associations: [
          makeAssociation("assoc-001", "prop-001", "concern-new"),
        ],
      });

      const bundle = buildCommitBundle(processResult, makeEmptyGraphState());

      // One audit entry for concern creation, one for association
      expect(bundle.auditEntries.length).toBeGreaterThanOrEqual(2);
      const concernAudit = bundle.auditEntries.find(
        (e) => e.entity_type === "concern"
      );
      expect(concernAudit).toBeDefined();
      expect(concernAudit!.entity_id).toBe("concern-new");
      expect(concernAudit!.new_value).toBe("ACTIVE");

      const assocAudit = bundle.auditEntries.find(
        (e) => e.entity_type === "association"
      );
      expect(assocAudit).toBeDefined();
      expect(assocAudit!.entity_id).toBe("assoc-001");
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // Payload Fingerprint / Idempotency Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("payload fingerprint determinism", () => {
    it("same ProcessResult always produces same fingerprint", () => {
      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001"), makeProposition("prop-002")],
        packets: [makePacket("pkt-001")],
        new_concern_proposals: [makeConcernProposal("concern-new")],
        proposed_associations: [
          makeAssociation("assoc-001", "prop-001", "concern-new"),
        ],
        packet_memberships: [
          makeMembership("mem-001", "pkt-001", "prop-001", 0),
        ],
        splits: [makeSplit("split-001", "pkt-001", ["pkt-001"])],
        retention_decisions: [makeRetentionDecision("ret-001")],
      });

      const fp1 = computePayloadFingerprint(processResult);
      const fp2 = computePayloadFingerprint(processResult);
      const fp3 = computePayloadFingerprint(processResult);

      expect(fp1).toBe(fp2);
      expect(fp2).toBe(fp3);
      expect(fp1).toMatch(/^fp_[0-9a-f]{8}$/);
    });

    it("different ProcessResult produces different fingerprint", () => {
      const resultA = makeMinimalProcessResult({
        request_id: "req-A",
        propositions: [makeProposition("prop-001")],
      });

      const resultB = makeMinimalProcessResult({
        request_id: "req-B",
        propositions: [makeProposition("prop-002")],
      });

      const fpA = computePayloadFingerprint(resultA);
      const fpB = computePayloadFingerprint(resultB);

      expect(fpA).not.toBe(fpB);
    });

    it("fingerprint is independent of entity insertion order", () => {
      const resultOrdered = makeMinimalProcessResult({
        propositions: [makeProposition("prop-a"), makeProposition("prop-b")],
      });

      const resultReversed = makeMinimalProcessResult({
        propositions: [makeProposition("prop-b"), makeProposition("prop-a")],
      });

      const fpOrdered = computePayloadFingerprint(resultOrdered);
      const fpReversed = computePayloadFingerprint(resultReversed);

      // Fingerprint sorts creation keys, so insertion order should not matter
      expect(fpOrdered).toBe(fpReversed);
    });

    it("different idempotency keys produce different fingerprints", () => {
      const resultA = makeMinimalProcessResult({
        idempotency_key: "conv-001:seq-1-5:pipe-0.1.0",
      });
      const resultB = makeMinimalProcessResult({
        idempotency_key: "conv-001:seq-6-10:pipe-0.1.0",
      });

      expect(computePayloadFingerprint(resultA)).not.toBe(
        computePayloadFingerprint(resultB)
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // Commit Flow Tests (Mocked RPC)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("commit flow (mocked RPC)", () => {
    it("successful commit returns CommitResult with success=true and new graph version", async () => {
      mockRpc.mockResolvedValueOnce({
        data: { graph_version: 6 },
        error: null,
      });

      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
        packets: [makePacket("pkt-001")],
      });
      const graphState = makeEmptyGraphState();

      const result = await commitSIEResult(
        "conv-001",
        processResult,
        graphState
      );

      expect(result.success).toBe(true);
      expect(result.committedGraphVersion).toBe(6);
      expect(result.requestId).toBe("req-test-001");
      expect(result.retryRequired).toBe(false);
      expect(result.violations).toHaveLength(0);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith(
        "v2_commit_update",
        expect.objectContaining({
          p_conversation_id: "conv-001",
          p_request_id: "req-test-001",
          p_required_engine: "SIE",
        })
      );
    });

    it("invariant violations prevent RPC call and return violations", async () => {
      // Override the mock to return violations
      const { validateInvariants } = await import("../invariant-validator");
      (validateInvariants as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        valid: false,
        violations: [
          {
            type: "cycle_detected",
            entityId: "concern-a",
            description: "Cycle in parent hierarchy",
          },
        ],
      });

      const processResult = makeMinimalProcessResult();
      const graphState = makeEmptyGraphState();

      const result = await commitSIEResult(
        "conv-001",
        processResult,
        graphState
      );

      expect(result.success).toBe(false);
      expect(result.committedGraphVersion).toBeNull();
      expect(result.retryRequired).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe("cycle_detected");
      // RPC should NOT have been called
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("version conflict error returns retryRequired=true", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "version conflict: expected 5 but found 6" },
      });

      const processResult = makeMinimalProcessResult();
      const graphState = makeEmptyGraphState();

      const result = await commitSIEResult(
        "conv-001",
        processResult,
        graphState
      );

      expect(result.success).toBe(false);
      expect(result.committedGraphVersion).toBeNull();
      expect(result.retryRequired).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("non-conflict errors throw", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "internal server error: database connection lost" },
      });

      const processResult = makeMinimalProcessResult();
      const graphState = makeEmptyGraphState();

      await expect(
        commitSIEResult("conv-001", processResult, graphState)
      ).rejects.toThrow("SIE commit RPC failed");
    });

    it("RPC is called with correct SIE-specific parameters", async () => {
      mockRpc.mockResolvedValueOnce({
        data: { graph_version: 6 },
        error: null,
      });

      const processResult = makeMinimalProcessResult({
        propositions: [makeProposition("prop-001")],
      });
      const graphState = makeEmptyGraphState();

      await commitSIEResult("conv-001", processResult, graphState);

      const rpcArgs = mockRpc.mock.calls[0][1];
      expect(rpcArgs.p_from_version).toBe(5);
      expect(rpcArgs.p_to_version).toBe(6);
      expect(rpcArgs.p_idempotency_key).toBe("conv-001:seq-1-5:pipe-0.1.0");
      expect(rpcArgs.p_payload_fingerprint).toMatch(/^fp_[0-9a-f]{8}$/);
      expect(rpcArgs.p_sie_commit_bundle).toBeDefined();
      expect(rpcArgs.p_sie_commit_bundle.entityRegistrations).toBeDefined();
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // Error Injection Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("error injection / handling", () => {
    it("handles authority mismatch error by throwing", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message: "authority mismatch: conversation conv-001 is not SIE-authoritative",
        },
      });

      const processResult = makeMinimalProcessResult();
      const graphState = makeEmptyGraphState();

      await expect(
        commitSIEResult("conv-001", processResult, graphState)
      ).rejects.toThrow("SIE commit RPC failed");
    });

    it("handles payload mismatch error by throwing", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message: "payload mismatch: idempotency key reused with different fingerprint",
        },
      });

      const processResult = makeMinimalProcessResult();
      const graphState = makeEmptyGraphState();

      await expect(
        commitSIEResult("conv-001", processResult, graphState)
      ).rejects.toThrow("SIE commit RPC failed");
    });

    it("unknown RPC errors are thrown with descriptive message", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "unique_violation: creation_key already exists" },
      });

      const processResult = makeMinimalProcessResult();
      const graphState = makeEmptyGraphState();

      await expect(
        commitSIEResult("conv-001", processResult, graphState)
      ).rejects.toThrow("conv-001");
    });

    it("stale version patterns are correctly detected as version conflicts", async () => {
      const versionConflictMessages = [
        "version conflict: expected 5 but got 7",
        "version_conflict error occurred",
        "optimistic lock failure on graph_version",
        "concurrent update detected for conversation",
        "stale version: client sent 5 but current is 8",
      ];

      for (const msg of versionConflictMessages) {
        vi.clearAllMocks();
        mockRpc.mockResolvedValueOnce({
          data: null,
          error: { message: msg },
        });

        const result = await commitSIEResult(
          "conv-001",
          makeMinimalProcessResult(),
          makeEmptyGraphState()
        );

        expect(result.retryRequired).toBe(true);
        expect(result.success).toBe(false);
      }
    });

    it("concurrent commit with duplicate delivery is handled via version conflict", async () => {
      // Simulate two concurrent commits — the second sees a version conflict
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "concurrent update: another commit advanced version" },
      });

      const result = await commitSIEResult(
        "conv-001",
        makeMinimalProcessResult(),
        makeEmptyGraphState()
      );

      expect(result.retryRequired).toBe(true);
      expect(result.success).toBe(false);
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // Pending Decision Persistence Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("pending decision lifecycle across commits", () => {
    it("unresolved resolutions create pending decisions", () => {
      const processResult = makeMinimalProcessResult({
        packets: [makePacket("pkt-001")],
        identity_resolutions: [
          {
            packet_id: "pkt-001",
            outcome: "RETRIEVAL_INCONCLUSIVE",
            confidence: "LOW",
            matched_concern_id: null,
            new_concern_proposal: null,
            candidates_considered: [],
            rationale: "Retrieval returned no candidates",
          },
        ],
      });

      const bundle = buildCommitBundle(processResult, makeEmptyGraphState());

      expect(bundle.pendingDecisionCreations).toHaveLength(1);
      expect(bundle.pendingDecisionCreations[0].outcome).toBe(
        "RETRIEVAL_INCONCLUSIVE"
      );
      expect(bundle.pendingDecisionResolutions).toHaveLength(0);
    });

    it("REQUIRES_VALIDATION outcome creates pending decision", () => {
      const processResult = makeMinimalProcessResult({
        packets: [makePacket("pkt-001")],
        identity_resolutions: [
          {
            packet_id: "pkt-001",
            outcome: "REQUIRES_VALIDATION",
            confidence: "MEDIUM",
            matched_concern_id: null,
            new_concern_proposal: null,
            candidates_considered: ["c-a"],
            rationale: "Needs human validation",
          },
        ],
      });

      const bundle = buildCommitBundle(processResult, makeEmptyGraphState());

      expect(bundle.pendingDecisionCreations).toHaveLength(1);
      expect(bundle.pendingDecisionCreations[0].outcome).toBe("REQUIRES_VALIDATION");
    });

    it("resolved YES outcomes do NOT create pending decisions", () => {
      const processResult = makeMinimalProcessResult({
        packets: [makePacket("pkt-001")],
        new_concern_proposals: [makeConcernProposal("concern-new")],
        identity_resolutions: [
          {
            packet_id: "pkt-001",
            outcome: "YES",
            confidence: "HIGH",
            matched_concern_id: null,
            new_concern_proposal: makeConcernProposal("concern-new"),
            candidates_considered: [],
            rationale: "New concern formed",
          },
        ],
      });

      const bundle = buildCommitBundle(processResult, makeEmptyGraphState());

      expect(bundle.pendingDecisionCreations).toHaveLength(0);
    });

    it("NO outcome does not create pending decision", () => {
      const processResult = makeMinimalProcessResult({
        packets: [makePacket("pkt-001")],
        identity_resolutions: [
          {
            packet_id: "pkt-001",
            outcome: "NO",
            confidence: "HIGH",
            matched_concern_id: null,
            new_concern_proposal: null,
            candidates_considered: ["c-a"],
            rationale: "Explicitly not a match",
          },
        ],
      });

      const bundle = buildCommitBundle(processResult, makeEmptyGraphState());

      expect(bundle.pendingDecisionCreations).toHaveLength(0);
    });

    it("previously deferred entity gets resolved when matched", () => {
      const processResult = makeMinimalProcessResult({
        packets: [makePacket("pkt-old"), makePacket("pkt-new")],
        identity_resolutions: [
          {
            packet_id: "pkt-old",
            outcome: "YES",
            confidence: "HIGH",
            matched_concern_id: "concern-a",
            new_concern_proposal: null,
            candidates_considered: ["concern-a"],
            rationale: "Now matches concern-a",
          },
          {
            packet_id: "pkt-new",
            outcome: "UNRESOLVED",
            confidence: "LOW",
            matched_concern_id: null,
            new_concern_proposal: null,
            candidates_considered: [],
            rationale: "Still unresolved",
          },
        ],
        diagnostics: {
          stage_versions: { retention: "0.1.0" },
          warnings: [],
          deferred_entity_ids: ["pkt-old"],
        },
      });

      const graphState = makeEmptyGraphState({
        concerns: [makeConcern("concern-a")],
      });

      const bundle = buildCommitBundle(processResult, graphState);

      // pkt-old was deferred and is now resolved
      expect(bundle.pendingDecisionResolutions).toHaveLength(1);
      expect(bundle.pendingDecisionResolutions[0].entity_id).toBe("pkt-old");

      // pkt-new is unresolved → new pending decision
      expect(bundle.pendingDecisionCreations).toHaveLength(1);
      expect(bundle.pendingDecisionCreations[0].entity_id).toBe("pkt-new");
    });
  });
});
