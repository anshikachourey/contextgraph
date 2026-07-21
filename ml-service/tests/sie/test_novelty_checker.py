"""Tests for the NoveltyChecker fail-closed novelty eligibility logic.

Verifies:
- Novelty is denied when downstream_decision.novelty_eligible is False.
- Novelty is denied (fail-closed) when any proposition has empty retention_levels.
- Novelty is denied when no INDEPENDENT_CONCERN_CANDIDATE retention level exists.
- Novelty is confirmed when all preconditions pass.
- Concern proposal IDs derive from canonical semantic identity (packet_creation_key),
  never from raw request_id or transport metadata.
- Parent is always None / PARENT_DEFERRED.
- Display title is first 50 chars of user_grounded_meaning.

Design authority: consolidated final design.md, Task 11.1.
"""

from __future__ import annotations

import pytest

from app.sie.enums import (
    CohesionStatus,
    ParentResolutionState,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    ResolutionAction,
    RetentionLevel,
    SemanticState,
)
from app.sie.id_generation import build_concern_key, resolve_entity_id
from app.sie.models import ConcernProposal, Proposition, SemanticPacket
from app.sie.retrieval.downstream_separator import DownstreamDecision
from app.sie.retrieval.novelty_checker import NoveltyChecker, NoveltyResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_packet(
    *,
    packet_id: str = "pkt-001",
    packet_creation_key: str = "req-1:partition-a",
    user_grounded_meaning: str = "User wants to learn about machine learning fundamentals",
) -> SemanticPacket:
    """Create a minimal SemanticPacket for testing."""
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=packet_creation_key,
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        message_seq_range=(1, 1),
        user_grounded_meaning=user_grounded_meaning,
        provenance="direct",
        packet_formation_version="1.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_proposition(
    *,
    proposition_id: str = "prop-001",
    retention_levels: list[RetentionLevel] | None = None,
) -> Proposition:
    """Create a Proposition with configurable retention_levels."""
    if retention_levels is None:
        retention_levels = [RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE]
    return Proposition(
        proposition_id=proposition_id,
        proposition_creation_key=f"req-1:{proposition_id}",
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        speaker_role="USER",
        canonical_meaning="I want to learn about ML",
        proposition_type=PropositionType.GOAL,
        message_seq_range=(1, 1),
        provenance=PropositionProvenance.DIRECT,
        semantic_state=SemanticState.ACTIVE,
        retention_levels=retention_levels,
        created_at="2024-01-01T00:00:00Z",
        extraction_version="1.0",
    )


def _novelty_eligible_decision() -> DownstreamDecision:
    """Create a DownstreamDecision where novelty_eligible=True."""
    return DownstreamDecision(
        outcome=PipelineOutcome.NO,
        action=ResolutionAction.PROPOSE_NEW,
        matched_concern_id=None,
        requires_widening=False,
        novelty_eligible=True,
        rationale="No plausible candidate; novelty eligible.",
    )


def _non_novelty_decision(
    *,
    outcome: PipelineOutcome = PipelineOutcome.YES,
    action: ResolutionAction = ResolutionAction.ASSIGN_EXISTING,
) -> DownstreamDecision:
    """Create a DownstreamDecision where novelty_eligible=False."""
    return DownstreamDecision(
        outcome=outcome,
        action=action,
        matched_concern_id="concern-existing",
        requires_widening=False,
        novelty_eligible=False,
        rationale="Matched existing concern.",
    )


# ---------------------------------------------------------------------------
# Tests: Gate 1 — downstream_decision.novelty_eligible is False
# ---------------------------------------------------------------------------


