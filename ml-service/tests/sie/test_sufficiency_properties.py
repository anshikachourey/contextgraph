"""Property-based tests for retrieval-sufficiency gate (Task 9.4).

Proves:
1. Identity ambiguity can coexist with ADEQUATE retrieval.
2. Ambiguity does not itself trigger widening.
3. Unresolved HIGH/MEDIUM IRS signals block adequacy.
4. NO/PROPOSE_NEW is impossible without completed HIGH adequacy.

**Validates: Requirements 4.1, 4.2, 4.3, 4.7**
"""

from __future__ import annotations

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
    ChannelDiagnostic,
    EvidenceReference,
    IRSSignal,
    RetrievalAttemptRecord,
    SufficiencyRecord,
)
from app.sie.identity_policy import (
    CANONICAL_CHANNEL_FAMILIES,
    ChannelFamilyRequirement,
    ChannelInvocation,
    RetrievalPolicy,
)
from app.sie.retrieval.channel_protocol import RetrievalResult
from app.sie.retrieval.sufficiency_gate import SufficiencyGate
from app.sie.retrieval.downstream_separator import DownstreamSeparator


# ---------------------------------------------------------------------------
# Shared strategies
# ---------------------------------------------------------------------------

confidence_st = st.sampled_from(list(BehavioralConfidenceBand))
irs_signal_type_st = st.sampled_from(list(IRSSignalType))
nonempty_str_st = st.text(
    min_size=1,
    max_size=20,
    alphabet=st.characters(whitelist_categories=("L", "N")),
)

# Canonical families we'll use for testing
_TEST_FAMILIES = sorted(CANONICAL_CHANNEL_FAMILIES)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_attempt(
    *,
    attempt_id: str = "attempt-001",
    channel_id: str = "emb_v1",
    channel_family: str = "embedding_primary",
    query_mode: str = "broad",
    status: RetrievalAttemptStatus = RetrievalAttemptStatus.SUCCESS_EMPTY,
    candidate_ids: list[str] | None = None,
    latency_ms: int = 10,
) -> RetrievalAttemptRecord:
    """Create a RetrievalAttemptRecord with minimal required fields."""
    ids = candidate_ids or []
    return RetrievalAttemptRecord(
        attempt_id=attempt_id,
        channel_id=channel_id,
        channel_family=channel_family,
        query_mode=query_mode,
        query_reference="test-ref",
        scope_description="test scope",
        status=status,
        candidate_ids=ids,
        candidate_count=len(ids),
        latency_ms=latency_ms,
        retrieval_policy_version="1.0.0",
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
            EvidenceReference(entity_id="prop-001", entity_type="proposition")
        ],
        explanation="Test signal",
        resolved=resolved,
        resolved_by_attempt_ids=["attempt-resolve"] if resolved else [],
    )


def _make_candidate(
    *,
    concern_id: str = "concern-001",
    confidence: BehavioralConfidenceBand = BehavioralConfidenceBand.HIGH,
) -> CandidateRecord:
    """Create a CandidateRecord for testing."""
    return CandidateRecord(
        concern_id=concern_id,
        lifecycle_status="ACTIVE",
        contributing_attempt_ids=["attempt-001"],
        channel_local_diagnostics=[],
        identity_evidence=[],
        contrary_evidence=[],
        confidence=confidence,
        explanation="Test candidate",
    )


def _make_adequate_policy(
    required_families: list[str] | None = None,
) -> RetrievalPolicy:
    """Create a policy requiring specified families (or just embedding_primary)."""
    families = required_families or ["embedding_primary"]
    requirements = {
        family: ChannelFamilyRequirement(
            required_for_adequacy=(family in families),
            min_successful_attempts=1,
            failure_blocks_no_match=(family in families),
        )
        for family in _TEST_FAMILIES
    }
    return RetrievalPolicy(
        policy_version="1.0.0",
        initial_channels=[
            ChannelInvocation(
                channel_id="emb_v1",
                query_mode="broad",
                scope_overrides={},
            )
        ],
        channel_family_requirements=requirements,
        irs_signal_channel_mapping={},
    )


def _build_adequate_retrieval(families: list[str]) -> RetrievalResult:
    """Build a retrieval result with successful attempts for all given families."""
    attempts = []
    for i, family in enumerate(families):
        attempts.append(
            _make_attempt(
                attempt_id=f"attempt-{i:03d}",
                channel_id=f"ch_{family}",
                channel_family=family,
                status=RetrievalAttemptStatus.SUCCESS_EMPTY,
            )
        )
    return RetrievalResult(attempts=attempts, candidates=[], total_latency_ms=100)


# ===========================================================================
# Property 1: Identity ambiguity can coexist with ADEQUATE retrieval.
# **Validates: Requirements 4.1, 4.2**
# ===========================================================================


