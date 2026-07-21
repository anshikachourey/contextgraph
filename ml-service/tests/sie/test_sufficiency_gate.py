"""Tests for the SufficiencyGate retrieval-sufficiency evaluator.

Verifies:
- All families covered → ADEQUATE (HIGH confidence).
- Missing required family → INCONCLUSIVE.
- Unresolved HIGH IRS signal → INCONCLUSIVE.
- SUCCESS_EMPTY counts as successful coverage.
- ERROR does not count as successful coverage.
- Identity ambiguity (multiple candidates) does NOT affect sufficiency.
- Failed coverage blocking (failure_blocks_no_match) causes INCONCLUSIVE.
- stage_status is always COMPLETED (gate always renders a judgment).

Design authority: design-corrections.md §7.2.
"""

from __future__ import annotations

import pytest

from app.sie.enums import (
    BehavioralConfidenceBand,
    IRSSignalType,
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
    ChannelFamilyRequirement,
    RetrievalPolicy,
)
from app.sie.retrieval.channel_protocol import RetrievalResult
from app.sie.retrieval.sufficiency_gate import SufficiencyGate


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
            EvidenceReference(entity_id="ev-1", entity_type="proposition")
        ],
        explanation="Test signal",
        resolved=resolved,
        resolved_by_attempt_ids=["attempt-x"] if resolved else [],
    )


def _make_policy(
    *,
    families: dict[str, ChannelFamilyRequirement] | None = None,
) -> RetrievalPolicy:
    """Create a minimal RetrievalPolicy for testing."""
    if families is None:
        families = {
            "embedding_primary": ChannelFamilyRequirement(
                required_for_adequacy=True,
                min_successful_attempts=1,
                failure_blocks_no_match=True,
            ),
        }
    return RetrievalPolicy(
        policy_version="1.0.0",
        initial_channels=[],
        channel_family_requirements=families,
        irs_signal_channel_mapping={},
    )


# ---------------------------------------------------------------------------
# Tests: ADEQUATE outcome
# ---------------------------------------------------------------------------


