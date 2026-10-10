/**
 * Reservation Orchestrator Tests
 *
 * Tests for task 16.3: reservation, lease, and cached-result orchestration.
 *
 * Covers:
 * - Every reservation outcome (NEW_LEASE, ANALYZED_RESULT, COMMITTED_RESULT,
 *   IN_PROGRESS, FINGERPRINT_CONFLICT, RETRYABLE_LEASE)
 * - Bounded wait/retry for concurrent duplicates (IN_PROGRESS)
 * - Recording validated analyzed result before commit
 * - Lease renewal
 * - Expired lease recovery via RETRYABLE_LEASE
 * - Marking requests as failed-retryable
 * - Superseding requests for version conflicts
 *
 * These tests mock the Supabase RPC layer to validate orchestration logic
 * without requiring a real PostgreSQL database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reserveRequest,
  recordAnalyzedResult,
  renewLease,
  markFailedRetryable,
  supersedeRequest,
  type ReservationConfig,
} from "../reservation-orchestrator";
import type { ProcessResult } from "../types";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRpc = vi.fn();

vi.mock("@/src/lib/supabase/server", () => ({
  createServerSupabaseClient: () => ({
    rpc: mockRpc,
  }),
}));

// ─── Test Helpers ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ReservationConfig = {
  leaseDurationMs: 30_000,
  maxWaitAttempts: 3,
  waitBaseDelayMs: 50, // Short for tests
  maxWaitTotalMs: 5000,
  leaseOwner: "test-worker-001",
};

const CONVERSATION_ID = "conv-test-001";
const REQUEST_ID = "req-test-001";
const IDEMPOTENCY_KEY = "conv-test-001:seq-1-5:pipe-0.1.0";
const FINGERPRINT = "fp_abc12345";

function makeMinimalProcessResult(): ProcessResult {
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
    retention_decisions: [],
    propositions: [],
    packets: [],
    packet_memberships: [],
    splits: [],
    identity_resolutions: [],
    new_concern_proposals: [],
    proposed_associations: [],
    diagnostics: {
      stage_versions: { identity_resolution: "0.1.0" },
      warnings: [],
      deferred_entity_ids: [],
    },
  } as unknown as ProcessResult;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("reserveRequest", () => {
  describe("NEW_LEASE outcome", () => {
    it("returns lease_acquired when a fresh reservation is created", async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "NEW_LEASE",
          request_id: REQUEST_ID,
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        DEFAULT_CONFIG
      );

      expect(result).toEqual({
        status: "lease_acquired",
        requestId: REQUEST_ID,
        leaseExpiresAt: "2024-01-01T00:00:30.000Z",
      });

      expect(mockRpc).toHaveBeenCalledWith("sie_reserve_request", {
        p_conversation_id: CONVERSATION_ID,
        p_request_id: REQUEST_ID,
        p_idempotency_key: IDEMPOTENCY_KEY,
        p_payload_fingerprint_hash: FINGERPRINT,
        p_lease_owner: "test-worker-001",
        p_lease_duration_ms: 30_000,
      });
    });
  });

  describe("ANALYZED_RESULT outcome", () => {
    it("returns cached_analyzed with previously recorded result", async () => {
      const cachedResult = makeMinimalProcessResult();
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
        DEFAULT_CONFIG
      );

      expect(result).toEqual({
        status: "cached_analyzed",
        analyzedResult: cachedResult,
      });
    });
  });

  describe("COMMITTED_RESULT outcome", () => {
    it("returns already_committed when the request was fully committed", async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "COMMITTED_RESULT",
        },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        DEFAULT_CONFIG
      );

      expect(result).toEqual({ status: "already_committed" });
    });
  });

  describe("FINGERPRINT_CONFLICT outcome", () => {
    it("returns fingerprint_conflict for different payload on same key", async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "FINGERPRINT_CONFLICT",
        },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        DEFAULT_CONFIG
      );

      expect(result).toEqual({ status: "fingerprint_conflict" });
    });
  });

  describe("RETRYABLE_LEASE outcome", () => {
    it("returns lease_acquired for recovered expired lease", async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "RETRYABLE_LEASE",
          request_id: REQUEST_ID,
          lease_expires_at: "2024-01-01T00:01:00.000Z",
        },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        DEFAULT_CONFIG
      );

      expect(result).toEqual({
        status: "lease_acquired",
        requestId: REQUEST_ID,
        leaseExpiresAt: "2024-01-01T00:01:00.000Z",
      });
    });

    it("uses the request_id from the RPC response for retried requests", async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "RETRYABLE_LEASE",
          request_id: "original-req-001",
          lease_expires_at: "2024-01-01T00:01:00.000Z",
        },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        "new-attempt-req",
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        DEFAULT_CONFIG
      );

      expect(result).toEqual({
        status: "lease_acquired",
        requestId: "original-req-001",
        leaseExpiresAt: "2024-01-01T00:01:00.000Z",
      });
    });
  });

  describe("IN_PROGRESS outcome — bounded wait/retry", () => {
    it("waits and retries when another worker holds the lease", async () => {
      // First call: IN_PROGRESS
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "IN_PROGRESS",
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      // Second call after wait: now available as NEW_LEASE
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "NEW_LEASE",
          request_id: REQUEST_ID,
          lease_expires_at: "2024-01-01T00:01:00.000Z",
        },
        error: null,
      });

      const resultPromise = reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        DEFAULT_CONFIG
      );

      // Advance timers to trigger the backoff wait
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;
      expect(result).toEqual({
        status: "lease_acquired",
        requestId: REQUEST_ID,
        leaseExpiresAt: "2024-01-01T00:01:00.000Z",
      });

      expect(mockRpc).toHaveBeenCalledTimes(2);
    });

    it("returns wait_timeout after exceeding maxWaitAttempts", async () => {
      // All calls return IN_PROGRESS
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
        { ...DEFAULT_CONFIG, maxWaitAttempts: 2, waitBaseDelayMs: 10 }
      );

      // Advance through all backoff delays
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;
      expect(result.status).toBe("wait_timeout");
      // Initial call + 2 retry attempts = 3 total calls
      expect(mockRpc).toHaveBeenCalledTimes(3);
    });

    it("returns wait_timeout when maxWaitTotalMs is exceeded", async () => {
      vi.useRealTimers(); // Use real timers for this time-based test

      mockRpc.mockResolvedValue({
        data: {
          outcome: "IN_PROGRESS",
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      const result = await reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        {
          ...DEFAULT_CONFIG,
          maxWaitAttempts: 100, // High limit
          waitBaseDelayMs: 10,
          maxWaitTotalMs: 50, // Very short total limit
        }
      );

      expect(result.status).toBe("wait_timeout");
    });

    it("returns ANALYZED_RESULT after waiting for in-progress to complete", async () => {
      const cachedResult = makeMinimalProcessResult();

      // First call: IN_PROGRESS
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "IN_PROGRESS",
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      // Second call: the other worker completed analysis
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
        DEFAULT_CONFIG
      );

      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;
      expect(result).toEqual({
        status: "cached_analyzed",
        analyzedResult: cachedResult,
      });
    });

    it("returns COMMITTED_RESULT after waiting for in-progress to commit", async () => {
      // First call: IN_PROGRESS
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "IN_PROGRESS",
          lease_expires_at: "2024-01-01T00:00:30.000Z",
        },
        error: null,
      });

      // Second call: the other worker committed
      mockRpc.mockResolvedValueOnce({
        data: {
          outcome: "COMMITTED_RESULT",
        },
        error: null,
      });

      const resultPromise = reserveRequest(
        CONVERSATION_ID,
        REQUEST_ID,
        IDEMPOTENCY_KEY,
        FINGERPRINT,
        DEFAULT_CONFIG
      );

      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;
      expect(result).toEqual({ status: "already_committed" });
    });
  });

  describe("Error handling", () => {
    it("throws on RPC failure", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "Database connection timeout" },
      });

      await expect(
        reserveRequest(
          CONVERSATION_ID,
          REQUEST_ID,
          IDEMPOTENCY_KEY,
          FINGERPRINT,
          DEFAULT_CONFIG
        )
      ).rejects.toThrow("Failed to reserve request");
    });

    it("throws on null response", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: null,
      });

      await expect(
        reserveRequest(
          CONVERSATION_ID,
          REQUEST_ID,
          IDEMPOTENCY_KEY,
          FINGERPRINT,
          DEFAULT_CONFIG
        )
      ).rejects.toThrow("Unexpected null response");
    });
  });
});

describe("recordAnalyzedResult", () => {
  it("records the analyzed result successfully", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });

    const processResult = makeMinimalProcessResult();
    const result = await recordAnalyzedResult(
      REQUEST_ID,
      "test-worker-001",
      processResult,
      5
    );

    expect(result).toEqual({ success: true, reason: undefined });
    expect(mockRpc).toHaveBeenCalledWith("sie_record_analyzed_result", {
      p_request_id: REQUEST_ID,
      p_lease_owner: "test-worker-001",
      p_analyzed_result: processResult,
      p_graph_version_analyzed: 5,
    });
  });

  it("returns failure when not the lease owner", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: "not_lease_owner" },
      error: null,
    });

    const processResult = makeMinimalProcessResult();
    const result = await recordAnalyzedResult(
      REQUEST_ID,
      "wrong-worker",
      processResult,
      5
    );

    expect(result).toEqual({ success: false, reason: "not_lease_owner" });
  });

  it("returns failure when lease has expired", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: "lease_expired" },
      error: null,
    });

    const processResult = makeMinimalProcessResult();
    const result = await recordAnalyzedResult(
      REQUEST_ID,
      "test-worker-001",
      processResult,
      5
    );

    expect(result).toEqual({ success: false, reason: "lease_expired" });
  });

  it("returns failure when request is not in RESERVED status", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: "invalid_status" },
      error: null,
    });

    const processResult = makeMinimalProcessResult();
    const result = await recordAnalyzedResult(
      REQUEST_ID,
      "test-worker-001",
      processResult,
      5
    );

    expect(result).toEqual({ success: false, reason: "invalid_status" });
  });

  it("throws on RPC error", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Connection refused" },
    });

    const processResult = makeMinimalProcessResult();
    await expect(
      recordAnalyzedResult(REQUEST_ID, "test-worker-001", processResult, 5)
    ).rejects.toThrow("Failed to record analyzed result");
  });

  it("throws on null response", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const processResult = makeMinimalProcessResult();
    await expect(
      recordAnalyzedResult(REQUEST_ID, "test-worker-001", processResult, 5)
    ).rejects.toThrow("Unexpected null response");
  });
});

describe("renewLease", () => {
  it("renews lease successfully", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: true, lease_expires_at: "2024-01-01T00:01:00.000Z" },
      error: null,
    });

    const result = await renewLease(REQUEST_ID, "test-worker-001", 30_000);

    expect(result).toEqual({
      success: true,
      leaseExpiresAt: "2024-01-01T00:01:00.000Z",
      reason: undefined,
    });

    expect(mockRpc).toHaveBeenCalledWith("sie_renew_lease", {
      p_request_id: REQUEST_ID,
      p_lease_owner: "test-worker-001",
      p_lease_duration_ms: 30_000,
    });
  });

  it("returns failure when not the lease owner", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: "not_lease_owner" },
      error: null,
    });

    const result = await renewLease(REQUEST_ID, "wrong-worker", 30_000);

    expect(result).toEqual({
      success: false,
      leaseExpiresAt: undefined,
      reason: "not_lease_owner",
    });
  });

  it("returns failure when lease already expired", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: "lease_expired" },
      error: null,
    });

    const result = await renewLease(REQUEST_ID, "test-worker-001", 30_000);

    expect(result).toEqual({
      success: false,
      leaseExpiresAt: undefined,
      reason: "lease_expired",
    });
  });

  it("throws on RPC error", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Timeout" },
    });

    await expect(
      renewLease(REQUEST_ID, "test-worker-001", 30_000)
    ).rejects.toThrow("Failed to renew lease");
  });
});

describe("markFailedRetryable", () => {
  it("marks request as failed-retryable successfully", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });

    const result = await markFailedRetryable(
      REQUEST_ID,
      "test-worker-001",
      "Python service returned 500"
    );

    expect(result).toEqual({ success: true, reason: undefined });
    expect(mockRpc).toHaveBeenCalledWith("sie_mark_failed_retryable", {
      p_request_id: REQUEST_ID,
      p_lease_owner: "test-worker-001",
      p_failure_reason: "Python service returned 500",
    });
  });

  it("returns failure when not the lease owner", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: "not_lease_owner" },
      error: null,
    });

    const result = await markFailedRetryable(
      REQUEST_ID,
      "wrong-worker",
      "Some failure"
    );

    expect(result).toEqual({ success: false, reason: "not_lease_owner" });
  });

  it("throws on RPC error", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "DB error" },
    });

    await expect(
      markFailedRetryable(REQUEST_ID, "test-worker-001", "failure")
    ).rejects.toThrow("Failed to mark request");
  });
});

describe("supersedeRequest", () => {
  it("supersedes a request for version conflict", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });

    const result = await supersedeRequest(
      REQUEST_ID,
      "test-worker-001",
      "req-successor-001",
      "conv-001:seq-1-5:pipe-0.1.0:v6"
    );

    expect(result).toEqual({ success: true, reason: undefined });
    expect(mockRpc).toHaveBeenCalledWith("sie_supersede_request", {
      p_request_id: REQUEST_ID,
      p_lease_owner: "test-worker-001",
      p_successor_request_id: "req-successor-001",
      p_successor_idempotency_key: "conv-001:seq-1-5:pipe-0.1.0:v6",
    });
  });

  it("returns failure when request is not in RESERVED or ANALYZED status", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: "invalid_status" },
      error: null,
    });

    const result = await supersedeRequest(
      REQUEST_ID,
      "test-worker-001",
      "req-successor-001",
      "key"
    );

    expect(result).toEqual({ success: false, reason: "invalid_status" });
  });

  it("throws on RPC error", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Connection lost" },
    });

    await expect(
      supersedeRequest(REQUEST_ID, "test-worker-001", "req-s", "key")
    ).rejects.toThrow("Failed to supersede request");
  });
});

describe("Integration scenarios", () => {
  it("full flow: reserve → record → commit (happy path)", async () => {
    // 1. Reserve
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
      DEFAULT_CONFIG
    );
    expect(reserveResult.status).toBe("lease_acquired");

    // 2. Record analyzed result
    mockRpc.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });

    const processResult = makeMinimalProcessResult();
    const recordResult = await recordAnalyzedResult(
      REQUEST_ID,
      "test-worker-001",
      processResult,
      5
    );
    expect(recordResult.success).toBe(true);
  });

  it("recovery flow: expired lease → retryable lease → re-analyze", async () => {
    // 1. First worker's lease expired; second worker gets RETRYABLE_LEASE
    mockRpc.mockResolvedValueOnce({
      data: {
        outcome: "RETRYABLE_LEASE",
        request_id: REQUEST_ID,
        lease_expires_at: "2024-01-01T00:01:00.000Z",
      },
      error: null,
    });

    const reserveResult = await reserveRequest(
      CONVERSATION_ID,
      "req-new-attempt",
      IDEMPOTENCY_KEY,
      FINGERPRINT,
      DEFAULT_CONFIG
    );

    expect(reserveResult.status).toBe("lease_acquired");
    if (reserveResult.status === "lease_acquired") {
      expect(reserveResult.requestId).toBe(REQUEST_ID);
    }
  });

  it("idempotent retry: returns cached analyzed result", async () => {
    const cachedResult = makeMinimalProcessResult();

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
      DEFAULT_CONFIG
    );

    expect(result.status).toBe("cached_analyzed");
    if (result.status === "cached_analyzed") {
      expect(result.analyzedResult).toEqual(cachedResult);
    }
  });

  it("failure + recovery flow: reserve → fail → retry → succeed", async () => {
    // 1. Mark as failed
    mockRpc.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });
    const failResult = await markFailedRetryable(
      REQUEST_ID,
      "test-worker-001",
      "Python 503"
    );
    expect(failResult.success).toBe(true);

    // 2. Next attempt gets RETRYABLE_LEASE
    mockRpc.mockResolvedValueOnce({
      data: {
        outcome: "RETRYABLE_LEASE",
        request_id: REQUEST_ID,
        lease_expires_at: "2024-01-01T00:02:00.000Z",
      },
      error: null,
    });

    const retryResult = await reserveRequest(
      CONVERSATION_ID,
      "req-retry-002",
      IDEMPOTENCY_KEY,
      FINGERPRINT,
      DEFAULT_CONFIG
    );

    expect(retryResult.status).toBe("lease_acquired");
  });
});