class TestNoveltyNotEligibleFromDownstream:
    """When novelty_eligible=False, novelty checker passes through downstream outcome."""

    def test_yes_assign_existing_passes_through(self) -> None:
        """YES/ASSIGN_EXISTING from downstream → not eligible, pass through."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [_make_proposition()]
        decision = _non_novelty_decision(
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
        )

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is False
        assert result.proposal is None
        assert result.outcome == PipelineOutcome.YES
        assert result.action == ResolutionAction.ASSIGN_EXISTING
        assert result.blocked_reason is None

    def test_unresolved_retain_pending_passes_through(self) -> None:
        """UNRESOLVED/RETAIN_PENDING from downstream → not eligible, pass through."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [_make_proposition()]
        decision = _non_novelty_decision(
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
        )

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is False
        assert result.outcome == PipelineOutcome.UNRESOLVED
        assert result.action == ResolutionAction.RETAIN_PENDING

    def test_retrieval_inconclusive_passes_through(self) -> None:
        """RETRIEVAL_INCONCLUSIVE from downstream → not eligible, pass through."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [_make_proposition()]
        decision = DownstreamDecision(
            outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            action=ResolutionAction.RETAIN_PENDING,
            matched_concern_id=None,
            requires_widening=True,
            novelty_eligible=False,
            rationale="Retrieval inconclusive.",
        )

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is False
        assert result.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert result.action == ResolutionAction.RETAIN_PENDING


# ---------------------------------------------------------------------------
# Tests: Gate 2 — missing retention detail (fail-closed)
# ---------------------------------------------------------------------------


class TestMissingRetentionDetailDeniesNovelty:
    """Missing retention_levels on any proposition DENIES novelty (fail-closed)."""

    def test_single_proposition_empty_retention(self) -> None:
        """One proposition with empty retention_levels → DEFER/NONE."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [_make_proposition(retention_levels=[])]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert result.blocked_reason == "missing retention detail"
        assert result.proposal is None

    def test_mixed_propositions_one_missing_retention(self) -> None:
        """If ANY proposition has empty retention → fail-closed."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="prop-good",
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
            _make_proposition(
                proposition_id="prop-bad",
                retention_levels=[],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert result.blocked_reason == "missing retention detail"
        assert "prop-bad" in result.rationale

    def test_all_propositions_empty_retention(self) -> None:
        """All propositions have empty retention → fail-closed on first."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [
            _make_proposition(proposition_id="p1", retention_levels=[]),
            _make_proposition(proposition_id="p2", retention_levels=[]),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is False
        assert result.blocked_reason == "missing retention detail"


# ---------------------------------------------------------------------------
# Tests: Gate 3 — no INDEPENDENT_CONCERN_CANDIDATE
# ---------------------------------------------------------------------------