class TestAmbiguityCoexistsWithAdequacy:
    """Prove identity ambiguity does NOT affect retrieval adequacy."""

    @given(
        num_high_candidates=st.integers(min_value=2, max_value=5),
    )
    @settings(max_examples=100)
    def test_multiple_high_candidates_with_adequate_retrieval(
        self, num_high_candidates: int
    ):
        """Multiple HIGH candidates (ambiguity) can coexist with ADEQUATE retrieval.

        The sufficiency gate evaluates retrieval coverage, NOT candidate
        plausibility. Even when multiple candidates compete for identity,
        retrieval is adequate if all policy-required channels completed.
        """
        # Set up a policy requiring only embedding_primary
        policy = _make_adequate_policy(required_families=["embedding_primary"])

        # Build retrieval with successful embedding_primary attempt
        retrieval_result = RetrievalResult(
            attempts=[
                _make_attempt(
                    attempt_id="attempt-emb",
                    channel_id="emb_v1",
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                    candidate_ids=[f"concern-{j}" for j in range(num_high_candidates)],
                )
            ],
            candidates=[],
            total_latency_ms=50,
        )

        # No IRS signals
        irs_signals: list[IRSSignal] = []

        gate = SufficiencyGate()
        result = gate.evaluate(retrieval_result, irs_signals, policy)

        # ADEQUATE despite multiple competing HIGH candidates
        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.HIGH
        assert result.failed_coverage_gaps == []
        assert result.unresolved_signals == []


# ===========================================================================
# Property 2: Ambiguity does not itself trigger widening.
# **Validates: Requirements 4.1, 4.2**
# ===========================================================================


class TestAmbiguityDoesNotTriggerWidening:
    """Prove ambiguity alone does not trigger widening (requires_widening=False)."""

    @given(
        num_high_candidates=st.integers(min_value=2, max_value=5),
    )
    @settings(max_examples=100)
    def test_ambiguity_does_not_produce_inconclusive_sufficiency(
        self, num_high_candidates: int
    ):
        """When retrieval is ADEQUATE but identity is ambiguous, widening
        is NOT triggered. The DownstreamSeparator produces UNRESOLVED,
        but requires_widening stays False because retrieval itself is complete.
        """
        # Build adequate policy
        policy = _make_adequate_policy(required_families=["embedding_primary"])

        # Build adequate retrieval
        retrieval_result = _build_adequate_retrieval(["embedding_primary"])

        gate = SufficiencyGate()
        sufficiency = gate.evaluate(retrieval_result, [], policy)

        # Sufficiency is ADEQUATE (HIGH) regardless of candidate ambiguity
        assert sufficiency.confidence == BehavioralConfidenceBand.HIGH

        # Now pass ambiguous candidates through downstream separator
        candidates = [
            _make_candidate(concern_id=f"concern-{i}", confidence=BehavioralConfidenceBand.HIGH)
            for i in range(num_high_candidates)
        ]

        separator = DownstreamSeparator()
        decision = separator.determine_outcome(sufficiency, candidates)

        # Ambiguity produces UNRESOLVED but does NOT require widening
        assert decision.outcome == PipelineOutcome.UNRESOLVED
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.requires_widening is False
        assert decision.novelty_eligible is False


# ===========================================================================
# Property 3: Unresolved HIGH/MEDIUM IRS signals block adequacy.
# **Validates: Requirements 4.7**
# ===========================================================================


class TestUnresolvedIRSSignalsBlockAdequacy:
    """Prove unresolved HIGH/MEDIUM IRS signals always make retrieval INCONCLUSIVE."""

    @given(
        signal_type=irs_signal_type_st,
        confidence=st.sampled_from([
            BehavioralConfidenceBand.HIGH,
            BehavioralConfidenceBand.MEDIUM,
        ]),
    )
    @settings(max_examples=100)
    def test_unresolved_high_medium_signal_blocks_adequacy(
        self, signal_type: IRSSignalType, confidence: BehavioralConfidenceBand
    ):
        """Any unresolved IRS signal with confidence HIGH or MEDIUM blocks
        retrieval adequacy. The sufficiency gate MUST produce INCONCLUSIVE
        (non-HIGH confidence) when such signals are present and unresolved.
        """
        # Set up adequate policy and retrieval
        policy = _make_adequate_policy(required_families=["embedding_primary"])
        retrieval_result = _build_adequate_retrieval(["embedding_primary"])

        # Create an unresolved HIGH or MEDIUM signal
        unresolved_signal = _make_irs_signal(
            signal_type=signal_type,
            confidence=confidence,
            resolved=False,
        )

        gate = SufficiencyGate()
        result = gate.evaluate(retrieval_result, [unresolved_signal], policy)

        # Adequacy is blocked → confidence != HIGH
        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence != BehavioralConfidenceBand.HIGH
        assert len(result.unresolved_signals) > 0

    @given(
        signal_type=irs_signal_type_st,
    )
    @settings(max_examples=100)
    def test_resolved_signal_does_not_block_adequacy(
        self, signal_type: IRSSignalType
    ):
        """A RESOLVED IRS signal (even if HIGH confidence) does NOT block adequacy."""
        policy = _make_adequate_policy(required_families=["embedding_primary"])
        retrieval_result = _build_adequate_retrieval(["embedding_primary"])

        # Create a resolved signal
        resolved_signal = _make_irs_signal(
            signal_type=signal_type,
            confidence=BehavioralConfidenceBand.HIGH,
            resolved=True,
        )

        gate = SufficiencyGate()
        result = gate.evaluate(retrieval_result, [resolved_signal], policy)

        # Resolved signals don't block → ADEQUATE (HIGH)
        assert result.confidence == BehavioralConfidenceBand.HIGH

    @given(
        signal_type=irs_signal_type_st,
    )
    @settings(max_examples=100)
    def test_low_confidence_signal_does_not_block_adequacy(
        self, signal_type: IRSSignalType
    ):
        """An unresolved LOW confidence IRS signal does NOT block adequacy."""
        policy = _make_adequate_policy(required_families=["embedding_primary"])
        retrieval_result = _build_adequate_retrieval(["embedding_primary"])

        # LOW confidence signal — unresolved but not material
        low_signal = _make_irs_signal(
            signal_type=signal_type,
            confidence=BehavioralConfidenceBand.LOW,
            resolved=False,
        )

        gate = SufficiencyGate()
        result = gate.evaluate(retrieval_result, [low_signal], policy)

        # LOW confidence signals are immaterial → ADEQUATE
        assert result.confidence == BehavioralConfidenceBand.HIGH


