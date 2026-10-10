/**
 * SIE Reservation Orchestrator — Manages the request reservation state machine
 * from the TypeScript orchestration layer.
 *
 * Responsibilities:
 * - Reserve requests via sie_reserve_request RPC
 * - Handle every reservation outcome (NEW_LEASE, ANALYZED_RESULT, COMMITTED_RESULT,
 *   IN_PROGRESS, FINGERPRINT_CONFLICT, RETRYABLE_LEASE)
 * - Serialize concurrent duplicates with bounded wait/retry
 * - Record validated analyzed results before commit
 * - Renew leases during long operations
 * - Recover expired leases and retryable failures without duplicating committed work
 *
 * Design rules:
 * - TypeScript does NOT make semantic decisions — it only orchestrates
 * - Only the active lease owner may record analysis or transition the request
 * - The validated Python result is persisted before graph commit so response-loss
 *   recovery does not rerun nondeterministic analysis
 * - Crashed requests recover after lease expiry
 * - Reusing an idempotency key with same payload fingerprint returns cached result
 * - Reusing with different fingerprint fails validation
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { ProcessResult } from "./types";

// ─── Reservation Outcome Types ──────────────────────────────────────────────

/**
 * Possible outcomes from the sie_reserve_request RPC.
 */
export type ReservationOutcome =
  | "NEW_LEASE"
  | "ANALYZED_RESULT"
  | "COMMITTED_RESULT"
  | "IN_PROGRESS"
  | "FINGERPRINT_CONFLICT"
  | "RETRYABLE_LEASE";

/**
 * Raw result returned by the sie_reserve_request RPC.
 */
export interface ReservationRPCResult {
  outcome: ReservationOutcome;
  request_id?: string;
  lease_expires_at?: string;
  analyzed_result?: unknown;
}

/**
 * Result of the reservation orchestration attempt.
 */
export type ReservationResult =
  | { status: "lease_acquired"; requestId: string; leaseExpiresAt: string }
  | { status: "cached_analyzed"; analyzedResult: ProcessResult }
  | { status: "already_committed" }
  | { status: "fingerprint_conflict" }
  | { status: "wait_timeout"; message: string };

/**
 * Result of recording an analyzed result.
 */
export interface RecordAnalyzedResultOutcome {
  success: boolean;
  reason?: string;
}

/**
 * Result of a lease renewal.
 */
export interface LeaseRenewalResult {
  success: boolean;
  leaseExpiresAt?: string;
  reason?: string;
}

/**
 * Result of marking a request as failed-retryable.
 */
export interface MarkFailedResult {
  success: boolean;
  reason?: string;
}

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Configuration for the reservation orchestrator.
 * All values must come from approved versioned configuration.
 */
