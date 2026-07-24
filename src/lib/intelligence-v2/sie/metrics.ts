/**
 * SIE Identity Resolution Structured Metrics (TypeScript Orchestration Side)
 *
 * Provides typed, versioned metric events for the TypeScript orchestration
 * layer. Covers context loading, reservation, commit, version-conflict
 * supersession, and cache-hit observability.
 *
 * All metric schemas are versioned (METRICS_SCHEMA_VERSION) for forward-
 * compatible evolution. Events are emitted as structured objects suitable
 * for consumption by observability/logging infrastructure.
 *
 * Per Requirement 11.4: structured metrics for latency, channel use,
 * widening frequency, model routing, retries, failures, pending-decision
 * rate, dormant reactivation, new-concern proposals, and version-conflict
 * re-analysis.
 *
 * Design authority: requirements.md §11.4, tasks.md §17.1.
 */

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const METRICS_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Metric event types (orchestration side)
// ---------------------------------------------------------------------------

export type OrchestratorMetricEventType =
  | "context_load_latency"
  | "reservation_latency"
  | "reservation_outcome"
  | "commit_latency"
  | "commit_outcome"
  | "version_conflict"
  | "supersession_attempt"
  | "supersession_outcome"
  | "cache_hit"
  | "invariant_validation_latency"
  | "invariant_violation"
  | "pipeline_invocation_latency"
  | "retry_attempt"
  | "failure";

// ---------------------------------------------------------------------------
// Metric event structure
// ---------------------------------------------------------------------------

export interface OrchestratorMetricEvent {
  /** Schema version for forward compatibility. */
  schema_version: string;
  /** Event classification. */
  event_type: OrchestratorMetricEventType;
  /** Conversation context. */
  conversation_id: string;
  /** Request that generated this event. */
  request_id: string;
  /** Unix timestamp in milliseconds. */
  timestamp_ms: number;
  /** Key-value dimensions carrying the metric data. */
  dimensions: Record<string, unknown>;
  /** Optional numeric value (latency in ms, count, etc.). */
  value?: number;
}

// ---------------------------------------------------------------------------
// Metrics collector
// ---------------------------------------------------------------------------

/**
 * Collects structured metric events during TypeScript orchestration
 * of a single SIE identity resolution request.
 *
 * Events are buffered and flushed at the end of processing.
 * Not shared across requests.
 */
export class OrchestratorMetricsCollector {
  private events: OrchestratorMetricEvent[] = [];
  private conversationId: string;
  private requestId: string;

  constructor(conversationId: string, requestId: string) {
    this.conversationId = conversationId;
    this.requestId = requestId;
  }

  /** Get collected events (for testing / external consumption). */
  getEvents(): OrchestratorMetricEvent[] {
    return [...this.events];
  }

  // -----------------------------------------------------------------
  // Context loading
  // -----------------------------------------------------------------

  recordContextLoadLatency(latencyMs: number, concernCount: number, embeddingCount: number): void {
    this.emit("context_load_latency", latencyMs, {
      concern_count: concernCount,
      embedding_count: embeddingCount,
    });
  }

  // -----------------------------------------------------------------
  // Reservation
  // -----------------------------------------------------------------

  recordReservationLatency(latencyMs: number): void {
    this.emit("reservation_latency", latencyMs, {});
  }

  recordReservationOutcome(
    outcome: "NEW_LEASE" | "ANALYZED_RESULT" | "COMMITTED_RESULT" | "IN_PROGRESS" | "FINGERPRINT_CONFLICT" | "RETRYABLE_LEASE",
  ): void {
    this.emit("reservation_outcome", undefined, { outcome });
  }

  // -----------------------------------------------------------------
  // Commit
  // -----------------------------------------------------------------

  recordCommitLatency(latencyMs: number, bundleSections: number): void {
    this.emit("commit_latency", latencyMs, {
      bundle_sections: bundleSections,
    });
  }

  recordCommitOutcome(
    success: boolean,
    failureReason?: string,
  ): void {
    this.emit("commit_outcome", undefined, {
      success,
      failure_reason: failureReason ?? null,
    });
  }

