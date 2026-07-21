"""Tests for the DownstreamSeparator decision logic.

Verifies the four downstream separation paths:
- Adequate retrieval + one unique HIGH match → YES / ASSIGN_EXISTING.
- Adequate retrieval + plausible candidates but no unique owner → UNRESOLVED / RETAIN_PENDING.
- Adequate retrieval + no plausible candidate → novelty eligibility.
- Inconclusive retrieval → widening or pending; NEVER novelty.

Critical invariant:
  Inconclusive retrieval can NEVER produce novelty_eligible=True or NO/PROPOSE_NEW.

Design authority: consolidated final design.md, Requirements 2.10, 2.11, 3.5, 3.6, 4.1–4.4.
"""

from __future__ import annotations

import pytest

from app.sie.enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    PipelineOutcome,
    ResolutionAction,
    StageExecutionStatus,
)
from app.sie.identity_models import (
    CandidateRecord,
    SufficiencyRecord,
)
from app.sie.retrieval.downstream_separator import (
    DownstreamDecision,
    DownstreamSeparator,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_sufficiency(
    *,
    confidence: BehavioralConfidenceBand = BehavioralConfidenceBand.HIGH,
) -> SufficiencyRecord:
    """Create a SufficiencyRecord with the given confidence level."""
    return SufficiencyRecord(
        stage_status=StageExecutionStatus.COMPLETED,
        confidence=confidence,
        coverage_summary="Test coverage summary",
        unresolved_signals=[],
        failed_coverage_gaps=[],
        rationale="Test rationale",
    )


def _make_candidate(
    *,
    concern_id: str = "concern-1",
    confidence: BehavioralConfidenceBand = BehavioralConfidenceBand.HIGH,
    lifecycle_status: ConcernStatus = ConcernStatus.ACTIVE,
) -> CandidateRecord:
    """Create a CandidateRecord with minimal required fields."""
    return CandidateRecord(
        concern_id=concern_id,
        lifecycle_status=lifecycle_status,
        contributing_attempt_ids=["attempt-001"],
        channel_local_diagnostics=[],
        identity_evidence=[],
        contrary_evidence=[],
        confidence=confidence,
        explanation=f"Test candidate {concern_id} with {confidence.value} confidence",
    )


# ---------------------------------------------------------------------------
# Tests: Adequate retrieval + one unique HIGH match → YES / ASSIGN_EXISTING
# ---------------------------------------------------------------------------


class TestAdequateWithUniqueHighMatch:
    """Tests for adequate retrieval with exactly one HIGH candidate."""

    def test_single_high_candidate_assigns_existing(self) -> None:
        """One HIGH candidate → YES / ASSIGN_EXISTING with that concern_id."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [_make_candidate(concern_id="concern-abc", confidence=BehavioralConfidenceBand.HIGH)]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.YES
        assert decision.action == ResolutionAction.ASSIGN_EXISTING
        assert decision.matched_concern_id == "concern-abc"
        assert decision.requires_widening is False
        assert decision.novelty_eligible is False

    def test_single_high_with_low_candidates_still_assigns(self) -> None:
        """One HIGH + several LOW candidates → still YES / ASSIGN_EXISTING."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="concern-winner", confidence=BehavioralConfidenceBand.HIGH),
            _make_candidate(concern_id="concern-weak-1", confidence=BehavioralConfidenceBand.LOW),
            _make_candidate(concern_id="concern-weak-2", confidence=BehavioralConfidenceBand.LOW),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.YES
        assert decision.action == ResolutionAction.ASSIGN_EXISTING
        assert decision.matched_concern_id == "concern-winner"
        assert decision.novelty_eligible is False

    def test_single_high_with_medium_candidates_still_assigns(self) -> None:
        """One HIGH + MEDIUM candidates → YES because HIGH is uniquely actionable."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="concern-owner", confidence=BehavioralConfidenceBand.HIGH),
            _make_candidate(concern_id="concern-plausible", confidence=BehavioralConfidenceBand.MEDIUM),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        # One unique HIGH → assign even if MEDIUM competitors exist
        assert decision.outcome == PipelineOutcome.YES
        assert decision.action == ResolutionAction.ASSIGN_EXISTING
        assert decision.matched_concern_id == "concern-owner"

    def test_single_high_dormant_candidate_assigns(self) -> None:
        """One HIGH candidate that is DORMANT → still YES / ASSIGN_EXISTING."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(
                concern_id="dormant-concern",
                confidence=BehavioralConfidenceBand.HIGH,
                lifecycle_status=ConcernStatus.DORMANT,
            ),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.YES
        assert decision.matched_concern_id == "dormant-concern"


