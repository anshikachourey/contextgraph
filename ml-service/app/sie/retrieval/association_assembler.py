"""Multi-role association assembly for SIE identity resolution.

This module implements `AssociationAssembler`, which creates every applicable
normalized association role for propositions in a packet rather than selecting
one winning role.

Key rules (design §11, Task 12.2):
- User propositions may receive PRIMARY_OWNER, SUPPORTING_EVIDENCE, and
  EMERGENCE_EVIDENCE according to their retained roles.
- Retention-to-role mapping for USER propositions:
    DURABLE_PROPOSITION or INDEPENDENT_CONCERN_CANDIDATE → PRIMARY_OWNER
    SUPPORTING_EVIDENCE → SUPPORTING_EVIDENCE
    EMERGENCE_EVIDENCE → EMERGENCE_EVIDENCE
- One proposition MAY receive multiple roles (e.g., PRIMARY_OWNER + SUPPORTING_EVIDENCE).
- CONTEXT_ONLY and DISCARD create NO durable concern association.
- Assistant-authored propositions NEVER receive PRIMARY_OWNER, SUPPORTING_EVIDENCE,
  or EMERGENCE_EVIDENCE — even after confirmation; the confirming USER proposition
  carries the applicable evidence.
- Association confidence is the supplied stage confidence (passed in from identity decision).
- Generate association IDs from canonical semantic request identity and normalized
  association tuple using build_association_key + resolve_entity_id.

Design authority: consolidated final design.md, Task 12.2.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ..enums import AssociationRole, BehavioralConfidenceBand, RetentionLevel, SemanticState
from ..id_generation import build_association_key, resolve_entity_id
from ..associations import PropositionAssociation
from ..models import Proposition, SemanticPacket


# Retention levels that map to association roles for USER propositions
_RETENTION_TO_ROLE: dict[RetentionLevel, AssociationRole] = {
    RetentionLevel.DURABLE_PROPOSITION: AssociationRole.PRIMARY_OWNER,
    RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE: AssociationRole.PRIMARY_OWNER,
    RetentionLevel.SUPPORTING_EVIDENCE: AssociationRole.SUPPORTING_EVIDENCE,
    RetentionLevel.EMERGENCE_EVIDENCE: AssociationRole.EMERGENCE_EVIDENCE,
}

# Retention levels that create NO durable association
_NON_DURABLE_LEVELS: frozenset[RetentionLevel] = frozenset({
    RetentionLevel.CONTEXT_ONLY,
    RetentionLevel.DISCARD,
})


class AssociationAssembler:
    """Assembles normalized multi-role proposition associations.

    Creates every applicable association role for each proposition in a packet,
    rather than selecting one winning role. A user proposition can hold multiple
    roles simultaneously (e.g., PRIMARY_OWNER of one concern AND evidence for
    another — or even multiple roles to the same concern).

    Assistant-authored propositions never receive user-grounded durable roles.
    """

    def assemble_associations(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        concern_id: str,
        request_id: str,
        confidence: BehavioralConfidenceBand,
    ) -> list[PropositionAssociation]:
        """Assemble all applicable associations for propositions in a packet.

        For each proposition:
        - If speaker_role == "ASSISTANT" → skip (no durable association)
        - If ALL retention_levels are CONTEXT_ONLY or DISCARD → skip
        - For USER propositions, compute applicable roles from retention_levels:
            DURABLE_PROPOSITION or INDEPENDENT_CONCERN_CANDIDATE → PRIMARY_OWNER
            SUPPORTING_EVIDENCE → SUPPORTING_EVIDENCE
            EMERGENCE_EVIDENCE → EMERGENCE_EVIDENCE
        - Create one PropositionAssociation per applicable role.

        Args:
            packet: The semantic packet establishing these associations.
            propositions: All propositions in the packet to evaluate.
            concern_id: The target concern for associations.
            request_id: The processing request ID (for deterministic key generation).
            confidence: The stage-specific confidence band for associations.

        Returns:
            List of PropositionAssociation records, one per applicable
            (proposition, role) pair.
        """
        associations: list[PropositionAssociation] = []
        now = datetime.now(timezone.utc).isoformat()

        for proposition in propositions:
            # Rule: Assistant-authored propositions never receive durable roles
            if proposition.speaker_role == "ASSISTANT":
                continue

            # Compute applicable roles from retention levels
            applicable_roles = self._compute_applicable_roles(
                proposition.retention_levels
            )

            # If no applicable roles (all CONTEXT_ONLY/DISCARD), skip
            if not applicable_roles:
                continue

            # Create one association per applicable role
            for role in sorted(applicable_roles, key=lambda r: r.value):
                association_creation_key = build_association_key(
                    request_id=request_id,
                    proposition_creation_key=proposition.proposition_creation_key,
                    concern_id=concern_id,
                    role=role.value,
                )
                association_id = resolve_entity_id("association", association_creation_key)

                associations.append(
                    PropositionAssociation(
                        association_id=association_id,
                        association_creation_key=association_creation_key,
                        proposition_id=proposition.proposition_id,
                        concern_id=concern_id,
                        role=role,
                        confidence=confidence,
                        provenance="identity_resolution",
                        established_by_packet_id=packet.packet_id,
                        semantic_state=SemanticState.ACTIVE,
                        created_at=now,
                        version=1,
                    )
                )

        return associations

    def _compute_applicable_roles(
        self,
        retention_levels: list[RetentionLevel],
    ) -> set[AssociationRole]:
        """Compute the set of applicable association roles from retention levels.

        Maps retention levels to association roles using the canonical mapping:
        - DURABLE_PROPOSITION → PRIMARY_OWNER
        - INDEPENDENT_CONCERN_CANDIDATE → PRIMARY_OWNER
        - SUPPORTING_EVIDENCE → SUPPORTING_EVIDENCE
        - EMERGENCE_EVIDENCE → EMERGENCE_EVIDENCE

        Both DURABLE_PROPOSITION and INDEPENDENT_CONCERN_CANDIDATE map to
        PRIMARY_OWNER, so even if both are present, only one PRIMARY_OWNER
        role is produced.

        CONTEXT_ONLY and DISCARD produce no roles.

        Args:
            retention_levels: All applicable retention levels for a proposition.

        Returns:
            Set of AssociationRole values. Empty set means no durable association.
        """
        roles: set[AssociationRole] = set()

        for level in retention_levels:
            mapped_role = _RETENTION_TO_ROLE.get(level)
            if mapped_role is not None:
                roles.add(mapped_role)

        return roles
