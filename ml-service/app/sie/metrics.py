"""SIE Identity Resolution Structured Metrics.

Provides typed, versioned metric events for observability of the identity
resolution pipeline. All metric schemas are versioned for forward-compatible
evolution. Metrics are emitted as structured events (not raw prints) suitable
for consumption by observability tools (structured logging, metrics backends).

Measured dimensions per Requirement 11.4:
- Latency (pipeline, retrieval, evaluation, commit)
- Channel use (which retrieval channels fired, success/failure counts)
- Widening frequency (how often adaptive widening triggers)
- Model routing (which LLM model was used per evaluation)
- Retries (reservation retries, model retries)
- Failures (retrieval errors, model failures, contract failures)
- Pending-decision rate (fraction of requests producing pending outcomes)
- Dormant reactivation (count and latency of reactivation proposals)
- New-concern proposals (count per request)
- Version-conflict re-analysis (supersession events)
- Cache hits (idempotent request replays)
- Privacy purges (purge/redaction events)

Design authority: requirements.md §11.4, tasks.md §17.1.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger("sie.metrics")


# ---------------------------------------------------------------------------
# Schema versioning
# ---------------------------------------------------------------------------

METRICS_SCHEMA_VERSION = "1.0.0"
"""Current version of the SIE metrics schema. Bump on breaking changes."""


# ---------------------------------------------------------------------------
# Metric event types
# ---------------------------------------------------------------------------


class MetricEventType(str, Enum):
    """Classification of metric events emitted by the pipeline."""

    # Latency
    PIPELINE_LATENCY = "pipeline_latency"
    RETRIEVAL_LATENCY = "retrieval_latency"
    EVALUATION_LATENCY = "evaluation_latency"
    SUFFICIENCY_LATENCY = "sufficiency_latency"
    WIDENING_LATENCY = "widening_latency"
    COMMIT_LATENCY = "commit_latency"

    # Channel use
    CHANNEL_ATTEMPT = "channel_attempt"
    CHANNEL_SUMMARY = "channel_summary"

    # Widening
    WIDENING_TRIGGERED = "widening_triggered"
    WIDENING_COMPLETED = "widening_completed"

    # Model routing
    MODEL_INVOCATION = "model_invocation"

    # Retries
    RESERVATION_RETRY = "reservation_retry"
    MODEL_RETRY = "model_retry"

    # Failures
    RETRIEVAL_FAILURE = "retrieval_failure"
    MODEL_FAILURE = "model_failure"
    CONTRACT_FAILURE = "contract_failure"
    POLICY_FAILURE = "policy_failure"
    CONTEXT_FAILURE = "context_failure"

    # Rates
    PENDING_DECISION = "pending_decision"
    DORMANT_REACTIVATION = "dormant_reactivation"
    NEW_CONCERN_PROPOSAL = "new_concern_proposal"

    # Version conflicts
    VERSION_CONFLICT = "version_conflict"

    # Cache
    CACHE_HIT = "cache_hit"

    # Privacy
    PRIVACY_PURGE = "privacy_purge"

    # Aggregate per-request summary
    REQUEST_SUMMARY = "request_summary"


# ---------------------------------------------------------------------------
# Structured metric event
# ---------------------------------------------------------------------------


@dataclass
class MetricEvent:
    """A single structured metric event emitted by the pipeline.

    Attributes:
        schema_version: Version of the metrics schema for forward compatibility.
        event_type: Classification of this metric.
        conversation_id: Conversation context (may be redacted in logs).
        request_id: Request that generated this event.
        timestamp_ms: Unix timestamp in milliseconds when the event was created.
        dimensions: Key-value pairs carrying the metric data.
        value: Optional numeric value (latency in ms, count, etc.).
    """

    schema_version: str
    event_type: MetricEventType
    conversation_id: str
    request_id: str
    timestamp_ms: float
    dimensions: dict[str, Any] = field(default_factory=dict)
    value: float | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a dictionary suitable for structured logging."""
        return {
            "schema_version": self.schema_version,
            "event_type": self.event_type.value,
            "conversation_id": self.conversation_id,
            "request_id": self.request_id,
            "timestamp_ms": self.timestamp_ms,
            "dimensions": self.dimensions,
            "value": self.value,
        }


# ---------------------------------------------------------------------------
# Metrics collector
# ---------------------------------------------------------------------------