export interface ReservationConfig {
  /** Lease duration in milliseconds for reservations. */
  leaseDurationMs: number;
  /** Maximum number of wait attempts for IN_PROGRESS serialization. */
  maxWaitAttempts: number;
  /** Base delay in milliseconds between wait attempts (exponential backoff). */
  waitBaseDelayMs: number;
  /** Maximum total wait time in milliseconds before giving up on IN_PROGRESS. */
  maxWaitTotalMs: number;
  /** Unique identifier for this worker/process instance. */
  leaseOwner: string;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Sleep for the specified duration. Used for bounded wait/retry backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute exponential backoff delay with jitter.
 */
function computeBackoff(attempt: number, baseMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs;
  return Math.min(exponential + jitter, 10_000); // Cap at 10s
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Attempts to reserve a request, handling every reservation outcome.
 *
 * This function implements the complete reservation state machine from the
 * TypeScript side:
 *
 * - NEW_LEASE: Fresh reservation acquired; caller proceeds with analysis.
 * - ANALYZED_RESULT: Same idempotency key + fingerprint with cached result;
 *   returns the cached ProcessResult without re-running analysis.
 * - COMMITTED_RESULT: Already fully committed; nothing to do.
 * - IN_PROGRESS: Another worker holds the lease; waits with bounded retry
 *   until the other worker completes, the lease expires, or timeout.
 * - FINGERPRINT_CONFLICT: Different payload fingerprint for same idempotency key.
 * - RETRYABLE_LEASE: Recovered from expired lease or failed-retryable state.
 *
 * @param conversationId - The conversation this request belongs to.
 * @param requestId - Stable request identifier.
 * @param idempotencyKey - Idempotency key for this processing request.
 * @param payloadFingerprintHash - Hash of the canonical payload fingerprint.
 * @param config - Reservation configuration (lease duration, wait params, owner).
 * @returns A ReservationResult indicating what the caller should do next.
 */
export async function reserveRequest(
  conversationId: string,
  requestId: string,
  idempotencyKey: string,
  payloadFingerprintHash: string,
  config: ReservationConfig
): Promise<ReservationResult> {
  const startTime = Date.now();
  let attempts = 0;

  while (attempts <= config.maxWaitAttempts) {
    const elapsed = Date.now() - startTime;
    if (attempts > 0 && elapsed >= config.maxWaitTotalMs) {
      return {
        status: "wait_timeout",
        message: `Timed out waiting for in-progress request after ${elapsed}ms (${attempts} attempts)`,
      };
    }

    const rpcResult = await callReserveRPC(
      conversationId,
      requestId,
      idempotencyKey,
      payloadFingerprintHash,
      config.leaseOwner,
      config.leaseDurationMs
    );

    switch (rpcResult.outcome) {
      case "NEW_LEASE":
        return {
          status: "lease_acquired",
          requestId: rpcResult.request_id ?? requestId,
          leaseExpiresAt: rpcResult.lease_expires_at!,
        };

      case "ANALYZED_RESULT":
        // Cached semantic result from a previous analysis; no re-run needed.
        return {
          status: "cached_analyzed",
          analyzedResult: rpcResult.analyzed_result as ProcessResult,
        };

      case "COMMITTED_RESULT":
        // Already fully committed; nothing more to do.
        return { status: "already_committed" };

      case "FINGERPRINT_CONFLICT":
        // Different payload for same idempotency key — validation failure.
        return { status: "fingerprint_conflict" };

      case "RETRYABLE_LEASE":
        // Recovered from expired lease or failed state; proceed with analysis.
        return {
          status: "lease_acquired",
          requestId: rpcResult.request_id ?? requestId,
          leaseExpiresAt: rpcResult.lease_expires_at!,
        };

      case "IN_PROGRESS":
        // Another worker holds the lease. Wait with bounded backoff.
        attempts++;
        if (attempts > config.maxWaitAttempts) {
          return {
            status: "wait_timeout",
            message: `Exceeded max wait attempts (${config.maxWaitAttempts}) for in-progress request`,
          };
        }
        const delay = computeBackoff(attempts - 1, config.waitBaseDelayMs);
        await sleep(delay);
        break;

      default: {
        // Defensive: unknown outcome treated as conflict.
        const _exhaustive: never = rpcResult.outcome;
        return { status: "fingerprint_conflict" };
      }
    }
  }

  return {
    status: "wait_timeout",
    message: `Exceeded max wait attempts (${config.maxWaitAttempts}) for in-progress request`,
  };
}

/**
 * Records a validated analyzed result (Python semantic output) before commit.
 *
 * This persists the semantic result so that response-loss recovery does not
 * rerun nondeterministic Python analysis. Only the active lease owner may
 * record the result.
 *
 * @param requestId - The request to record the result for.
 * @param leaseOwner - Must match the current lease owner.
 * @param analyzedResult - The validated ProcessResult from Python.
 * @param graphVersionAnalyzed - The graph version used during analysis.
 * @returns Whether the recording was successful.
 */
export async function recordAnalyzedResult(
  requestId: string,
  leaseOwner: string,
  analyzedResult: ProcessResult,
  graphVersionAnalyzed: number
): Promise<RecordAnalyzedResultOutcome> {
  const db = createServerSupabaseClient();

  const { data, error } = await db.rpc("sie_record_analyzed_result", {
    p_request_id: requestId,
    p_lease_owner: leaseOwner,
    p_analyzed_result: analyzedResult as unknown as Record<string, unknown>,
    p_graph_version_analyzed: graphVersionAnalyzed,
  });

  if (error) {
    throw new Error(
      `Failed to record analyzed result for request ${requestId}: ${error.message}`
    );
  }

  const result = data as { success: boolean; reason?: string } | null;
  if (!result) {
    throw new Error(
      `Unexpected null response from sie_record_analyzed_result for request ${requestId}`
    );
  }

  return {
    success: result.success,
    reason: result.reason,
  };
}

/**
 * Renews an active lease to prevent expiry during long operations.
 *
 * Should be called periodically during Python analysis or other long-running
 * steps to ensure the lease does not expire while work is in progress.
 * Only the current lease owner may renew.
 *
 * @param requestId - The request whose lease to renew.
 * @param leaseOwner - Must match the current lease owner.
 * @param leaseDurationMs - New lease duration in milliseconds.
 * @returns Whether the renewal was successful, with new expiry if so.
 */
export async function renewLease(
  requestId: string,
  leaseOwner: string,
  leaseDurationMs: number
): Promise<LeaseRenewalResult> {
  const db = createServerSupabaseClient();

  const { data, error } = await db.rpc("sie_renew_lease", {
    p_request_id: requestId,
    p_lease_owner: leaseOwner,
    p_lease_duration_ms: leaseDurationMs,
  });

  if (error) {
    throw new Error(
      `Failed to renew lease for request ${requestId}: ${error.message}`
    );
  }

  const result = data as {
    success: boolean;
    lease_expires_at?: string;
    reason?: string;
  } | null;

  if (!result) {
    throw new Error(
      `Unexpected null response from sie_renew_lease for request ${requestId}`
    );
  }

  return {
    success: result.success,
    leaseExpiresAt: result.lease_expires_at,
    reason: result.reason,
  };
}

/**
 * Marks a request as failed-retryable after a transient failure.
 *
 * Transitions the request to FAILED_RETRYABLE, clears the lease, and records
 * the failure reason. A subsequent caller can reacquire the request via
 * RETRYABLE_LEASE outcome.
 *
 * @param requestId - The request to mark as failed.
 * @param leaseOwner - Must match the current lease owner.
 * @param failureReason - Human-readable reason for the failure.
 * @returns Whether the operation was successful.
 */
export async function markFailedRetryable(
  requestId: string,
  leaseOwner: string,
  failureReason: string
): Promise<MarkFailedResult> {
  const db = createServerSupabaseClient();

  const { data, error } = await db.rpc("sie_mark_failed_retryable", {
    p_request_id: requestId,
    p_lease_owner: leaseOwner,
    p_failure_reason: failureReason,
  });

  if (error) {
    throw new Error(
      `Failed to mark request ${requestId} as failed-retryable: ${error.message}`
    );
  }

  const result = data as { success: boolean; reason?: string } | null;
  if (!result) {
    throw new Error(
      `Unexpected null response from sie_mark_failed_retryable for request ${requestId}`
    );
  }

  return {
    success: result.success,
    reason: result.reason,
  };
}

/**
 * Supersedes a request due to version conflict, linking to its successor.
 *
 * Used when a graph version conflict is detected: the stale request is
 * superseded and a new reservation is created for the updated version.
 * Only the lease owner may supersede.
 *
 * @param requestId - The stale request to supersede.
 * @param leaseOwner - Must match the current lease owner.
 * @param successorRequestId - The new request that replaces this one.
 * @param successorIdempotencyKey - Idempotency key for the successor request.
 * @returns Whether the operation was successful.
 */
export async function supersedeRequest(
  requestId: string,
  leaseOwner: string,
  successorRequestId: string,
  successorIdempotencyKey: string
): Promise<{ success: boolean; reason?: string }> {
  const db = createServerSupabaseClient();

  const { data, error } = await db.rpc("sie_supersede_request", {
    p_request_id: requestId,
    p_lease_owner: leaseOwner,
    p_successor_request_id: successorRequestId,
    p_successor_idempotency_key: successorIdempotencyKey,
  });

  if (error) {
    throw new Error(
      `Failed to supersede request ${requestId}: ${error.message}`
    );
  }

  const result = data as { success: boolean; reason?: string } | null;
  if (!result) {
    throw new Error(
      `Unexpected null response from sie_supersede_request for request ${requestId}`
    );
  }

  return {
    success: result.success,
    reason: result.reason,
  };
}

// ─── Internal RPC Caller ────────────────────────────────────────────────────

/**
 * Calls the sie_reserve_request database RPC.
 * Isolated for testability.
 */
async function callReserveRPC(
  conversationId: string,
  requestId: string,
  idempotencyKey: string,
  payloadFingerprintHash: string,
  leaseOwner: string,
  leaseDurationMs: number
): Promise<ReservationRPCResult> {
  const db = createServerSupabaseClient();

  const { data, error } = await db.rpc("sie_reserve_request", {
    p_conversation_id: conversationId,
    p_request_id: requestId,
    p_idempotency_key: idempotencyKey,
    p_payload_fingerprint_hash: payloadFingerprintHash,
    p_lease_owner: leaseOwner,
    p_lease_duration_ms: leaseDurationMs,
  });

  if (error) {
    throw new Error(
      `Failed to reserve request for conversation ${conversationId}: ${error.message}`
    );
  }

  if (!data) {
    throw new Error(
      `Unexpected null response from sie_reserve_request for conversation ${conversationId}`
    );
  }

  return data as ReservationRPCResult;
}
