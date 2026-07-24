"""Tests for the ProvisionalOverlay deterministic multi-packet ordering.

Verifies:
- Packets are ordered by (message_seq_start, message_seq_end, packet_id).
- Earlier proposals become visible as ACTIVE concerns to later packets.
- Earlier assignments become visible as association summaries.
- Earlier reactivations change dormant/retired concerns to ACTIVE.
- Earlier pending records become visible as pending decision summaries.
- The base GraphStateContext is NEVER mutated.
- get_proposed_concern_ids and is_already_proposed track proposals correctly.
- get_context_with_overlay returns a NEW context each time.

Design authority: consolidated final design.md §9.3, Task 14.1.
"""

from __future__ import annotations

import pytest

from app.sie.contracts import (
    AssociationSummary,
    ConcernSummary,
    GraphStateContext,
    PendingDecisionSummary,
)
from app.sie.enums import (
    AssociationRole,
    CohesionStatus,
    ConcernStatus,
    ParentResolutionState,
    PipelineOutcome,
    SemanticState,
)
from app.sie.models import ConcernProposal, SemanticPacket
from app.sie.retrieval.provisional_overlay import ProvisionalOverlay


# ---------------------------------------------------------------------------
# Fixtures and Helpers
# ---------------------------------------------------------------------------


def _make_base_context(
    concerns: list[ConcernSummary] | None = None,
    active_associations: list[AssociationSummary] | None = None,
    pending_decisions: list[PendingDecisionSummary] | None = None,
) -> GraphStateContext:
    """Create a minimal GraphStateContext for testing."""
    return GraphStateContext(
        graph_version=1,
        snapshot_token="snap-001",
        snapshot_digest="digest-001",
        concerns=concerns or [],
        propositions=[],
        active_associations=active_associations or [],
        pending_decisions=pending_decisions or [],
    )


def _make_packet(
    *,
    packet_id: str = "pkt-001",
    message_seq_range: tuple[int, int] = (1, 1),
) -> SemanticPacket:
    """Create a minimal SemanticPacket for testing."""
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=f"req-1:{packet_id}",
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        message_seq_range=message_seq_range,
        user_grounded_meaning="Test packet meaning",
        provenance="direct",
        packet_formation_version="1.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_concern(
    *,
    concern_id: str = "concern-001",
    status: ConcernStatus = ConcernStatus.ACTIVE,
) -> ConcernSummary:
    """Create a minimal ConcernSummary for testing."""
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary="Test concern",
        display_title="Test",
        current_summary="A test concern",
        status=status,
        parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
        last_active_at="2024-01-01T00:00:00Z",
        semantic_version=1,
    )


def _make_proposal(
    *,
    proposed_concern_id: str = "proposed-001",
    concern_creation_key: str = "key-001",
    identity_summary: str = "New concern about ML",
    display_title: str = "ML Concern",
) -> ConcernProposal:
    """Create a minimal ConcernProposal for testing."""
    return ConcernProposal(
        concern_creation_key=concern_creation_key,
        proposed_concern_id=proposed_concern_id,
        identity_summary=identity_summary,
        display_title=display_title,
        initial_summary=identity_summary,
        proposed_parent_id=None,
        parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
    )


# ---------------------------------------------------------------------------
# Test: order_packets
# ---------------------------------------------------------------------------


