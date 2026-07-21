"""Reusable validation functions for identity-resolution invariants.

This module provides validators that enforce the discriminated-result semantics
and stage-status/confidence coupling rules defined by the SIE identity-resolution
design:

1. Stage-status/confidence coupling:
   - COMPLETED requires non-null confidence (HIGH, MEDIUM, or LOW).
   - NOT_RUN and FAILED require null confidence.
   - A stage that did not execute never receives a fabricated confidence band.

2. Outcome-specific stage requirements:
   - YES/ASSIGN_EXISTING requires identity_stage_status=COMPLETED
     and identity_confidence=HIGH.
   - NO/PROPOSE_NEW requires sufficiency_stage_status=COMPLETED
     and sufficiency_confidence=HIGH.

3. Discriminated result invariant:
   - YES/ASSIGN_EXISTING: matched_concern_id IS NOT NULL,
     new_concern_proposal IS NULL.
   - NO/PROPOSE_NEW: matched_concern_id IS NULL,
     new_concern_proposal IS NOT NULL.
   - Pending outcomes (UNRESOLVED, DEFER, RETRIEVAL_INCONCLUSIVE,
     REQUIRES_VALIDATION): both IS NULL.

These validators can be imported and composed into Pydantic model_validators
on the IdentityResolutionRecord or IdentityResolutionResult models.
"""

from __future__ import annotations

from typing import Optional

from .enums import (
    BehavioralConfidenceBand,
    PipelineOutcome,
    ResolutionAction,
    StageExecutionStatus,
)


# ---------------------------------------------------------------------------
# Outcome → action canonical mapping
# ---------------------------------------------------------------------------

_OUTCOME_ACTION_MAP: dict[PipelineOutcome, set[ResolutionAction]] = {
    PipelineOutcome.YES: {ResolutionAction.ASSIGN_EXISTING},
    PipelineOutcome.NO: {ResolutionAction.PROPOSE_NEW},
    PipelineOutcome.UNRESOLVED: {ResolutionAction.RETAIN_PENDING},
    PipelineOutcome.DEFER: {ResolutionAction.RETAIN_PENDING, ResolutionAction.NONE},
    PipelineOutcome.RETRIEVAL_INCONCLUSIVE: {ResolutionAction.RETAIN_PENDING},
    PipelineOutcome.REQUIRES_VALIDATION: {
        ResolutionAction.RETAIN_PENDING,
        ResolutionAction.NONE,
    },
}

# Pending outcomes: neither matched nor proposed concern IDs are present.
PENDING_OUTCOMES: frozenset[PipelineOutcome] = frozenset(
    {
        PipelineOutcome.UNRESOLVED,
        PipelineOutcome.DEFER,
        PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
        PipelineOutcome.REQUIRES_VALIDATION,
    }
)


# ---------------------------------------------------------------------------
# Stage-status / confidence coupling
# ---------------------------------------------------------------------------


def validate_stage_confidence_coupling(
    stage_status: StageExecutionStatus,
    confidence: Optional[BehavioralConfidenceBand],
    *,
    stage_name: str = "stage",
) -> None:
    """Validate that stage execution status and confidence are consistent.

    Rules:
    - COMPLETED requires a non-null confidence band (HIGH, MEDIUM, or LOW).
    - NOT_RUN and FAILED require null confidence.

    Raises:
        ValueError: If the coupling invariant is violated.
    """
    if stage_status == StageExecutionStatus.COMPLETED:
        if confidence is None:
            raise ValueError(
                f"{stage_name} has status COMPLETED but confidence is null. "
                f"A completed stage must report a confidence band."
            )
    else:
        # NOT_RUN or FAILED
        if confidence is not None:
            raise ValueError(
                f"{stage_name} has status {stage_status.value} but confidence "
                f"is {confidence.value}. A stage that did not complete "
                f"must not have a fabricated confidence band."
            )


# ---------------------------------------------------------------------------
# Discriminated result invariant (outcome ↔ concern IDs)
# ---------------------------------------------------------------------------


