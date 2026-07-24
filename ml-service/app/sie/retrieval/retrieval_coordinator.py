"""Retrieval coordinator orchestrating multi-channel retrieval.

The RetrievalCoordinator executes the versioned retrieval policy's initial
channel invocation plan, aggregates candidates, and deduplicates by concern_id
while preserving contributing attempt IDs.

Key design invariants:
- Executes ONLY the policy's initial_channels plan (widening is handled by AdaptiveWidener).
- Channel failures (ERROR, TIMEOUT, UNAVAILABLE) are recorded as attempts but do NOT abort.
- Failed/errored attempts are NOT represented as successful empty retrieval.
- Channel-local scores are preserved as diagnostics only; no score causes YES.
- The coordinator does NOT make ownership decisions or assign confidence.

Design authority: design.md §3 (RetrievalCoordinator).
"""

from __future__ import annotations

import time

from ..contracts import GraphStateContext
from ..enums import ConcernStatus, RetrievalAttemptStatus
from ..identity_models import IRSSignal, RetrievalAttemptRecord
from ..identity_policy import RetrievalPolicy
from ..models import SemanticPacket
from .channel_protocol import ChannelRegistry, RetrievalCandidate, RetrievalResult


class RetrievalCoordinator:
    """Orchestrates retrieval across multiple channels per versioned policy.

    Does not make ownership decisions. Does not assign confidence.
    Retrieval scores remain channel-local diagnostics only.
    """

    def __init__(
        self, channel_registry: ChannelRegistry, policy: RetrievalPolicy
    ) -> None:
        self._channel_registry = channel_registry
        self._policy = policy

    @property
    def policy(self) -> RetrievalPolicy:
        """The retrieval policy governing this coordinator."""
        return self._policy

    async def retrieve_candidates(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        prior_attempts: list[RetrievalAttemptRecord] | None = None,
        widening_signals: list[IRSSignal] | None = None,
    ) -> RetrievalResult:
        """Execute the initial retrieval plan and return aggregated results.

        Args:
            packet: The semantic packet to find identity candidates for.
            context: Immutable graph state snapshot — the ONLY data source.
            prior_attempts: Previously completed attempts (for context only).
            widening_signals: If provided, indicates widening phase — coordinator
                only runs the initial plan regardless; widening is handled by
                AdaptiveWidener.

        Returns:
            RetrievalResult with all attempts, deduplicated candidates,
            and total latency across all channel invocations.
        """
        attempts: list[RetrievalAttemptRecord] = []
        total_latency_ms = 0

        # Execute the policy's initial channel invocations in order
        for invocation in self._policy.initial_channels:
            channel = self._channel_registry.get(invocation.channel_id)

            start_time_ns = time.perf_counter_ns()
            try:
                attempt = await channel.retrieve(packet, context, invocation)
            except Exception as exc:
                # Channel raised an unhandled exception — record as ERROR
                elapsed_ms = (time.perf_counter_ns() - start_time_ns) // 1_000_000
                attempt = RetrievalAttemptRecord(
                    attempt_id=f"{invocation.channel_id}_{invocation.query_mode}_error",
                    channel_id=invocation.channel_id,
                    channel_family=channel.channel_family,
                    query_mode=invocation.query_mode,
                    query_reference="",
                    scope_description=str(invocation.scope_overrides),
                    status=RetrievalAttemptStatus.ERROR,
                    candidate_ids=[],
                    candidate_count=0,
                    latency_ms=elapsed_ms,
                    failure_reason=str(exc),
                    retrieval_policy_version=self._policy.policy_version,
                )

            attempts.append(attempt)
            if attempt.latency_ms is not None:
                total_latency_ms += attempt.latency_ms

        # Aggregate and deduplicate candidates from successful attempts
        candidates = self._aggregate_candidates(attempts)

        return RetrievalResult(
            attempts=attempts,
            candidates=candidates,
            total_latency_ms=total_latency_ms,
        )

    def _aggregate_candidates(
        self, attempts: list[RetrievalAttemptRecord]
    ) -> list[RetrievalCandidate]:
        """Aggregate and deduplicate candidates across successful attempts.

        For each unique concern_id found across SUCCESS_WITH_CANDIDATES attempts,
        create ONE RetrievalCandidate with merged contributing_attempt_ids.

        RetrievalCandidate carries NO semantic confidence — retrieval does not
        evaluate identity continuity or assign behavioral confidence bands.
        The IdentityEvaluator produces CandidateRecord with confidence later.

        Candidates from failed/errored/timed-out attempts are NOT included.
        """
        # Map concern_id -> list of attempt_ids that surfaced it
        concern_to_attempts: dict[str, list[str]] = {}

        for attempt in attempts:
            if attempt.status != RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES:
                continue
            for candidate_id in attempt.candidate_ids:
                if candidate_id not in concern_to_attempts:
                    concern_to_attempts[candidate_id] = []
                concern_to_attempts[candidate_id].append(attempt.attempt_id)

        # Build deduplicated RetrievalCandidates — no confidence assigned
        candidates: list[RetrievalCandidate] = []
        for concern_id, attempt_ids in concern_to_attempts.items():
            candidates.append(
                RetrievalCandidate(
                    concern_id=concern_id,
                    lifecycle_status=ConcernStatus.ACTIVE,
                    contributing_attempt_ids=attempt_ids,
                )
            )

        return candidates
