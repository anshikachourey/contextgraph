/**
 * Tests for SIE Orchestrator Structured Metrics.
 *
 * Verifies:
 * - All metric event types are emittable and serializable.
 * - Schema version is included in every event.
 * - Context load, reservation, commit, version-conflict, cache-hit,
 *   invariant, pipeline invocation, retries, and failures are measurable.
 * - Collector buffers and flushes correctly.
 * - Events include correct conversation and request IDs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  METRICS_SCHEMA_VERSION,
  OrchestratorMetricsCollector,
  createOrchestratorMetrics,
  type OrchestratorMetricEvent,
} from "../metrics";

describe("SIE Orchestrator Metrics", () => {
  let collector: OrchestratorMetricsCollector;

  beforeEach(() => {
    collector = createOrchestratorMetrics("conv-test-123", "req-test-456");
  });

  // -------------------------------------------------------------------------
  // Schema versioning
  // -------------------------------------------------------------------------

  describe("Schema Versioning", () => {
    it("METRICS_SCHEMA_VERSION is a non-empty semver string", () => {
      expect(METRICS_SCHEMA_VERSION).toBeTruthy();
      const parts = METRICS_SCHEMA_VERSION.split(".");
      expect(parts).toHaveLength(3);
      parts.forEach((p) => expect(Number.isInteger(Number(p))).toBe(true));
    });

    it("all events include schema_version", () => {
      collector.recordContextLoadLatency(50, 10, 8);
      collector.recordCommitLatency(30, 2);
      const events = collector.flush();
      events.forEach((e) => {
        expect(e.schema_version).toBe(METRICS_SCHEMA_VERSION);
      });
    });

    it("all events include conversation_id and request_id", () => {
      collector.recordContextLoadLatency(50, 10, 8);
      const events = collector.flush();
      events.forEach((e) => {
        expect(e.conversation_id).toBe("conv-test-123");
        expect(e.request_id).toBe("req-test-456");
      });
    });
  });

  // -------------------------------------------------------------------------
  // Context loading
  // -------------------------------------------------------------------------

  describe("Context Load Metrics", () => {
    it("records context load latency with counts", () => {
      collector.recordContextLoadLatency(120, 15, 12);
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("context_load_latency");
      expect(events[0].value).toBe(120);
      expect(events[0].dimensions.concern_count).toBe(15);
      expect(events[0].dimensions.embedding_count).toBe(12);
    });
  });

  // -------------------------------------------------------------------------
  // Reservation
  // -------------------------------------------------------------------------

  describe("Reservation Metrics", () => {
    it("records reservation latency", () => {
      collector.recordReservationLatency(25);
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("reservation_latency");
      expect(events[0].value).toBe(25);
    });

    it("records reservation outcome", () => {
      collector.recordReservationOutcome("NEW_LEASE");
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("reservation_outcome");
      expect(events[0].dimensions.outcome).toBe("NEW_LEASE");
    });

    it("records all reservation outcome types", () => {
      const outcomes = [
        "NEW_LEASE",
        "ANALYZED_RESULT",
        "COMMITTED_RESULT",
        "IN_PROGRESS",
        "FINGERPRINT_CONFLICT",
        "RETRYABLE_LEASE",
      ] as const;
      outcomes.forEach((o) => collector.recordReservationOutcome(o));
      const events = collector.flush();
      expect(events).toHaveLength(outcomes.length);
    });
  });

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  describe("Commit Metrics", () => {
    it("records commit latency", () => {
      collector.recordCommitLatency(45, 3);
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("commit_latency");
      expect(events[0].value).toBe(45);
      expect(events[0].dimensions.bundle_sections).toBe(3);
    });

    it("records commit success", () => {
      collector.recordCommitOutcome(true);
      const events = collector.flush();
      expect(events[0].dimensions.success).toBe(true);
      expect(events[0].dimensions.failure_reason).toBeNull();
    });

    it("records commit failure with reason", () => {
      collector.recordCommitOutcome(false, "version_mismatch");
      const events = collector.flush();
      expect(events[0].dimensions.success).toBe(false);
      expect(events[0].dimensions.failure_reason).toBe("version_mismatch");
    });
  });

  // -------------------------------------------------------------------------
  // Version conflicts
  // -------------------------------------------------------------------------

  describe("Version Conflict Metrics", () => {
    it("records version conflict", () => {
      collector.recordVersionConflict(5, 8);
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("version_conflict");
      expect(events[0].dimensions.analyzed_version).toBe(5);
      expect(events[0].dimensions.current_version).toBe(8);
    });

    it("records supersession attempt", () => {
      collector.recordSupersessionAttempt(2, 5, 8);
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("supersession_attempt");
      expect(events[0].value).toBe(2);
      expect(events[0].dimensions.previous_version).toBe(5);
      expect(events[0].dimensions.new_version).toBe(8);
    });

    it("records supersession outcome - committed", () => {
      collector.recordSupersessionOutcome("committed", 1);
      const events = collector.flush();
      expect(events[0].event_type).toBe("supersession_outcome");
      expect(events[0].dimensions.status).toBe("committed");
      expect(events[0].value).toBe(1);
    });

    it("records supersession outcome - exhausted", () => {
      collector.recordSupersessionOutcome("exhausted", 3, "max_retries_reached");
      const events = collector.flush();
      expect(events[0].dimensions.status).toBe("exhausted");
      expect(events[0].dimensions.reason).toBe("max_retries_reached");
    });
  });

  // -------------------------------------------------------------------------
  // Cache hits
  // -------------------------------------------------------------------------

  describe("Cache Hit Metrics", () => {
    it("records analyzed_result cache hit", () => {
      collector.recordCacheHit("analyzed_result", "key-123");
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("cache_hit");
      expect(events[0].dimensions.cache_type).toBe("analyzed_result");
      expect(events[0].dimensions.idempotency_key).toBe("key-123");
    });

    it("records committed_result cache hit", () => {
      collector.recordCacheHit("committed_result", "key-456");
      const events = collector.flush();
      expect(events[0].dimensions.cache_type).toBe("committed_result");
    });
  });

  // -------------------------------------------------------------------------
  // Invariant validation
  // -------------------------------------------------------------------------

  describe("Invariant Validation Metrics", () => {
    it("records invariant validation latency", () => {
      collector.recordInvariantValidationLatency(15);
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("invariant_validation_latency");
      expect(events[0].value).toBe(15);
    });

    it("records invariant violation", () => {
      collector.recordInvariantViolation(
        "discriminated_result",
        "YES outcome with no matched_concern_id"
      );
      const events = collector.flush();
      expect(events[0].event_type).toBe("invariant_violation");
      expect(events[0].dimensions.violation_type).toBe("discriminated_result");
    });
  });

  // -------------------------------------------------------------------------
  // Pipeline invocation
  // -------------------------------------------------------------------------

  describe("Pipeline Invocation Metrics", () => {
    it("records pipeline invocation latency", () => {
      collector.recordPipelineInvocationLatency(2500, 3);
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("pipeline_invocation_latency");
      expect(events[0].value).toBe(2500);
      expect(events[0].dimensions.packet_count).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Retries
  // -------------------------------------------------------------------------

  describe("Retry Metrics", () => {
    it("records reservation retry", () => {
      collector.recordRetryAttempt("reservation", 2, "in_progress_wait");
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("retry_attempt");
      expect(events[0].value).toBe(2);
      expect(events[0].dimensions.retry_type).toBe("reservation");
      expect(events[0].dimensions.reason).toBe("in_progress_wait");
    });

    it("records commit retry", () => {
      collector.recordRetryAttempt("commit", 1, "version_conflict");
      const events = collector.flush();
      expect(events[0].dimensions.retry_type).toBe("commit");
    });
  });

  // -------------------------------------------------------------------------
  // Failures
  // -------------------------------------------------------------------------

  describe("Failure Metrics", () => {
    it("records recoverable failure", () => {
      collector.recordFailure("context_load", "timeout", true);
      const events = collector.flush();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("failure");
      expect(events[0].dimensions.failure_type).toBe("context_load");
      expect(events[0].dimensions.reason).toBe("timeout");
      expect(events[0].dimensions.recoverable).toBe(true);
    });

    it("records non-recoverable failure", () => {
      collector.recordFailure("contract", "schema_version_mismatch", false);
      const events = collector.flush();
      expect(events[0].dimensions.recoverable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Collector behavior
  // -------------------------------------------------------------------------

  describe("Collector Behavior", () => {
    it("buffers events before flush", () => {
      collector.recordContextLoadLatency(10, 5, 3);
      collector.recordCommitLatency(20, 1);
      expect(collector.getEvents()).toHaveLength(2);
    });

    it("flush returns all events and clears buffer", () => {
      collector.recordContextLoadLatency(10, 5, 3);
      collector.recordCommitLatency(20, 1);
      const events = collector.flush();
      expect(events).toHaveLength(2);
      expect(collector.getEvents()).toHaveLength(0);
    });

    it("second flush returns empty array", () => {
      collector.recordContextLoadLatency(10, 5, 3);
      collector.flush();
      const events = collector.flush();
      expect(events).toHaveLength(0);
    });

    it("events have non-decreasing timestamps", () => {
      collector.recordContextLoadLatency(10, 5, 3);
      collector.recordCommitLatency(20, 1);
      const events = collector.flush();
      expect(events[0].timestamp_ms).toBeLessThanOrEqual(events[1].timestamp_ms);
    });

    it("factory creates valid collector", () => {
      const c = createOrchestratorMetrics("conv-1", "req-1");
      expect(c).toBeInstanceOf(OrchestratorMetricsCollector);
      c.recordContextLoadLatency(10, 5, 3);
      const events = c.flush();
      expect(events).toHaveLength(1);
      expect(events[0].conversation_id).toBe("conv-1");
      expect(events[0].request_id).toBe("req-1");
    });
  });

  // -------------------------------------------------------------------------
  // Coverage: all event types should be emittable
  // -------------------------------------------------------------------------

  describe("Event Type Coverage", () => {
    it("all orchestrator metric event types are emittable", () => {
      collector.recordContextLoadLatency(1, 1, 1);
      collector.recordReservationLatency(1);
      collector.recordReservationOutcome("NEW_LEASE");
      collector.recordCommitLatency(1, 1);
      collector.recordCommitOutcome(true);
      collector.recordVersionConflict(1, 2);
      collector.recordSupersessionAttempt(1, 1, 2);
      collector.recordSupersessionOutcome("committed", 1);
      collector.recordCacheHit("analyzed_result", "k");
      collector.recordInvariantValidationLatency(1);
      collector.recordInvariantViolation("type", "detail");
      collector.recordPipelineInvocationLatency(1, 1);
      collector.recordRetryAttempt("reservation", 1, "reason");
      collector.recordFailure("pipeline", "error", false);

      const events = collector.flush();
      const types = new Set(events.map((e) => e.event_type));

      const expectedTypes = [
        "context_load_latency",
        "reservation_latency",
        "reservation_outcome",
        "commit_latency",
        "commit_outcome",
        "version_conflict",
        "supersession_attempt",
        "supersession_outcome",
        "cache_hit",
        "invariant_validation_latency",
        "invariant_violation",
        "pipeline_invocation_latency",
        "retry_attempt",
        "failure",
      ];

      expectedTypes.forEach((t: string) => {
        expect(types.has(t as typeof events[number]["event_type"])).toBe(true);
      });
    });
  });
});