# ---------------------------------------------------------------------------
# Tests: Adequate retrieval + plausible candidates but no unique owner
# ---------------------------------------------------------------------------


class TestAdequateWithPlausibleButNoUniqueOwner:
    """Tests for adequate retrieval with ambiguous or non-actionable candidates."""

    def test_multiple_high_candidates_is_unresolved(self) -> None:
        """Multiple HIGH candidates → UNRESOLVED / RETAIN_PENDING (ambiguity)."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="concern-a", confidence=BehavioralConfidenceBand.HIGH),
            _make_candidate(concern_id="concern-b", confidence=BehavioralConfidenceBand.HIGH),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.UNRESOLVED
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.matched_concern_id is None
        assert decision.requires_widening is False
        assert decision.novelty_eligible is False

    def test_three_high_candidates_is_unresolved(self) -> None:
        """Three HIGH candidates → UNRESOLVED / RETAIN_PENDING."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="c1", confidence=BehavioralConfidenceBand.HIGH),
            _make_candidate(concern_id="c2", confidence=BehavioralConfidenceBand.HIGH),
            _make_candidate(concern_id="c3", confidence=BehavioralConfidenceBand.HIGH),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.UNRESOLVED
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.novelty_eligible is False

    def test_only_medium_candidates_is_unresolved(self) -> None:
        """Only MEDIUM candidates (no HIGH) → UNRESOLVED / RETAIN_PENDING."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="plausible-1", confidence=BehavioralConfidenceBand.MEDIUM),
            _make_candidate(concern_id="plausible-2", confidence=BehavioralConfidenceBand.MEDIUM),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.UNRESOLVED
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.matched_concern_id is None
        assert decision.novelty_eligible is False

    def test_single_medium_candidate_is_unresolved(self) -> None:
        """Single MEDIUM candidate → still UNRESOLVED (not actionable)."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="maybe", confidence=BehavioralConfidenceBand.MEDIUM),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.UNRESOLVED
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.novelty_eligible is False

    def test_medium_and_low_candidates_is_unresolved(self) -> None:
        """Mix of MEDIUM and LOW candidates → UNRESOLVED (MEDIUM is plausible)."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="c-med", confidence=BehavioralConfidenceBand.MEDIUM),
            _make_candidate(concern_id="c-low", confidence=BehavioralConfidenceBand.LOW),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.UNRESOLVED
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.novelty_eligible is False


# ---------------------------------------------------------------------------
# Tests: Adequate retrieval + no plausible candidate → novelty eligible
# ---------------------------------------------------------------------------


class TestAdequateWithNoPlausibleCandidate:
    """Tests for adequate retrieval with no plausible candidate."""

    def test_no_candidates_at_all_is_novelty_eligible(self) -> None:
        """No candidates at all → novelty_eligible=True."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates: list[CandidateRecord] = []

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.NO
        assert decision.action == ResolutionAction.PROPOSE_NEW
        assert decision.matched_concern_id is None
        assert decision.requires_widening is False
        assert decision.novelty_eligible is True

    def test_only_low_candidates_is_novelty_eligible(self) -> None:
        """Only LOW candidates → novelty_eligible=True."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="weak-1", confidence=BehavioralConfidenceBand.LOW),
            _make_candidate(concern_id="weak-2", confidence=BehavioralConfidenceBand.LOW),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.NO
        assert decision.action == ResolutionAction.PROPOSE_NEW
        assert decision.novelty_eligible is True
        assert decision.matched_concern_id is None

    def test_single_low_candidate_is_novelty_eligible(self) -> None:
        """Single LOW candidate → novelty_eligible=True (not plausible)."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [
            _make_candidate(concern_id="insufficient", confidence=BehavioralConfidenceBand.LOW),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.novelty_eligible is True
        assert decision.outcome == PipelineOutcome.NO