class TestNoIndependentConcernCandidate:
    """Novelty denied when no proposition has INDEPENDENT_CONCERN_CANDIDATE."""

    def test_all_supporting_evidence_only(self) -> None:
        """Propositions with only SUPPORTING_EVIDENCE → not eligible."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="p1",
                retention_levels=[RetentionLevel.SUPPORTING_EVIDENCE],
            ),
            _make_proposition(
                proposition_id="p2",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is False
        assert result.outcome == PipelineOutcome.UNRESOLVED
        assert result.action == ResolutionAction.RETAIN_PENDING
        assert "INDEPENDENT_CONCERN_CANDIDATE" in result.blocked_reason

    def test_context_only_and_discard(self) -> None:
        """Context-only and discard levels → not eligible for novelty."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="p1",
                retention_levels=[RetentionLevel.CONTEXT_ONLY],
            ),
            _make_proposition(
                proposition_id="p2",
                retention_levels=[RetentionLevel.DISCARD],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is False
        assert result.outcome == PipelineOutcome.UNRESOLVED
        assert result.action == ResolutionAction.RETAIN_PENDING


# ---------------------------------------------------------------------------
# Tests: All preconditions pass → NO / PROPOSE_NEW
# ---------------------------------------------------------------------------


class TestNoveltyConfirmed:
    """When all preconditions pass, novelty is confirmed with a ConcernProposal."""

    def test_basic_novelty_confirmed(self) -> None:
        """Single proposition with INDEPENDENT_CONCERN_CANDIDATE → novelty."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is True
        assert result.outcome == PipelineOutcome.NO
        assert result.action == ResolutionAction.PROPOSE_NEW
        assert result.blocked_reason is None
        assert result.proposal is not None

    def test_proposal_has_correct_creation_key(self) -> None:
        """Concern creation key uses packet_creation_key + 'novelty'."""
        checker = NoveltyChecker()
        pkt_key = "req-1:partition-a"
        packet = _make_packet(packet_creation_key=pkt_key)
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-transport-999")

        expected_key = build_concern_key(pkt_key, "novelty")
        assert result.proposal is not None
        assert result.proposal.concern_creation_key == expected_key

    def test_proposal_id_is_deterministic(self) -> None:
        """Proposed concern ID is deterministically resolved from creation key."""
        checker = NoveltyChecker()
        pkt_key = "req-1:partition-a"
        packet = _make_packet(packet_creation_key=pkt_key)
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result1 = checker.check_novelty(packet, propositions, decision, "req-1")
        result2 = checker.check_novelty(packet, propositions, decision, "req-2")

        # Same packet_creation_key → same proposed_concern_id regardless of request_id
        assert result1.proposal is not None
        assert result2.proposal is not None
        assert result1.proposal.proposed_concern_id == result2.proposal.proposed_concern_id

    def test_request_id_excluded_from_creation_key(self) -> None:
        """Raw request_id must NOT influence the concern creation key."""
        checker = NoveltyChecker()
        pkt_key = "req-1:partition-a"
        packet = _make_packet(packet_creation_key=pkt_key)
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result_a = checker.check_novelty(packet, propositions, decision, "transport-id-aaa")
        result_b = checker.check_novelty(packet, propositions, decision, "transport-id-bbb")

        # Different request_ids produce same key (request_id not in key)
        assert result_a.proposal.concern_creation_key == result_b.proposal.concern_creation_key
        assert result_a.proposal.proposed_concern_id == result_b.proposal.proposed_concern_id

    def test_proposal_resolved_entity_id_matches(self) -> None:
        """proposed_concern_id matches resolve_entity_id('concern', creation_key)."""
        checker = NoveltyChecker()
        pkt_key = "req-1:partition-a"
        packet = _make_packet(packet_creation_key=pkt_key)
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        expected_key = build_concern_key(pkt_key, "novelty")
        expected_id = resolve_entity_id("concern", expected_key)
        assert result.proposal.proposed_concern_id == expected_id

    def test_proposal_parent_is_none_and_deferred(self) -> None:
        """Parent is always None / PARENT_DEFERRED — no hierarchy inferred."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.proposal.proposed_parent_id is None
        assert result.proposal.parent_resolution_state == ParentResolutionState.PARENT_DEFERRED

    def test_proposal_identity_summary_from_packet(self) -> None:
        """identity_summary and initial_summary come from user_grounded_meaning."""
        checker = NoveltyChecker()
        meaning = "User wants to learn about machine learning fundamentals"
        packet = _make_packet(user_grounded_meaning=meaning)
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.proposal.identity_summary == meaning
        assert result.proposal.initial_summary == meaning

    def test_proposal_display_title_truncated_to_50(self) -> None:
        """display_title is first 50 chars of user_grounded_meaning."""
        checker = NoveltyChecker()
        long_meaning = "A" * 100  # 100 chars
        packet = _make_packet(user_grounded_meaning=long_meaning)
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.proposal.display_title == "A" * 50
        assert len(result.proposal.display_title) == 50

    def test_proposal_display_title_short_meaning_not_truncated(self) -> None:
        """Short user_grounded_meaning is not truncated."""
        checker = NoveltyChecker()
        short_meaning = "Learn ML"
        packet = _make_packet(user_grounded_meaning=short_meaning)
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.proposal.display_title == short_meaning

    def test_multiple_propositions_one_independent(self) -> None:
        """Multiple propositions, one with INDEPENDENT_CONCERN_CANDIDATE → eligible."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="p1",
                retention_levels=[RetentionLevel.SUPPORTING_EVIDENCE],
            ),
            _make_proposition(
                proposition_id="p2",
                retention_levels=[
                    RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE,
                    RetentionLevel.DURABLE_PROPOSITION,
                ],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is True
        assert result.outcome == PipelineOutcome.NO
        assert result.action == ResolutionAction.PROPOSE_NEW

    def test_multiple_independent_propositions(self) -> None:
        """Multiple INDEPENDENT_CONCERN_CANDIDATE propositions → still eligible."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="p1",
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
            _make_proposition(
                proposition_id="p2",
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
            ),
        ]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.eligible is True


# ---------------------------------------------------------------------------
# Tests: NoveltyResult dataclass
# ---------------------------------------------------------------------------


class TestNoveltyResultDataclass:
    """Tests for the NoveltyResult frozen dataclass."""

    def test_result_is_frozen(self) -> None:
        """NoveltyResult instances are immutable."""
        result = NoveltyResult(
            eligible=False,
            proposal=None,
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.NONE,
            rationale="Test",
            blocked_reason="test reason",
        )
        with pytest.raises(AttributeError):
            result.eligible = True  # type: ignore[misc]

    def test_result_equality(self) -> None:
        """Two results with same fields are equal."""
        r1 = NoveltyResult(
            eligible=False,
            proposal=None,
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            rationale="No ICC",
            blocked_reason="no INDEPENDENT_CONCERN_CANDIDATE",
        )
        r2 = NoveltyResult(
            eligible=False,
            proposal=None,
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            rationale="No ICC",
            blocked_reason="no INDEPENDENT_CONCERN_CANDIDATE",
        )
        assert r1 == r2

    def test_rationale_always_present(self) -> None:
        """Every NoveltyResult has a non-empty rationale."""
        checker = NoveltyChecker()
        packet = _make_packet()
        propositions = [_make_proposition()]
        decision = _novelty_eligible_decision()

        result = checker.check_novelty(packet, propositions, decision, "req-123")

        assert result.rationale
        assert len(result.rationale) > 0