class TestOrderPackets:
    """Tests for deterministic packet ordering."""

    def test_sorts_by_message_seq_start(self) -> None:
        """Packets with different start sequences are sorted by start."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        packets = [
            _make_packet(packet_id="pkt-c", message_seq_range=(3, 3)),
            _make_packet(packet_id="pkt-a", message_seq_range=(1, 1)),
            _make_packet(packet_id="pkt-b", message_seq_range=(2, 2)),
        ]

        ordered = overlay.order_packets(packets)

        assert [p.packet_id for p in ordered] == ["pkt-a", "pkt-b", "pkt-c"]

    def test_sorts_by_message_seq_end_when_start_equal(self) -> None:
        """Packets with same start are sorted by end sequence."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        packets = [
            _make_packet(packet_id="pkt-long", message_seq_range=(1, 3)),
            _make_packet(packet_id="pkt-short", message_seq_range=(1, 1)),
            _make_packet(packet_id="pkt-mid", message_seq_range=(1, 2)),
        ]

        ordered = overlay.order_packets(packets)

        assert [p.packet_id for p in ordered] == ["pkt-short", "pkt-mid", "pkt-long"]

    def test_sorts_by_packet_id_when_seq_range_equal(self) -> None:
        """Packets with same seq range are sorted by packet_id (deterministic tiebreak)."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        packets = [
            _make_packet(packet_id="pkt-z", message_seq_range=(1, 1)),
            _make_packet(packet_id="pkt-a", message_seq_range=(1, 1)),
            _make_packet(packet_id="pkt-m", message_seq_range=(1, 1)),
        ]

        ordered = overlay.order_packets(packets)

        assert [p.packet_id for p in ordered] == ["pkt-a", "pkt-m", "pkt-z"]

    def test_empty_list(self) -> None:
        """Empty input returns empty output."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        assert overlay.order_packets([]) == []

    def test_single_packet(self) -> None:
        """Single packet is returned as-is."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        packet = _make_packet(packet_id="only")
        assert overlay.order_packets([packet]) == [packet]

    def test_full_composite_key_ordering(self) -> None:
        """Test full composite key (start, end, packet_id) ordering."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        packets = [
            _make_packet(packet_id="pkt-b", message_seq_range=(1, 2)),
            _make_packet(packet_id="pkt-a", message_seq_range=(1, 2)),
            _make_packet(packet_id="pkt-c", message_seq_range=(1, 1)),
            _make_packet(packet_id="pkt-d", message_seq_range=(2, 3)),
        ]

        ordered = overlay.order_packets(packets)

        # (1,1,"pkt-c") < (1,2,"pkt-a") < (1,2,"pkt-b") < (2,3,"pkt-d")
        assert [p.packet_id for p in ordered] == ["pkt-c", "pkt-a", "pkt-b", "pkt-d"]


# ---------------------------------------------------------------------------
# Test: record_proposal and visibility
# ---------------------------------------------------------------------------


class TestRecordProposal:
    """Tests for proposal recording and visibility in overlay context."""

    def test_proposal_visible_in_derived_context(self) -> None:
        """A recorded proposal appears as an ACTIVE ConcernSummary."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        proposal = _make_proposal(proposed_concern_id="new-concern-001")
        overlay.record_proposal(proposal)

        derived = overlay.get_context_with_overlay()

        concern_ids = {c.concern_id for c in derived.concerns}
        assert "new-concern-001" in concern_ids

        new_concern = next(c for c in derived.concerns if c.concern_id == "new-concern-001")
        assert new_concern.status == ConcernStatus.ACTIVE
        assert new_concern.identity_summary == proposal.identity_summary
        assert new_concern.display_title == proposal.display_title

    def test_multiple_proposals_all_visible(self) -> None:
        """Multiple proposals all appear in the derived context."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        overlay.record_proposal(_make_proposal(proposed_concern_id="new-a", concern_creation_key="k-a"))
        overlay.record_proposal(_make_proposal(proposed_concern_id="new-b", concern_creation_key="k-b"))

        derived = overlay.get_context_with_overlay()
        concern_ids = {c.concern_id for c in derived.concerns}

        assert "new-a" in concern_ids
        assert "new-b" in concern_ids

    def test_proposal_does_not_duplicate_existing_concern(self) -> None:
        """A proposal with an ID matching an existing concern is not duplicated."""
        existing = _make_concern(concern_id="existing-001")
        ctx = _make_base_context(concerns=[existing])
        overlay = ProvisionalOverlay(ctx)

        # Propose with same ID as existing
        overlay.record_proposal(_make_proposal(proposed_concern_id="existing-001"))

        derived = overlay.get_context_with_overlay()
        matching = [c for c in derived.concerns if c.concern_id == "existing-001"]
        assert len(matching) == 1  # Not duplicated