class TestAdequateOutcome:
    """Tests verifying retrieval evaluates as ADEQUATE."""

    def test_all_required_families_covered_is_adequate(self) -> None:
        """When all required families have enough successful attempts → ADEQUATE."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                    candidate_ids=["concern-1"],
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.stage_status == StageExecutionStatus.COMPLETED
        assert record.confidence == BehavioralConfidenceBand.HIGH
        assert record.failed_coverage_gaps == []
        assert record.unresolved_signals == []
        assert "ADEQUATE" in record.rationale

    def test_success_empty_counts_as_successful(self) -> None:
        """SUCCESS_EMPTY contributes to coverage adequacy."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.confidence == BehavioralConfidenceBand.HIGH
        assert record.failed_coverage_gaps == []

    def test_multiple_families_all_covered(self) -> None:
        """Multiple required families all covered → ADEQUATE."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    attempt_id="a1",
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
                _make_attempt(
                    attempt_id="a2",
                    channel_id="alias_v1",
                    channel_family="alias_normalized",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=20,
        )
        policy = _make_policy(
            families={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=False,
                ),
                "alias_normalized": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=False,
                ),
            }
        )

        record = gate.evaluate(result, [], policy)

        assert record.confidence == BehavioralConfidenceBand.HIGH

    def test_resolved_irs_signals_do_not_block(self) -> None:
        """Resolved HIGH/MEDIUM IRS signals do not block adequacy."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        signals = [
            _make_irs_signal(
                confidence=BehavioralConfidenceBand.HIGH,
                resolved=True,
            ),
        ]
        policy = _make_policy()

        record = gate.evaluate(result, signals, policy)

        assert record.confidence == BehavioralConfidenceBand.HIGH
        assert record.unresolved_signals == []

    def test_non_required_family_failure_does_not_block(self) -> None:
        """Failure in a non-required family does not block adequacy."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    attempt_id="a1",
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
                _make_attempt(
                    attempt_id="a2",
                    channel_id="dormant_v1",
                    channel_family="dormant_scan",
                    status=RetrievalAttemptStatus.ERROR,
                ),
            ],
            candidates=[],
            total_latency_ms=20,
        )
        policy = _make_policy(
            families={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=True,
                ),
                "dormant_scan": ChannelFamilyRequirement(
                    required_for_adequacy=False,
                    min_successful_attempts=0,
                    failure_blocks_no_match=False,
                ),
            }
        )

        record = gate.evaluate(result, [], policy)

        assert record.confidence == BehavioralConfidenceBand.HIGH


# ---------------------------------------------------------------------------
# Tests: INCONCLUSIVE outcome
# ---------------------------------------------------------------------------


class TestInconclusiveOutcome:
    """Tests verifying retrieval evaluates as INCONCLUSIVE."""

    def test_missing_required_family_is_inconclusive(self) -> None:
        """No attempts for a required family → INCONCLUSIVE."""
        gate = SufficiencyGate()

        # No attempts at all for embedding_primary
        result = RetrievalResult(
            attempts=[],
            candidates=[],
            total_latency_ms=0,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.stage_status == StageExecutionStatus.COMPLETED
        assert record.confidence in (
            BehavioralConfidenceBand.MEDIUM,
            BehavioralConfidenceBand.LOW,
        )
        assert "embedding_primary" in record.failed_coverage_gaps
        assert "INCONCLUSIVE" in record.rationale

    def test_insufficient_successful_attempts_is_inconclusive(self) -> None:
        """Not enough successful attempts for a family → INCONCLUSIVE."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        # Requires 2 successful attempts
        policy = _make_policy(
            families={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=2,
                    failure_blocks_no_match=True,
                ),
            }
        )

        record = gate.evaluate(result, [], policy)

        assert record.confidence in (
            BehavioralConfidenceBand.MEDIUM,
            BehavioralConfidenceBand.LOW,
        )
        assert "embedding_primary" in record.failed_coverage_gaps

    def test_unresolved_high_irs_signal_blocks_adequacy(self) -> None:
        """Unresolved HIGH-confidence IRS signal → INCONCLUSIVE."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        signals = [
            _make_irs_signal(
                signal_type=IRSSignalType.HISTORICAL_REFERENT,
                confidence=BehavioralConfidenceBand.HIGH,
                resolved=False,
            ),
        ]
        policy = _make_policy()

        record = gate.evaluate(result, signals, policy)

        assert record.confidence == BehavioralConfidenceBand.LOW
        assert len(record.unresolved_signals) == 1
        assert record.unresolved_signals[0].signal_type == IRSSignalType.HISTORICAL_REFERENT

    def test_unresolved_medium_irs_signal_blocks_adequacy(self) -> None:
        """Unresolved MEDIUM-confidence IRS signal → INCONCLUSIVE."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        signals = [
            _make_irs_signal(
                confidence=BehavioralConfidenceBand.MEDIUM,
                resolved=False,
            ),
        ]
        policy = _make_policy()

        record = gate.evaluate(result, signals, policy)

        assert record.confidence in (
            BehavioralConfidenceBand.MEDIUM,
            BehavioralConfidenceBand.LOW,
        )
        assert len(record.unresolved_signals) == 1

    def test_low_confidence_irs_signal_does_not_block(self) -> None:
        """Unresolved LOW-confidence IRS signal does NOT block adequacy."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        signals = [
            _make_irs_signal(
                confidence=BehavioralConfidenceBand.LOW,
                resolved=False,
            ),
        ]
        policy = _make_policy()

        record = gate.evaluate(result, signals, policy)

        # LOW confidence IRS signals are not material and don't block
        assert record.confidence == BehavioralConfidenceBand.HIGH
        assert record.unresolved_signals == []

    def test_error_does_not_count_as_successful(self) -> None:
        """ERROR attempts do not contribute to coverage adequacy."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.ERROR,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.confidence in (
            BehavioralConfidenceBand.MEDIUM,
            BehavioralConfidenceBand.LOW,
        )
        assert "embedding_primary" in record.failed_coverage_gaps

    def test_timeout_does_not_count_as_successful(self) -> None:
        """TIMEOUT attempts do not contribute to coverage adequacy."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.TIMEOUT,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.confidence != BehavioralConfidenceBand.HIGH
        assert "embedding_primary" in record.failed_coverage_gaps

    def test_unavailable_does_not_count_as_successful(self) -> None:
        """UNAVAILABLE attempts do not contribute to coverage adequacy."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.UNAVAILABLE,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.confidence != BehavioralConfidenceBand.HIGH

    def test_skipped_does_not_count_as_successful(self) -> None:
        """SKIPPED_WITH_REASON attempts do not contribute to coverage adequacy."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SKIPPED_WITH_REASON,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.confidence != BehavioralConfidenceBand.HIGH

    def test_failure_blocks_no_match_with_no_success(self) -> None:
        """Family with failure_blocks_no_match and only errors → material gap."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    attempt_id="a1",
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
                _make_attempt(
                    attempt_id="a2",
                    channel_id="alias_v1",
                    channel_family="alias_normalized",
                    status=RetrievalAttemptStatus.ERROR,
                ),
            ],
            candidates=[],
            total_latency_ms=20,
        )
        policy = _make_policy(
            families={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=False,
                ),
                "alias_normalized": ChannelFamilyRequirement(
                    required_for_adequacy=False,
                    min_successful_attempts=0,
                    failure_blocks_no_match=True,
                ),
            }
        )

        record = gate.evaluate(result, [], policy)

        # alias_normalized has failure_blocks_no_match=True and only ERROR
        assert record.confidence != BehavioralConfidenceBand.HIGH
        assert "alias_normalized" in record.failed_coverage_gaps

    def test_failure_blocks_no_match_with_success_is_ok(self) -> None:
        """Family with failure_blocks_no_match but also a success → no material gap."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    attempt_id="a1",
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
                _make_attempt(
                    attempt_id="a2",
                    channel_id="alias_v1",
                    channel_family="alias_normalized",
                    status=RetrievalAttemptStatus.ERROR,
                ),
                _make_attempt(
                    attempt_id="a3",
                    channel_id="alias_v1",
                    channel_family="alias_normalized",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=30,
        )
        policy = _make_policy(
            families={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=False,
                ),
                "alias_normalized": ChannelFamilyRequirement(
                    required_for_adequacy=False,
                    min_successful_attempts=0,
                    failure_blocks_no_match=True,
                ),
            }
        )

        record = gate.evaluate(result, [], policy)

        # alias_normalized has a success alongside the error → no material gap
        assert record.confidence == BehavioralConfidenceBand.HIGH
        assert "alias_normalized" not in record.failed_coverage_gaps


# ---------------------------------------------------------------------------
# Tests: Identity ambiguity does NOT affect sufficiency
# ---------------------------------------------------------------------------


class TestIdentityAmbiguityIndependence:
    """Tests proving identity ambiguity does not affect retrieval sufficiency."""

    def test_multiple_candidates_does_not_affect_sufficiency(self) -> None:
        """Multiple competing candidates do NOT make retrieval INCONCLUSIVE."""
        gate = SufficiencyGate()

        # Multiple candidates from successful retrieval
        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                    candidate_ids=["concern-1", "concern-2", "concern-3"],
                ),
            ],
            candidates=[
                CandidateRecord(
                    concern_id="concern-1",
                    lifecycle_status="ACTIVE",
                    contributing_attempt_ids=["attempt-001"],
                    channel_local_diagnostics=[],
                    identity_evidence=[],
                    contrary_evidence=[],
                    confidence=BehavioralConfidenceBand.HIGH,
                    explanation="Strong match",
                ),
                CandidateRecord(
                    concern_id="concern-2",
                    lifecycle_status="ACTIVE",
                    contributing_attempt_ids=["attempt-001"],
                    channel_local_diagnostics=[],
                    identity_evidence=[],
                    contrary_evidence=[],
                    confidence=BehavioralConfidenceBand.HIGH,
                    explanation="Also strong match — ambiguous!",
                ),
                CandidateRecord(
                    concern_id="concern-3",
                    lifecycle_status="DORMANT",
                    contributing_attempt_ids=["attempt-001"],
                    channel_local_diagnostics=[],
                    identity_evidence=[],
                    contrary_evidence=[],
                    confidence=BehavioralConfidenceBand.MEDIUM,
                    explanation="Moderate match",
                ),
            ],
            total_latency_ms=50,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        # Identity ambiguity is irrelevant to retrieval sufficiency
        assert record.confidence == BehavioralConfidenceBand.HIGH
        assert record.failed_coverage_gaps == []
        assert record.unresolved_signals == []

    def test_zero_candidates_with_good_coverage_is_adequate(self) -> None:
        """Zero candidates but full coverage → ADEQUATE (empty means no match)."""
        gate = SufficiencyGate()

        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.confidence == BehavioralConfidenceBand.HIGH


# ---------------------------------------------------------------------------
# Tests: stage_status always COMPLETED
# ---------------------------------------------------------------------------


class TestStageStatus:
    """Tests verifying the gate always produces COMPLETED status."""

    def test_adequate_has_completed_status(self) -> None:
        """ADEQUATE outcome has stage_status=COMPLETED."""
        gate = SufficiencyGate()
        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.stage_status == StageExecutionStatus.COMPLETED

    def test_inconclusive_has_completed_status(self) -> None:
        """INCONCLUSIVE outcome also has stage_status=COMPLETED."""
        gate = SufficiencyGate()
        result = RetrievalResult(attempts=[], candidates=[], total_latency_ms=0)
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert record.stage_status == StageExecutionStatus.COMPLETED
        assert record.confidence is not None  # COMPLETED requires non-null confidence


# ---------------------------------------------------------------------------
# Tests: Coverage summary
# ---------------------------------------------------------------------------


class TestCoverageSummary:
    """Tests verifying coverage summary content."""

    def test_adequate_summary_contains_adequate(self) -> None:
        """Coverage summary for adequate result mentions ADEQUATE."""
        gate = SufficiencyGate()
        result = RetrievalResult(
            attempts=[
                _make_attempt(
                    channel_family="embedding_primary",
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                ),
            ],
            candidates=[],
            total_latency_ms=10,
        )
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert "ADEQUATE" in record.coverage_summary

    def test_inconclusive_summary_contains_inconclusive(self) -> None:
        """Coverage summary for inconclusive result mentions INCONCLUSIVE."""
        gate = SufficiencyGate()
        result = RetrievalResult(attempts=[], candidates=[], total_latency_ms=0)
        policy = _make_policy()

        record = gate.evaluate(result, [], policy)

        assert "INCONCLUSIVE" in record.coverage_summary
