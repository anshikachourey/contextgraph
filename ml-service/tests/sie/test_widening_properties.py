"""Property-based tests for adaptive widening (Task 10.3).

Proves:
1. Example IRS mappings loaded exclusively from test policy fixtures.
2. Changing policy changes widening behavior without code changes.
3. Missing mappings fail closed rather than using hidden defaults.
4. Budget exhaustion never produces novelty.

**Validates: Requirements 5.5, 5.6, 5.12**
"""

from __future__ import annotations

import asyncio
import pytest

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")
from dataclasses import dataclass, field
from unittest.mock import AsyncMock

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

from app.sie.enums import (
    BehavioralConfidenceBand,
    IRSSignalType,
    PipelineOutcome,
    ResolutionAction,
    RetrievalAttemptStatus,
    StageExecutionStatus,
)
from app.sie.identity_models import (
    CandidateRecord,
    EvidenceReference,
    IRSSignal,
    RetrievalAttemptRecord,
    SufficiencyRecord,
    WideningBudget,
)
from app.sie.identity_policy import (
    CANONICAL_CHANNEL_FAMILIES,
    ChannelFamilyRequirement,
    ChannelInvocation,
    RetrievalPolicy,
)
from app.sie.retrieval.adaptive_widener import AdaptiveWidener, WideningResult
from app.sie.retrieval.channel_protocol import ChannelRegistry, RetrievalResult
from app.sie.retrieval.downstream_separator import DownstreamSeparator
from app.sie.retrieval.sufficiency_gate import SufficiencyGate
from app.sie.models import SemanticPacket
from app.sie.enums import CohesionStatus


# ---------------------------------------------------------------------------
# Shared strategies
# ---------------------------------------------------------------------------

irs_signal_type_st = st.sampled_from(list(IRSSignalType))
confidence_st = st.sampled_from(list(BehavioralConfidenceBand))
nonempty_str_st = st.text(
    min_size=1,
    max_size=20,
    alphabet=st.characters(whitelist_categories=("L", "N")),
)

_TEST_FAMILIES = sorted(CANONICAL_CHANNEL_FAMILIES)


# ---------------------------------------------------------------------------
# Test fixtures: Policy builders (all IRS mappings in policy, not code)
# ---------------------------------------------------------------------------


def _make_policy_with_mappings(
    mappings: dict[str, list[ChannelInvocation]],
) -> RetrievalPolicy:
    """Build a retrieval policy with the given IRS-to-channel mappings.

    All mappings come from this test fixture — never from hardcoded code.
    """
    requirements = {
        family: ChannelFamilyRequirement(
            required_for_adequacy=True,
            min_successful_attempts=1,
            failure_blocks_no_match=True,
        )
        for family in _TEST_FAMILIES
    }
    return RetrievalPolicy(
        policy_version="test-1.0.0",
        initial_channels=[
            ChannelInvocation(
                channel_id="emb_v1",
                query_mode="broad",
                scope_overrides={},
            )
        ],
        channel_family_requirements=requirements,
        irs_signal_channel_mapping=mappings,
    )


def _make_empty_mapping_policy() -> RetrievalPolicy:
    """Policy with NO IRS-to-channel mappings (empty)."""
    return _make_policy_with_mappings({})


def _make_single_signal_policy(
    signal_type: IRSSignalType,
    channel_id: str = "hist_v1",
    channel_family: str = "historical_region",
    query_mode: str = "full",
) -> RetrievalPolicy:
    """Policy mapping one signal type to one channel invocation."""
    return _make_policy_with_mappings({
        signal_type.value: [
            ChannelInvocation(
                channel_id=channel_id,
                query_mode=query_mode,
                scope_overrides={},
            )
        ],
    })


# ---------------------------------------------------------------------------
# Fake channel for testing
# ---------------------------------------------------------------------------


