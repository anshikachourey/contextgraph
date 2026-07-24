"""Proposition-detail validation for SIE identity resolution.

This module implements `PropositionDetailValidator`, which enforces that every
proposition associated with a packet has complete detail required for identity
resolution. Missing detail blocks the entire packet dependency group with
DEFER or REQUIRES_VALIDATION — never silently skips.

Validation checks (ALL must pass):
1. At least one proposition must be associated with the packet.
2. Every proposition must have non-empty `speaker_role`.
3. Every proposition must have non-empty `retention_levels` (complete retention data).
4. Every proposition must have valid `provenance` (not empty/null).
5. Every proposition must have non-empty `proposition_id` and `proposition_creation_key`.
6. Every proposition must have non-empty `source_message_ids`.

Design authority: consolidated final design.md, Task 12.1.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..enums import PipelineOutcome, ResolutionAction
from ..models import Proposition, SemanticPacket


@dataclass(frozen=True, slots=True)
class PropositionValidationResult:
    """Result of proposition-detail validation for a packet.

    Fields:
        valid: True if all propositions pass all checks.
        outcome: DEFER if invalid, None if valid.
        action: NONE if invalid, None if valid.
        missing_fields: Descriptive list of what's missing.
        rationale: Human-readable explanation of the result.
    """

    valid: bool
    outcome: PipelineOutcome | None
    action: ResolutionAction | None
    missing_fields: list[str] = field(default_factory=list)
    rationale: str = ""


class PropositionDetailValidator:
    """Validates that packet propositions have complete detail for identity resolution.

    Critical rule: Missing detail BLOCKS the entire packet dependency group.
    Never silently skip a proposition with incomplete data.
    """

    def validate_packet_propositions(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
    ) -> PropositionValidationResult:
        """Validate that all propositions for a packet have required detail.

        Args:
            packet: The semantic packet being validated.
            propositions: All propositions associated with this packet.

        Returns:
            PropositionValidationResult with valid=True if all checks pass,
            or valid=False with DEFER outcome and descriptive missing_fields
            if any check fails.
        """
        missing_fields: list[str] = []

        # Check 1: At least one proposition must be associated with the packet
        if not propositions:
            missing_fields.append(
                f"packet '{packet.packet_id}': no propositions associated"
            )
            return self._build_failure(missing_fields)

        # Checks 2–6: Validate each proposition
        for prop in propositions:
            # Check 5a: Non-empty proposition_id
            if not prop.proposition_id or not prop.proposition_id.strip():
                missing_fields.append(
                    f"proposition in packet '{packet.packet_id}': "
                    "empty proposition_id"
                )

            # Check 5b: Non-empty proposition_creation_key
            if not prop.proposition_creation_key or not prop.proposition_creation_key.strip():
                missing_fields.append(
                    f"proposition '{prop.proposition_id}' in packet "
                    f"'{packet.packet_id}': empty proposition_creation_key"
                )

            # Check 2: Non-empty speaker_role
            if not prop.speaker_role or not prop.speaker_role.strip():
                missing_fields.append(
                    f"proposition '{prop.proposition_id}' in packet "
                    f"'{packet.packet_id}': empty speaker_role"
                )

            # Check 3: Non-empty retention_levels (complete retention data)
            if not prop.retention_levels:
                missing_fields.append(
                    f"proposition '{prop.proposition_id}' in packet "
                    f"'{packet.packet_id}': empty retention_levels"
                )

            # Check 4: Valid provenance (not empty/null)
            # provenance is a PropositionProvenance enum, but we check for
            # falsy/empty string defensively
            if not prop.provenance:
                missing_fields.append(
                    f"proposition '{prop.proposition_id}' in packet "
                    f"'{packet.packet_id}': empty provenance"
                )

            # Check 6: Non-empty source_message_ids
            if not prop.source_message_ids:
                missing_fields.append(
                    f"proposition '{prop.proposition_id}' in packet "
                    f"'{packet.packet_id}': empty source_message_ids"
                )

        if missing_fields:
            return self._build_failure(missing_fields)

        return PropositionValidationResult(
            valid=True,
            outcome=None,
            action=None,
            missing_fields=[],
            rationale=(
                f"All {len(propositions)} proposition(s) in packet "
                f"'{packet.packet_id}' have complete detail: speaker_role, "
                "retention_levels, provenance, stable IDs, and source_message_ids."
            ),
        )

    def _build_failure(
        self, missing_fields: list[str]
    ) -> PropositionValidationResult:
        """Build a failure result that blocks the entire packet."""
        rationale = (
            "Proposition detail validation FAILED — entire packet dependency "
            "group is blocked. Missing detail: "
            + "; ".join(missing_fields)
            + ". Never silently skip propositions with incomplete data."
        )
        return PropositionValidationResult(
            valid=False,
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.NONE,
            missing_fields=missing_fields,
            rationale=rationale,
        )
