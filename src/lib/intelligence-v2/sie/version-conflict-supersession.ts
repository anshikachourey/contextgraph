/**
 * Version-Conflict Supersession — Handles stale semantic analysis when graph
 * version has advanced between analysis and commit.
 *
 * Per requirement 9.6-9.7:
 * - TypeScript SHALL commit a returned mutation proposal only if the current
 *   graph version equals Graph_Version_Analyzed.
 * - When the graph version has advanced, TypeScript SHALL reject the stale
 *   proposal, reload current graph state, and request semantic re-analysis.
 *
 * Key invariants:
 * - Stale semantic decisions are NEVER committed against a newer graph version.
 * - The superseded request is marked SUPERSEDED with a successor link.
 * - Semantic creation keys remain STABLE across retries (same semantic event).
 * - Only the payload fingerprint changes (it includes graph version/snapshot).
 * - Bounded retry prevents infinite loops on rapidly advancing graphs.
 */

import { retrieveGraphState } from "./graph-state-retriever";
import { commitSIEResult, computePayloadFingerprint } from "./commit-manager";
import type {
  CommitResult,
  ProcessResult,
  SIEGraphState,
  SIEOrchestratorResult,
} from "./types";
import type { components } from "./generated";

// ─── Transport types ────────────────────────────────────────────────────────

type GraphStateContext = components["schemas"]["GraphStateContext"];
type ProcessRequest = components["schemas"]["ProcessRequest"];

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Configuration for version-conflict supersession retry behavior.
 *
 * All limits come from versioned configuration; no hardcoded defaults
 * are used in production paths. The defaults here are for test usage only.
 */
export interface SupersessionConfig {
  /** Maximum number of version-conflict retries before giving up. */
  maxRetries: number;
  /** Base delay in ms between retries (exponential backoff). */
  baseRetryDelayMs: number;
  /** Maximum total elapsed time for all retries before aborting. */
  maxTotalDurationMs: number;
}

// ─── Supersession Result Types ──────────────────────────────────────────────

export type SupersessionOutcome =
  | { status: "committed"; commitResult: CommitResult; retriesUsed: number }
  | { status: "exhausted"; lastConflictVersion: number; retriesUsed: number; reason: string }
  | { status: "failed"; error: string; retriesUsed: number };

/**
 * Record of a single supersession event for diagnostics and audit.
 */
export interface SupersessionRecord {
  /** The original request ID that was superseded. */
  supersededRequestId: string;
  /** The successor request ID with new version context. */
  successorRequestId: string;
  /** The semantic creation key (stable across retries). */
  semanticCreationKey: string;
  /** Graph version that the superseded request was analyzed against. */
  staleGraphVersion: number;
  /** New graph version loaded for the successor request. */
  newGraphVersion: number;
  /** The new payload fingerprint (version-scoped). */
  newPayloadFingerprint: string;
  /** Timestamp when supersession occurred. */
  supersededAt: string;
}

/**
 * Callback type for invoking Python ml-service with a ProcessRequest.
 * Abstracted so tests can inject deterministic fakes.
 */
export type PythonInvoker = (
  request: ProcessRequest
) => Promise<ProcessResult>;

/**
 * Callback type for marking a request as SUPERSEDED in the database.
 * Records the successor link and ensures the old request never commits.
 */
export type SupersedeRequestFn = (params: {
  supersededRequestId: string;
  successorRequestId: string;
  successorKey: string;
  reason: string;
}) => Promise<void>;

// ─── Semantic Creation Key Derivation ───────────────────────────────────────

/**
 * Derives the stable semantic creation key from request identity.
 *
 * The semantic creation key is stable across retries and version-conflict
 * re-analysis because it is derived from:
 * - conversation_id
 * - packet lineage (source message IDs + sequence range)
 * - pipeline/contract version
 *
 * It explicitly EXCLUDES:
 * - raw request_id (changes per attempt)
 * - graph version (changes on conflict)
 * - timestamp or lease metadata
 */
