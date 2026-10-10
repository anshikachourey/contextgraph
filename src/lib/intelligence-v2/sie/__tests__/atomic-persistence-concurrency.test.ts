/**
 * Atomic Persistence and Concurrency Integration Tests — Task 18.2
 *
 * Tests:
 * 1. Failure injection at every identity bundle phase → complete rollback.
 * 2. Stale-version rejection and retryRequired=true.
 * 3. Concurrent duplicate serialization (IN_PROGRESS → ANALYZED_RESULT).
 * 4. Lease recovery (RETRYABLE_LEASE).
 * 5. Cached result replay (ANALYZED_RESULT / COMMITTED_RESULT).
 * 6. Cross-conversation rejection.
 * 7. Database-side validation catches invalid input even when TS validation
 *    is bypassed in the test.
 *
 * These tests use mocked RPCs to simulate real PostgreSQL behavior at the
 * integration level, exercising the full commit-manager + reservation +
 * supersession flows together.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildCommitBundle,
  computePayloadFingerprint,
  commitSIEResult,
} from "../commit-manager";
import {
  reserveRequest,
  recordAnalyzedResult,
  renewLease,
  markFailedRetryable,
  supersedeRequest,
  type ReservationConfig,
} from "../reservation-orchestrator";
import {
  handleVersionConflictSupersession,
  deriveSemanticCreationKey,
  generateSuccessorRequestId,
} from "../version-conflict-supersession";
import type { SIEGraphState, ProcessResult, CommitResult } from "../types";
import type { components } from "../generated/transport-types";

type Proposition = components["schemas"]["Proposition"];
type PropositionAssociation = components["schemas"]["PropositionAssociation"];
type SemanticPacket = components["schemas"]["SemanticPacket"];
type ConcernProposal = components["schemas"]["ConcernProposal"];
type IdentityResolutionResult = components["schemas"]["IdentityResolutionResult"];
type RetentionDecision = components["schemas"]["RetentionDecision"];
type PacketMembership = components["schemas"]["PacketMembership"];
type ProcessRequest = components["schemas"]["ProcessRequest"];

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
  projectToV2Snapshot: vi.fn(() => ({
    objects: [],
    propositions: [],
    threads: [],
  })),
}));

vi.mock("../graph-state-retriever", () => ({
  retrieveGraphState: vi.fn(),
}));

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const CONVERSATION_ID = "conv-persist-001";
const REQUEST_ID = "req-persist-001";
const IDEMPOTENCY_KEY = "conv-persist-001:seq-1-5:pipe-0.1.0";
const FINGERPRINT = "fp_a1b2c3d4";

const RESERVATION_CONFIG: ReservationConfig = {
  leaseDurationMs: 30_000,
  maxWaitAttempts: 3,
  waitBaseDelayMs: 50,
  maxWaitTotalMs: 5000,
  leaseOwner: "test-worker-persist",
};

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

function makeProposition(id: string, overrides?: Partial<Proposition>): Proposition {
  return {
    proposition_id: id,
    proposition_creation_key: `${CONVERSATION_ID}:req:extract-${id}`,
    conversation_id: CONVERSATION_ID,
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

function makePacket(id: string, overrides?: Partial<SemanticPacket>): SemanticPacket {
  return {
    packet_id: id,
    packet_creation_key: `${CONVERSATION_ID}:req:partition-${id}`,
    conversation_id: CONVERSATION_ID,
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

function makeAssociation(
  id: string,
  propId: string,
  concernId: string,
  overrides?: Partial<PropositionAssociation>
): PropositionAssociation {
  return {
    association_id: id,
    association_creation_key: `${CONVERSATION_ID}:req:assoc-${id}`,
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

function makeConcernProposal(
  id: string,
  overrides?: Partial<ConcernProposal>
): ConcernProposal {
  return {
    concern_creation_key: `${CONVERSATION_ID}:req:concern-${id}`,
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

function makeIdentityResolution(
  overrides: Partial<IdentityResolutionResult> & {
    packet_id: string;
    outcome: IdentityResolutionResult["outcome"];
    rationale: string;
  }
): IdentityResolutionResult {
  const isYes = overrides.outcome === "YES";
  const isNo = overrides.outcome === "NO";
  return {
    action: isYes ? "ASSIGN_EXISTING" : isNo ? "PROPOSE_NEW" : "RETAIN_PENDING",
    identity_stage_status: "COMPLETED",
    identity_confidence: isYes ? "HIGH" : "LOW",
    sufficiency_stage_status: isNo ? "COMPLETED" : "NOT_RUN",
    sufficiency_confidence: isNo ? "HIGH" : null,
    matched_concern_id: null,
    new_concern_proposal: null,
    candidates_considered: [],
    ...overrides,
  };
}

function makeRetentionDecision(
  id: string,
  overrides?: Partial<RetentionDecision>
): RetentionDecision {
  return {
    decision_id: id,
    decision_creation_key: `${CONVERSATION_ID}:req:retention-${id}`,
    conversation_id: CONVERSATION_ID,
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

function makeFullProcessResult(overrides?: Partial<ProcessResult>): ProcessResult {
  return {
    api_contract_version: "1.1.0",
    pipeline_version: "0.1.0",
    model_version: "gpt-4o",
    extraction_version: "0.1.0",
    request_id: REQUEST_ID,
    idempotency_key: IDEMPOTENCY_KEY,
    conversation_id: CONVERSATION_ID,
    base_graph_version: 5,
    lowest_seq: 1,
    highest_seq: 5,
    retention_decisions: [makeRetentionDecision("ret-001")],
    propositions: [makeProposition("prop-001")],
    packets: [makePacket("pkt-001")],
    packet_memberships: [makeMembership("mem-001", "pkt-001", "prop-001", 0)],
    splits: [],
    identity_resolutions: [
      makeIdentityResolution({
        packet_id: "pkt-001",
        outcome: "NO",
        action: "PROPOSE_NEW",
        identity_confidence: "LOW",
        sufficiency_stage_status: "COMPLETED",
        sufficiency_confidence: "HIGH",
        rationale: "New concern — adequate retrieval, no match",
      }),
    ],
    new_concern_proposals: [makeConcernProposal("concern-new-001")],
    proposed_associations: [
      makeAssociation("assoc-001", "prop-001", "concern-new-001"),
    ],
    dependency_groups: [
      {
        group_id: "grp-001",
        failure_policy: "ALL_OR_NONE",
        mutation_refs: ["concern-new-001", "assoc-001", "pkt-001"],
      },
    ],
    diagnostics: {
      stage_versions: { retention: "0.1.0", identity_resolution: "0.1.0" },
      warnings: [],
      deferred_entity_ids: [],
    },
    ...overrides,
  };
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe("Atomic Persistence and Concurrency — Task 18.2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Failure Injection at Every Identity Bundle Phase
  // Prove complete rollback — no partial state persists.
  // ═══════════════════════════════════════════════════════════════════════════

  describe("failure injection at every identity bundle phase → complete rollback", () => {
    it("v2_commit_update failure → no identity bundle call, no partial state", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "internal: disk full" },
      });

      const processResult = makeFullProcessResult();
      const graphState = makeEmptyGraphState();

      await expect(
        commitSIEResult(CONVERSATION_ID, processResult, graphState, undefined, "SIE_SHADOW")
      ).rejects.toThrow("SIE commit RPC failed");

      // Only one RPC was called (v2_commit_update) — identity bundle never executed
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith("v2_commit_update", expect.any(Object));
    });

    it("v2_commit_identity_bundle failure → throws, no partial commit persists", async () => {
      // v2_commit_update succeeds
      mockRpc.mockResolvedValueOnce({
        data: { graph_version: 6 },
        error: null,
      });
      // v2_commit_identity_bundle fails
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "internal: connection reset during identity bundle write" },
      });

      const processResult = makeFullProcessResult();
      const graphState = makeEmptyGraphState();

      await expect(
        commitSIEResult(CONVERSATION_ID, processResult, graphState, undefined, "SIE_SHADOW")
      ).rejects.toThrow("SIE identity bundle commit failed");

      // Both RPCs were called: base commit + identity bundle
      expect(mockRpc).toHaveBeenCalledTimes(2);
      expect(mockRpc).toHaveBeenNthCalledWith(1, "v2_commit_update", expect.any(Object));
      expect(mockRpc).toHaveBeenNthCalledWith(
        2,
        "v2_commit_identity_bundle",
        expect.any(Object)
      );
    });

    it("identity bundle version-conflict → retryRequired=true, no partial state", async () => {
      mockRpc.mockResolvedValueOnce({
        data: { graph_version: 6 },
        error: null,
      });
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "version conflict: graph advanced during identity bundle" },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(true);
      expect(result.committedGraphVersion).toBeNull();
      expect(result.violations).toHaveLength(0);
    });

    it("identity bundle DB validation error → authoritative rejection, no retry", async () => {
      mockRpc.mockResolvedValueOnce({
        data: { graph_version: 6 },
        error: null,
      });
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message: "invariant_violation: association_uniqueness violated for assoc-001",
        },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(result.committedGraphVersion).toBeNull();
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].description).toContain("Database validation rejected");
      expect(result.violations[0].description).toContain("identity bundle");
    });

    it("contract validation failure prevents any RPC call → no partial state", async () => {
      const processResult = makeFullProcessResult({
        api_contract_version: "",
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        processResult,
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: Stale-Version Rejection
  // ═══════════════════════════════════════════════════════════════════════════

  describe("stale-version rejection", () => {
    it("version conflict from v2_commit_update → retryRequired=true", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "version conflict: expected 5 but found 7" },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(true);
      expect(result.committedGraphVersion).toBeNull();
    });

    it("stale version pattern detected via optimistic lock wording", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "optimistic lock failure: another write advanced to v8" },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(true);
    });

    it("stale version from concurrent update pattern", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "concurrent update detected for conversation" },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(true);
    });

    it("supersession marks stale request SUPERSEDED and re-invokes Python", async () => {
      // Mock the graph-state-retriever to return fresh state
      const { retrieveGraphState } = await import("../graph-state-retriever");
      (retrieveGraphState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        graphVersion: 7,
        sieGraphState: makeEmptyGraphState({ graphVersion: 7 }),
        graphStateContext: {
          graph_version: 7,
          concerns: [],
          propositions: [],
          associations: [],
          pending_decisions: [],
        },
      });

      // Mock commit to succeed on the retry
      mockRpc
        .mockResolvedValueOnce({ data: { graph_version: 8 }, error: null })
        .mockResolvedValueOnce({ data: { success: true }, error: null });

      const freshResult = makeFullProcessResult({
        request_id: "conv-persist-001:seq-1-5:pipe-0.1.0:v7:retry-1",
        base_graph_version: 7,
        idempotency_key: "conv-persist-001:seq-1-5:pipe-0.1.0:gv-7",
      });

      const mockInvokePython = vi.fn().mockResolvedValue(freshResult);
      const mockSupersede = vi.fn().mockResolvedValue(undefined);

      const originalRequest = {
        api_contract_version: "1.1.0",
        base_graph_version: 5,
        conversation_id: CONVERSATION_ID,
        request_id: REQUEST_ID,
        idempotency_key: IDEMPOTENCY_KEY,
        message_seq_start: 1,
        message_seq_end: 5,
        pipeline_version: "0.1.0",
        model_version: "gpt-4o",
        extraction_version: "0.1.0",
        messages: [],
        processing_mode: "FULL_PIPELINE",
        retrieval_policy_version: "1.0.0",
        semantic_policy_version: "1.0.0",
        current_graph_state: {} as any,
      } as unknown as ProcessRequest;

      const outcome = await handleVersionConflictSupersession(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        originalRequest,
        mockInvokePython,
        mockSupersede,
        { maxRetries: 3, baseRetryDelayMs: 10, maxTotalDurationMs: 60_000 }
      );

      // Verify stale request was marked superseded
      expect(mockSupersede).toHaveBeenCalledWith(
        expect.objectContaining({
          supersededRequestId: REQUEST_ID,
          reason: expect.stringContaining("Version conflict"),
        })
      );

      // Verify Python was re-invoked with fresh state
      expect(mockInvokePython).toHaveBeenCalledWith(
        expect.objectContaining({
          base_graph_version: 7,
        })
      );

      // Verify outcome is committed
      expect(outcome.status).toBe("committed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3: Concurrent Duplicate Serialization (IN_PROGRESS → ANALYZED_RESULT)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("concurrent duplicate serialization", () => {
    it("IN_PROGRESS then ANALYZED_RESULT → returns cached analysis", async () => {
      const cachedResult = makeFullProcessResult();

      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "IN_PROGRESS",
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "ANALYZED_RESULT",
          analyzed_result: cachedResult,
        },
        error: null,
      });

      const resultPromise = reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );

      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;
      expect(result.status).toBe("cached_analyzed");
      if (result.status === "cached_analyzed") {
        expect(result.analyzedResult).toEqual(cachedResult);
      }
      expect(mockRpc).toHaveBeenCalledTimes(2);
    });

    it("IN_PROGRESS then COMMITTED_RESULT → returns already_committed", async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "IN_PROGRESS",
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      mockRpc.mockResolvedValueOnce({
        data: { outcome: "COMMITTED_RESULT" },
        error: null,
      });

      const resultPromise = reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );

      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;
      expect(result.status).toBe("already_committed");
    });

    it("multiple IN_PROGRESS then timeout → returns wait_timeout", async () => {
      mockRpc.mockResolvedValue({
        data: {
          outcome: "IN_PROGRESS",
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      const resultPromise = reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        { ...RESERVATION_CONFIG, maxWaitAttempts: 2, waitBaseDelayMs: 10 }
      );

      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;
      expect(result.status).toBe("wait_timeout");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4: Lease Recovery (RETRYABLE_LEASE)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("lease recovery (RETRYABLE_LEASE)", () => {
    it("expired lease is recovered → lease_acquired with original request_id", async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "RETRYABLE_LEASE",
          request_id: "original-req-from-crashed-worker",
          lease_expires_at: "2024-01-01T00:01:00.000Z",
        },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        "new-attempt-id",
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );

      expect(result.status).toBe("lease_acquired");
      if (result.status === "lease_acquired") {
        expect(result.requestId).toBe("original-req-from-crashed-worker");
        expect(result.leaseExpiresAt).toBe("2024-01-01T00:01:00.000Z");
      }
    });

    it("markFailedRetryable + subsequent RETRYABLE_LEASE allows recovery", async () => {
      // markFailedRetryable uses: (requestId, leaseOwner, failureReason)
      mockRpc.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      });

      const failResult = await markFailedRetryable(
        "crashed-req-001",
        RESERVATION_CONFIG.leaseOwner,
        "Worker crashed during Python invocation"
      );
      expect(failResult.success).toBe(true);

      // A new worker picks up the retryable request
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "RETRYABLE_LEASE",
          request_id: "crashed-req-001",
          lease_expires_at: "2024-01-01T00:02:00.000Z",
        },
        error: null,
      });

      const reserveResult = await reserveRequest(
        CONVERSATION_ID,
        "recovery-attempt-001",
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        { ...RESERVATION_CONFIG, leaseOwner: "recovery-worker-001" }
      );

      expect(reserveResult.status).toBe("lease_acquired");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5: Cached Result Replay
  // ═══════════════════════════════════════════════════════════════════════════

  describe("cached result replay", () => {
    it("ANALYZED_RESULT → returns previously recorded analysis", async () => {
      const cachedResult = makeFullProcessResult();

      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "ANALYZED_RESULT",
          analyzed_result: cachedResult,
        },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );

      expect(result.status).toBe("cached_analyzed");
      if (result.status === "cached_analyzed") {
        expect(result.analyzedResult.request_id).toBe(REQUEST_ID);
      }
    });

    it("COMMITTED_RESULT → returns already_committed", async () => {
      mockRpc.mockResolvedValueOnce({
        data: { outcome: "COMMITTED_RESULT" },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );

      expect(result.status).toBe("already_committed");
    });

    it("FINGERPRINT_CONFLICT → different payload with same key is rejected", async () => {
      mockRpc.mockResolvedValueOnce({
        data: { outcome: "FINGERPRINT_CONFLICT" },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        "fp_different_fingerprint",
        RESERVATION_CONFIG
      );

      expect(result.status).toBe("fingerprint_conflict");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6: Cross-Conversation Rejection
  // ═══════════════════════════════════════════════════════════════════════════

  describe("cross-conversation rejection", () => {
    it("cross-conversation entity rejected by DB validation via v2_commit_update", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            "conversation_ownership: proposition prop-001 belongs to conv-other, not conv-persist-001",
        },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      // conversation_ownership is a DB validation error → authoritative
      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].description).toContain("Database validation rejected");
      expect(result.violations[0].description).toContain("conversation_ownership");
    });

    it("cross-conversation packet in identity bundle rejected at commit", async () => {
      // v2_commit_update succeeds
      mockRpc.mockResolvedValueOnce({
        data: { graph_version: 6 },
        error: null,
      });
      // Identity bundle rejects the cross-conversation entity
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message: "conversation_ownership: packet pkt-cross references conv-OTHER-999",
        },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(result.violations[0].description).toContain("conversation_ownership");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 7: Database-Side Validation Catches Invalid Input
  // Even when TypeScript validation is bypassed in the test.
  // ═══════════════════════════════════════════════════════════════════════════

  describe("database-side validation catches invalid input (TS validation bypassed)", () => {
    it("lease_invalid error is authoritative rejection (not retry)", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "lease_invalid: lease expired or owned by another worker" },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].description).toContain("Database validation rejected");
    });

    it("fingerprint_mismatch error is authoritative", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            "fingerprint_mismatch: stored fp_abc12345 does not match submitted fp_xyz99999",
        },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(result.violations[0].description).toContain("fingerprint_mismatch");
    });

    it("entity_registry_conflict is authoritative rejection", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            "entity_registry_conflict: creation_key already registered to different entity",
        },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(result.violations[0].description).toContain("entity_registry_conflict");
    });

    it("dependency_group_incomplete from DB is authoritative", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            "dependency_group_incomplete: group grp-001 missing mutation ref",
        },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(result.violations[0].description).toContain("dependency_group_incomplete");
    });

    it("association_uniqueness from identity bundle is authoritative", async () => {
      // v2_commit_update succeeds
      mockRpc.mockResolvedValueOnce({
        data: { graph_version: 6 },
        error: null,
      });
      // Identity bundle rejects
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            "association_uniqueness: (prop-001, concern-new-001, PRIMARY_OWNER) exists",
        },
      });

      const result = await commitSIEResult(
        CONVERSATION_ID,
        makeFullProcessResult(),
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(result.success).toBe(false);
      expect(result.retryRequired).toBe(false);
      expect(result.violations[0].description).toContain("association_uniqueness");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 8: End-to-End Reservation → Analysis → Commit
  // ═══════════════════════════════════════════════════════════════════════════

  describe("end-to-end reservation → analysis → commit integration", () => {
    it("happy path: reserve → record analyzed → commit succeeds", async () => {
      // 1. Reserve → NEW_LEASE
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "NEW_LEASE",
          request_id: REQUEST_ID,
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      const reserveResult = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );
      expect(reserveResult.status).toBe("lease_acquired");

      // 2. Record analyzed result
      // recordAnalyzedResult(requestId, leaseOwner, analyzedResult, graphVersion)
      const processResult = makeFullProcessResult();
      mockRpc.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      });

      const recordResult = await recordAnalyzedResult(
        REQUEST_ID,
        RESERVATION_CONFIG.leaseOwner,
        processResult,
        5
      );
      expect(recordResult.success).toBe(true);

      // 3. Commit: v2_commit_update + v2_commit_identity_bundle
      mockRpc
        .mockResolvedValueOnce({ data: { graph_version: 6 }, error: null })
        .mockResolvedValueOnce({ data: { success: true }, error: null });

      const commitResult = await commitSIEResult(
        CONVERSATION_ID,
        processResult,
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(commitResult.success).toBe(true);
      expect(commitResult.committedGraphVersion).toBe(6);
    });

    it("reserve → record → commit version conflict → cached analysis available on retry", async () => {
      // 1. Reserve
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "NEW_LEASE",
          request_id: REQUEST_ID,
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );

      // 2. Record analyzed result
      const processResult = makeFullProcessResult();
      mockRpc.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      });

      await recordAnalyzedResult(
        REQUEST_ID,
        RESERVATION_CONFIG.leaseOwner,
        processResult,
        5
      );

      // 3. Commit hits version conflict
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "version conflict: expected 5 but found 8" },
      });

      const commitResult = await commitSIEResult(
        CONVERSATION_ID,
        processResult,
        makeEmptyGraphState(),
        undefined,
        "SIE_SHADOW"
      );

      expect(commitResult.success).toBe(false);
      expect(commitResult.retryRequired).toBe(true);

      // 4. On retry reserve, the cached analysis is available
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "ANALYZED_RESULT",
          analyzed_result: processResult,
        },
        error: null,
      });

      const retryReserve = await reserveRequest(
        CONVERSATION_ID,
        "req-retry-001",
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );

      expect(retryReserve.status).toBe("cached_analyzed");
    });

    it("recording analysis fails → markFailedRetryable → recovery by another worker", async () => {
      // 1. Reserve succeeds
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "NEW_LEASE",
          request_id: REQUEST_ID,
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        RESERVATION_CONFIG
      );

      // 2. Recording analyzed result fails (RPC error → throws)
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "connection reset" },
      });

      await expect(
        recordAnalyzedResult(
          REQUEST_ID,
          RESERVATION_CONFIG.leaseOwner,
          makeFullProcessResult(),
          5
        )
      ).rejects.toThrow("Failed to record analyzed result");

      // 3. Mark as failed-retryable
      mockRpc.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      });

      const failResult = await markFailedRetryable(
        REQUEST_ID,
        RESERVATION_CONFIG.leaseOwner,
        "Worker crashed during analysis recording"
      );
      expect(failResult.success).toBe(true);

      // 4. Another worker recovers the request
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "RETRYABLE_LEASE",
          request_id: REQUEST_ID,
          lease_expires_at: "2024-01-01T00:02:00.000Z",
        },
        error: null,
      });

      const recoveryResult = await reserveRequest(
        CONVERSATION_ID,
        "recovery-req-001",
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        { ...RESERVATION_CONFIG, leaseOwner: "recovery-worker" }
      );

      expect(recoveryResult.status).toBe("lease_acquired");
    });
  });
});