  // -----------------------------------------------------------------
  // Version conflicts
  // -----------------------------------------------------------------

  recordVersionConflict(
    analyzedVersion: number,
    currentVersion: number,
  ): void {
    this.emit("version_conflict", undefined, {
      analyzed_version: analyzedVersion,
      current_version: currentVersion,
    });
  }

  recordSupersessionAttempt(
    retryNumber: number,
    previousVersion: number,
    newVersion: number,
  ): void {
    this.emit("supersession_attempt", retryNumber, {
      previous_version: previousVersion,
      new_version: newVersion,
    });
  }

  recordSupersessionOutcome(
    status: "committed" | "exhausted" | "failed",
    retriesUsed: number,
    reason?: string,
  ): void {
    this.emit("supersession_outcome", retriesUsed, {
      status,
      reason: reason ?? null,
    });
  }

  // -----------------------------------------------------------------
  // Cache hits
  // -----------------------------------------------------------------

  recordCacheHit(
    cacheType: "analyzed_result" | "committed_result",
    idempotencyKey: string,
  ): void {
    this.emit("cache_hit", undefined, {
      cache_type: cacheType,
      idempotency_key: idempotencyKey,
    });
  }

  // -----------------------------------------------------------------
  // Invariant validation
  // -----------------------------------------------------------------

  recordInvariantValidationLatency(latencyMs: number): void {
    this.emit("invariant_validation_latency", latencyMs, {});
  }

  recordInvariantViolation(
    violationType: string,
    detail: string,
  ): void {
    this.emit("invariant_violation", undefined, {
      violation_type: violationType,
      detail,
    });
  }

  // -----------------------------------------------------------------
  // Pipeline invocation (Python call)
  // -----------------------------------------------------------------

  recordPipelineInvocationLatency(
    latencyMs: number,
    packetCount: number,
  ): void {
    this.emit("pipeline_invocation_latency", latencyMs, {
      packet_count: packetCount,
    });
  }

  // -----------------------------------------------------------------
  // Retries
  // -----------------------------------------------------------------

  recordRetryAttempt(
    retryType: "reservation" | "commit" | "context_load" | "pipeline_invocation",
    attemptNumber: number,
    reason: string,
  ): void {
    this.emit("retry_attempt", attemptNumber, {
      retry_type: retryType,
      reason,
    });
  }

  // -----------------------------------------------------------------
  // Failures
  // -----------------------------------------------------------------

  recordFailure(
    failureType: "context_load" | "reservation" | "pipeline" | "commit" | "invariant" | "contract",
    reason: string,
    recoverable: boolean,
  ): void {
    this.emit("failure", undefined, {
      failure_type: failureType,
      reason,
      recoverable,
    });
  }

  // -----------------------------------------------------------------
  // Flush
  // -----------------------------------------------------------------

  /**
   * Flush all collected events. Returns the events for downstream processing.
   * In production, these would be forwarded to the observability backend.
   */
  flush(): OrchestratorMetricEvent[] {
    const flushed = [...this.events];
    this.events = [];
    // In production, emit to structured logging / metrics backend
    for (const event of flushed) {
      // Structured log emission (console.log for now, replaced by
      // observability SDK in production deployment)
      if (typeof globalThis !== "undefined" && process?.env?.NODE_ENV !== "test") {
        console.log(JSON.stringify({ type: "sie_metric", ...event }));
      }
    }
    return flushed;
  }

  // -----------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------

  private emit(
    eventType: OrchestratorMetricEventType,
    value: number | undefined,
    dimensions: Record<string, unknown>,
  ): void {
    this.events.push({
      schema_version: METRICS_SCHEMA_VERSION,
      event_type: eventType,
      conversation_id: this.conversationId,
      request_id: this.requestId,
      timestamp_ms: Date.now(),
      dimensions,
      value,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a metrics collector for one orchestration request.
 */
export function createOrchestratorMetrics(
  conversationId: string,
  requestId: string,
): OrchestratorMetricsCollector {
  return new OrchestratorMetricsCollector(conversationId, requestId);
}
