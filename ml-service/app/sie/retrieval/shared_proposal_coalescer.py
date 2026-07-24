"""Shared proposal coalescing for deterministic multi-packet identity resolution.

This module implements `SharedProposalCoalescer`, which ensures that when multiple
packets in a single request resolve to the same novel concern, only one concern-creation
mutation is emitted. Later packets reference the shared proposal without duplicating it.

Design authority: consolidated final design.md §9.3.

Key invariants:
- A later packet matching an uncommitted proposal NEVER returns YES/ASSIGN_EXISTING.
- It returns NO/PROPOSE_NEW with the SAME deterministic proposal_id.
- The concern-creation mutation is emitted ONCE by the first proposer.
- All dependent associations from every contributing packet reference the shared proposal.
- All dependent mutations from the first proposer belong to one ALL_OR_NONE group.
- Independent packet groups remain semantically separate.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..contracts import SemanticDependencyGroupRef
from ..enums import PipelineOutcome, ResolutionAction
from ..id_generation import resolve_entity_id
from ..models import ConcernProposal, SemanticPacket
from .novelty_checker import NoveltyResult
from .provisional_overlay import ProvisionalOverlay


@dataclass(frozen=True, slots=True)
class CoalescedProposalResult:
    """Result of shared proposal coalescing for a single packet.

    Attributes:
        is_shared: True if this packet references an already-proposed concern
            (i.e., another earlier packet in this request already proposed it).
        proposal: The (potentially shared) concern proposal. All packets that
            resolve to the same novel concern reference this same proposal.
        outcome: Always PipelineOutcome.NO — novel concerns never return YES.
        action: Always ResolutionAction.PROPOSE_NEW — the packet proposes
            (or joins) a new concern.
        is_first_proposer: True if this packet created the proposal and owns
            the concern-creation mutation. False for later packets that join
            an existing shared proposal.
        dependency_group: The ALL_OR_NONE dependency group for the first proposer.
            None for later packets (they add associations to the existing group).
    """

    is_shared: bool
    proposal: ConcernProposal
    outcome: PipelineOutcome
    action: ResolutionAction
    is_first_proposer: bool
    dependency_group: SemanticDependencyGroupRef | None


class SharedProposalCoalescer:
    """Coalesces shared proposals across multiple packets in one request.

    When multiple packets in the same request independently resolve to the same
    novel concern (via deterministic ID generation from packet_creation_key),
    this coalescer ensures:

    1. The first packet is the "first proposer" — it creates the proposal and
       owns the concern-creation mutation.
    2. Later packets reference the SAME proposal without creating duplicate
       mutations. They return NO/PROPOSE_NEW (never YES/ASSIGN_EXISTING)
       because the proposal is uncommitted.
    3. The first proposer's dependency group uses ALL_OR_NONE failure policy.
    4. All packets reference the same deterministic proposed_concern_id.

    Critical rules (from design §9.3):
    - A later packet matching an uncommitted proposal NEVER returns
      YES/ASSIGN_EXISTING.
    - It returns NO/PROPOSE_NEW with the SAME deterministic proposal_id.
    - The final ProcessResult contains the concern-creation mutation only ONCE.
    """

    def coalesce_proposal(
        self,
        packet: SemanticPacket,
        overlay: ProvisionalOverlay,
        novelty_result: NoveltyResult,
    ) -> CoalescedProposalResult:
        """Coalesce a novelty result against the current overlay state.

        Determines whether this packet is the first proposer of a novel concern
        or a later packet joining an existing uncommitted proposal.

        Args:
            packet: The semantic packet being resolved.
            overlay: The provisional overlay tracking earlier proposals in this
                request. Used to check if the proposal already exists.
            novelty_result: The result from NoveltyChecker. Must have
                eligible=True and a non-None proposal.

        Returns:
            CoalescedProposalResult indicating whether this is a shared or
            first proposal, with the appropriate dependency group.

        Raises:
            ValueError: If novelty_result is not eligible or has no proposal.
        """
        if not novelty_result.eligible:
            raise ValueError(
                "Cannot coalesce a non-eligible novelty result. "
                "novelty_result.eligible must be True."
            )
        if novelty_result.proposal is None:
            raise ValueError(
                "Cannot coalesce without a proposal. "
                "novelty_result.proposal must not be None."
            )

        proposal = novelty_result.proposal
        proposed_concern_id = proposal.proposed_concern_id

        # Check if this concern has already been proposed by an earlier packet
        already_proposed = overlay.is_already_proposed(proposed_concern_id)

        if already_proposed:
            # Later packet: references existing shared proposal, does NOT own
            # the concern-creation mutation. No new dependency group needed.
            return CoalescedProposalResult(
                is_shared=True,
                proposal=proposal,
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                is_first_proposer=False,
                dependency_group=None,
            )
        else:
            # First proposer: record proposal into overlay and build the
            # ALL_OR_NONE dependency group for atomic concern creation.
            overlay.record_proposal(proposal)

            # Build the dependency group with ALL_OR_NONE policy.
            # The group_id is deterministic from the proposed concern ID.
            group_id = _build_dependency_group_id(proposed_concern_id)

            # Mutation refs: the concern-creation mutation reference.
            # Additional association mutations are added by the caller.
            concern_mutation_ref = f"create-concern:{proposed_concern_id}"

            dependency_group = SemanticDependencyGroupRef(
                group_id=group_id,
                mutation_refs=[concern_mutation_ref],
                failure_policy="ALL_OR_NONE",
            )

            return CoalescedProposalResult(
                is_shared=False,
                proposal=proposal,
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                is_first_proposer=True,
                dependency_group=dependency_group,
            )


def _build_dependency_group_id(proposed_concern_id: str) -> str:
    """Build a deterministic dependency group ID from the proposed concern ID.

    The group ID is derived using the entity ID resolution mechanism to ensure
    determinism and collision avoidance across different proposals.

    Args:
        proposed_concern_id: The deterministic concern ID from the proposal.

    Returns:
        A deterministic group ID string.
    """
    return f"proposal-group:{proposed_concern_id}"