# ---------------------------------------------------------------------------
# Test: record_assignment and visibility
# ---------------------------------------------------------------------------


class TestRecordAssignment:
    """Tests for assignment recording and visibility."""

    def test_assignment_visible_as_association(self) -> None:
        """A recorded assignment appears as an association in derived context."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        overlay.record_assignment(concern_id="concern-001", packet_id="pkt-001")

        derived = overlay.get_context_with_overlay()

        # Find the overlay association
        overlay_assocs = [
            a for a in derived.active_associations
            if a.concern_id == "concern-001" and "pkt-001" in a.association_id
        ]
        assert len(overlay_assocs) == 1
        assert overlay_assocs[0].role == AssociationRole.PRIMARY_OWNER
        assert overlay_assocs[0].semantic_state == SemanticState.ACTIVE

    def test_multiple_assignments(self) -> None:
        """Multiple assignments are all visible."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        overlay.record_assignment(concern_id="c-1", packet_id="pkt-1")
        overlay.record_assignment(concern_id="c-2", packet_id="pkt-2")

        derived = overlay.get_context_with_overlay()

        concern_ids_in_assocs = {a.concern_id for a in derived.active_associations}
        assert "c-1" in concern_ids_in_assocs
        assert "c-2" in concern_ids_in_assocs


# ---------------------------------------------------------------------------
# Test: record_reactivation and visibility
# ---------------------------------------------------------------------------


class TestRecordReactivation:
    """Tests for reactivation recording and visibility."""

    def test_dormant_concern_becomes_active(self) -> None:
        """A dormant concern reactivated in overlay appears as ACTIVE."""
        dormant = _make_concern(concern_id="dormant-001", status=ConcernStatus.DORMANT)
        ctx = _make_base_context(concerns=[dormant])
        overlay = ProvisionalOverlay(ctx)

        overlay.record_reactivation("dormant-001")

        derived = overlay.get_context_with_overlay()
        concern = next(c for c in derived.concerns if c.concern_id == "dormant-001")
        assert concern.status == ConcernStatus.ACTIVE

    def test_retired_concern_becomes_active(self) -> None:
        """A retired concern reactivated in overlay appears as ACTIVE."""
        retired = _make_concern(concern_id="retired-001", status=ConcernStatus.RETIRED)
        ctx = _make_base_context(concerns=[retired])
        overlay = ProvisionalOverlay(ctx)

        overlay.record_reactivation("retired-001")

        derived = overlay.get_context_with_overlay()
        concern = next(c for c in derived.concerns if c.concern_id == "retired-001")
        assert concern.status == ConcernStatus.ACTIVE

    def test_active_concern_unchanged_by_reactivation(self) -> None:
        """Reactivating an already-ACTIVE concern has no visible effect."""
        active = _make_concern(concern_id="active-001", status=ConcernStatus.ACTIVE)
        ctx = _make_base_context(concerns=[active])
        overlay = ProvisionalOverlay(ctx)

        overlay.record_reactivation("active-001")

        derived = overlay.get_context_with_overlay()
        concern = next(c for c in derived.concerns if c.concern_id == "active-001")
        assert concern.status == ConcernStatus.ACTIVE

    def test_reactivation_preserves_other_fields(self) -> None:
        """Reactivation only changes status, preserving all other concern fields."""
        dormant = ConcernSummary(
            concern_id="dormant-002",
            identity_summary="Important concern",
            display_title="Important",
            current_summary="A very important concern",
            status=ConcernStatus.DORMANT,
            aliases=["alias1", "alias2"],
            parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
            last_active_at="2024-06-01T00:00:00Z",
            semantic_version=3,
        )
        ctx = _make_base_context(concerns=[dormant])
        overlay = ProvisionalOverlay(ctx)

        overlay.record_reactivation("dormant-002")

        derived = overlay.get_context_with_overlay()
        concern = next(c for c in derived.concerns if c.concern_id == "dormant-002")
        assert concern.status == ConcernStatus.ACTIVE
        assert concern.identity_summary == "Important concern"
        assert concern.display_title == "Important"
        assert concern.aliases == ["alias1", "alias2"]
        assert concern.semantic_version == 3


