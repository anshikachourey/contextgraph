"""Tests for SharedProposalCoalescer — shared proposal coalescing logic.

Verifies:
- First packet proposing a novel concern is marked as first_proposer with is_shared=False.
- Later packets matching the same uncommitted proposal are marked is_shared=True,
  is_first_proposer=False, and NEVER return YES/ASSIGN_EXISTING.
- Both first and later packets return outcome=NO, action=PROPOSE_NEW.
- The first proposer gets an ALL_OR_NONE dependency group; later packets do not.
- All packets reference the SAME deterministic proposal (same proposed_concern_id).
- ValueError is raised for non-eligible novelty results or missing proposals.
- Unrelated packets with different proposals remain independent.

Design authority: consolidated final design.md §9.3, Task 14.2.
"""

from __future__ import annotations

import pytest

from app.sie.contracts import GraphStateContext, SemanticDependencyGroupRef
from app.sie.enums import (
    CohesionStatus,
    ParentResolutionState,
    PipelineOutcome,
    ResolutionAction,
)
from app.sie.id_generation import build_concern_key, resolve_entity_id
from app.sie.models import ConcernProposal, SemanticPacket
from app.sie.retrieval.novelty_checker import NoveltyResult
from app.sie.retrieval.provisional_overlay import ProvisionalOverlay
from app.sie.retrieval.shared_proposal_coalescer import (
    CoalescedProposalResult,
    SharedProposalCoalescer,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_packet(
    *,
    packet_id: str = "pkt-001",
    packet_creation_key: str = "req-1:partition-a",
    user_grounded_meaning: str = "User wants to learn about ML",
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


def _make_proposal(
    *,
    packet_creation_key: str = "req-1:partition-a",
) -> ConcernProposal:
    """Create a ConcernProposal derived from the given packet_creation_key."""
    concern_creation_key = build_concern_key(packet_creation_key, "novelty")
    proposed_concern_id = resolve_entity_id("concern", concern_creation_key)
    return ConcernProposal(
        concern_creation_key=concern_creation_key,
        proposed_concern_id=proposed_concern_id,
        identity_summary="User wants to learn about ML",
        display_title="User wants to learn about ML",
        initial_summary="User wants to learn about ML",
        proposed_parent_id=None,
        parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
    )


def _make_eligible_novelty_result(
    *,
    packet_creation_key: str = "req-1:partition-a",
) -> NoveltyResult:
    """Create a NoveltyResult with eligible=True and a valid proposal."""
    proposal = _make_proposal(packet_creation_key=packet_creation_key)
    return NoveltyResult(
        eligible=True,
        proposal=proposal,
        outcome=PipelineOutcome.NO,
        action=ResolutionAction.PROPOSE_NEW,
        rationale="Novelty confirmed.",
        blocked_reason=None,
    )


def _make_non_eligible_novelty_result() -> NoveltyResult:
    """Create a NoveltyResult with eligible=False."""
    return NoveltyResult(
        eligible=False,
        proposal=None,
        outcome=PipelineOutcome.UNRESOLVED,
        action=ResolutionAction.RETAIN_PENDING,
        rationale="Novelty not eligible.",
        blocked_reason="downstream not eligible",
    )


def _make_base_context() -> GraphStateContext:
    """Create a minimal GraphStateContext for the overlay."""
    return GraphStateContext(
        graph_version=1,
        snapshot_token="snap-001",
        snapshot_digest="digest-001",
        concerns=[],
        propositions=[],
        active_associations=[],
        pending_decisions=[],
        concern_embeddings=[],
        normalized_aliases=[],
        pending_identity_details=[],
        privacy_suppressed_concern_ids=[],
        packet_lineage=[],
    )


# ---------------------------------------------------------------------------
# Tests: First proposer behavior
# ---------------------------------------------------------------------------


class TestFirstProposer:
    """When a packet is the first to propose a novel concern."""

    def test_first_proposer_is_not_shared(self) -> None:
        """First proposer has is_shared=False."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        result = coalescer.coalesce_proposal(packet, overlay, novelty_result)

        assert result.is_shared is False

    def test_first_proposer_is_marked_first(self) -> None:
        """First proposer has is_first_proposer=True."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        result = coalescer.coalesce_proposal(packet, overlay, novelty_result)

        assert result.is_first_proposer is True

    def test_first_proposer_outcome_is_no(self) -> None:
        """First proposer outcome is always NO (never YES for uncommitted)."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        result = coalescer.coalesce_proposal(packet, overlay, novelty_result)

        assert result.outcome == PipelineOutcome.NO

    def test_first_proposer_action_is_propose_new(self) -> None:
        """First proposer action is always PROPOSE_NEW."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        result = coalescer.coalesce_proposal(packet, overlay, novelty_result)

        assert result.action == ResolutionAction.PROPOSE_NEW

    def test_first_proposer_has_dependency_group(self) -> None:
        """First proposer gets an ALL_OR_NONE dependency group."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        result = coalescer.coalesce_proposal(packet, overlay, novelty_result)

        assert result.dependency_group is not None
        assert result.dependency_group.failure_policy == "ALL_OR_NONE"

    def test_first_proposer_dependency_group_has_concern_mutation(self) -> None:
        """First proposer's dependency group references the concern-creation mutation."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        result = coalescer.coalesce_proposal(packet, overlay, novelty_result)

        expected_ref = f"create-concern:{novelty_result.proposal.proposed_concern_id}"
        assert expected_ref in result.dependency_group.mutation_refs

    def test_first_proposer_records_into_overlay(self) -> None:
        """First proposer records the proposal into the overlay."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        coalescer.coalesce_proposal(packet, overlay, novelty_result)

        proposed_id = novelty_result.proposal.proposed_concern_id
        assert overlay.is_already_proposed(proposed_id)

    def test_first_proposer_preserves_proposal_identity(self) -> None:
        """First proposer result contains the original proposal unchanged."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        result = coalescer.coalesce_proposal(packet, overlay, novelty_result)

        assert result.proposal == novelty_result.proposal


# ---------------------------------------------------------------------------
# Tests: Later packet (shared proposal) behavior
# ---------------------------------------------------------------------------


class TestLaterPacketSharedProposal:
    """When a later packet matches an already-proposed uncommitted concern."""

    def _setup_shared(self) -> tuple[SharedProposalCoalescer, ProvisionalOverlay, NoveltyResult]:
        """Set up a coalescer where the proposal is already recorded."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())

        # First packet proposes it
        first_packet = _make_packet(packet_id="pkt-001")
        novelty_result = _make_eligible_novelty_result()
        coalescer.coalesce_proposal(first_packet, overlay, novelty_result)

        return coalescer, overlay, novelty_result

    def test_later_packet_is_shared(self) -> None:
        """Later packet has is_shared=True."""
        coalescer, overlay, novelty_result = self._setup_shared()
        later_packet = _make_packet(packet_id="pkt-002")

        result = coalescer.coalesce_proposal(later_packet, overlay, novelty_result)

        assert result.is_shared is True

    def test_later_packet_is_not_first_proposer(self) -> None:
        """Later packet has is_first_proposer=False."""
        coalescer, overlay, novelty_result = self._setup_shared()
        later_packet = _make_packet(packet_id="pkt-002")

        result = coalescer.coalesce_proposal(later_packet, overlay, novelty_result)

        assert result.is_first_proposer is False

    def test_later_packet_never_returns_yes(self) -> None:
        """Later packet NEVER returns YES — always NO for uncommitted proposals."""
        coalescer, overlay, novelty_result = self._setup_shared()
        later_packet = _make_packet(packet_id="pkt-002")

        result = coalescer.coalesce_proposal(later_packet, overlay, novelty_result)

        assert result.outcome == PipelineOutcome.NO
        assert result.outcome != PipelineOutcome.YES

    def test_later_packet_action_is_propose_new(self) -> None:
        """Later packet action is PROPOSE_NEW, not ASSIGN_EXISTING."""
        coalescer, overlay, novelty_result = self._setup_shared()
        later_packet = _make_packet(packet_id="pkt-002")

        result = coalescer.coalesce_proposal(later_packet, overlay, novelty_result)

        assert result.action == ResolutionAction.PROPOSE_NEW
        assert result.action != ResolutionAction.ASSIGN_EXISTING

    def test_later_packet_has_no_dependency_group(self) -> None:
        """Later packet does NOT get its own dependency group (joins the existing one)."""
        coalescer, overlay, novelty_result = self._setup_shared()
        later_packet = _make_packet(packet_id="pkt-002")

        result = coalescer.coalesce_proposal(later_packet, overlay, novelty_result)

        assert result.dependency_group is None

    def test_later_packet_references_same_proposal(self) -> None:
        """Later packet references the SAME proposal as the first proposer."""
        coalescer, overlay, novelty_result = self._setup_shared()
        later_packet = _make_packet(packet_id="pkt-002")

        result = coalescer.coalesce_proposal(later_packet, overlay, novelty_result)

        assert result.proposal.proposed_concern_id == novelty_result.proposal.proposed_concern_id
        assert result.proposal.concern_creation_key == novelty_result.proposal.concern_creation_key

    def test_multiple_later_packets_all_shared(self) -> None:
        """Multiple later packets all get is_shared=True, is_first_proposer=False."""
        coalescer, overlay, novelty_result = self._setup_shared()

        for i in range(3, 6):
            later_packet = _make_packet(packet_id=f"pkt-00{i}")
            result = coalescer.coalesce_proposal(later_packet, overlay, novelty_result)
            assert result.is_shared is True
            assert result.is_first_proposer is False
            assert result.outcome == PipelineOutcome.NO
            assert result.action == ResolutionAction.PROPOSE_NEW


# ---------------------------------------------------------------------------
# Tests: Independent proposals stay separate
# ---------------------------------------------------------------------------


class TestIndependentProposals:
    """Unrelated packets with different proposals remain independent."""

    def test_different_proposals_are_both_first_proposers(self) -> None:
        """Two packets with different concern proposals are both first proposers."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())

        # First packet — one proposal
        packet_a = _make_packet(packet_id="pkt-a", packet_creation_key="req-1:partition-a")
        novelty_a = _make_eligible_novelty_result(packet_creation_key="req-1:partition-a")
        result_a = coalescer.coalesce_proposal(packet_a, overlay, novelty_a)

        # Second packet — different proposal
        packet_b = _make_packet(packet_id="pkt-b", packet_creation_key="req-1:partition-b")
        novelty_b = _make_eligible_novelty_result(packet_creation_key="req-1:partition-b")
        result_b = coalescer.coalesce_proposal(packet_b, overlay, novelty_b)

        assert result_a.is_first_proposer is True
        assert result_a.is_shared is False
        assert result_b.is_first_proposer is True
        assert result_b.is_shared is False

    def test_different_proposals_have_separate_dependency_groups(self) -> None:
        """Independent proposals get their own ALL_OR_NONE dependency groups."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())

        packet_a = _make_packet(packet_id="pkt-a", packet_creation_key="req-1:partition-a")
        novelty_a = _make_eligible_novelty_result(packet_creation_key="req-1:partition-a")
        result_a = coalescer.coalesce_proposal(packet_a, overlay, novelty_a)

        packet_b = _make_packet(packet_id="pkt-b", packet_creation_key="req-1:partition-b")
        novelty_b = _make_eligible_novelty_result(packet_creation_key="req-1:partition-b")
        result_b = coalescer.coalesce_proposal(packet_b, overlay, novelty_b)

        assert result_a.dependency_group is not None
        assert result_b.dependency_group is not None
        assert result_a.dependency_group.group_id != result_b.dependency_group.group_id

    def test_different_proposals_have_different_concern_ids(self) -> None:
        """Independent proposals produce different proposed_concern_ids."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())

        packet_a = _make_packet(packet_id="pkt-a", packet_creation_key="req-1:partition-a")
        novelty_a = _make_eligible_novelty_result(packet_creation_key="req-1:partition-a")
        result_a = coalescer.coalesce_proposal(packet_a, overlay, novelty_a)

        packet_b = _make_packet(packet_id="pkt-b", packet_creation_key="req-1:partition-b")
        novelty_b = _make_eligible_novelty_result(packet_creation_key="req-1:partition-b")
        result_b = coalescer.coalesce_proposal(packet_b, overlay, novelty_b)

        assert result_a.proposal.proposed_concern_id != result_b.proposal.proposed_concern_id


# ---------------------------------------------------------------------------
# Tests: Error cases
# ---------------------------------------------------------------------------


class TestCoalescerErrorCases:
    """Error handling for invalid inputs."""

    def test_non_eligible_novelty_raises_value_error(self) -> None:
        """ValueError if novelty_result.eligible is False."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        non_eligible = _make_non_eligible_novelty_result()

        with pytest.raises(ValueError, match="non-eligible"):
            coalescer.coalesce_proposal(packet, overlay, non_eligible)

    def test_eligible_but_no_proposal_raises_value_error(self) -> None:
        """ValueError if novelty_result.eligible is True but proposal is None."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()

        # Construct a broken NoveltyResult (eligible but no proposal)
        broken_result = NoveltyResult(
            eligible=True,
            proposal=None,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            rationale="Broken test case.",
            blocked_reason=None,
        )

        with pytest.raises(ValueError, match="proposal must not be None"):
            coalescer.coalesce_proposal(packet, overlay, broken_result)


# ---------------------------------------------------------------------------
# Tests: Determinism and consistency
# ---------------------------------------------------------------------------


class TestDeterminism:
    """Determinism properties of shared proposal coalescing."""

    def test_same_inputs_produce_same_result(self) -> None:
        """Same packet and novelty result always produce the same coalesced result."""
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        # Run twice with fresh overlays
        coalescer = SharedProposalCoalescer()
        overlay_1 = ProvisionalOverlay(_make_base_context())
        result_1 = coalescer.coalesce_proposal(packet, overlay_1, novelty_result)

        overlay_2 = ProvisionalOverlay(_make_base_context())
        result_2 = coalescer.coalesce_proposal(packet, overlay_2, novelty_result)

        assert result_1.is_shared == result_2.is_shared
        assert result_1.is_first_proposer == result_2.is_first_proposer
        assert result_1.outcome == result_2.outcome
        assert result_1.action == result_2.action
        assert result_1.proposal.proposed_concern_id == result_2.proposal.proposed_concern_id
        assert result_1.dependency_group.group_id == result_2.dependency_group.group_id

    def test_dependency_group_id_is_deterministic(self) -> None:
        """Dependency group ID is deterministic from the proposed concern ID."""
        coalescer = SharedProposalCoalescer()
        overlay = ProvisionalOverlay(_make_base_context())
        packet = _make_packet()
        novelty_result = _make_eligible_novelty_result()

        result = coalescer.coalesce_proposal(packet, overlay, novelty_result)

        expected_group_id = f"proposal-group:{novelty_result.proposal.proposed_concern_id}"
        assert result.dependency_group.group_id == expected_group_id
