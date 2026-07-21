"""Downstream separation logic for SIE identity resolution.

This module implements `DownstreamSeparator`, which determines the pipeline
outcome based on the combination of retrieval sufficiency and candidate
evaluation results.

Design authority: consolidated final design.md.

Decision matrix:
┌───────────────────────────────┬────────────────────────────────────────────────┐
│ Sufficiency confidence        │ Downstream decision                            │
├───────────────────────────────┼────────────────────────────────────────────────┤
│ != HIGH (inconclusive)        │ RETRIEVAL_INCONCLUSIVE / RETAIN_PENDING        │
│                               │   requires_widening=True, never novelty        │
├───────────────────────────────┼────────────────────────────────────────────────┤
│ HIGH (adequate) + 1 HIGH      │ YES / ASSIGN_EXISTING                          │
│ candidate                     │   matched to that concern                      │
├───────────────────────────────┼────────────────────────────────────────────────┤
│ HIGH (adequate) + >1 HIGH     │ UNRESOLVED / RETAIN_PENDING                    │
│ candidates                    │   identity ambiguity                           │
├───────────────────────────────┼────────────────────────────────────────────────┤
│ HIGH (adequate) + 0 HIGH      │ UNRESOLVED / RETAIN_PENDING                    │
│ but some MEDIUM               │   plausible but not actionable                 │
├───────────────────────────────┼────────────────────────────────────────────────┤
│ HIGH (adequate) + no          │ novelty_eligible=True                          │
│ plausible candidates          │   downstream novelty check proceeds            │
└───────────────────────────────┴────────────────────────────────────────────────┘

Critical invariant:
  Inconclusive retrieval → NEVER NO/PROPOSE_NEW, NEVER novelty_eligible.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..enums import (
    BehavioralConfidenceBand,
    PipelineOutcome,
    ResolutionAction,
)
from ..identity_models import CandidateRecord, SufficiencyRecord


@dataclass(frozen=True, slots=True)
class DownstreamDecision:
    """Result of downstream separation logic.

    Fields:
        outcome: The pipeline outcome determined by separation logic.
        action: The resolution action to take.
        matched_concern_id: The concern ID assigned when outcome is YES.
        requires_widening: Whether retrieval should be widened before proceeding.
        novelty_eligible: Whether the packet is eligible for novelty checking.
        rationale: Human-readable explanation of the decision.
    """

    outcome: PipelineOutcome
    action: ResolutionAction
    matched_concern_id: str | None
    requires_widening: bool
    novelty_eligible: bool
    rationale: str


class DownstreamSeparator:
    """Determines pipeline outcome from sufficiency and candidate evaluation.

    This component explicitly separates the downstream paths after
    retrieval-sufficiency assessment and candidate evaluation, ensuring
    the critical invariant: inconclusive retrieval can NEVER produce
    novelty eligibility or NO/PROPOSE_NEW.
    """

    def determine_outcome(
        self,
        sufficiency: SufficiencyRecord,
        candidates: list[CandidateRecord],
    ) -> DownstreamDecision:
        """Determine the downstream pipeline outcome.

        Args:
            sufficiency: The retrieval-sufficiency assessment result.
                confidence == HIGH means retrieval is adequate.
                confidence == MEDIUM or LOW means retrieval is inconclusive.
            candidates: Evaluated identity candidates with confidence bands.

        Returns:
            A DownstreamDecision encoding the outcome, action, and eligibility.
        """
        # --- Path A: Inconclusive retrieval (confidence != HIGH) ---
        if sufficiency.confidence != BehavioralConfidenceBand.HIGH:
            return DownstreamDecision(
                outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                requires_widening=True,
                novelty_eligible=False,
                rationale=(
                    "Retrieval is inconclusive "
                    f"(confidence={sufficiency.confidence.value if sufficiency.confidence else 'None'}). "
                    "Widening required; novelty is not permitted."
                ),
            )

        # --- Path B: Adequate retrieval (confidence == HIGH) ---
        high_candidates = [
            c for c in candidates
            if c.confidence == BehavioralConfidenceBand.HIGH
        ]
        medium_candidates = [
            c for c in candidates
            if c.confidence == BehavioralConfidenceBand.MEDIUM
        ]

        # B1: Exactly one HIGH candidate → YES / ASSIGN_EXISTING
        if len(high_candidates) == 1:
            matched = high_candidates[0]
            return DownstreamDecision(
                outcome=PipelineOutcome.YES,
                action=ResolutionAction.ASSIGN_EXISTING,
                matched_concern_id=matched.concern_id,
                requires_widening=False,
                novelty_eligible=False,
                rationale=(
                    f"Adequate retrieval with one uniquely actionable HIGH match: "
                    f"concern '{matched.concern_id}'. Assigning existing concern."
                ),
            )

        # B2: Multiple HIGH candidates → UNRESOLVED / RETAIN_PENDING (ambiguity)
        if len(high_candidates) > 1:
            competing_ids = [c.concern_id for c in high_candidates]
            return DownstreamDecision(
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=False,
                rationale=(
                    f"Adequate retrieval but identity ambiguity: "
                    f"{len(high_candidates)} HIGH candidates compete "
                    f"({', '.join(competing_ids)}). Cannot assign unique owner."
                ),
            )

        # B3: No HIGH candidates but some MEDIUM → UNRESOLVED / RETAIN_PENDING
        if medium_candidates:
            plausible_ids = [c.concern_id for c in medium_candidates]
            return DownstreamDecision(
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=False,
                rationale=(
                    f"Adequate retrieval with plausible but non-actionable candidates: "
                    f"{len(medium_candidates)} MEDIUM "
                    f"({', '.join(plausible_ids)}). "
                    "No unique owner; retaining pending."
                ),
            )

        # B4: No plausible candidates (all LOW or none) → novelty eligible
        return DownstreamDecision(
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            matched_concern_id=None,
            requires_widening=False,
            novelty_eligible=True,
            rationale=(
                "Adequate retrieval with no plausible candidate "
                f"({len(candidates)} candidates, all LOW or absent). "
                "Packet is eligible for novelty checking."
            ),
        )