# ---------------------------------------------------------------------------
# Tests: Inconclusive retrieval → widening or pending; NEVER novelty
# ---------------------------------------------------------------------------


class TestInconclusiveRetrieval:
    """Tests for inconclusive retrieval — the critical invariant path."""

    def test_medium_confidence_is_inconclusive(self) -> None:
        """MEDIUM sufficiency confidence → RETRIEVAL_INCONCLUSIVE."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.MEDIUM)
        candidates: list[CandidateRecord] = []

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.matched_concern_id is None
        assert decision.requires_widening is True
        assert decision.novelty_eligible is False

    def test_low_confidence_is_inconclusive(self) -> None:
        """LOW sufficiency confidence → RETRIEVAL_INCONCLUSIVE."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.LOW)
        candidates: list[CandidateRecord] = []

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.requires_widening is True
        assert decision.novelty_eligible is False

    def test_inconclusive_with_high_candidates_still_inconclusive(self) -> None:
        """Even with HIGH candidates, inconclusive retrieval → no assignment."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.MEDIUM)
        candidates = [
            _make_candidate(concern_id="strong-match", confidence=BehavioralConfidenceBand.HIGH),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        # Critical: inconclusive retrieval means we can't trust candidates
        assert decision.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.matched_concern_id is None
        assert decision.requires_widening is True
        assert decision.novelty_eligible is False

    def test_inconclusive_never_produces_novelty(self) -> None:
        """Inconclusive retrieval + zero candidates → still NOT novelty eligible."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.LOW)
        candidates: list[CandidateRecord] = []

        decision = separator.determine_outcome(sufficiency, candidates)

        # Critical invariant: inconclusive → NEVER novelty
        assert decision.novelty_eligible is False
        assert decision.outcome != PipelineOutcome.NO
        assert decision.action != ResolutionAction.PROPOSE_NEW

    def test_inconclusive_never_produces_assign(self) -> None:
        """Inconclusive retrieval + multiple HIGH → still not ASSIGN_EXISTING."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.LOW)
        candidates = [
            _make_candidate(concern_id="c1", confidence=BehavioralConfidenceBand.HIGH),
            _make_candidate(concern_id="c2", confidence=BehavioralConfidenceBand.HIGH),
        ]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert decision.action == ResolutionAction.RETAIN_PENDING
        assert decision.matched_concern_id is None


# ---------------------------------------------------------------------------
# Tests: DownstreamDecision dataclass
# ---------------------------------------------------------------------------


class TestDownstreamDecisionDataclass:
    """Tests for the DownstreamDecision frozen dataclass."""

    def test_decision_is_frozen(self) -> None:
        """DownstreamDecision instances are immutable."""
        decision = DownstreamDecision(
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            matched_concern_id="c-1",
            requires_widening=False,
            novelty_eligible=False,
            rationale="Test",
        )
        with pytest.raises(AttributeError):
            decision.outcome = PipelineOutcome.NO  # type: ignore[misc]

    def test_decision_equality(self) -> None:
        """Two decisions with same fields are equal."""
        d1 = DownstreamDecision(
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            matched_concern_id=None,
            requires_widening=False,
            novelty_eligible=False,
            rationale="Ambiguity",
        )
        d2 = DownstreamDecision(
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            matched_concern_id=None,
            requires_widening=False,
            novelty_eligible=False,
            rationale="Ambiguity",
        )
        assert d1 == d2

    def test_decision_rationale_present(self) -> None:
        """Every decision includes a human-readable rationale."""
        separator = DownstreamSeparator()
        sufficiency = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)
        candidates = [_make_candidate(concern_id="c-1", confidence=BehavioralConfidenceBand.HIGH)]

        decision = separator.determine_outcome(sufficiency, candidates)

        assert decision.rationale
        assert len(decision.rationale) > 0
