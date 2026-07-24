"""Provisional overlay for deterministic multi-packet identity resolution.

This module implements `ProvisionalOverlay`, which accumulates in-memory state
from earlier packets' resolution results and makes them visible to later packets
WITHOUT mutating the committed `GraphStateContext`.

Design authority: consolidated final design.md §9.3.

Key invariants:
- The base `GraphStateContext` is NEVER mutated.
- Packets are ordered by (message_seq_start, message_seq_end, packet_id).
- After each resolution, earlier proposals, assignments, reactivations, and
  pending records become visible to later packets through a derived context.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..contracts import (
    AssociationSummary,
    ConcernSummary,
    GraphStateContext,
    PendingDecisionSummary,
)
from ..enums import (
    AssociationRole,
    ConcernStatus,
    ParentResolutionState,
    PipelineOutcome,
    SemanticState,
)
from ..models import ConcernProposal, SemanticPacket


@dataclass
class ProvisionalOverlay:
    """Accumulates in-memory state from resolved packets for later packets.

    This overlay makes earlier proposals, assignments, reactivations, and pending
    records visible to later packets without mutating the committed context.

    Usage:
        overlay = ProvisionalOverlay(base_context)
        ordered = overlay.order_packets(packets)
        for packet in ordered:
            ctx = overlay.get_context_with_overlay()
            result = resolve(packet, ctx)
            # record results into overlay...
    """

    _base_context: GraphStateContext
    _proposals: list[ConcernProposal] = field(default_factory=list)
    _assignments: list[_AssignmentRecord] = field(default_factory=list)
    _reactivations: list[str] = field(default_factory=list)
    _pending_records: list[_PendingRecord] = field(default_factory=list)

    def __init__(self, base_context: GraphStateContext) -> None:
        """Initialize overlay with a base context that will never be mutated.

        Args:
            base_context: The committed graph state context. This is treated
                as immutable — the overlay produces derived contexts instead.
        """
        self._base_context = base_context
        self._proposals: list[ConcernProposal] = []
        self._assignments: list[_AssignmentRecord] = []
        self._reactivations: list[str] = []
        self._pending_records: list[_PendingRecord] = []

    def order_packets(self, packets: list[SemanticPacket]) -> list[SemanticPacket]:
        """Order packets deterministically by (message_seq_start, message_seq_end, packet_id).

        This ensures a stable processing order regardless of input ordering.

        Args:
            packets: Unordered list of semantic packets to process.

        Returns:
            A new list of the same packets sorted by the canonical ordering key.
        """
        return sorted(
            packets,
            key=lambda p: (p.message_seq_range[0], p.message_seq_range[1], p.packet_id),
        )

    def record_proposal(self, proposal: ConcernProposal) -> None:
        """Record a new concern proposal from an earlier packet's resolution.

        The proposal will become visible to later packets as an ACTIVE concern
        in the derived context.

        Args:
            proposal: The concern proposal to record.
        """
        self._proposals.append(proposal)

    def record_assignment(self, concern_id: str, packet_id: str) -> None:
        """Record that a packet was assigned to an existing concern.

        This makes the assignment visible to later packets through the
        overlay's association summaries.

        Args:
            concern_id: The concern ID that was assigned.
            packet_id: The packet ID that was assigned to the concern.
        """
        self._assignments.append(_AssignmentRecord(concern_id=concern_id, packet_id=packet_id))

    def record_reactivation(self, concern_id: str) -> None:
        """Record that a dormant/retired concern was reactivated.

        The concern will appear as ACTIVE in the derived context for later packets.

        Args:
            concern_id: The concern ID that was reactivated.
        """
        self._reactivations.append(concern_id)

    def record_pending(self, packet_id: str, outcome: PipelineOutcome) -> None:
        """Record that a packet's resolution resulted in a pending decision.

        The pending decision will be visible to later packets in the derived context.

        Args:
            packet_id: The packet that produced the pending decision.
            outcome: The pipeline outcome (UNRESOLVED, DEFER, etc.).
        """
        self._pending_records.append(_PendingRecord(packet_id=packet_id, outcome=outcome))

    def get_proposed_concern_ids(self) -> set[str]:
        """Return the set of all proposed concern IDs accumulated so far.

        Returns:
            Set of proposed_concern_id values from all recorded proposals.
        """
        return {p.proposed_concern_id for p in self._proposals}

    def is_already_proposed(self, concern_id: str) -> bool:
        """Check whether a concern ID has already been proposed.

        Args:
            concern_id: The concern ID to check.

        Returns:
            True if the concern_id matches any recorded proposal.
        """
        return concern_id in self.get_proposed_concern_ids()

    def get_context_with_overlay(self) -> GraphStateContext:
        """Return a NEW GraphStateContext merging base context with overlay additions.

        The base context is NEVER mutated. A new derived context is produced
        containing:
        - New proposals become ConcernSummary entries with status=ACTIVE.
        - Reactivated concerns are updated to status=ACTIVE.
        - New assignments are visible as AssociationSummary entries.
        - New pending records are visible as PendingDecisionSummary entries.

        Returns:
            A new GraphStateContext with overlay state merged in.
        """
        # Deep copy the base context's mutable lists to avoid mutation
        concerns = list(self._base_context.concerns)
        active_associations = list(self._base_context.active_associations)
        pending_decisions = list(self._base_context.pending_decisions)

        # 1. Add proposals as new ACTIVE concern summaries
        existing_concern_ids = {c.concern_id for c in concerns}
        for proposal in self._proposals:
            if proposal.proposed_concern_id not in existing_concern_ids:
                concerns.append(
                    ConcernSummary(
                        concern_id=proposal.proposed_concern_id,
                        identity_summary=proposal.identity_summary,
                        display_title=proposal.display_title,
                        current_summary=proposal.initial_summary,
                        status=ConcernStatus.ACTIVE,
                        aliases=[],
                        canonical_parent_id=proposal.proposed_parent_id,
                        parent_resolution_state=proposal.parent_resolution_state,
                        last_active_at="",  # Provisional — no committed timestamp
                        semantic_version=0,
                    )
                )
                existing_concern_ids.add(proposal.proposed_concern_id)

        # 2. Reflect reactivations — update status of dormant/retired concerns
        reactivation_set = set(self._reactivations)
        if reactivation_set:
            updated_concerns = []
            for concern in concerns:
                if concern.concern_id in reactivation_set and concern.status in (
                    ConcernStatus.DORMANT,
                    ConcernStatus.RETIRED,
                ):
                    # Create a new ConcernSummary with updated status
                    updated_concerns.append(
                        ConcernSummary(
                            concern_id=concern.concern_id,
                            identity_summary=concern.identity_summary,
                            display_title=concern.display_title,
                            current_summary=concern.current_summary,
                            status=ConcernStatus.ACTIVE,
                            merged_into_concern_id=concern.merged_into_concern_id,
                            aliases=concern.aliases,
                            canonical_parent_id=concern.canonical_parent_id,
                            parent_resolution_state=concern.parent_resolution_state,
                            last_active_at=concern.last_active_at,
                            semantic_version=concern.semantic_version,
                        )
                    )
                else:
                    updated_concerns.append(concern)
            concerns = updated_concerns

        # 3. Add assignment associations
        for assignment in self._assignments:
            active_associations.append(
                AssociationSummary(
                    association_id=f"overlay-assoc-{assignment.concern_id}-{assignment.packet_id}",
                    proposition_id=assignment.packet_id,  # Packet-level placeholder
                    concern_id=assignment.concern_id,
                    role=AssociationRole.PRIMARY_OWNER,
                    semantic_state=SemanticState.ACTIVE,
                )
            )

        # 4. Add pending decision summaries
        for pending in self._pending_records:
            pending_decisions.append(
                PendingDecisionSummary(
                    entity_id=pending.packet_id,
                    stage="identity_resolution",
                    outcome=pending.outcome,
                    rationale=None,
                )
            )

        # Construct a new GraphStateContext without mutating the base
        return GraphStateContext(
            graph_version=self._base_context.graph_version,
            snapshot_token=self._base_context.snapshot_token,
            snapshot_digest=self._base_context.snapshot_digest,
            concerns=concerns,
            propositions=list(self._base_context.propositions),
            active_associations=active_associations,
            pending_decisions=pending_decisions,
            concern_embeddings=list(self._base_context.concern_embeddings),
            normalized_aliases=list(self._base_context.normalized_aliases),
            pending_identity_details=list(self._base_context.pending_identity_details),
            privacy_suppressed_concern_ids=list(
                self._base_context.privacy_suppressed_concern_ids
            ),
            packet_lineage=list(self._base_context.packet_lineage),
        )


@dataclass(frozen=True, slots=True)
class _AssignmentRecord:
    """Internal record of a concern assignment."""

    concern_id: str
    packet_id: str


@dataclass(frozen=True, slots=True)
class _PendingRecord:
    """Internal record of a pending decision."""

    packet_id: str
    outcome: PipelineOutcome
