"""Fail-closed novelty eligibility checker for SIE identity resolution.

This module implements `NoveltyChecker`, which determines whether a semantic
packet qualifies as a genuinely novel concern. It enforces a strict fail-closed
policy: missing retention data or incomplete preconditions always DENY novelty,
never silently skip.

Novelty preconditions (all must hold):
1. DownstreamDecision.novelty_eligible == True (adequate retrieval, no plausible match).
2. At least one proposition in the packet has INDEPENDENT_CONCERN_CANDIDATE retention.
3. All propositions have non-empty retention_levels (complete retention data).

When novelty is confirmed, the checker emits NO/PROPOSE_NEW with a ConcernProposal
whose IDs are derived from canonical semantic request identity (packet_creation_key),
never from raw request_id or transport metadata.

Parent is always None / PARENT_DEFERRED — hierarchy is never inferred here.

Design authority: consolidated final design.md.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..enums import (
    ParentResolutionState,
    PipelineOutcome,
    ResolutionAction,
    RetentionLevel,
)
from ..id_generation import build_concern_key, resolve_entity_id
from ..models import ConcernProposal, Proposition, SemanticPacket
from .downstream_separator import DownstreamDecision


@dataclass(frozen=True, slots=True)
class NoveltyResult:
    """Result of the novelty eligibility check.

    Fields:
        eligible: Whether novelty was confirmed (all preconditions passed).
        proposal: The concern proposal if eligible, None otherwise.
        outcome: Pipeline outcome — NO if novelty, or the upstream decision's
            outcome/DEFER/UNRESOLVED if blocked.
        action: Resolution action — PROPOSE_NEW if novelty, or the upstream
            decision's action/RETAIN_PENDING/NONE if blocked.
        rationale: Human-readable explanation of the decision.
        blocked_reason: Why novelty was denied, if not eligible. None if eligible.
    """

    eligible: bool
    proposal: ConcernProposal | None
    outcome: PipelineOutcome
    action: ResolutionAction
    rationale: str
    blocked_reason: str | None


class NoveltyChecker:
    """Fail-closed novelty eligibility checker.

    Determines whether a semantic packet qualifies for concern creation
    after downstream separation has flagged it as novelty-eligible.

    Critical rules:
    - Missing retention detail DENIES novelty (fail closed).
    - Concern proposal IDs derive from canonical semantic request identity
      (packet_creation_key + "novelty"), never raw request or idempotency IDs.
    - Parent is always None / PARENT_DEFERRED.
    """

    def check_novelty(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        downstream_decision: DownstreamDecision,
        request_id: str,
    ) -> NoveltyResult:
        """Check whether the packet qualifies for novel concern creation.

        Args:
            packet: The concern-cohesive semantic packet being resolved.
            propositions: All propositions belonging to this packet.
            downstream_decision: The result from DownstreamSeparator.
            request_id: The processing request ID (transport metadata; NOT used
                in creation key generation per canonical semantic identity rules).

        Returns:
            NoveltyResult encoding the eligibility decision, concern proposal
            (if eligible), and rationale.
        """
        # --- Gate 1: Downstream must have flagged novelty_eligible ---
        if not downstream_decision.novelty_eligible:
            return NoveltyResult(
                eligible=False,
                proposal=None,
                outcome=downstream_decision.outcome,
                action=downstream_decision.action,
                rationale=(
                    "Novelty not eligible: downstream decision does not permit "
                    f"novelty (outcome={downstream_decision.outcome.value}, "
                    f"action={downstream_decision.action.value})."
                ),
                blocked_reason=None,
            )

        # --- Gate 2: All propositions must have complete retention data ---
        # Missing retention detail DENIES novelty (fail closed).
        for prop in propositions:
            if not prop.retention_levels:
                return NoveltyResult(
                    eligible=False,
                    proposal=None,
                    outcome=PipelineOutcome.DEFER,
                    action=ResolutionAction.NONE,
                    rationale=(
                        f"Novelty denied (fail-closed): proposition "
                        f"'{prop.proposition_id}' has empty retention_levels. "
                        "Missing retention detail blocks novelty determination."
                    ),
                    blocked_reason="missing retention detail",
                )

        # --- Gate 3: At least one INDEPENDENT_CONCERN_CANDIDATE ---
        has_independent_candidate = any(
            RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE in prop.retention_levels
            for prop in propositions
        )

        if not has_independent_candidate:
            return NoveltyResult(
                eligible=False,
                proposal=None,
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                rationale=(
                    "Novelty denied: no proposition in the packet has "
                    "INDEPENDENT_CONCERN_CANDIDATE retention level. "
                    "Packet retained pending further evidence."
                ),
                blocked_reason=(
                    "no INDEPENDENT_CONCERN_CANDIDATE retention level found"
                ),
            )

        # --- All preconditions pass: emit NO / PROPOSE_NEW ---
        # Generate concern proposal ID from canonical semantic request identity.
        # Uses packet_creation_key + "novelty" — never raw request_id.
        concern_creation_key = build_concern_key(
            packet.packet_creation_key, "novelty"
        )
        proposed_concern_id = resolve_entity_id("concern", concern_creation_key)

        # Display title: first 50 chars of user_grounded_meaning.
        display_title = packet.user_grounded_meaning[:50]

        proposal = ConcernProposal(
            concern_creation_key=concern_creation_key,
            proposed_concern_id=proposed_concern_id,
            identity_summary=packet.user_grounded_meaning,
            display_title=display_title,
            initial_summary=packet.user_grounded_meaning,
            proposed_parent_id=None,
            parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
        )

        return NoveltyResult(
            eligible=True,
            proposal=proposal,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            rationale=(
                "Novelty confirmed: adequate retrieval with no plausible match, "
                "INDEPENDENT_CONCERN_CANDIDATE retention present, all propositions "
                "have complete retention data. Proposing new concern "
                f"'{proposed_concern_id}'."
            ),
            blocked_reason=None,
        )
