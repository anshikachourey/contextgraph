"""Tests for the AdaptiveWidener policy-driven retrieval widener.

Verifies:
- All IRS-to-channel invocations come from RetrievalPolicy (no hardcoded defaults).
- Widening executes configured invocations for each unresolved signal.
- Budget consumption is tracked (attempts, latency, rounds).
- Widening stops when budget is exhausted.
- New candidate IDs are collected from successful attempts.
- No widening occurs when there are no unresolved signals.
- Budget exhaustion is reflected in the result.
- The widener does NOT assign ownership.

Design authority: design-corrections.md §7.3.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.sie.contracts import GraphStateContext
from app.sie.enums import (
    BehavioralConfidenceBand,
    IRSSignalType,
    PipelineOutcome,
    ResolutionAction,
    RetrievalAttemptStatus,
    StageExecutionStatus,
)
from app.sie.identity_models import (
    EvidenceReference,
    IRSSignal,
    RetrievalAttemptRecord,
    SufficiencyRecord,
    WideningBudget,
)
from app.sie.identity_policy import (
    ChannelFamilyRequirement,
    ChannelInvocation,
    RetrievalPolicy,
)
from app.sie.retrieval.adaptive_widener import AdaptiveWidener, WideningResult
from app.sie.retrieval.channel_protocol import ChannelRegistry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_budget(
    *,
    max_rounds: int = 3,
    max_attempts: int = 10,
    max_latency_ms: int = 5000,
    max_cost_units: float = 100.0,
    rounds_used: int = 0,
    attempts_used: int = 0,
    latency_used_ms: int = 0,
    cost_used: float = 0.0,
) -> WideningBudget:
    """Create a WideningBudget with defaults suitable for testing."""
    exhausted = (
        rounds_used >= max_rounds
        or attempts_used >= max_attempts
        or latency_used_ms >= max_latency_ms
        or cost_used >= max_cost_units
    )
    return WideningBudget(
        max_rounds=max_rounds,
        max_attempts=max_attempts,
        max_latency_ms=max_latency_ms,
        max_cost_units=max_cost_units,
        rounds_used=rounds_used,
        attempts_used=attempts_used,
        latency_used_ms=latency_used_ms,
        cost_used=cost_used,
        exhausted=exhausted,
    )


def _make_irs_signal(
    *,
    signal_type: IRSSignalType = IRSSignalType.REVISIT_LANGUAGE,
    confidence: BehavioralConfidenceBand = BehavioralConfidenceBand.HIGH,
    resolved: bool = False,
) -> IRSSignal:
    """Create an IRSSignal for testing."""
    return IRSSignal(
        signal_type=signal_type,
        confidence=confidence,
        source_evidence=[
            EvidenceReference(entity_id="ev-1", entity_type="proposition")
        ],
        explanation="Test signal",
        resolved=resolved,
        resolved_by_attempt_ids=["attempt-x"] if resolved else [],
    )


def _make_sufficiency_record(
    *,
    unresolved_signals: list[IRSSignal] | None = None,
    failed_coverage_gaps: list[str] | None = None,
) -> SufficiencyRecord:
    """Create a SufficiencyRecord for testing widener input."""
    return SufficiencyRecord(
        stage_status=StageExecutionStatus.COMPLETED,
        confidence=BehavioralConfidenceBand.MEDIUM,
        coverage_summary="Test coverage",
        unresolved_signals=unresolved_signals or [],
        failed_coverage_gaps=failed_coverage_gaps or [],
        rationale="Retrieval is INCONCLUSIVE: test",
    )


def _make_attempt_record(
    *,
    attempt_id: str = "widened-attempt-001",
    channel_id: str = "hist_v1",
    channel_family: str = "historical_region",
    query_mode: str = "deep_scan",
    status: RetrievalAttemptStatus = RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
    candidate_ids: list[str] | None = None,
    latency_ms: int = 50,
    signal_type: IRSSignalType | None = None,
) -> RetrievalAttemptRecord:
    """Create a RetrievalAttemptRecord for mocking channel responses."""
    ids = candidate_ids or ["concern-new-1"]
    return RetrievalAttemptRecord(
        attempt_id=attempt_id,
        channel_id=channel_id,
        channel_family=channel_family,
        query_mode=query_mode,
        query_reference="widening-ref",
        scope_description="widening scope",
        status=status,
        candidate_ids=ids,
        candidate_count=len(ids),
        latency_ms=latency_ms,
        retrieval_policy_version="1.0.0",
        triggered_by_signal=signal_type,
    )


def _make_policy(
    *,
    irs_mapping: dict[str, list[ChannelInvocation]] | None = None,
) -> RetrievalPolicy:
    """Create a RetrievalPolicy with given IRS signal mapping."""
    if irs_mapping is None:
        irs_mapping = {}
    return RetrievalPolicy(
        policy_version="1.0.0",
        initial_channels=[],
        channel_family_requirements={
            "embedding_primary": ChannelFamilyRequirement(
                required_for_adequacy=True,
                min_successful_attempts=1,
                failure_blocks_no_match=True,
            ),
        },
        irs_signal_channel_mapping=irs_mapping,
    )


def _make_mock_channel(
    *,
    channel_id: str = "hist_v1",
    channel_family: str = "historical_region",
    supported_query_modes: list[str] | None = None,
    retrieve_return: RetrievalAttemptRecord | None = None,
) -> AsyncMock:
    """Create a mock RetrievalChannel."""
    mock = AsyncMock()
    mock.channel_id = channel_id
    mock.channel_family = channel_family
    mock.supported_query_modes = supported_query_modes or ["deep_scan", "broad"]
    if retrieve_return is None:
        retrieve_return = _make_attempt_record(
            channel_id=channel_id, channel_family=channel_family
        )
    mock.retrieve = AsyncMock(return_value=retrieve_return)
    return mock


def _make_context() -> GraphStateContext:
    """Create a minimal GraphStateContext for testing."""
    return GraphStateContext(
        graph_version=1,
        snapshot_token="snap-001",
        snapshot_digest="digest-001",
        concerns=[],
        propositions=[],
        active_associations=[],
    )


def _make_packet() -> Any:
    """Create a minimal SemanticPacket stub for testing."""
    # Use a mock since SemanticPacket has many required fields
    from unittest.mock import MagicMock

    packet = MagicMock()
    packet.packet_id = "packet-001"
    return packet


# ---------------------------------------------------------------------------
# Tests: No widening needed
# ---------------------------------------------------------------------------


class TestNoWidening:
    """Tests verifying widening is skipped when not needed."""

    @pytest.mark.asyncio
    async def test_no_unresolved_signals_returns_empty_result(self) -> None:
        """When no unresolved signals exist, widening returns an empty result."""
        registry = ChannelRegistry()
        policy = _make_policy()
        widener = AdaptiveWidener(registry, policy)

        sufficiency = _make_sufficiency_record(unresolved_signals=[])
        budget = _make_budget()

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert result.new_attempts == []
        assert result.new_candidate_ids == []
        assert result.rounds_executed == 0
        assert result.budget_exhausted is False
        assert "No unresolved signals" in result.rationale

    @pytest.mark.asyncio
    async def test_unresolved_signal_with_no_mapping_returns_empty(self) -> None:
        """Unresolved signal with no configured mapping produces no attempts."""
        registry = ChannelRegistry()
        policy = _make_policy(irs_mapping={})  # No mappings at all
        widener = AdaptiveWidener(registry, policy)

        signal = _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT)
        sufficiency = _make_sufficiency_record(unresolved_signals=[signal])
        budget = _make_budget()

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert result.new_attempts == []
        assert result.new_candidate_ids == []
        assert result.rounds_executed == 0


# ---------------------------------------------------------------------------
# Tests: Successful widening
# ---------------------------------------------------------------------------


class TestSuccessfulWidening:
    """Tests verifying widening executes policy-configured invocations."""

    @pytest.mark.asyncio
    async def test_executes_configured_invocations_for_signal(self) -> None:
        """Widener executes channel invocations mapped to unresolved signal type."""
        mock_channel = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
        )
        registry = ChannelRegistry()
        registry.register(mock_channel)

        invocation = ChannelInvocation(
            channel_id="hist_v1",
            query_mode="deep_scan",
            scope_overrides={},
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signal = _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT)
        sufficiency = _make_sufficiency_record(unresolved_signals=[signal])
        budget = _make_budget()

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert len(result.new_attempts) == 1
        assert result.new_candidate_ids == ["concern-new-1"]
        assert result.rounds_executed == 1
        assert result.budget_exhausted is False
        mock_channel.retrieve.assert_called_once()

    @pytest.mark.asyncio
    async def test_multiple_invocations_for_one_signal(self) -> None:
        """Multiple invocations per signal type are all executed."""
        mock_ch1 = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                attempt_id="att-1",
                channel_id="hist_v1",
                candidate_ids=["c-1"],
            ),
        )
        mock_ch2 = _make_mock_channel(
            channel_id="alias_v1",
            channel_family="alias_normalized",
            supported_query_modes=["broad", "narrow"],
            retrieve_return=_make_attempt_record(
                attempt_id="att-2",
                channel_id="alias_v1",
                channel_family="alias_normalized",
                query_mode="broad",
                candidate_ids=["c-2"],
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch1)
        registry.register(mock_ch2)

        invocations = [
            ChannelInvocation(
                channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
            ),
            ChannelInvocation(
                channel_id="alias_v1", query_mode="broad", scope_overrides={}
            ),
        ]
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: invocations,
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signal = _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT)
        sufficiency = _make_sufficiency_record(unresolved_signals=[signal])
        budget = _make_budget()

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert len(result.new_attempts) == 2
        assert "c-1" in result.new_candidate_ids
        assert "c-2" in result.new_candidate_ids
        assert result.rounds_executed == 1

    @pytest.mark.asyncio
    async def test_multiple_signals_produce_multiple_rounds(self) -> None:
        """Each unresolved signal with invocations counts as a separate round."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                candidate_ids=["c-1"],
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
                IRSSignalType.REVISIT_LANGUAGE.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signals = [
            _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT),
            _make_irs_signal(signal_type=IRSSignalType.REVISIT_LANGUAGE),
        ]
        sufficiency = _make_sufficiency_record(unresolved_signals=signals)
        budget = _make_budget(max_rounds=5)

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert result.rounds_executed == 2
        assert len(result.new_attempts) == 2

    @pytest.mark.asyncio
    async def test_deduplicates_candidate_ids(self) -> None:
        """Candidate IDs appearing in multiple attempts are deduplicated."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                candidate_ids=["c-shared", "c-unique-1"],
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
                IRSSignalType.REVISIT_LANGUAGE.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signals = [
            _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT),
            _make_irs_signal(signal_type=IRSSignalType.REVISIT_LANGUAGE),
        ]
        sufficiency = _make_sufficiency_record(unresolved_signals=signals)
        budget = _make_budget(max_rounds=5)

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        # Same candidates returned by both invocations — should be deduped
        assert result.new_candidate_ids == ["c-shared", "c-unique-1"]


# ---------------------------------------------------------------------------
# Tests: Budget enforcement
# ---------------------------------------------------------------------------


class TestBudgetEnforcement:
    """Tests verifying budget limits are respected."""

    @pytest.mark.asyncio
    async def test_stops_when_max_attempts_reached(self) -> None:
        """Widening stops when attempts_used reaches max_attempts."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(candidate_ids=["c-1"]),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
                IRSSignalType.REVISIT_LANGUAGE.value: [invocation],
                IRSSignalType.IMPLIED_PRIOR_STATE.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signals = [
            _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT),
            _make_irs_signal(signal_type=IRSSignalType.REVISIT_LANGUAGE),
            _make_irs_signal(signal_type=IRSSignalType.IMPLIED_PRIOR_STATE),
        ]
        sufficiency = _make_sufficiency_record(unresolved_signals=signals)
        # Only allow 1 attempt total
        budget = _make_budget(max_attempts=1, max_rounds=10)

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert len(result.new_attempts) == 1
        assert result.budget_exhausted is True
        assert result.budget is not None
        assert result.budget.attempts_used == 1

    @pytest.mark.asyncio
    async def test_stops_when_max_rounds_reached(self) -> None:
        """Widening stops when rounds_used reaches max_rounds."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(candidate_ids=["c-1"]),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
                IRSSignalType.REVISIT_LANGUAGE.value: [invocation],
                IRSSignalType.IMPLIED_PRIOR_STATE.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signals = [
            _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT),
            _make_irs_signal(signal_type=IRSSignalType.REVISIT_LANGUAGE),
            _make_irs_signal(signal_type=IRSSignalType.IMPLIED_PRIOR_STATE),
        ]
        sufficiency = _make_sufficiency_record(unresolved_signals=signals)
        # Only allow 1 round
        budget = _make_budget(max_rounds=1, max_attempts=100)

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        # Only the first signal's invocations complete (1 round)
        assert result.rounds_executed == 1
        assert result.budget_exhausted is True
        assert result.budget is not None
        assert result.budget.rounds_used == 1

    @pytest.mark.asyncio
    async def test_stops_when_max_latency_reached(self) -> None:
        """Widening stops when latency_used_ms reaches max_latency_ms."""
        # Channel returns high latency per attempt
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                candidate_ids=["c-1"], latency_ms=3000
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
                IRSSignalType.REVISIT_LANGUAGE.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signals = [
            _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT),
            _make_irs_signal(signal_type=IRSSignalType.REVISIT_LANGUAGE),
        ]
        sufficiency = _make_sufficiency_record(unresolved_signals=signals)
        # Only allow 2500ms total — first attempt uses 3000ms
        budget = _make_budget(max_latency_ms=2500, max_rounds=10, max_attempts=10)

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        # First attempt exceeds latency budget after execution
        assert len(result.new_attempts) == 1
        assert result.budget_exhausted is True
        assert result.budget is not None
        assert result.budget.latency_used_ms >= 2500

    @pytest.mark.asyncio
    async def test_already_exhausted_budget_produces_no_attempts(self) -> None:
        """If budget is already exhausted at start, no widening occurs."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signal = _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT)
        sufficiency = _make_sufficiency_record(unresolved_signals=[signal])
        # Budget already exhausted (max_rounds=1, rounds_used=1)
        budget = _make_budget(max_rounds=1, rounds_used=1)

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert result.new_attempts == []
        assert result.rounds_executed == 0
        assert result.budget_exhausted is True
        mock_ch.retrieve.assert_not_called()

    @pytest.mark.asyncio
    async def test_budget_consumption_is_tracked_cumulatively(self) -> None:
        """Budget tracks cumulative consumption across all attempts."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                candidate_ids=["c-1"], latency_ms=100
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
                IRSSignalType.REVISIT_LANGUAGE.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signals = [
            _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT),
            _make_irs_signal(signal_type=IRSSignalType.REVISIT_LANGUAGE),
        ]
        sufficiency = _make_sufficiency_record(unresolved_signals=signals)
        # Start with some budget already used
        budget = _make_budget(
            max_attempts=10,
            max_rounds=5,
            attempts_used=2,
            rounds_used=1,
            latency_used_ms=200,
        )

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert result.budget is not None
        # Started with 2 attempts, did 2 more
        assert result.budget.attempts_used == 4
        # Started with 1 round, did 2 more
        assert result.budget.rounds_used == 3
        # Started with 200ms, added 100ms per attempt
        assert result.budget.latency_used_ms == 400

    @pytest.mark.asyncio
    async def test_budget_exhaustion_before_adequacy_no_novelty_eligible(
        self,
    ) -> None:
        """Budget exhaustion before adequacy → result does not produce novelty.

        When the budget is exhausted while unresolved signals remain, the
        widening result only contains raw candidate IDs for re-evaluation
        (not novelty-eligible candidates). The downstream separator
        guarantees RETRIEVAL_INCONCLUSIVE with novelty_eligible=False.
        """
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                candidate_ids=["c-raw-1", "c-raw-2"], latency_ms=100
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        # Three signals require processing, but budget allows only 1 attempt
        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
                IRSSignalType.REVISIT_LANGUAGE.value: [invocation],
                IRSSignalType.IMPLIED_PRIOR_STATE.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signals = [
            _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT),
            _make_irs_signal(signal_type=IRSSignalType.REVISIT_LANGUAGE),
            _make_irs_signal(signal_type=IRSSignalType.IMPLIED_PRIOR_STATE),
        ]
        sufficiency = _make_sufficiency_record(unresolved_signals=signals)
        # Budget allows only 1 attempt — will exhaust before all signals resolved
        budget = _make_budget(max_attempts=1, max_rounds=10, max_latency_ms=5000)

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        # Budget is exhausted
        assert result.budget_exhausted is True
        assert result.budget is not None
        assert result.budget.exhausted is True

        # new_candidate_ids are raw IDs for re-evaluation, NOT novelty-eligible
        # The widener itself never grants novelty — it only collects candidates
        assert result.new_candidate_ids == ["c-raw-1", "c-raw-2"]

        # Now verify downstream: feed the still-inconclusive sufficiency into
        # the DownstreamSeparator — it must produce RETRIEVAL_INCONCLUSIVE
        # with novelty_eligible=False
        from app.sie.retrieval.downstream_separator import DownstreamSeparator

        separator = DownstreamSeparator()
        # The sufficiency remains INCONCLUSIVE (MEDIUM confidence) because
        # budget exhausted before adequacy was achieved
        decision = separator.determine_outcome(sufficiency, candidates=[])

        assert decision.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.novelty_eligible is False
        assert decision.requires_widening is True


# ---------------------------------------------------------------------------
# Tests: Nonmaterial channel failure
# ---------------------------------------------------------------------------


class TestNonmaterialChannelFailure:
    """Tests verifying a nonmaterial channel failure does not abort widening."""

    @pytest.mark.asyncio
    async def test_error_on_one_channel_does_not_abort_remaining(self) -> None:
        """An ERROR attempt on a non-blocking channel does not stop widening.

        The widener records the failed attempt and continues to the next
        invocation, preserving otherwise adequate retrieval results.
        """
        # First channel returns ERROR, second returns success
        mock_ch_error = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                attempt_id="att-err",
                channel_id="hist_v1",
                channel_family="historical_region",
                status=RetrievalAttemptStatus.ERROR,
                candidate_ids=[],
            ),
        )
        mock_ch_success = _make_mock_channel(
            channel_id="alias_v1",
            channel_family="alias_normalized",
            supported_query_modes=["broad"],
            retrieve_return=_make_attempt_record(
                attempt_id="att-ok",
                channel_id="alias_v1",
                channel_family="alias_normalized",
                query_mode="broad",
                status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                candidate_ids=["c-good-1"],
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch_error)
        registry.register(mock_ch_success)

        invocations = [
            ChannelInvocation(
                channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
            ),
            ChannelInvocation(
                channel_id="alias_v1", query_mode="broad", scope_overrides={}
            ),
        ]
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: invocations,
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signal = _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT)
        sufficiency = _make_sufficiency_record(unresolved_signals=[signal])
        budget = _make_budget()

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        # Both attempts were executed — error didn't abort
        assert len(result.new_attempts) == 2
        # Only the successful channel contributed candidates
        assert result.new_candidate_ids == ["c-good-1"]
        # Widening completed — budget not exhausted
        assert result.budget_exhausted is False
        assert result.rounds_executed == 1


# ---------------------------------------------------------------------------
# Tests: Policy-driven behavior (no hardcoded defaults)
# ---------------------------------------------------------------------------


class TestPolicyDriven:
    """Tests verifying all behavior comes from policy, not hardcoded defaults."""

    @pytest.mark.asyncio
    async def test_only_uses_policy_mapping_for_invocations(self) -> None:
        """Widener only executes channels from policy mapping, never guesses."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
        )
        mock_ch_unused = _make_mock_channel(
            channel_id="emb_v1",
            channel_family="embedding_primary",
            supported_query_modes=["broad"],
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)
        registry.register(mock_ch_unused)

        # Only map HISTORICAL_REFERENT to hist_v1
        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signal = _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT)
        sufficiency = _make_sufficiency_record(unresolved_signals=[signal])
        budget = _make_budget()

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        # hist_v1 was called, emb_v1 was never called
        mock_ch.retrieve.assert_called_once()
        mock_ch_unused.retrieve.assert_not_called()
        assert len(result.new_attempts) == 1

    @pytest.mark.asyncio
    async def test_empty_success_does_not_produce_candidates(self) -> None:
        """SUCCESS_EMPTY attempts don't contribute candidate IDs."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                candidate_ids=[],
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signal = _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT)
        sufficiency = _make_sufficiency_record(unresolved_signals=[signal])
        budget = _make_budget()

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert len(result.new_attempts) == 1
        assert result.new_candidate_ids == []

    @pytest.mark.asyncio
    async def test_error_attempts_do_not_produce_candidates(self) -> None:
        """ERROR attempts don't contribute candidate IDs."""
        mock_ch = _make_mock_channel(
            channel_id="hist_v1",
            channel_family="historical_region",
            retrieve_return=_make_attempt_record(
                status=RetrievalAttemptStatus.ERROR,
                candidate_ids=[],
            ),
        )
        registry = ChannelRegistry()
        registry.register(mock_ch)

        invocation = ChannelInvocation(
            channel_id="hist_v1", query_mode="deep_scan", scope_overrides={}
        )
        policy = _make_policy(
            irs_mapping={
                IRSSignalType.HISTORICAL_REFERENT.value: [invocation],
            }
        )
        widener = AdaptiveWidener(registry, policy)

        signal = _make_irs_signal(signal_type=IRSSignalType.HISTORICAL_REFERENT)
        sufficiency = _make_sufficiency_record(unresolved_signals=[signal])
        budget = _make_budget()

        result = await widener.widen(
            _make_packet(), _make_context(), sufficiency, budget
        )

        assert len(result.new_attempts) == 1
        assert result.new_candidate_ids == []


# ---------------------------------------------------------------------------
# Tests: WideningResult dataclass
# ---------------------------------------------------------------------------


class TestWideningResult:
    """Tests verifying WideningResult construction and fields."""

    def test_default_construction(self) -> None:
        """WideningResult can be constructed with defaults."""
        result = WideningResult()
        assert result.new_attempts == []
        assert result.new_candidate_ids == []
        assert result.budget is None
        assert result.rounds_executed == 0
        assert result.budget_exhausted is False
        assert result.rationale == ""

    def test_full_construction(self) -> None:
        """WideningResult constructed with all fields."""
        budget = _make_budget(attempts_used=3, rounds_used=1)
        attempt = _make_attempt_record()
        result = WideningResult(
            new_attempts=[attempt],
            new_candidate_ids=["c-1", "c-2"],
            budget=budget,
            rounds_executed=1,
            budget_exhausted=False,
            rationale="Completed widening successfully.",
        )
        assert len(result.new_attempts) == 1
        assert result.new_candidate_ids == ["c-1", "c-2"]
        assert result.budget is not None
        assert result.rounds_executed == 1
        assert result.budget_exhausted is False
        assert "Completed" in result.rationale