# ===========================================================================
# Property 4: NO/PROPOSE_NEW is impossible without completed HIGH adequacy.
# **Validates: Requirements 3.6, 4.1, 4.2, 4.3, 4.4**
# ===========================================================================


class TestNoProposalWithoutHighAdequacy:
    """Prove NO/PROPOSE_NEW is impossible when sufficiency confidence != HIGH."""

    @given(
        sufficiency_confidence=st.sampled_from([
            BehavioralConfidenceBand.MEDIUM,
            BehavioralConfidenceBand.LOW,
        ]),
    )
    @settings(max_examples=100)
    def test_non_high_sufficiency_never_produces_novelty(
        self, sufficiency_confidence: BehavioralConfidenceBand
    ):
        """When sufficiency confidence is MEDIUM or LOW, the downstream
        separator must NEVER produce NO/PROPOSE_NEW or novelty_eligible=True.
        This ensures sufficiency-before-novelty is enforced.
        """
        # Build a sufficiency record with non-HIGH confidence
        sufficiency = SufficiencyRecord(
            stage_status=StageExecutionStatus.COMPLETED,
            confidence=sufficiency_confidence,
            coverage_summary="Inconclusive retrieval",
            unresolved_signals=[
                _make_irs_signal(
                    confidence=BehavioralConfidenceBand.HIGH,
                    resolved=False,
                )
            ],
            failed_coverage_gaps=["embedding_primary"],
            rationale="Test inconclusive",
        )

        # Even with NO candidates (which would normally allow novelty)
        no_candidates: list[CandidateRecord] = []

        separator = DownstreamSeparator()
        decision = separator.determine_outcome(sufficiency, no_candidates)

        # Must NOT produce NO/PROPOSE_NEW
        assert decision.outcome != PipelineOutcome.NO
        assert decision.action != ResolutionAction.PROPOSE_NEW
        assert decision.novelty_eligible is False
        assert decision.requires_widening is True

    @given(
        num_low_candidates=st.integers(min_value=0, max_value=5),
    )
    @settings(max_examples=100)
    def test_high_adequacy_with_no_plausible_candidates_allows_novelty(
        self, num_low_candidates: int
    ):
        """Conversely, when sufficiency is HIGH and no plausible candidate
        exists, NO/PROPOSE_NEW IS permitted. This proves the invariant
        by demonstrating the positive case.
        """
        # Build ADEQUATE sufficiency (HIGH confidence)
        sufficiency = SufficiencyRecord(
            stage_status=StageExecutionStatus.COMPLETED,
            confidence=BehavioralConfidenceBand.HIGH,
            coverage_summary="Adequate retrieval",
            unresolved_signals=[],
            failed_coverage_gaps=[],
            rationale="All requirements met",
        )

        # Only LOW candidates (no plausible ones)
        candidates = [
            _make_candidate(
                concern_id=f"concern-{i}",
                confidence=BehavioralConfidenceBand.LOW,
            )
            for i in range(num_low_candidates)
        ]

        separator = DownstreamSeparator()
        decision = separator.determine_outcome(sufficiency, candidates)

        # HIGH adequacy + no plausible candidate → novelty eligible
        assert decision.outcome == PipelineOutcome.NO
        assert decision.action == ResolutionAction.PROPOSE_NEW
        assert decision.novelty_eligible is True
        assert decision.requires_widening is False