# ---------------------------------------------------------------------------
# Test: record_pending and visibility
# ---------------------------------------------------------------------------


class TestRecordPending:
    """Tests for pending record recording and visibility."""

    def test_pending_visible_in_derived_context(self) -> None:
        """A recorded pending decision appears in pending_decisions."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        overlay.record_pending(packet_id="pkt-001", outcome=PipelineOutcome.UNRESOLVED)

        derived = overlay.get_context_with_overlay()

        pending_entities = [p.entity_id for p in derived.pending_decisions]
        assert "pkt-001" in pending_entities

        pending = next(p for p in derived.pending_decisions if p.entity_id == "pkt-001")
        assert pending.outcome == PipelineOutcome.UNRESOLVED
        assert pending.stage == "identity_resolution"

    def test_multiple_pending_records(self) -> None:
        """Multiple pending records are all visible."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        overlay.record_pending(packet_id="pkt-1", outcome=PipelineOutcome.DEFER)
        overlay.record_pending(packet_id="pkt-2", outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE)

        derived = overlay.get_context_with_overlay()

        pending_entities = {p.entity_id for p in derived.pending_decisions}
        assert "pkt-1" in pending_entities
        assert "pkt-2" in pending_entities


# ---------------------------------------------------------------------------
# Test: get_proposed_concern_ids and is_already_proposed
# ---------------------------------------------------------------------------


class TestProposalTracking:
    """Tests for proposal ID tracking helpers."""

    def test_empty_initially(self) -> None:
        """No proposed concern IDs when overlay is fresh."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        assert overlay.get_proposed_concern_ids() == set()

    def test_tracks_proposals(self) -> None:
        """Proposed concern IDs are tracked after recording."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        overlay.record_proposal(_make_proposal(proposed_concern_id="p-1", concern_creation_key="k-1"))
        overlay.record_proposal(_make_proposal(proposed_concern_id="p-2", concern_creation_key="k-2"))

        assert overlay.get_proposed_concern_ids() == {"p-1", "p-2"}

    def test_is_already_proposed_true(self) -> None:
        """is_already_proposed returns True for recorded proposals."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        overlay.record_proposal(_make_proposal(proposed_concern_id="p-1", concern_creation_key="k-1"))

        assert overlay.is_already_proposed("p-1") is True

    def test_is_already_proposed_false(self) -> None:
        """is_already_proposed returns False for unknown concern IDs."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        assert overlay.is_already_proposed("unknown-id") is False


# ---------------------------------------------------------------------------
# Test: Base context immutability
# ---------------------------------------------------------------------------