class FakeChannel:
    """A fake retrieval channel for testing widening behavior."""

    def __init__(
        self,
        channel_id: str,
        channel_family: str,
        result_status: RetrievalAttemptStatus = RetrievalAttemptStatus.SUCCESS_EMPTY,
        candidate_ids: list[str] | None = None,
        latency_ms: int = 10,
    ):
        self._channel_id = channel_id
        self._channel_family = channel_family
        self._result_status = result_status
        self._candidate_ids = candidate_ids or []
        self._latency_ms = latency_ms
        self.call_count = 0

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return self._channel_family

    @property
    def supported_query_modes(self) -> list[str]:
        return ["broad", "narrow", "full", "continuation"]

    async def retrieve(self, packet, context, invocation):
        self.call_count += 1
        ids = self._candidate_ids
        return RetrievalAttemptRecord(
            attempt_id=f"widening-{self._channel_id}-{self.call_count}",
            channel_id=self._channel_id,
            channel_family=self._channel_family,
            query_mode=invocation.query_mode,
            query_reference="widening-ref",
            scope_description="widening scope",
            status=self._result_status,
            candidate_ids=ids,
            candidate_count=len(ids),
            latency_ms=self._latency_ms,
            retrieval_policy_version="test-1.0.0",
            triggered_by_signal=None,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_irs_signal(
    *,
    signal_type: IRSSignalType = IRSSignalType.HISTORICAL_REFERENT,
    confidence: BehavioralConfidenceBand = BehavioralConfidenceBand.HIGH,
    resolved: bool = False,
) -> IRSSignal:
    return IRSSignal(
        signal_type=signal_type,
        confidence=confidence,
        source_evidence=[
            EvidenceReference(entity_id="prop-001", entity_type="proposition")
        ],
        explanation="Test IRS signal",
        resolved=resolved,
        resolved_by_attempt_ids=[],
    )


def _make_budget(
    *,
    max_rounds: int = 3,
    max_attempts: int = 10,
    max_latency_ms: int = 5000,
    max_cost_units: float = 100.0,
    rounds_used: int = 0,
    attempts_used: int = 0,
    latency_used_ms: int = 0,
) -> WideningBudget:
    return WideningBudget(
        max_rounds=max_rounds,
        max_attempts=max_attempts,
        max_latency_ms=max_latency_ms,
        max_cost_units=max_cost_units,
        rounds_used=rounds_used,
        attempts_used=attempts_used,
        latency_used_ms=latency_used_ms,
        cost_used=0.0,
        exhausted=False,
    )


def _make_exhausted_budget() -> WideningBudget:
    """Create an already-exhausted budget."""
    return WideningBudget(
        max_rounds=1,
        max_attempts=1,
        max_latency_ms=100,
        max_cost_units=1.0,
        rounds_used=1,
        attempts_used=1,
        latency_used_ms=100,
        cost_used=1.0,
        exhausted=True,
    )


def _make_sufficiency_inconclusive(
    unresolved_signals: list[IRSSignal],
) -> SufficiencyRecord:
    return SufficiencyRecord(
        stage_status=StageExecutionStatus.COMPLETED,
        confidence=BehavioralConfidenceBand.MEDIUM,
        coverage_summary="Inconclusive",
        unresolved_signals=unresolved_signals,
        failed_coverage_gaps=["historical_region"],
        rationale="Unresolved signals remain",
    )


def _make_packet() -> SemanticPacket:
    return SemanticPacket(
        packet_id="pkt-001",
        packet_creation_key="req-001:partition-0",
        conversation_id="conv-001",
        source_message_ids=["msg-001"],
        message_seq_range=(1, 1),
        user_grounded_meaning="Test user meaning",
        provenance="test",
        packet_formation_version="1.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


# ===========================================================================
# Property 1: IRS mappings loaded exclusively from test policy fixtures.
# **Validates: Requirements 5.5**
# ===========================================================================


class TestMappingsFromPolicyFixtures:
    """Prove AdaptiveWidener reads IRS-to-channel mappings from policy, not code."""

    @given(
        signal_type=irs_signal_type_st,
    )
    @settings(max_examples=100)
    def test_widener_uses_policy_mapping_for_signal(self, signal_type: IRSSignalType):
        """The widener selects channels based on the policy's
        irs_signal_channel_mapping, which comes from test fixtures.
        If a signal maps to a channel in the policy, that channel is invoked.
        """
        # Create policy mapping this signal to hist_v1
        policy = _make_single_signal_policy(signal_type, channel_id="hist_v1")

        # Register the channel
        registry = ChannelRegistry()
        fake_channel = FakeChannel("hist_v1", "historical_region")
        registry.register(fake_channel)

        widener = AdaptiveWidener(channel_registry=registry, policy=policy)

        # Create an unresolved signal of this type
        signal = _make_irs_signal(signal_type=signal_type)
        sufficiency = _make_sufficiency_inconclusive([signal])
        budget = _make_budget()
        packet = _make_packet()

        # Run widening
        result = asyncio.run(
            widener.widen(packet, None, sufficiency, budget)
        )

        # The channel was invoked
        assert fake_channel.call_count > 0
        assert len(result.new_attempts) > 0


# ===========================================================================
# Property 2: Changing policy changes widening behavior without code changes.
# **Validates: Requirements 5.5**
# ===========================================================================


class TestPolicyChangesBehavior:
    """Prove that changing the policy fixture changes widening behavior."""

    @given(
        signal_type=irs_signal_type_st,
    )
    @settings(max_examples=100)
    def test_different_policy_mapping_uses_different_channel(
        self, signal_type: IRSSignalType
    ):
        """When policy maps a signal to channel A, channel A is invoked.
        When we change the policy to map the same signal to channel B,
        channel B is invoked instead — no code change needed.
        """
        # Policy A: signal → alias_v1
        policy_a = _make_policy_with_mappings({
            signal_type.value: [
                ChannelInvocation(
                    channel_id="alias_v1",
                    query_mode="broad",
                    scope_overrides={},
                )
            ],
        })

        # Policy B: signal → hist_v1
        policy_b = _make_policy_with_mappings({
            signal_type.value: [
                ChannelInvocation(
                    channel_id="hist_v1",
                    query_mode="full",
                    scope_overrides={},
                )
            ],
        })

        # Register both channels
        registry = ChannelRegistry()
        alias_channel = FakeChannel("alias_v1", "alias_normalized")
        hist_channel = FakeChannel("hist_v1", "historical_region")
        registry.register(alias_channel)
        registry.register(hist_channel)

        signal = _make_irs_signal(signal_type=signal_type)
        sufficiency = _make_sufficiency_inconclusive([signal])
        budget = _make_budget()
        packet = _make_packet()

        # Widen with policy A
        widener_a = AdaptiveWidener(channel_registry=registry, policy=policy_a)
        asyncio.run(
            widener_a.widen(packet, None, sufficiency, budget)
        )
        assert alias_channel.call_count > 0
        assert hist_channel.call_count == 0

        # Reset counts
        alias_channel.call_count = 0
        hist_channel.call_count = 0

        # Widen with policy B (same signal, different mapping)
        budget_b = _make_budget()
        widener_b = AdaptiveWidener(channel_registry=registry, policy=policy_b)
        asyncio.run(
            widener_b.widen(packet, None, sufficiency, budget_b)
        )
        assert hist_channel.call_count > 0
        assert alias_channel.call_count == 0


# ===========================================================================
# Property 3: Missing mappings fail closed rather than using hidden defaults.
# **Validates: Requirements 5.5, 5.6**
# ===========================================================================


class TestMissingMappingsFailClosed:
    """Prove missing IRS-to-channel mappings produce no invocations (fail closed)."""

    @given(
        signal_type=irs_signal_type_st,
    )
    @settings(max_examples=100)
    def test_signal_with_no_mapping_produces_no_attempts(
        self, signal_type: IRSSignalType
    ):
        """When the policy has no mapping for a signal type, the widener
        produces no new retrieval attempts for that signal. It does NOT
        fall back to hardcoded default channel selections.
        """
        # Policy with EMPTY mappings (no signal → channel rules)
        policy = _make_empty_mapping_policy()

        # Register channels (they should NOT be called)
        registry = ChannelRegistry()
        fake_channel = FakeChannel("emb_v1", "embedding_primary")
        registry.register(fake_channel)

        widener = AdaptiveWidener(channel_registry=registry, policy=policy)

        # Create an unresolved signal
        signal = _make_irs_signal(signal_type=signal_type)
        sufficiency = _make_sufficiency_inconclusive([signal])
        budget = _make_budget()
        packet = _make_packet()

        result = asyncio.run(
            widener.widen(packet, None, sufficiency, budget)
        )

        # No attempts produced — fail closed (no hidden default)
        assert result.new_attempts == []
        assert result.new_candidate_ids == []
        assert fake_channel.call_count == 0

    @given(
        mapped_signal=irs_signal_type_st,
        unmapped_signal=irs_signal_type_st,
    )
    @settings(max_examples=100)
    def test_only_mapped_signals_trigger_invocations(
        self, mapped_signal: IRSSignalType, unmapped_signal: IRSSignalType
    ):
        """Only signals with explicit policy mappings trigger channel invocations.
        Unmapped signals are silently skipped (fail closed).
        """
        assume(mapped_signal != unmapped_signal)

        # Only the mapped_signal has a channel mapping
        policy = _make_single_signal_policy(
            mapped_signal, channel_id="hist_v1"
        )

        registry = ChannelRegistry()
        hist_channel = FakeChannel("hist_v1", "historical_region")
        registry.register(hist_channel)

        widener = AdaptiveWidener(channel_registry=registry, policy=policy)

        # Only supply the UNMAPPED signal
        signal = _make_irs_signal(signal_type=unmapped_signal)
        sufficiency = _make_sufficiency_inconclusive([signal])
        budget = _make_budget()
        packet = _make_packet()

        result = asyncio.run(
            widener.widen(packet, None, sufficiency, budget)
        )

        # No invocations for unmapped signal
        assert hist_channel.call_count == 0
        assert result.new_attempts == []


# ===========================================================================
# Property 4: Budget exhaustion never produces novelty.
# **Validates: Requirements 5.5, 5.6, 5.12**
# ===========================================================================


class TestBudgetExhaustionNeverProducesNovelty:
    """Prove budget exhaustion → RETRIEVAL_INCONCLUSIVE, never NO/PROPOSE_NEW."""

    @given(
        signal_type=irs_signal_type_st,
        budget_dimension=st.sampled_from(["rounds", "attempts", "latency"]),
    )
    @settings(max_examples=100)
    def test_exhausted_budget_produces_inconclusive_not_novelty(
        self, signal_type: IRSSignalType, budget_dimension: str
    ):
        """When the widening budget is exhausted before retrieval adequacy
        is established, the downstream outcome must be RETRIEVAL_INCONCLUSIVE
        or DEFER — never NO/PROPOSE_NEW.
        """
        # Create budget already at limit in one dimension
        if budget_dimension == "rounds":
            budget = _make_budget(max_rounds=0)  # Already exhausted
        elif budget_dimension == "attempts":
            budget = _make_budget(max_attempts=0)
        else:
            budget = _make_budget(max_latency_ms=0)

        policy = _make_single_signal_policy(signal_type, channel_id="hist_v1")

        registry = ChannelRegistry()
        hist_channel = FakeChannel("hist_v1", "historical_region")
        registry.register(hist_channel)

        widener = AdaptiveWidener(channel_registry=registry, policy=policy)

        signal = _make_irs_signal(signal_type=signal_type)
        sufficiency = _make_sufficiency_inconclusive([signal])
        packet = _make_packet()

        result = asyncio.run(
            widener.widen(packet, None, sufficiency, budget)
        )

        # Budget exhausted: no new attempts should have been produced
        # (budget was already at limit before starting)
        assert result.budget_exhausted is True

        # Now verify the downstream decision with the still-inconclusive sufficiency
        # Budget exhaustion means retrieval remains inconclusive
        separator = DownstreamSeparator()
        decision = separator.determine_outcome(sufficiency, [])

        # Must NEVER produce novelty
        assert decision.outcome != PipelineOutcome.NO
        assert decision.action != ResolutionAction.PROPOSE_NEW
        assert decision.novelty_eligible is False

    @given(
        num_signals=st.integers(min_value=1, max_value=4),
    )
    @settings(max_examples=100)
    def test_budget_exhaustion_during_widening_blocks_novelty(
        self, num_signals: int
    ):
        """Even when widening finds no match, if budget was exhausted before
        adequacy was confirmed, the result cannot be novelty.
        """
        signal_types = list(IRSSignalType)[:num_signals]

        # Create a budget that allows exactly 1 attempt (will exhaust quickly)
        budget = _make_budget(max_attempts=1)

        # Map ALL signals to hist_v1
        mappings = {
            st_val.value: [
                ChannelInvocation(
                    channel_id="hist_v1",
                    query_mode="full",
                    scope_overrides={},
                )
            ]
            for st_val in signal_types
        }
        policy = _make_policy_with_mappings(mappings)

        registry = ChannelRegistry()
        hist_channel = FakeChannel("hist_v1", "historical_region")
        registry.register(hist_channel)

        widener = AdaptiveWidener(channel_registry=registry, policy=policy)

        signals = [
            _make_irs_signal(signal_type=st_val)
            for st_val in signal_types
        ]
        sufficiency = _make_sufficiency_inconclusive(signals)
        packet = _make_packet()

        result = asyncio.run(
            widener.widen(packet, None, sufficiency, budget)
        )

        # Budget should be exhausted (only 1 attempt allowed)
        if num_signals > 0:
            assert result.budget_exhausted is True

        # The post-widening sufficiency remains inconclusive since
        # we only spent 1 attempt and have multiple unresolved signals.
        # Downstream cannot produce novelty with inconclusive sufficiency.
        separator = DownstreamSeparator()
        decision = separator.determine_outcome(sufficiency, [])

        assert decision.outcome != PipelineOutcome.NO
        assert decision.action != ResolutionAction.PROPOSE_NEW
        assert decision.novelty_eligible is False