export function deriveSemanticCreationKey(
  conversationId: string,
  messageSeqStart: number,
  messageSeqEnd: number,
  pipelineVersion: string
): string {
  return `${conversationId}:seq-${messageSeqStart}-${messageSeqEnd}:pipe-${pipelineVersion}`;
}

/**
 * Generates a successor request ID for a version-conflict retry.
 * The request ID is unique per attempt but the semantic creation key stays stable.
 */
export function generateSuccessorRequestId(
  semanticCreationKey: string,
  newGraphVersion: number,
  retryOrdinal: number
): string {
  return `${semanticCreationKey}:v${newGraphVersion}:retry-${retryOrdinal}`;
}

// ─── Core Supersession Logic ────────────────────────────────────────────────

/**
 * Handles version-conflict supersession with bounded retry.
 *
 * When commitSIEResult returns retryRequired=true (version conflict):
 * 1. Marks the stale request as SUPERSEDED with successor link.
 * 2. Reloads current graph state (which has a newer version).
 * 3. Builds a new ProcessRequest with the same semantic creation key
 *    but a new version-scoped payload fingerprint.
 * 4. Re-invokes Python ml-service for fresh semantic analysis.
 * 5. Attempts to commit the new result.
 * 6. Repeats if another conflict occurs, up to maxRetries.
 *
 * @param conversationId - The conversation being processed
 * @param initialProcessResult - The first analysis result that hit a version conflict
 * @param initialGraphState - The graph state used for the stale analysis
 * @param originalRequest - The original ProcessRequest (for re-invocation)
 * @param invokePython - Callback to invoke the Python ml-service
 * @param supersedeRequest - Callback to mark requests as SUPERSEDED in DB
 * @param config - Bounded retry configuration
 * @returns SupersessionOutcome indicating final result
 */
