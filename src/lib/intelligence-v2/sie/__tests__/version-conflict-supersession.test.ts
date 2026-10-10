/**
 * Version-Conflict Supersession Tests
 *
 * Tests for:
 * - Stale analysis rejection and supersession marking
 * - Successor linking with stable semantic creation keys
 * - Context reload and Python re-invocation
 * - Version-scoped payload fingerprint changes
 * - Bounded retry with exponential backoff
 * - Semantic creation key stability across retries
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleVersionConflictSupersession,
  deriveSemanticCreationKey,
  generateSuccessorRequestId,
  validateSemanticKeyStability,
  wouldFingerprintChange,
} from "../version-conflict-supersession";
import type { SupersessionConfig, PythonInvoker, SupersedeRequestFn } from "../version-conflict-supersession";
import type { ProcessResult, SIEGraphState } from "../types";
import type { components } from "../generated/transport-types";

type ProcessRequest = components["schemas"]["ProcessRequest"];
type GraphStateContext = components["schemas"]["GraphStateContext"];

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRetrieveGraphState = vi.fn();

vi.mock("../graph-state-retriever", () => ({
  retrieveGraphState: (...args: unknown[]) => mockRetrieveGraphState(...args),
}));

const mockCommitSIEResult = vi.fn();
const mockComputePayloadFingerprint = vi.fn(() => "fp_newprint1");

vi.mock("../commit-manager", () => ({
  commitSIEResult: (...args: unknown[]) => mockCommitSIEResult(...args),
  computePayloadFingerprint: (..._args: unknown[]) => mockComputePayloadFingerprint(),
}));

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeGraphStateContext(graphVersion: number): GraphStateContext {
  return {
    graph_version: graphVersion,
    concerns: [],
    propositions: [],
    active_associations: [],
    pending_decisions: [],
    snapshot_digest: "test-digest",
    snapshot_token: "test-token",
  } as GraphStateContext;
}

function makeSIEGraphState(graphVersion: number): SIEGraphState {
  return {
    graphVersion,
    concerns: [],
    propositions: [],
    associations: [],
    packets: [],
  };
}

function makeProcessResult(overrides?: Partial<ProcessResult>): ProcessResult {
  return {
    api_contract_version: "1.1.0",
    pipeline_version: "0.1.0",
    model_version: "gpt-4o",
    extraction_version: "0.1.0",
    request_id: "req-original-001",
    idempotency_key: "conv-001:seq-1-5:pipe-0.1.0:gv-5",
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

function makeProcessRequest(overrides?: Partial<ProcessRequest>): ProcessRequest {
  return {
    api_contract_version: "1.1.0",
    pipeline_version: "0.1.0",
    model_version: "gpt-4o",
    extraction_version: "0.1.0",
    request_id: "req-original-001",
    idempotency_key: "conv-001:seq-1-5:pipe-0.1.0:gv-5",
    conversation_id: "conv-001",
    base_graph_version: 5,
    message_seq_start: 1,
    message_seq_end: 5,
    processing_mode: "FULL_PIPELINE",
    messages: [],
    current_graph_state: makeGraphStateContext(5),
    ...overrides,
  } as ProcessRequest;
}

const defaultConfig: SupersessionConfig = {
  maxRetries: 3,
  baseRetryDelayMs: 10, // Short for tests
  maxTotalDurationMs: 30000,
};

// ─── Test Suites ────────────────────────────────────────────────────────────

describe("Version-Conflict Supersession", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Semantic Creation Key Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("deriveSemanticCreationKey", () => {
    it("produces a stable key from conversation, seq range, and pipeline version", () => {
      const key = deriveSemanticCreationKey("conv-001", 1, 5, "0.1.0");
      expect(key).toBe("conv-001:seq-1-5:pipe-0.1.0");
    });

    it("different conversations produce different keys", () => {
      const key1 = deriveSemanticCreationKey("conv-001", 1, 5, "0.1.0");
      const key2 = deriveSemanticCreationKey("conv-002", 1, 5, "0.1.0");
      expect(key1).not.toBe(key2);
    });

    it("different seq ranges produce different keys", () => {
      const key1 = deriveSemanticCreationKey("conv-001", 1, 5, "0.1.0");
      const key2 = deriveSemanticCreationKey("conv-001", 6, 10, "0.1.0");
      expect(key1).not.toBe(key2);
    });

    it("same inputs always produce the same key (deterministic)", () => {
      const key1 = deriveSemanticCreationKey("conv-001", 1, 5, "0.1.0");
      const key2 = deriveSemanticCreationKey("conv-001", 1, 5, "0.1.0");
      expect(key1).toBe(key2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Successor Request ID Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("generateSuccessorRequestId", () => {
    it("includes semantic key, new version, and retry ordinal", () => {
      const id = generateSuccessorRequestId("conv-001:seq-1-5:pipe-0.1.0", 7, 1);
      expect(id).toBe("conv-001:seq-1-5:pipe-0.1.0:v7:retry-1");
    });

    it("different graph versions produce different IDs", () => {
      const id1 = generateSuccessorRequestId("conv-001:seq-1-5:pipe-0.1.0", 7, 1);
      const id2 = generateSuccessorRequestId("conv-001:seq-1-5:pipe-0.1.0", 8, 1);
      expect(id1).not.toBe(id2);
    });

    it("different retry ordinals produce different IDs", () => {
      const id1 = generateSuccessorRequestId("conv-001:seq-1-5:pipe-0.1.0", 7, 1);
      const id2 = generateSuccessorRequestId("conv-001:seq-1-5:pipe-0.1.0", 7, 2);
      expect(id1).not.toBe(id2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Key Stability Validation Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("validateSemanticKeyStability", () => {
    it("returns true for matching keys", () => {
      expect(validateSemanticKeyStability("key-a", "key-a")).toBe(true);
    });

    it("returns false for different keys", () => {
      expect(validateSemanticKeyStability("key-a", "key-b")).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Fingerprint Change Detection Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("wouldFingerprintChange", () => {
    it("returns true when graph versions differ", () => {
      expect(wouldFingerprintChange(5, 7)).toBe(true);
    });

    it("returns false when graph versions are the same", () => {
      expect(wouldFingerprintChange(5, 5)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handleVersionConflictSupersession Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("handleVersionConflictSupersession", () => {
    it("successfully retries and commits on first retry", async () => {
      // Fresh graph state at version 7
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(7),
        graphVersion: 7,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(7),
      });

      // Python returns fresh analysis
      const freshResult = makeProcessResult({
        request_id: "conv-001:seq-1-5:pipe-0.1.0:v7:retry-1",
        base_graph_version: 7,
      });
      const mockPython: PythonInvoker = vi.fn().mockResolvedValueOnce(freshResult);
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValueOnce(undefined);

      // Commit succeeds on fresh result
      mockCommitSIEResult.mockResolvedValueOnce({
        success: true,
        committedGraphVersion: 8,
        requestId: freshResult.request_id,
        retryRequired: false,
        violations: [],
      });

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(), // stale result at version 5
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      expect(result.status).toBe("committed");
      if (result.status === "committed") {
        expect(result.commitResult.committedGraphVersion).toBe(8);
        expect(result.retriesUsed).toBe(1);
      }
    });

    it("marks stale request as SUPERSEDED with successor link", async () => {
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(7),
        graphVersion: 7,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(7),
      });

      const freshResult = makeProcessResult({
        request_id: "conv-001:seq-1-5:pipe-0.1.0:v7:retry-1",
        base_graph_version: 7,
      });
      const mockPython: PythonInvoker = vi.fn().mockResolvedValueOnce(freshResult);
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValueOnce(undefined);

      mockCommitSIEResult.mockResolvedValueOnce({
        success: true,
        committedGraphVersion: 8,
        requestId: freshResult.request_id,
        retryRequired: false,
        violations: [],
      });

      await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      // Verify supersede was called with correct params
      expect(mockSupersede).toHaveBeenCalledTimes(1);
      expect(mockSupersede).toHaveBeenCalledWith({
        supersededRequestId: "req-original-001",
        successorRequestId: "conv-001:seq-1-5:pipe-0.1.0:v7:retry-1",
        successorKey: "conv-001:seq-1-5:pipe-0.1.0",
        reason: expect.stringContaining("Version conflict"),
      });
    });

    it("preserves semantic creation key across retries", async () => {
      // First retry: version 7, still conflicts
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(7),
        graphVersion: 7,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(7),
      });
      // Second retry: version 8, succeeds
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(8),
        graphVersion: 8,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(8),
      });

      const freshResult7 = makeProcessResult({
        request_id: "conv-001:seq-1-5:pipe-0.1.0:v7:retry-1",
        base_graph_version: 7,
      });
      const freshResult8 = makeProcessResult({
        request_id: "conv-001:seq-1-5:pipe-0.1.0:v8:retry-2",
        base_graph_version: 8,
      });

      const mockPython: PythonInvoker = vi.fn()
        .mockResolvedValueOnce(freshResult7)
        .mockResolvedValueOnce(freshResult8);
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValue(undefined);

      // First commit: another version conflict
      mockCommitSIEResult.mockResolvedValueOnce({
        success: false,
        committedGraphVersion: null,
        requestId: freshResult7.request_id,
        retryRequired: true,
        violations: [],
      });
      // Second commit: success
      mockCommitSIEResult.mockResolvedValueOnce({
        success: true,
        committedGraphVersion: 9,
        requestId: freshResult8.request_id,
        retryRequired: false,
        violations: [],
      });

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      expect(result.status).toBe("committed");
      if (result.status === "committed") {
        expect(result.retriesUsed).toBe(2);
      }

      // Both supersede calls use same semantic creation key
      expect(mockSupersede).toHaveBeenCalledTimes(2);
      const call1 = (mockSupersede as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
      const call2 = (mockSupersede as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0] as Record<string, unknown>;
      expect(call1.successorKey).toBe("conv-001:seq-1-5:pipe-0.1.0");
      expect(call2.successorKey).toBe("conv-001:seq-1-5:pipe-0.1.0");
    });

    it("returns exhausted when max retries exceeded", async () => {
      // Every retry hits another version conflict
      for (let i = 0; i < 3; i++) {
        mockRetrieveGraphState.mockResolvedValueOnce({
          graphStateContext: makeGraphStateContext(6 + i),
          graphVersion: 6 + i,
          authoritativeEngine: "SIE",
          sieGraphState: makeSIEGraphState(6 + i),
        });
      }

      const mockPython: PythonInvoker = vi.fn().mockImplementation(
        async (req: ProcessRequest) => makeProcessResult({
          request_id: req.request_id,
          base_graph_version: req.base_graph_version,
        })
      );
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValue(undefined);

      mockCommitSIEResult.mockResolvedValue({
        success: false,
        committedGraphVersion: null,
        requestId: "any",
        retryRequired: true,
        violations: [],
      });

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      expect(result.status).toBe("exhausted");
      if (result.status === "exhausted") {
        expect(result.retriesUsed).toBe(3);
        expect(result.reason).toContain("Maximum retries exhausted");
      }
    });

    it("returns failed when graph state reload fails", async () => {
      mockRetrieveGraphState.mockRejectedValueOnce(
        new Error("Database connection lost")
      );

      const mockPython: PythonInvoker = vi.fn();
      const mockSupersede: SupersedeRequestFn = vi.fn();

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("Failed to reload graph state");
        expect(result.error).toContain("Database connection lost");
        expect(result.retriesUsed).toBe(1);
      }

      // Python should not have been called
      expect(mockPython).not.toHaveBeenCalled();
    });

    it("returns failed when graph version did not advance", async () => {
      // Version didn't actually advance (same version returned)
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(5),
        graphVersion: 5,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(5),
      });

      const mockPython: PythonInvoker = vi.fn();
      const mockSupersede: SupersedeRequestFn = vi.fn();

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("Graph version did not advance");
        expect(result.retriesUsed).toBe(1);
      }
    });

    it("returns failed when Python re-invocation throws", async () => {
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(7),
        graphVersion: 7,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(7),
      });

      const mockPython: PythonInvoker = vi.fn().mockRejectedValueOnce(
        new Error("Python service unavailable")
      );
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValueOnce(undefined);

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("Python re-invocation failed");
        expect(result.error).toContain("Python service unavailable");
      }
    });

    it("returns failed when supersede marking fails", async () => {
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(7),
        graphVersion: 7,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(7),
      });

      const mockPython: PythonInvoker = vi.fn();
      const mockSupersede: SupersedeRequestFn = vi.fn().mockRejectedValueOnce(
        new Error("RPC failed: request already superseded")
      );

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("Failed to mark request");
        expect(result.error).toContain("SUPERSEDED");
      }
    });

    it("returns failed on non-retryable commit error (invariant violations)", async () => {
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(7),
        graphVersion: 7,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(7),
      });

      const freshResult = makeProcessResult({
        request_id: "conv-001:seq-1-5:pipe-0.1.0:v7:retry-1",
        base_graph_version: 7,
      });
      const mockPython: PythonInvoker = vi.fn().mockResolvedValueOnce(freshResult);
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValueOnce(undefined);

      mockCommitSIEResult.mockResolvedValueOnce({
        success: false,
        committedGraphVersion: null,
        requestId: freshResult.request_id,
        retryRequired: false,
        violations: [{ type: "cycle_detected", entityId: "c-1", description: "Cycle" }],
      });

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("non-retryable");
        expect(result.error).toContain("cycle_detected");
      }
    });

    it("re-invokes Python with version-scoped idempotency key", async () => {
      mockRetrieveGraphState.mockResolvedValueOnce({
        graphStateContext: makeGraphStateContext(7),
        graphVersion: 7,
        authoritativeEngine: "SIE",
        sieGraphState: makeSIEGraphState(7),
      });

      const freshResult = makeProcessResult({
        request_id: "conv-001:seq-1-5:pipe-0.1.0:v7:retry-1",
        base_graph_version: 7,
      });
      const mockPython: PythonInvoker = vi.fn().mockResolvedValueOnce(freshResult);
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValueOnce(undefined);

      mockCommitSIEResult.mockResolvedValueOnce({
        success: true,
        committedGraphVersion: 8,
        requestId: freshResult.request_id,
        retryRequired: false,
        violations: [],
      });

      await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      // Verify Python was called with correct request
      expect(mockPython).toHaveBeenCalledTimes(1);
      const pythonArg = (mockPython as ReturnType<typeof vi.fn>).mock.calls[0][0] as ProcessRequest;
      expect(pythonArg.base_graph_version).toBe(7);
      expect(pythonArg.request_id).toBe("conv-001:seq-1-5:pipe-0.1.0:v7:retry-1");
      expect(pythonArg.idempotency_key).toBe("conv-001:seq-1-5:pipe-0.1.0:gv-7");
      expect(pythonArg.current_graph_state.graph_version).toBe(7);
    });

    it("returns exhausted when total duration budget exceeded", async () => {
      const shortConfig: SupersessionConfig = {
        maxRetries: 10,
        baseRetryDelayMs: 1,
        maxTotalDurationMs: 1, // 1ms budget — will exhaust immediately on retry 2
      };

      // First retry works fine, but second check of elapsed time exceeds budget
      mockRetrieveGraphState
        .mockResolvedValueOnce({
          graphStateContext: makeGraphStateContext(6),
          graphVersion: 6,
          authoritativeEngine: "SIE",
          sieGraphState: makeSIEGraphState(6),
        })
        .mockImplementationOnce(async () => {
          // Simulate some time passing by waiting a bit
          await new Promise(r => setTimeout(r, 5));
          return {
            graphStateContext: makeGraphStateContext(7),
            graphVersion: 7,
            authoritativeEngine: "SIE",
            sieGraphState: makeSIEGraphState(7),
          };
        });

      const mockPython: PythonInvoker = vi.fn().mockImplementation(
        async (req: ProcessRequest) => makeProcessResult({
          request_id: req.request_id,
          base_graph_version: req.base_graph_version,
        })
      );
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValue(undefined);

      // First commit: version conflict (triggers retry loop)
      mockCommitSIEResult.mockResolvedValue({
        success: false,
        committedGraphVersion: null,
        requestId: "any",
        retryRequired: true,
        violations: [],
      });

      const result = await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        shortConfig
      );

      // Should have exhausted because of time budget
      expect(result.status).toBe("exhausted");
      if (result.status === "exhausted") {
        expect(result.reason).toContain("duration budget exhausted");
      }
    });

    it("reloads fresh graph context from database on each retry", async () => {
      // Setup: two retries with advancing versions
      mockRetrieveGraphState
        .mockResolvedValueOnce({
          graphStateContext: makeGraphStateContext(7),
          graphVersion: 7,
          authoritativeEngine: "SIE",
          sieGraphState: makeSIEGraphState(7),
        })
        .mockResolvedValueOnce({
          graphStateContext: makeGraphStateContext(9),
          graphVersion: 9,
          authoritativeEngine: "SIE",
          sieGraphState: makeSIEGraphState(9),
        });

      const freshResult7 = makeProcessResult({
        request_id: "conv-001:seq-1-5:pipe-0.1.0:v7:retry-1",
        base_graph_version: 7,
      });
      const freshResult9 = makeProcessResult({
        request_id: "conv-001:seq-1-5:pipe-0.1.0:v9:retry-2",
        base_graph_version: 9,
      });

      const mockPython: PythonInvoker = vi.fn()
        .mockResolvedValueOnce(freshResult7)
        .mockResolvedValueOnce(freshResult9);
      const mockSupersede: SupersedeRequestFn = vi.fn().mockResolvedValue(undefined);

      // First commit fails with conflict, second succeeds
      mockCommitSIEResult
        .mockResolvedValueOnce({
          success: false,
          committedGraphVersion: null,
          requestId: freshResult7.request_id,
          retryRequired: true,
          violations: [],
        })
        .mockResolvedValueOnce({
          success: true,
          committedGraphVersion: 10,
          requestId: freshResult9.request_id,
          retryRequired: false,
          violations: [],
        });

      await handleVersionConflictSupersession(
        "conv-001",
        makeProcessResult(),
        makeSIEGraphState(5),
        makeProcessRequest(),
        mockPython,
        mockSupersede,
        defaultConfig
      );

      // Graph state was reloaded twice
      expect(mockRetrieveGraphState).toHaveBeenCalledTimes(2);
      expect(mockRetrieveGraphState).toHaveBeenCalledWith("conv-001");

      // Python was called with different base versions
      const calls = (mockPython as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].base_graph_version).toBe(7);
      expect(calls[1][0].base_graph_version).toBe(9);
    });
  });
});