def validate_discriminated_result(
    outcome: PipelineOutcome,
    matched_concern_id: Optional[str],
    new_concern_proposal_present: bool,
) -> None:
    """Validate the discriminated-result invariant for outcome/concern-ID coupling.

    Rules:
    - YES/ASSIGN_EXISTING: matched_concern_id IS NOT NULL,
      new_concern_proposal IS NULL.
    - NO/PROPOSE_NEW: matched_concern_id IS NULL,
      new_concern_proposal IS NOT NULL.
    - Pending outcomes: both IS NULL.

    Args:
        outcome: The pipeline outcome.
        matched_concern_id: The matched existing concern ID (or None).
        new_concern_proposal_present: Whether a new concern proposal is set.

    Raises:
        ValueError: If the invariant is violated.
    """
    has_match = matched_concern_id is not None
    has_proposal = new_concern_proposal_present

    if outcome == PipelineOutcome.YES:
        # YES/ASSIGN_EXISTING: exactly one matched concern, no proposal
        if not has_match:
            raise ValueError(
                "Outcome YES/ASSIGN_EXISTING requires matched_concern_id "
                "to be set (one committed matched concern)."
            )
        if has_proposal:
            raise ValueError(
                "Outcome YES/ASSIGN_EXISTING must not have "
                "new_concern_proposal set."
            )

    elif outcome == PipelineOutcome.NO:
        # NO/PROPOSE_NEW: exactly one proposal, no match
        if has_match:
            raise ValueError(
                "Outcome NO/PROPOSE_NEW must not have "
                "matched_concern_id set."
            )
        if not has_proposal:
            raise ValueError(
                "Outcome NO/PROPOSE_NEW requires new_concern_proposal "
                "to be set (one proposed concern)."
            )

    else:
        # Pending outcomes: neither matched nor proposed
        if has_match:
            raise ValueError(
                f"Outcome {outcome.value} (pending) must not have "
                f"matched_concern_id set."
            )
        if has_proposal:
            raise ValueError(
                f"Outcome {outcome.value} (pending) must not have "
                f"new_concern_proposal set."
            )


# ---------------------------------------------------------------------------
# Outcome-specific stage requirements
# ---------------------------------------------------------------------------


def validate_outcome_stage_requirements(
    outcome: PipelineOutcome,
    identity_stage_status: StageExecutionStatus,
    identity_confidence: Optional[BehavioralConfidenceBand],
    sufficiency_stage_status: StageExecutionStatus,
    sufficiency_confidence: Optional[BehavioralConfidenceBand],
) -> None:
    """Validate that stage statuses and confidences meet outcome requirements.

    Rules:
    - YES/ASSIGN_EXISTING requires identity_stage_status=COMPLETED
      and identity_confidence=HIGH.
    - NO/PROPOSE_NEW requires sufficiency_stage_status=COMPLETED
      and sufficiency_confidence=HIGH.

    This function does NOT validate stage-confidence coupling independently;
    call validate_stage_confidence_coupling separately for each stage.

    Raises:
        ValueError: If the outcome's stage requirements are not met.
    """
    if outcome == PipelineOutcome.YES:
        if identity_stage_status != StageExecutionStatus.COMPLETED:
            raise ValueError(
                "Outcome YES/ASSIGN_EXISTING requires "
                "identity_stage_status=COMPLETED, "
                f"got {identity_stage_status.value}."
            )
        if identity_confidence != BehavioralConfidenceBand.HIGH:
            raise ValueError(
                "Outcome YES/ASSIGN_EXISTING requires "
                "identity_confidence=HIGH, "
                f"got {identity_confidence.value if identity_confidence else 'None'}."
            )

    elif outcome == PipelineOutcome.NO:
        if sufficiency_stage_status != StageExecutionStatus.COMPLETED:
            raise ValueError(
                "Outcome NO/PROPOSE_NEW requires "
                "sufficiency_stage_status=COMPLETED, "
                f"got {sufficiency_stage_status.value}."
            )
        if sufficiency_confidence != BehavioralConfidenceBand.HIGH:
            raise ValueError(
                "Outcome NO/PROPOSE_NEW requires "
                "sufficiency_confidence=HIGH, "
                f"got {sufficiency_confidence.value if sufficiency_confidence else 'None'}."
            )