export async function handleVersionConflictSupersession(
  conversationId: string,
  initialProcessResult: ProcessResult,
  initialGraphState: SIEGraphState,
  originalRequest: ProcessRequest,
  invokePython: PythonInvoker,
  supersedeRequest: SupersedeRequestFn,
  config: SupersessionConfig
): Promise<SupersessionOutcome> {
  const startTime = Date.now();
  const semanticCreationKey = deriveSemanticCreationKey(
    conversationId,
    originalRequest.message_seq_start,
    originalRequest.message_seq_end,
    originalRequest.pipeline_version
  );

  let currentProcessResult = initialProcessResult;
  let currentGraphState = initialGraphState;
  let retriesUsed = 0;
  const supersessionRecords: SupersessionRecord[] = [];

  while (retriesUsed < config.maxRetries) {
    // ─── Check total duration budget ────────────────────────────────────
    const elapsed = Date.now() - startTime;
    if (elapsed >= config.maxTotalDurationMs) {
      return {
        status: "exhausted",
        lastConflictVersion: currentGraphState.graphVersion,
        retriesUsed,
        reason: `Total duration budget exhausted (${elapsed}ms >= ${config.maxTotalDurationMs}ms)`,
      };
    }

    retriesUsed++;
    const supersededRequestId = currentProcessResult.request_id;
    const staleGraphVersion = currentProcessResult.base_graph_version;

    // ─── Step 1: Reload fresh graph state ─────────────────────────────────
    let freshGraphState;
    try {
      freshGraphState = await retrieveGraphState(conversationId);
    } catch (err) {
      return {
        status: "failed",
        error: `Failed to reload graph state on retry ${retriesUsed}: ${err instanceof Error ? err.message : String(err)}`,
        retriesUsed,
      };
    }

    const newGraphVersion = freshGraphState.graphVersion;

    // If somehow the version hasn't advanced, something is wrong
    if (newGraphVersion <= staleGraphVersion) {
      return {
        status: "failed",
        error: `Graph version did not advance after conflict (stale: ${staleGraphVersion}, fresh: ${newGraphVersion})`,
        retriesUsed,
      };
    }

    // ─── Step 2: Generate successor request identity ────────────────────────
    const successorRequestId = generateSuccessorRequestId(
      semanticCreationKey,
      newGraphVersion,
      retriesUsed
    );

    // ─── Step 3: Mark the stale request as SUPERSEDED ─────────────────────
    try {
      await supersedeRequest({
        supersededRequestId,
        successorRequestId,
        successorKey: semanticCreationKey,
        reason: `Version conflict: analyzed v${staleGraphVersion} but current is v${newGraphVersion}`,
      });
    } catch (err) {
      return {
        status: "failed",
        error: `Failed to mark request ${supersededRequestId} as SUPERSEDED: ${err instanceof Error ? err.message : String(err)}`,
        retriesUsed,
      };
    }

    // ─── Step 4: Build new ProcessRequest with fresh context ──────────────
    // Semantic creation key is preserved; payload fingerprint changes due to new graph version
    const newRequest: ProcessRequest = {
      ...originalRequest,
      request_id: successorRequestId,
      // Idempotency key includes graph version so it's version-scoped
      idempotency_key: `${semanticCreationKey}:gv-${newGraphVersion}`,
      base_graph_version: newGraphVersion,
      current_graph_state: freshGraphState.graphStateContext,
    };

    // ─── Step 5: Re-invoke Python with fresh context ──────────────────────
    let newProcessResult: ProcessResult;
    try {
      newProcessResult = await invokePython(newRequest);
    } catch (err) {
      return {
        status: "failed",
        error: `Python re-invocation failed on retry ${retriesUsed}: ${err instanceof Error ? err.message : String(err)}`,
        retriesUsed,
      };
    }

    // Record supersession for diagnostics
    supersessionRecords.push({
      supersededRequestId,
      successorRequestId,
      semanticCreationKey,
      staleGraphVersion,
      newGraphVersion,
      newPayloadFingerprint: computePayloadFingerprint(newProcessResult),
      supersededAt: new Date().toISOString(),
    });

    // ─── Step 6: Attempt to commit the fresh result ───────────────────────
    let commitResult: CommitResult;
    try {
      commitResult = await commitSIEResult(
        conversationId,
        newProcessResult,
        freshGraphState.sieGraphState
      );
    } catch (err) {
      return {
        status: "failed",
        error: `Commit failed on retry ${retriesUsed}: ${err instanceof Error ? err.message : String(err)}`,
        retriesUsed,
      };
    }

    // ─── Step 7: Check if commit succeeded or hit another conflict ────────
    if (commitResult.success) {
      return {
        status: "committed",
        commitResult,
        retriesUsed,
      };
    }

    if (commitResult.retryRequired) {
      // Another version conflict — loop continues with bounded retry
      currentProcessResult = newProcessResult;
      currentGraphState = freshGraphState.sieGraphState;

      // Apply exponential backoff delay before next retry
      const delay = Math.min(
        config.baseRetryDelayMs * Math.pow(2, retriesUsed - 1),
        5000 // Cap at 5 seconds
      );
      await sleep(delay);
      continue;
    }

    // Non-retryable failure (invariant violations, etc.)
    return {
      status: "failed",
      error: `Commit rejected (non-retryable) on retry ${retriesUsed}: ${JSON.stringify(commitResult.violations)}`,
      retriesUsed,
    };
  }

  // ─── Exhausted all retries ──────────────────────────────────────────────
  return {
    status: "exhausted",
    lastConflictVersion: currentGraphState.graphVersion,
    retriesUsed,
    reason: `Maximum retries exhausted (${config.maxRetries})`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validates that a semantic creation key has not changed between retries.
 * This is a safety check ensuring the same semantic event is being retried,
 * not a different request altogether.
 */
export function validateSemanticKeyStability(
  originalKey: string,
  retryKey: string
): boolean {
  return originalKey === retryKey;
}

/**
 * Determines whether a payload fingerprint would change given a new graph version.
 *
 * Since the payload fingerprint includes base_graph_version, any graph-version
 * change guarantees a different fingerprint. This is used as a fast-path check
 * before full fingerprint computation.
 */
export function wouldFingerprintChange(
  originalGraphVersion: number,
  newGraphVersion: number
): boolean {
  return originalGraphVersion !== newGraphVersion;
}