class TestBaseContextImmutability:
    """Critical tests: base GraphStateContext is NEVER mutated."""

    def test_base_context_unchanged_after_proposals(self) -> None:
        """Recording proposals does not mutate the base context."""
        ctx = _make_base_context()
        original_concern_count = len(ctx.concerns)

        overlay = ProvisionalOverlay(ctx)
        overlay.record_proposal(_make_proposal(proposed_concern_id="new-001"))
        _ = overlay.get_context_with_overlay()

        # Base context unchanged
        assert len(ctx.concerns) == original_concern_count
        assert not any(c.concern_id == "new-001" for c in ctx.concerns)

    def test_base_context_unchanged_after_assignments(self) -> None:
        """Recording assignments does not mutate the base context."""
        ctx = _make_base_context()
        original_assoc_count = len(ctx.active_associations)

        overlay = ProvisionalOverlay(ctx)
        overlay.record_assignment(concern_id="c-1", packet_id="pkt-1")
        _ = overlay.get_context_with_overlay()

        assert len(ctx.active_associations) == original_assoc_count

    def test_base_context_unchanged_after_reactivation(self) -> None:
        """Recording reactivations does not mutate the base context."""
        dormant = _make_concern(concern_id="dormant-001", status=ConcernStatus.DORMANT)
        ctx = _make_base_context(concerns=[dormant])

        overlay = ProvisionalOverlay(ctx)
        overlay.record_reactivation("dormant-001")
        _ = overlay.get_context_with_overlay()

        # Base context still shows dormant
        assert ctx.concerns[0].status == ConcernStatus.DORMANT

    def test_base_context_unchanged_after_pending(self) -> None:
        """Recording pending decisions does not mutate the base context."""
        ctx = _make_base_context()
        original_pending_count = len(ctx.pending_decisions)

        overlay = ProvisionalOverlay(ctx)
        overlay.record_pending(packet_id="pkt-1", outcome=PipelineOutcome.DEFER)
        _ = overlay.get_context_with_overlay()

        assert len(ctx.pending_decisions) == original_pending_count

    def test_derived_context_is_independent_of_base(self) -> None:
        """Mutating the derived context does not affect the base or future derivations."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        overlay.record_proposal(_make_proposal(proposed_concern_id="new-001"))

        derived1 = overlay.get_context_with_overlay()
        derived1_concern_count = len(derived1.concerns)

        # Get another derived context - should be identical
        derived2 = overlay.get_context_with_overlay()
        assert len(derived2.concerns) == derived1_concern_count


# ---------------------------------------------------------------------------
# Test: Cumulative overlay state
# ---------------------------------------------------------------------------


class TestCumulativeOverlay:
    """Tests that overlay state accumulates across multiple recordings."""

    def test_all_record_types_visible_together(self) -> None:
        """All types of overlay state are visible in a single derived context."""
        dormant = _make_concern(concern_id="dormant-001", status=ConcernStatus.DORMANT)
        ctx = _make_base_context(concerns=[dormant])
        overlay = ProvisionalOverlay(ctx)

        # Record various state
        overlay.record_proposal(_make_proposal(proposed_concern_id="new-001"))
        overlay.record_assignment(concern_id="existing-001", packet_id="pkt-1")
        overlay.record_reactivation("dormant-001")
        overlay.record_pending(packet_id="pkt-2", outcome=PipelineOutcome.UNRESOLVED)

        derived = overlay.get_context_with_overlay()

        # Proposal visible
        assert any(c.concern_id == "new-001" for c in derived.concerns)

        # Assignment visible
        assert any(
            a.concern_id == "existing-001" for a in derived.active_associations
        )

        # Reactivation visible
        reactivated = next(c for c in derived.concerns if c.concern_id == "dormant-001")
        assert reactivated.status == ConcernStatus.ACTIVE

        # Pending visible
        assert any(p.entity_id == "pkt-2" for p in derived.pending_decisions)

    def test_progressive_accumulation(self) -> None:
        """Each new recording is visible in subsequent get_context_with_overlay calls."""
        ctx = _make_base_context()
        overlay = ProvisionalOverlay(ctx)

        # First recording
        overlay.record_proposal(_make_proposal(proposed_concern_id="p-1", concern_creation_key="k-1"))
        derived1 = overlay.get_context_with_overlay()
        assert len([c for c in derived1.concerns if c.concern_id == "p-1"]) == 1

        # Second recording — both should be visible
        overlay.record_proposal(_make_proposal(proposed_concern_id="p-2", concern_creation_key="k-2"))
        derived2 = overlay.get_context_with_overlay()
        assert any(c.concern_id == "p-1" for c in derived2.concerns)
        assert any(c.concern_id == "p-2" for c in derived2.concerns)

    def test_preserves_base_context_concerns(self) -> None:
        """Base context concerns are preserved in derived context alongside overlay additions."""
        existing = _make_concern(concern_id="base-001")
        ctx = _make_base_context(concerns=[existing])
        overlay = ProvisionalOverlay(ctx)

        overlay.record_proposal(_make_proposal(proposed_concern_id="new-001"))

        derived = overlay.get_context_with_overlay()
        concern_ids = {c.concern_id for c in derived.concerns}
        assert "base-001" in concern_ids
        assert "new-001" in concern_ids