class MetricsCollector:
    """Collects structured metric events during a single pipeline request.

    Thread-safe for a single request context. Not shared across requests.
    Events are buffered and flushed at the end of processing.

    Usage:
        collector = MetricsCollector(conversation_id, request_id)
        collector.record_pipeline_start()
        # ... pipeline stages ...
        collector.record_pipeline_end(outcome, packet_count)
        collector.flush()
    """

    def __init__(self, conversation_id: str, request_id: str) -> None:
        self._conversation_id = conversation_id
        self._request_id = request_id
        self._events: list[MetricEvent] = []
        self._pipeline_start_ms: float | None = None

    @property
    def events(self) -> list[MetricEvent]:
        """Return collected events (read-only view for testing)."""
        return list(self._events)

    # -------------------------------------------------------------------
    # Latency tracking
    # -------------------------------------------------------------------

    def record_pipeline_start(self) -> None:
        """Mark the start of pipeline processing for latency measurement."""
        self._pipeline_start_ms = _now_ms()

    def record_pipeline_end(
        self,
        outcome: str,
        packet_count: int,
    ) -> None:
        """Record total pipeline latency and outcome summary."""
        elapsed = _elapsed_since(self._pipeline_start_ms)
        self._emit(
            MetricEventType.PIPELINE_LATENCY,
            value=elapsed,
            dimensions={
                "outcome": outcome,
                "packet_count": packet_count,
            },
        )

    def record_retrieval_latency(
        self,
        packet_id: str,
        latency_ms: float,
        channel_count: int,
        candidate_count: int,
    ) -> None:
        """Record retrieval stage latency for one packet."""
        self._emit(
            MetricEventType.RETRIEVAL_LATENCY,
            value=latency_ms,
            dimensions={
                "packet_id": packet_id,
                "channel_count": channel_count,
                "candidate_count": candidate_count,
            },
        )

    def record_evaluation_latency(
        self,
        packet_id: str,
        latency_ms: float,
        model_id: str,
    ) -> None:
        """Record identity evaluation latency for one packet."""
        self._emit(
            MetricEventType.EVALUATION_LATENCY,
            value=latency_ms,
            dimensions={
                "packet_id": packet_id,
                "model_id": model_id,
            },
        )

    def record_sufficiency_latency(
        self,
        packet_id: str,
        latency_ms: float,
    ) -> None:
        """Record sufficiency gate latency."""
        self._emit(
            MetricEventType.SUFFICIENCY_LATENCY,
            value=latency_ms,
            dimensions={"packet_id": packet_id},
        )

    def record_widening_latency(
        self,
        packet_id: str,
        latency_ms: float,
        rounds: int,
        new_candidates: int,
    ) -> None:
        """Record adaptive widening total latency."""
        self._emit(
            MetricEventType.WIDENING_LATENCY,
            value=latency_ms,
            dimensions={
                "packet_id": packet_id,
                "rounds": rounds,
                "new_candidates": new_candidates,
            },
        )

    def record_commit_latency(self, latency_ms: float) -> None:
        """Record commit/persistence latency (TypeScript-side, reported back)."""
        self._emit(
            MetricEventType.COMMIT_LATENCY,
            value=latency_ms,
            dimensions={},
        )

    # -------------------------------------------------------------------
    # Channel use
    # -------------------------------------------------------------------

    def record_channel_attempt(
        self,
        packet_id: str,
        channel_id: str,
        channel_family: str,
        status: str,
        latency_ms: float | None,
        candidate_count: int,
        is_widening: bool = False,
    ) -> None:
        """Record a single retrieval channel attempt."""
        self._emit(
            MetricEventType.CHANNEL_ATTEMPT,
            value=latency_ms,
            dimensions={
                "packet_id": packet_id,
                "channel_id": channel_id,
                "channel_family": channel_family,
                "status": status,
                "candidate_count": candidate_count,
                "is_widening": is_widening,
            },
        )

    def record_channel_summary(
        self,
        packet_id: str,
        total_channels: int,
        successful_channels: int,
        failed_channels: int,
    ) -> None:
        """Record aggregate channel usage for one packet."""
        self._emit(
            MetricEventType.CHANNEL_SUMMARY,
            dimensions={
                "packet_id": packet_id,
                "total_channels": total_channels,
                "successful_channels": successful_channels,
                "failed_channels": failed_channels,
            },
        )

    # -------------------------------------------------------------------
    # Widening
    # -------------------------------------------------------------------

    def record_widening_triggered(
        self,
        packet_id: str,
        trigger_signals: list[str],
        coverage_gaps: list[str],
    ) -> None:
        """Record that adaptive widening was triggered."""
        self._emit(
            MetricEventType.WIDENING_TRIGGERED,
            dimensions={
                "packet_id": packet_id,
                "trigger_signals": trigger_signals,
                "coverage_gaps": coverage_gaps,
            },
        )

    def record_widening_completed(
        self,
        packet_id: str,
        rounds_used: int,
        attempts_used: int,
        budget_exhausted: bool,
        new_candidates_found: int,
    ) -> None:
        """Record adaptive widening completion."""
        self._emit(
            MetricEventType.WIDENING_COMPLETED,
            dimensions={
                "packet_id": packet_id,
                "rounds_used": rounds_used,
                "attempts_used": attempts_used,
                "budget_exhausted": budget_exhausted,
                "new_candidates_found": new_candidates_found,
            },
        )

    # -------------------------------------------------------------------
    # Model routing
    # -------------------------------------------------------------------

    def record_model_invocation(
        self,
        packet_id: str,
        model_id: str,
        prompt_version: str,
        tokens_used: int | None,
        latency_ms: float,
        is_fallback: bool = False,
    ) -> None:
        """Record an LLM model invocation for identity evaluation."""
        self._emit(
            MetricEventType.MODEL_INVOCATION,
            value=latency_ms,
            dimensions={
                "packet_id": packet_id,
                "model_id": model_id,
                "prompt_version": prompt_version,
                "tokens_used": tokens_used,
                "is_fallback": is_fallback,
            },
        )

    # -------------------------------------------------------------------
    # Retries
    # -------------------------------------------------------------------

    def record_reservation_retry(
        self,
        attempt_number: int,
        reason: str,
    ) -> None:
        """Record a reservation/idempotency retry event."""
        self._emit(
            MetricEventType.RESERVATION_RETRY,
            value=float(attempt_number),
            dimensions={"reason": reason},
        )

    def record_model_retry(
        self,
        packet_id: str,
        attempt_number: int,
        model_id: str,
        reason: str,
    ) -> None:
        """Record a model invocation retry."""
        self._emit(
            MetricEventType.MODEL_RETRY,
            value=float(attempt_number),
            dimensions={
                "packet_id": packet_id,
                "model_id": model_id,
                "reason": reason,
            },
        )

    # -------------------------------------------------------------------
    # Failures
    # -------------------------------------------------------------------

    def record_retrieval_failure(
        self,
        packet_id: str,
        channel_id: str,
        channel_family: str,
        failure_reason: str,
    ) -> None:
        """Record a retrieval channel failure."""
        self._emit(
            MetricEventType.RETRIEVAL_FAILURE,
            dimensions={
                "packet_id": packet_id,
                "channel_id": channel_id,
                "channel_family": channel_family,
                "failure_reason": failure_reason,
            },
        )

    def record_model_failure(
        self,
        packet_id: str,
        model_id: str,
        failure_reason: str,
    ) -> None:
        """Record an LLM model failure."""
        self._emit(
            MetricEventType.MODEL_FAILURE,
            dimensions={
                "packet_id": packet_id,
                "model_id": model_id,
                "failure_reason": failure_reason,
            },
        )

    def record_contract_failure(
        self,
        failure_type: str,
        detail: str,
    ) -> None:
        """Record a contract validation failure."""
        self._emit(
            MetricEventType.CONTRACT_FAILURE,
            dimensions={
                "failure_type": failure_type,
                "detail": detail,
            },
        )

    def record_policy_failure(
        self,
        policy_version: str,
        failure_reason: str,
    ) -> None:
        """Record a policy loading/validation failure (fail-closed)."""
        self._emit(
            MetricEventType.POLICY_FAILURE,
            dimensions={
                "policy_version": policy_version,
                "failure_reason": failure_reason,
            },
        )

    def record_context_failure(
        self,
        failure_reason: str,
    ) -> None:
        """Record a context loading failure."""
        self._emit(
            MetricEventType.CONTEXT_FAILURE,
            dimensions={"failure_reason": failure_reason},
        )

    # -------------------------------------------------------------------
    # Rates / counts
    # -------------------------------------------------------------------

    def record_pending_decision(
        self,
        packet_id: str,
        outcome: str,
    ) -> None:
        """Record a pending decision being created."""
        self._emit(
            MetricEventType.PENDING_DECISION,
            dimensions={
                "packet_id": packet_id,
                "outcome": outcome,
            },
        )

    def record_dormant_reactivation(
        self,
        packet_id: str,
        concern_id: str,
        from_status: str,
    ) -> None:
        """Record a dormant/retired concern reactivation proposal."""
        self._emit(
            MetricEventType.DORMANT_REACTIVATION,
            dimensions={
                "packet_id": packet_id,
                "concern_id": concern_id,
                "from_status": from_status,
            },
        )

    def record_new_concern_proposal(
        self,
        packet_id: str,
        proposal_id: str,
    ) -> None:
        """Record a new-concern proposal being created."""
        self._emit(
            MetricEventType.NEW_CONCERN_PROPOSAL,
            dimensions={
                "packet_id": packet_id,
                "proposal_id": proposal_id,
            },
        )

    # -------------------------------------------------------------------
    # Version conflicts
    # -------------------------------------------------------------------

    def record_version_conflict(
        self,
        analyzed_version: int,
        current_version: int,
        retry_number: int,
    ) -> None:
        """Record a graph version conflict requiring re-analysis."""
        self._emit(
            MetricEventType.VERSION_CONFLICT,
            value=float(retry_number),
            dimensions={
                "analyzed_version": analyzed_version,
                "current_version": current_version,
            },
        )

    # -------------------------------------------------------------------
    # Cache hits
    # -------------------------------------------------------------------

    def record_cache_hit(
        self,
        cache_type: str,
        idempotency_key: str,
    ) -> None:
        """Record an idempotent request replay (cache hit)."""
        self._emit(
            MetricEventType.CACHE_HIT,
            dimensions={
                "cache_type": cache_type,
                "idempotency_key": idempotency_key,
            },
        )

    # -------------------------------------------------------------------
    # Privacy
    # -------------------------------------------------------------------

    def record_privacy_purge(
        self,
        purge_type: str,
        entities_affected: int,
    ) -> None:
        """Record a privacy purge/redaction event."""
        self._emit(
            MetricEventType.PRIVACY_PURGE,
            value=float(entities_affected),
            dimensions={"purge_type": purge_type},
        )

    # -------------------------------------------------------------------
    # Request summary (aggregate)
    # -------------------------------------------------------------------

    def record_request_summary(
        self,
        packet_count: int,
        assigned_count: int,
        proposed_count: int,
        pending_count: int,
        deferred_count: int,
        reactivation_count: int,
        widening_count: int,
        total_retrieval_attempts: int,
        total_model_invocations: int,
    ) -> None:
        """Record an aggregate summary of the full request processing."""
        self._emit(
            MetricEventType.REQUEST_SUMMARY,
            dimensions={
                "packet_count": packet_count,
                "assigned_count": assigned_count,
                "proposed_count": proposed_count,
                "pending_count": pending_count,
                "deferred_count": deferred_count,
                "reactivation_count": reactivation_count,
                "widening_count": widening_count,
                "total_retrieval_attempts": total_retrieval_attempts,
                "total_model_invocations": total_model_invocations,
            },
        )

    # -------------------------------------------------------------------
    # Flush / emission
    # -------------------------------------------------------------------

    def flush(self) -> list[MetricEvent]:
        """Flush all collected events via structured logging and return them.

        Events are emitted to the 'sie.metrics' logger as structured JSON
        at INFO level. The returned list allows downstream consumers
        (tests, aggregators) to process events programmatically.
        """
        flushed = list(self._events)
        for event in flushed:
            logger.info(
                "sie_metric",
                extra={"metric": event.to_dict()},
            )
        self._events.clear()
        return flushed

    # -------------------------------------------------------------------
    # Internal helpers
    # -------------------------------------------------------------------

    def _emit(
        self,
        event_type: MetricEventType,
        value: float | None = None,
        dimensions: dict[str, Any] | None = None,
    ) -> None:
        """Create and buffer a metric event."""
        self._events.append(
            MetricEvent(
                schema_version=METRICS_SCHEMA_VERSION,
                event_type=event_type,
                conversation_id=self._conversation_id,
                request_id=self._request_id,
                timestamp_ms=_now_ms(),
                dimensions=dimensions or {},
                value=value,
            )
        )


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def _now_ms() -> float:
    """Current time in milliseconds (monotonic-safe for latency, wall for events)."""
    return time.time() * 1000


def _elapsed_since(start_ms: float | None) -> float:
    """Calculate elapsed milliseconds since start_ms."""
    if start_ms is None:
        return 0.0
    return _now_ms() - start_ms


# ---------------------------------------------------------------------------
# Module-level convenience for creating collectors
# ---------------------------------------------------------------------------


def create_metrics_collector(
    conversation_id: str,
    request_id: str,
) -> MetricsCollector:
    """Factory function for creating a metrics collector for a request."""
    return MetricsCollector(conversation_id, request_id)
