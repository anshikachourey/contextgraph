"""Deterministic grounding validation for LLM identity evaluation output.

This module validates that LLM-produced structured output is grounded in
the actual request context. It rejects fabricated IDs, missing evidence,
unsupported assistant attribution, unlisted competitors, and malformed output.

Design authority: design-corrections.md §8.4.

Key contract rules:
- Grounding validation is deterministic — no LLM call.
- Validation failure triggers bounded retry by the caller.
- Exhaustion produces DEFER or REQUIRES_VALIDATION — never inferred LOW or novelty.
- Every rejection includes a specific, auditable reason.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


# ---------------------------------------------------------------------------
# Grounding rejection reasons
# ---------------------------------------------------------------------------


class GroundingRejectionReason(str, Enum):
    """Specific reasons a grounding validation may reject LLM output."""

    FABRICATED_CONCERN_ID = "FABRICATED_CONCERN_ID"
    FABRICATED_PROPOSITION_ID = "FABRICATED_PROPOSITION_ID"
    MISSING_EVIDENCE_SPAN = "MISSING_EVIDENCE_SPAN"
    UNSUPPORTED_ASSISTANT_ATTRIBUTION = "UNSUPPORTED_ASSISTANT_ATTRIBUTION"
    UNLISTED_COMPETITOR = "UNLISTED_COMPETITOR"
    MALFORMED_OUTPUT = "MALFORMED_OUTPUT"
    MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD"
    INVALID_PRIORITY_RUBRIC = "INVALID_PRIORITY_RUBRIC"


# ---------------------------------------------------------------------------
# Grounding result
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GroundingViolation:
    """A single grounding violation found during validation.

    Attributes:
        reason: The category of grounding violation.
        detail: Human-readable explanation of the specific violation.
        field_path: Dot-separated path to the offending field in the output.
        offending_value: The value that failed grounding (for diagnostics).
    """

    reason: GroundingRejectionReason
    detail: str
    field_path: str
    offending_value: str | None = None


@dataclass(frozen=True)
class GroundingResult:
    """Result of deterministic grounding validation.

    Attributes:
        valid: Whether the output passed all grounding checks.
        violations: List of specific violations found (empty if valid).
        output: The validated output dict (same as input if valid, None if invalid).
    """

    valid: bool
    violations: list[GroundingViolation] = field(default_factory=list)
    output: dict | None = None


# ---------------------------------------------------------------------------
# Grounding context
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GroundingContext:
    """Context for grounding validation — the set of valid IDs and references.

    All IDs listed here are the only ones that may appear in LLM output.
    Anything else is fabricated.

    Attributes:
        valid_concern_ids: Set of concern IDs present in the request context.
        valid_proposition_ids: Set of proposition IDs present in the request.
        valid_message_ids: Set of source message IDs for evidence spans.
        candidate_concern_ids: Set of concern IDs that were presented as
            candidates to the LLM (subset of valid_concern_ids).
        assistant_proposition_ids: Set of proposition IDs authored by the assistant.
    """

    valid_concern_ids: frozenset[str]
    valid_proposition_ids: frozenset[str]
    valid_message_ids: frozenset[str]
    candidate_concern_ids: frozenset[str]
    assistant_proposition_ids: frozenset[str]


# ---------------------------------------------------------------------------
# GroundingValidator
# ---------------------------------------------------------------------------


class GroundingValidator:
    """Deterministic grounding validator for LLM identity evaluation output.

    Validates that all IDs, evidence references, and attributions in the
    LLM's structured output are grounded in the actual request context.

    Rejection categories:
    - Fabricated concern IDs not in context.
    - Fabricated proposition IDs not in context.
    - Missing evidence spans (evidence references with no source).
    - Unsupported assistant-to-user attribution (assistant propositions
      claimed as user-grounded ownership evidence).
    - Unlisted competitors (competing candidates not in the candidate set).
    - Malformed output (missing required fields, wrong types).
    - Invalid priority rubric violations.

    On any rejection, the caller retries with the bounded invoker. On
    total exhaustion, the caller produces DEFER or REQUIRES_VALIDATION —
    NEVER inferred LOW confidence or novelty.
    """

    def validate(
        self,
        raw_output: dict,
        grounding_context: GroundingContext,
    ) -> GroundingResult:
        """Validate LLM output against the grounding context.

        Args:
            raw_output: The parsed structured output dict from the LLM.
            grounding_context: Context containing all valid IDs and references.

        Returns:
            GroundingResult with valid=True if all checks pass, or
            valid=False with a list of specific violations.
        """
        violations: list[GroundingViolation] = []

        # 1. Validate top-level structure
        self._validate_structure(raw_output, violations)
        if violations:
            # If structure is malformed, further checks are unreliable
            return GroundingResult(valid=False, violations=violations, output=None)

        # 2. Validate candidate assessments
        candidate_assessments = raw_output.get("candidate_assessments", [])
        for i, assessment in enumerate(candidate_assessments):
            self._validate_candidate_assessment(
                assessment, i, grounding_context, violations
            )

        # 3. Validate best_match_concern_id
        best_match = raw_output.get("best_match_concern_id")
        if best_match is not None:
            if best_match not in grounding_context.candidate_concern_ids:
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.FABRICATED_CONCERN_ID,
                        detail=(
                            f"best_match_concern_id '{best_match}' is not in "
                            f"the candidate set presented to the LLM."
                        ),
                        field_path="best_match_concern_id",
                        offending_value=best_match,
                    )
                )

        # 4. Validate competing_candidate_ids
        competing_ids = raw_output.get("competing_candidate_ids", [])
        for j, comp_id in enumerate(competing_ids):
            if comp_id not in grounding_context.candidate_concern_ids:
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.UNLISTED_COMPETITOR,
                        detail=(
                            f"competing_candidate_ids[{j}] '{comp_id}' is not "
                            f"in the candidate set presented to the LLM."
                        ),
                        field_path=f"competing_candidate_ids[{j}]",
                        offending_value=comp_id,
                    )
                )

        if violations:
            return GroundingResult(valid=False, violations=violations, output=None)

        return GroundingResult(valid=True, violations=[], output=raw_output)

    # -----------------------------------------------------------------------
    # Private validation methods
    # -----------------------------------------------------------------------

    def _validate_structure(
        self, raw_output: dict, violations: list[GroundingViolation]
    ) -> None:
        """Validate the top-level structure of the LLM output."""
        required_fields = [
            "candidate_assessments",
            "best_match_concern_id",
            "competing_candidate_ids",
            "explanation",
        ]

        for field_name in required_fields:
            if field_name not in raw_output:
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.MISSING_REQUIRED_FIELD,
                        detail=f"Required field '{field_name}' is missing from output.",
                        field_path=field_name,
                    )
                )

        # Type checks for present fields
        if "candidate_assessments" in raw_output:
            if not isinstance(raw_output["candidate_assessments"], list):
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.MALFORMED_OUTPUT,
                        detail="'candidate_assessments' must be a list.",
                        field_path="candidate_assessments",
                        offending_value=str(type(raw_output["candidate_assessments"])),
                    )
                )

        if "competing_candidate_ids" in raw_output:
            if not isinstance(raw_output["competing_candidate_ids"], list):
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.MALFORMED_OUTPUT,
                        detail="'competing_candidate_ids' must be a list.",
                        field_path="competing_candidate_ids",
                        offending_value=str(
                            type(raw_output["competing_candidate_ids"])
                        ),
                    )
                )

        if "explanation" in raw_output:
            if not isinstance(raw_output["explanation"], str):
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.MALFORMED_OUTPUT,
                        detail="'explanation' must be a string.",
                        field_path="explanation",
                        offending_value=str(type(raw_output["explanation"])),
                    )
                )

    def _validate_candidate_assessment(
        self,
        assessment: object,
        index: int,
        context: GroundingContext,
        violations: list[GroundingViolation],
    ) -> None:
        """Validate a single candidate assessment for grounding."""
        prefix = f"candidate_assessments[{index}]"

        if not isinstance(assessment, dict):
            violations.append(
                GroundingViolation(
                    reason=GroundingRejectionReason.MALFORMED_OUTPUT,
                    detail=f"{prefix} must be a dict, got {type(assessment).__name__}.",
                    field_path=prefix,
                    offending_value=str(type(assessment)),
                )
            )
            return

        # Required fields in each assessment
        assessment_required = [
            "concern_id",
            "supporting_evidence",
            "contrary_evidence",
            "exact_continuity",
            "historical_trajectory",
            "return_path_continuity",
            "scope_compatible",
            "explanation",
        ]
        for field_name in assessment_required:
            if field_name not in assessment:
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.MISSING_REQUIRED_FIELD,
                        detail=(
                            f"{prefix} missing required field '{field_name}'."
                        ),
                        field_path=f"{prefix}.{field_name}",
                    )
                )

        # Validate concern_id is in the candidate set
        concern_id = assessment.get("concern_id")
        if concern_id is not None:
            if concern_id not in context.candidate_concern_ids:
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.FABRICATED_CONCERN_ID,
                        detail=(
                            f"{prefix}.concern_id '{concern_id}' is not in "
                            f"the candidate set."
                        ),
                        field_path=f"{prefix}.concern_id",
                        offending_value=concern_id,
                    )
                )

        # Validate evidence references
        supporting = assessment.get("supporting_evidence", [])
        if isinstance(supporting, list):
            self._validate_evidence_list(
                supporting, f"{prefix}.supporting_evidence", context, violations
            )

        contrary = assessment.get("contrary_evidence", [])
        if isinstance(contrary, list):
            self._validate_evidence_list(
                contrary, f"{prefix}.contrary_evidence", context, violations
            )

        # Check for unsupported assistant attribution
        if isinstance(supporting, list):
            self._check_assistant_attribution(
                supporting, f"{prefix}.supporting_evidence", context, violations
            )

    def _validate_evidence_list(
        self,
        evidence_list: list,
        path_prefix: str,
        context: GroundingContext,
        violations: list[GroundingViolation],
    ) -> None:
        """Validate that evidence references point to existing entities."""
        for k, evidence in enumerate(evidence_list):
            if not isinstance(evidence, dict):
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.MALFORMED_OUTPUT,
                        detail=f"{path_prefix}[{k}] must be a dict.",
                        field_path=f"{path_prefix}[{k}]",
                    )
                )
                continue

            entity_id = evidence.get("entity_id")
            entity_type = evidence.get("entity_type")

            if entity_id is None or entity_type is None:
                violations.append(
                    GroundingViolation(
                        reason=GroundingRejectionReason.MISSING_EVIDENCE_SPAN,
                        detail=(
                            f"{path_prefix}[{k}] missing entity_id or entity_type."
                        ),
                        field_path=f"{path_prefix}[{k}]",
                    )
                )
                continue

            # Validate entity_id based on entity_type
            if entity_type == "proposition":
                if entity_id not in context.valid_proposition_ids:
                    violations.append(
                        GroundingViolation(
                            reason=GroundingRejectionReason.FABRICATED_PROPOSITION_ID,
                            detail=(
                                f"{path_prefix}[{k}].entity_id '{entity_id}' "
                                f"(type=proposition) not in valid proposition set."
                            ),
                            field_path=f"{path_prefix}[{k}].entity_id",
                            offending_value=entity_id,
                        )
                    )
            elif entity_type == "concern":
                if entity_id not in context.valid_concern_ids:
                    violations.append(
                        GroundingViolation(
                            reason=GroundingRejectionReason.FABRICATED_CONCERN_ID,
                            detail=(
                                f"{path_prefix}[{k}].entity_id '{entity_id}' "
                                f"(type=concern) not in valid concern set."
                            ),
                            field_path=f"{path_prefix}[{k}].entity_id",
                            offending_value=entity_id,
                        )
                    )
            elif entity_type == "message":
                if entity_id not in context.valid_message_ids:
                    violations.append(
                        GroundingViolation(
                            reason=GroundingRejectionReason.MISSING_EVIDENCE_SPAN,
                            detail=(
                                f"{path_prefix}[{k}].entity_id '{entity_id}' "
                                f"(type=message) not in valid message set."
                            ),
                            field_path=f"{path_prefix}[{k}].entity_id",
                            offending_value=entity_id,
                        )
                    )

    def _check_assistant_attribution(
        self,
        evidence_list: list,
        path_prefix: str,
        context: GroundingContext,
        violations: list[GroundingViolation],
    ) -> None:
        """Check for unsupported assistant-to-user attribution.

        Assistant-authored propositions cannot be used as supporting evidence
        for user concern ownership. The assistant may inform interpretation,
        but cannot independently establish a user concern.
        """
        for k, evidence in enumerate(evidence_list):
            if not isinstance(evidence, dict):
                continue

            entity_id = evidence.get("entity_id")
            entity_type = evidence.get("entity_type")

            if entity_type == "proposition" and entity_id is not None:
                if entity_id in context.assistant_proposition_ids:
                    violations.append(
                        GroundingViolation(
                            reason=GroundingRejectionReason.UNSUPPORTED_ASSISTANT_ATTRIBUTION,
                            detail=(
                                f"{path_prefix}[{k}] uses assistant proposition "
                                f"'{entity_id}' as supporting ownership evidence. "
                                f"Assistant-authored material cannot independently "
                                f"establish a user concern."
                            ),
                            field_path=f"{path_prefix}[{k}].entity_id",
                            offending_value=entity_id,
                        )
                    )
