"""Tests for SIE structured metrics module.

Verifies:
- All metric event types are emittable and serializable.
- Schema version is included in every event.
- Latency, channel, widening, model routing, retries, failures,
  pending rate, reactivation, proposals, version conflicts, cache hits,
  and privacy purges are all measurable.
- Metrics collector buffers and flushes correctly.
- Event types match the MetricEventType enum.
"""

from __future__ import annotations

import time

import pytest

from app.sie.metrics import (
    METRICS_SCHEMA_VERSION,
    MetricEvent,
    MetricEventType,
    MetricsCollector,
    create_metrics_collector,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def collector() -> MetricsCollector:
    """Create a fresh metrics collector for testing."""
    return create_metrics_collector(
        conversation_id="conv-test-123",
        request_id="req-test-456",
    )


# ---------------------------------------------------------------------------
# Schema versioning
# ---------------------------------------------------------------------------


class TestSchemaVersioning:
    """All events must carry the current schema version."""

    def test_schema_version_is_defined(self) -> None:
        """METRICS_SCHEMA_VERSION must be a non-empty string."""
        assert isinstance(METRICS_SCHEMA_VERSION, str)
        assert len(METRICS_SCHEMA_VERSION) > 0

    def test_schema_version_follows_semver(self) -> None:
        """Schema version should follow major.minor.patch format."""
        parts = METRICS_SCHEMA_VERSION.split(".")
        assert len(parts) == 3
        for part in parts:
            assert part.isdigit()

    def test_events_include_schema_version(self, collector: MetricsCollector) -> None:
        """Every emitted event must include schema_version."""
        collector.record_pipeline_start()
        collector.record_pipeline_end(outcome="YES", packet_count=1)
        events = collector.flush()
        for event in events:
            assert event.schema_version == METRICS_SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Latency metrics
# ---------------------------------------------------------------------------


class TestLatencyMetrics:
    """Latency metrics for pipeline, retrieval, evaluation, widening, commit."""

    def test_pipeline_latency(self, collector: MetricsCollector) -> None:
        """Pipeline latency is recorded with outcome and packet count."""
        collector.record_pipeline_start()
        # Small delay to ensure non-zero latency
        collector.record_pipeline_end(outcome="YES", packet_count=3)
        events = collector.flush()
        latency_events = [
            e for e in events if e.event_type == MetricEventType.PIPELINE_LATENCY
        ]
        assert len(latency_events) == 1
        event = latency_events[0]
        assert event.value is not None
        assert event.value >= 0
        assert event.dimensions["outcome"] == "YES"
        assert event.dimensions["packet_count"] == 3

    def test_retrieval_latency(self, collector: MetricsCollector) -> None:
        """Retrieval latency per packet is recorded."""
        collector.record_retrieval_latency(
            packet_id="pkt-1",
            latency_ms=45.5,
            channel_count=3,
            candidate_count=5,
        )
        events = collector.flush()
        assert len(events) == 1
        event = events[0]
        assert event.event_type == MetricEventType.RETRIEVAL_LATENCY
        assert event.value == 45.5
        assert event.dimensions["packet_id"] == "pkt-1"
        assert event.dimensions["channel_count"] == 3
        assert event.dimensions["candidate_count"] == 5

    def test_evaluation_latency(self, collector: MetricsCollector) -> None:
        """Evaluation latency per packet with model info."""
        collector.record_evaluation_latency(
            packet_id="pkt-2",
            latency_ms=120.0,
            model_id="gpt-4o",
        )
        events = collector.flush()
        assert len(events) == 1
        event = events[0]
        assert event.event_type == MetricEventType.EVALUATION_LATENCY
        assert event.value == 120.0
        assert event.dimensions["model_id"] == "gpt-4o"

    def test_sufficiency_latency(self, collector: MetricsCollector) -> None:
        """Sufficiency gate latency is recorded."""
        collector.record_sufficiency_latency(packet_id="pkt-3", latency_ms=5.2)
        events = collector.flush()
        assert len(events) == 1
        assert events[0].event_type == MetricEventType.SUFFICIENCY_LATENCY
        assert events[0].value == 5.2

    def test_widening_latency(self, collector: MetricsCollector) -> None:
        """Widening latency with round and candidate details."""
        collector.record_widening_latency(
            packet_id="pkt-4",
            latency_ms=300.0,
            rounds=2,
            new_candidates=4,
        )
        events = collector.flush()
        assert len(events) == 1
        event = events[0]
        assert event.event_type == MetricEventType.WIDENING_LATENCY
        assert event.dimensions["rounds"] == 2
        assert event.dimensions["new_candidates"] == 4

    def test_commit_latency(self, collector: MetricsCollector) -> None:
        """Commit latency is recorded."""
        collector.record_commit_latency(latency_ms=80.0)
        events = collector.flush()
        assert len(events) == 1
        assert events[0].event_type == MetricEventType.COMMIT_LATENCY
        assert events[0].value == 80.0


# ---------------------------------------------------------------------------
# Channel metrics
# ---------------------------------------------------------------------------


class TestChannelMetrics:
    """Channel use metrics."""

    def test_channel_attempt(self, collector: MetricsCollector) -> None:
        """Individual channel attempts are recorded."""
        collector.record_channel_attempt(
            packet_id="pkt-1",
            channel_id="emb-primary-01",
            channel_family="embedding_primary",
            status="SUCCESS_WITH_CANDIDATES",
            latency_ms=30.0,
            candidate_count=3,
            is_widening=False,
        )
        events = collector.flush()
        assert len(events) == 1
        event = events[0]
        assert event.event_type == MetricEventType.CHANNEL_ATTEMPT
        assert event.dimensions["channel_family"] == "embedding_primary"
        assert event.dimensions["status"] == "SUCCESS_WITH_CANDIDATES"
        assert event.dimensions["is_widening"] is False

    def test_channel_attempt_widening(self, collector: MetricsCollector) -> None:
        """Widening channel attempts are distinguished."""
        collector.record_channel_attempt(
            packet_id="pkt-1",
            channel_id="hist-region-01",
            channel_family="historical_region",
            status="SUCCESS_EMPTY",
            latency_ms=50.0,
            candidate_count=0,
            is_widening=True,
        )
        events = collector.flush()
        assert events[0].dimensions["is_widening"] is True

    def test_channel_summary(self, collector: MetricsCollector) -> None:
        """Channel summary aggregates are recorded."""
        collector.record_channel_summary(
            packet_id="pkt-1",
            total_channels=5,
            successful_channels=4,
            failed_channels=1,
        )
        events = collector.flush()
        assert len(events) == 1
        event = events[0]
        assert event.event_type == MetricEventType.CHANNEL_SUMMARY
        assert event.dimensions["total_channels"] == 5
        assert event.dimensions["failed_channels"] == 1


# ---------------------------------------------------------------------------
# Widening metrics
# ---------------------------------------------------------------------------


class TestWideningMetrics:
    """Widening frequency and completion metrics."""

    def test_widening_triggered(self, collector: MetricsCollector) -> None:
        """Widening trigger events record IRS signals and gaps."""
        collector.record_widening_triggered(
            packet_id="pkt-1",
            trigger_signals=["REVISIT_LANGUAGE", "HISTORICAL_REFERENT"],
            coverage_gaps=["historical_region"],
        )
        events = collector.flush()
        assert len(events) == 1
        event = events[0]
        assert event.event_type == MetricEventType.WIDENING_TRIGGERED
        assert len(event.dimensions["trigger_signals"]) == 2
        assert "historical_region" in event.dimensions["coverage_gaps"]

    def test_widening_completed(self, collector: MetricsCollector) -> None:
        """Widening completion records budget usage."""
        collector.record_widening_completed(
            packet_id="pkt-1",
            rounds_used=2,
            attempts_used=4,
            budget_exhausted=False,
            new_candidates_found=3,
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.WIDENING_COMPLETED
        assert event.dimensions["budget_exhausted"] is False
        assert event.dimensions["new_candidates_found"] == 3


# ---------------------------------------------------------------------------
# Model routing metrics
# ---------------------------------------------------------------------------


class TestModelRoutingMetrics:
    """Model routing and invocation tracking."""

    def test_model_invocation(self, collector: MetricsCollector) -> None:
        """Model invocations record model identity and token usage."""
        collector.record_model_invocation(
            packet_id="pkt-1",
            model_id="gpt-4o",
            prompt_version="identity-eval-v3",
            tokens_used=1250,
            latency_ms=800.0,
            is_fallback=False,
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.MODEL_INVOCATION
        assert event.value == 800.0
        assert event.dimensions["model_id"] == "gpt-4o"
        assert event.dimensions["tokens_used"] == 1250
        assert event.dimensions["is_fallback"] is False

    def test_model_invocation_fallback(self, collector: MetricsCollector) -> None:
        """Fallback model invocations are marked."""
        collector.record_model_invocation(
            packet_id="pkt-1",
            model_id="gpt-4o-mini",
            prompt_version="identity-eval-v3",
            tokens_used=800,
            latency_ms=400.0,
            is_fallback=True,
        )
        events = collector.flush()
        assert events[0].dimensions["is_fallback"] is True


# ---------------------------------------------------------------------------
# Retry metrics
# ---------------------------------------------------------------------------


class TestRetryMetrics:
    """Retry event recording."""

    def test_reservation_retry(self, collector: MetricsCollector) -> None:
        """Reservation retries are counted with reason."""
        collector.record_reservation_retry(
            attempt_number=2,
            reason="lease_expired",
        )
        events = collector.flush()
        assert len(events) == 1
        event = events[0]
        assert event.event_type == MetricEventType.RESERVATION_RETRY
        assert event.value == 2.0
        assert event.dimensions["reason"] == "lease_expired"

    def test_model_retry(self, collector: MetricsCollector) -> None:
        """Model retries record model and reason."""
        collector.record_model_retry(
            packet_id="pkt-1",
            attempt_number=3,
            model_id="gpt-4o",
            reason="structured_output_validation_failed",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.MODEL_RETRY
        assert event.value == 3.0
        assert event.dimensions["model_id"] == "gpt-4o"


# ---------------------------------------------------------------------------
# Failure metrics
# ---------------------------------------------------------------------------


class TestFailureMetrics:
    """Failure event recording."""

    def test_retrieval_failure(self, collector: MetricsCollector) -> None:
        """Retrieval failures record channel and reason."""
        collector.record_retrieval_failure(
            packet_id="pkt-1",
            channel_id="emb-primary-01",
            channel_family="embedding_primary",
            failure_reason="timeout_exceeded",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.RETRIEVAL_FAILURE
        assert event.dimensions["failure_reason"] == "timeout_exceeded"

    def test_model_failure(self, collector: MetricsCollector) -> None:
        """Model failures record model and reason."""
        collector.record_model_failure(
            packet_id="pkt-1",
            model_id="gpt-4o",
            failure_reason="rate_limit_exceeded",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.MODEL_FAILURE

    def test_contract_failure(self, collector: MetricsCollector) -> None:
        """Contract validation failures are recorded."""
        collector.record_contract_failure(
            failure_type="schema_mismatch",
            detail="Missing required field: proposition_ids",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.CONTRACT_FAILURE

    def test_policy_failure(self, collector: MetricsCollector) -> None:
        """Policy failures are recorded."""
        collector.record_policy_failure(
            policy_version="ir-policy-v2",
            failure_reason="unknown_channel_id: ghost_channel",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.POLICY_FAILURE

    def test_context_failure(self, collector: MetricsCollector) -> None:
        """Context loading failures are recorded."""
        collector.record_context_failure(
            failure_reason="snapshot_version_mismatch",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.CONTEXT_FAILURE


# ---------------------------------------------------------------------------
# Rate/count metrics
# ---------------------------------------------------------------------------


class TestRateMetrics:
    """Pending decision, reactivation, and proposal rates."""

    def test_pending_decision(self, collector: MetricsCollector) -> None:
        """Pending decisions record outcome."""
        collector.record_pending_decision(
            packet_id="pkt-1",
            outcome="UNRESOLVED",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.PENDING_DECISION
        assert event.dimensions["outcome"] == "UNRESOLVED"

    def test_dormant_reactivation(self, collector: MetricsCollector) -> None:
        """Dormant reactivation proposals are counted."""
        collector.record_dormant_reactivation(
            packet_id="pkt-1",
            concern_id="concern-dormant-1",
            from_status="DORMANT",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.DORMANT_REACTIVATION
        assert event.dimensions["from_status"] == "DORMANT"

    def test_new_concern_proposal(self, collector: MetricsCollector) -> None:
        """New concern proposals are counted."""
        collector.record_new_concern_proposal(
            packet_id="pkt-1",
            proposal_id="proposal-new-1",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.NEW_CONCERN_PROPOSAL


# ---------------------------------------------------------------------------
# Version conflict metrics
# ---------------------------------------------------------------------------


class TestVersionConflictMetrics:
    """Version conflict and re-analysis metrics."""

    def test_version_conflict(self, collector: MetricsCollector) -> None:
        """Version conflicts record analyzed vs current version."""
        collector.record_version_conflict(
            analyzed_version=5,
            current_version=7,
            retry_number=1,
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.VERSION_CONFLICT
        assert event.value == 1.0
        assert event.dimensions["analyzed_version"] == 5
        assert event.dimensions["current_version"] == 7


# ---------------------------------------------------------------------------
# Cache hit metrics
# ---------------------------------------------------------------------------


class TestCacheHitMetrics:
    """Cache hit (idempotent replay) metrics."""

    def test_cache_hit(self, collector: MetricsCollector) -> None:
        """Cache hits record type and idempotency key."""
        collector.record_cache_hit(
            cache_type="analyzed_result",
            idempotency_key="idemp-key-001",
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.CACHE_HIT
        assert event.dimensions["cache_type"] == "analyzed_result"


# ---------------------------------------------------------------------------
# Privacy purge metrics
# ---------------------------------------------------------------------------


class TestPrivacyPurgeMetrics:
    """Privacy purge/redaction metrics."""

    def test_privacy_purge(self, collector: MetricsCollector) -> None:
        """Privacy purges record type and entity count."""
        collector.record_privacy_purge(
            purge_type="full_content_purge",
            entities_affected=12,
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.PRIVACY_PURGE
        assert event.value == 12.0
        assert event.dimensions["purge_type"] == "full_content_purge"


# ---------------------------------------------------------------------------
# Request summary
# ---------------------------------------------------------------------------


class TestRequestSummary:
    """Aggregate request summary metric."""

    def test_request_summary(self, collector: MetricsCollector) -> None:
        """Request summary aggregates all key counts."""
        collector.record_request_summary(
            packet_count=4,
            assigned_count=2,
            proposed_count=1,
            pending_count=1,
            deferred_count=0,
            reactivation_count=1,
            widening_count=1,
            total_retrieval_attempts=12,
            total_model_invocations=3,
        )
        events = collector.flush()
        event = events[0]
        assert event.event_type == MetricEventType.REQUEST_SUMMARY
        assert event.dimensions["packet_count"] == 4
        assert event.dimensions["assigned_count"] == 2
        assert event.dimensions["proposed_count"] == 1
        assert event.dimensions["total_retrieval_attempts"] == 12


# ---------------------------------------------------------------------------
# Collector behavior
# ---------------------------------------------------------------------------


class TestCollectorBehavior:
    """MetricsCollector buffering and flush behavior."""

    def test_events_buffered_before_flush(self, collector: MetricsCollector) -> None:
        """Events are buffered until flush is called."""
        collector.record_pipeline_start()
        collector.record_pipeline_end(outcome="NO", packet_count=1)
        # Events are in the collector but not yet flushed
        assert len(collector.events) > 0

    def test_flush_returns_all_events(self, collector: MetricsCollector) -> None:
        """Flush returns all collected events."""
        collector.record_retrieval_latency("pkt-1", 10.0, 2, 3)
        collector.record_evaluation_latency("pkt-1", 50.0, "gpt-4o")
        events = collector.flush()
        assert len(events) == 2

    def test_flush_clears_buffer(self, collector: MetricsCollector) -> None:
        """Flush clears the event buffer."""
        collector.record_retrieval_latency("pkt-1", 10.0, 2, 3)
        collector.flush()
        events_after = collector.flush()
        assert len(events_after) == 0

    def test_event_timestamps_are_monotonic(self, collector: MetricsCollector) -> None:
        """Events have non-decreasing timestamps."""
        collector.record_retrieval_latency("pkt-1", 10.0, 2, 3)
        collector.record_evaluation_latency("pkt-1", 50.0, "gpt-4o")
        events = collector.flush()
        assert events[0].timestamp_ms <= events[1].timestamp_ms

    def test_event_serialization(self, collector: MetricsCollector) -> None:
        """Events serialize to dict correctly."""
        collector.record_cache_hit(cache_type="committed_result", idempotency_key="k1")
        events = collector.flush()
        d = events[0].to_dict()
        assert d["schema_version"] == METRICS_SCHEMA_VERSION
        assert d["event_type"] == "cache_hit"
        assert d["conversation_id"] == "conv-test-123"
        assert d["request_id"] == "req-test-456"
        assert "timestamp_ms" in d
        assert d["dimensions"]["cache_type"] == "committed_result"

    def test_factory_creates_collector(self) -> None:
        """create_metrics_collector produces a valid collector."""
        c = create_metrics_collector("conv-1", "req-1")
        assert isinstance(c, MetricsCollector)
        c.record_pipeline_start()
        c.record_pipeline_end(outcome="DEFER", packet_count=0)
        events = c.flush()
        assert len(events) == 1
        assert events[0].conversation_id == "conv-1"


# ---------------------------------------------------------------------------
# Complete coverage: all MetricEventType values are testable
# ---------------------------------------------------------------------------


class TestMetricEventTypeCoverage:
    """Ensure all MetricEventType enum values can be emitted."""

    def test_all_event_types_have_emitter(self, collector: MetricsCollector) -> None:
        """Every MetricEventType value should be emittable via the collector."""
        # Emit one event per type
        collector.record_pipeline_start()
        collector.record_pipeline_end("YES", 1)  # PIPELINE_LATENCY
        collector.record_retrieval_latency("p", 1.0, 1, 1)  # RETRIEVAL_LATENCY
        collector.record_evaluation_latency("p", 1.0, "m")  # EVALUATION_LATENCY
        collector.record_sufficiency_latency("p", 1.0)  # SUFFICIENCY_LATENCY
        collector.record_widening_latency("p", 1.0, 1, 1)  # WIDENING_LATENCY
        collector.record_commit_latency(1.0)  # COMMIT_LATENCY
        collector.record_channel_attempt("p", "c", "f", "s", 1.0, 1)  # CHANNEL_ATTEMPT
        collector.record_channel_summary("p", 1, 1, 0)  # CHANNEL_SUMMARY
        collector.record_widening_triggered("p", ["s"], ["g"])  # WIDENING_TRIGGERED
        collector.record_widening_completed("p", 1, 1, False, 1)  # WIDENING_COMPLETED
        collector.record_model_invocation("p", "m", "v", 100, 1.0)  # MODEL_INVOCATION
        collector.record_reservation_retry(1, "r")  # RESERVATION_RETRY
        collector.record_model_retry("p", 1, "m", "r")  # MODEL_RETRY
        collector.record_retrieval_failure("p", "c", "f", "r")  # RETRIEVAL_FAILURE
        collector.record_model_failure("p", "m", "r")  # MODEL_FAILURE
        collector.record_contract_failure("t", "d")  # CONTRACT_FAILURE
        collector.record_policy_failure("v", "r")  # POLICY_FAILURE
        collector.record_context_failure("r")  # CONTEXT_FAILURE
        collector.record_pending_decision("p", "o")  # PENDING_DECISION
        collector.record_dormant_reactivation("p", "c", "DORMANT")  # DORMANT_REACTIVATION
        collector.record_new_concern_proposal("p", "pr")  # NEW_CONCERN_PROPOSAL
        collector.record_version_conflict(1, 2, 1)  # VERSION_CONFLICT
        collector.record_cache_hit("analyzed_result", "k")  # CACHE_HIT
        collector.record_privacy_purge("full", 1)  # PRIVACY_PURGE
        collector.record_request_summary(1, 1, 0, 0, 0, 0, 0, 1, 1)  # REQUEST_SUMMARY

        events = collector.flush()
        emitted_types = {e.event_type for e in events}

        # Verify all MetricEventType values were emitted
        all_types = set(MetricEventType)
        assert emitted_types == all_types, (
            f"Missing event types: {all_types - emitted_types}"
        )


# ---------------------------------------------------------------------------
# Integration test: Pipeline emits metrics at key stages
# ---------------------------------------------------------------------------


class TestPipelineMetricsIntegration:
    """Verify that the pipeline instruments key stages with metrics."""

    @pytest.fixture
    def metrics_collector(self) -> MetricsCollector:
        """Create a metrics collector for pipeline integration testing."""
        return create_metrics_collector(
            conversation_id="conv-int-test",
            request_id="req-int-test",
        )

    def test_metrics_collector_accepts_all_pipeline_events(
        self, metrics_collector: MetricsCollector
    ) -> None:
        """Simulate the sequence of metrics a pipeline run emits."""
        mc = metrics_collector

        # Pipeline start
        mc.record_pipeline_start()

        # Retrieval stage
        mc.record_channel_attempt(
            packet_id="pkt-1",
            channel_id="emb-primary-01",
            channel_family="embedding_primary",
            status="SUCCESS_WITH_CANDIDATES",
            latency_ms=25.0,
            candidate_count=3,
            is_widening=False,
        )
        mc.record_channel_attempt(
            packet_id="pkt-1",
            channel_id="alias-norm-01",
            channel_family="alias_normalized",
            status="SUCCESS_EMPTY",
            latency_ms=10.0,
            candidate_count=0,
            is_widening=False,
        )
        mc.record_retrieval_latency(
            packet_id="pkt-1", latency_ms=35.0, channel_count=2, candidate_count=3
        )
        mc.record_channel_summary(
            packet_id="pkt-1",
            total_channels=2,
            successful_channels=2,
            failed_channels=0,
        )

        # Evaluation stage
        mc.record_evaluation_latency(
            packet_id="pkt-1", latency_ms=150.0, model_id="model-v1"
        )

        # Sufficiency stage
        mc.record_sufficiency_latency(packet_id="pkt-1", latency_ms=3.0)

        # Widening triggered
        mc.record_widening_triggered(
            packet_id="pkt-1",
            trigger_signals=["HISTORICAL_REFERENT"],
            coverage_gaps=["historical_region"],
        )
        mc.record_channel_attempt(
            packet_id="pkt-1",
            channel_id="hist-region-01",
            channel_family="historical_region",
            status="SUCCESS_WITH_CANDIDATES",
            latency_ms=60.0,
            candidate_count=1,
            is_widening=True,
        )
        mc.record_widening_latency(
            packet_id="pkt-1", latency_ms=60.0, rounds=1, new_candidates=1
        )
        mc.record_widening_completed(
            packet_id="pkt-1",
            rounds_used=1,
            attempts_used=1,
            budget_exhausted=False,
            new_candidates_found=1,
        )

        # Pipeline end and summary
        mc.record_request_summary(
            packet_count=1,
            assigned_count=1,
            proposed_count=0,
            pending_count=0,
            deferred_count=0,
            reactivation_count=0,
            widening_count=1,
            total_retrieval_attempts=3,
            total_model_invocations=1,
        )
        mc.record_pipeline_end(outcome="YES", packet_count=1)

        events = mc.flush()

        # Verify all expected event types appear
        event_types = {e.event_type for e in events}
        assert MetricEventType.PIPELINE_LATENCY in event_types
        assert MetricEventType.RETRIEVAL_LATENCY in event_types
        assert MetricEventType.EVALUATION_LATENCY in event_types
        assert MetricEventType.SUFFICIENCY_LATENCY in event_types
        assert MetricEventType.WIDENING_TRIGGERED in event_types
        assert MetricEventType.WIDENING_LATENCY in event_types
        assert MetricEventType.WIDENING_COMPLETED in event_types
        assert MetricEventType.CHANNEL_ATTEMPT in event_types
        assert MetricEventType.CHANNEL_SUMMARY in event_types
        assert MetricEventType.REQUEST_SUMMARY in event_types

        # Verify all events carry the correct schema version
        for event in events:
            assert event.schema_version == METRICS_SCHEMA_VERSION

        # Verify widening channel attempts are marked correctly
        widening_attempts = [
            e for e in events
            if e.event_type == MetricEventType.CHANNEL_ATTEMPT
            and e.dimensions.get("is_widening") is True
        ]
        assert len(widening_attempts) == 1
        assert widening_attempts[0].dimensions["channel_family"] == "historical_region"

    def test_pending_decision_metrics_emitted_for_unresolved(
        self, metrics_collector: MetricsCollector
    ) -> None:
        """Pending decision metrics should be emitted for unresolved outcomes."""
        mc = metrics_collector
        mc.record_pending_decision(packet_id="pkt-2", outcome="UNRESOLVED")
        mc.record_pending_decision(packet_id="pkt-3", outcome="RETRIEVAL_INCONCLUSIVE")
        mc.record_pending_decision(packet_id="pkt-4", outcome="DEFER")

        events = mc.flush()
        assert len(events) == 3
        outcomes = [e.dimensions["outcome"] for e in events]
        assert "UNRESOLVED" in outcomes
        assert "RETRIEVAL_INCONCLUSIVE" in outcomes
        assert "DEFER" in outcomes

    def test_reactivation_and_proposal_metrics(
        self, metrics_collector: MetricsCollector
    ) -> None:
        """Reactivation and new-concern proposal events are emitted."""
        mc = metrics_collector
        mc.record_dormant_reactivation(
            packet_id="pkt-5", concern_id="concern-dormant-1", from_status="DORMANT"
        )
        mc.record_new_concern_proposal(
            packet_id="pkt-6", proposal_id="proposal-new-1"
        )

        events = mc.flush()
        assert len(events) == 2
        types = {e.event_type for e in events}
        assert MetricEventType.DORMANT_REACTIVATION in types
        assert MetricEventType.NEW_CONCERN_PROPOSAL in types

    def test_version_conflict_and_cache_hit_metrics(
        self, metrics_collector: MetricsCollector
    ) -> None:
        """Version conflict and cache hit events are emitted with details."""
        mc = metrics_collector
        mc.record_version_conflict(
            analyzed_version=3, current_version=5, retry_number=1
        )
        mc.record_cache_hit(
            cache_type="analyzed_result", idempotency_key="key-123"
        )

        events = mc.flush()
        assert len(events) == 2
        conflict_event = next(
            e for e in events if e.event_type == MetricEventType.VERSION_CONFLICT
        )
        assert conflict_event.dimensions["analyzed_version"] == 3
        assert conflict_event.dimensions["current_version"] == 5

        cache_event = next(
            e for e in events if e.event_type == MetricEventType.CACHE_HIT
        )
        assert cache_event.dimensions["cache_type"] == "analyzed_result"
