"""Tests for AssociationAssembler — multi-role association assembly.

Verifies:
- User propositions receive correct association roles from retention levels.
- One proposition can hold multiple valid association roles.
- Assistant-authored propositions never receive user-grounded durable roles.
- CONTEXT_ONLY and DISCARD create no durable association.
- Association IDs are deterministic from canonical semantic request identity.
- Association confidence is the supplied stage confidence.
- established_by_packet_id is the packet that triggered the association.

Design authority: consolidated final design.md, Task 12.2.
"""

from __future__ import annotations

import pytest

from app.sie.associations import PropositionAssociation
from app.sie.enums import (
    AssociationRole,
    BehavioralConfidenceBand,
    CohesionStatus,
    PropositionProvenance,
    PropositionType,
    RetentionLevel,
    SemanticState,
)
from app.sie.id_generation import build_association_key, resolve_entity_id
from app.sie.models import Proposition, SemanticPacket
from app.sie.retrieval.association_assembler import AssociationAssembler


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_packet(
    *,
    packet_id: str = "pkt-001",
    packet_creation_key: str = "req-1:partition-a",
) -> SemanticPacket:
    """Create a minimal SemanticPacket for testing."""
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=packet_creation_key,
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        message_seq_range=(1, 1),
        user_grounded_meaning="User wants to learn about ML",
        provenance="direct",
        packet_formation_version="1.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_proposition(
    *,
    proposition_id: str = "prop-001",
    proposition_creation_key: str = "req-1:0",
    speaker_role: str = "USER",
    retention_levels: list[RetentionLevel] | None = None,
) -> Proposition:
    """Create a Proposition with configurable fields for testing."""
    if retention_levels is None:
        retention_levels = [RetentionLevel.DURABLE_PROPOSITION]
    return Proposition(
        proposition_id=proposition_id,
        proposition_creation_key=proposition_creation_key,
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        speaker_role=speaker_role,
        canonical_meaning="I want to learn about ML",
        proposition_type=PropositionType.GOAL,
        message_seq_range=(1, 1),
        provenance=PropositionProvenance.DIRECT,
        semantic_state=SemanticState.ACTIVE,
        retention_levels=retention_levels,
        created_at="2024-01-01T00:00:00Z",
        extraction_version="1.0",
    )


# ---------------------------------------------------------------------------
# Tests: USER propositions with single retention levels
# ---------------------------------------------------------------------------


class TestUserPropositionSingleRole:
    """User propositions with a single retention level get the correct role."""

    def test_durable_proposition_maps_to_primary_owner(self) -> None:
        """DURABLE_PROPOSITION → PRIMARY_OWNER."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DURABLE_PROPOSITION])
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert len(result) == 1
        assert result[0].role == AssociationRole.PRIMARY_OWNER
        assert result[0].concern_id == "concern-001"
        assert result[0].proposition_id == "prop-001"

    def test_independent_concern_candidate_maps_to_primary_owner(self) -> None:
        """INDEPENDENT_CONCERN_CANDIDATE → PRIMARY_OWNER."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert len(result) == 1
        assert result[0].role == AssociationRole.PRIMARY_OWNER

    def test_supporting_evidence_maps_to_supporting_evidence(self) -> None:
        """SUPPORTING_EVIDENCE → SUPPORTING_EVIDENCE."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.SUPPORTING_EVIDENCE]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-002", "req-1", BehavioralConfidenceBand.MEDIUM
        )

        assert len(result) == 1
        assert result[0].role == AssociationRole.SUPPORTING_EVIDENCE

    def test_emergence_evidence_maps_to_emergence_evidence(self) -> None:
        """EMERGENCE_EVIDENCE → EMERGENCE_EVIDENCE."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.EMERGENCE_EVIDENCE]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-003", "req-1", BehavioralConfidenceBand.LOW
        )

        assert len(result) == 1
        assert result[0].role == AssociationRole.EMERGENCE_EVIDENCE


# ---------------------------------------------------------------------------
# Tests: USER propositions with multiple retention levels → multiple roles
# ---------------------------------------------------------------------------


class TestUserPropositionMultipleRoles:
    """One proposition can hold multiple valid association roles."""

    def test_durable_and_supporting_maps_to_two_roles(self) -> None:
        """DURABLE_PROPOSITION + SUPPORTING_EVIDENCE → PRIMARY_OWNER + SUPPORTING_EVIDENCE."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[
                    RetentionLevel.DURABLE_PROPOSITION,
                    RetentionLevel.SUPPORTING_EVIDENCE,
                ]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert len(result) == 2
        roles = {a.role for a in result}
        assert AssociationRole.PRIMARY_OWNER in roles
        assert AssociationRole.SUPPORTING_EVIDENCE in roles

    def test_all_three_applicable_roles(self) -> None:
        """DURABLE_PROPOSITION + SUPPORTING_EVIDENCE + EMERGENCE_EVIDENCE → 3 roles."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[
                    RetentionLevel.DURABLE_PROPOSITION,
                    RetentionLevel.SUPPORTING_EVIDENCE,
                    RetentionLevel.EMERGENCE_EVIDENCE,
                ]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert len(result) == 3
        roles = {a.role for a in result}
        assert roles == {
            AssociationRole.PRIMARY_OWNER,
            AssociationRole.SUPPORTING_EVIDENCE,
            AssociationRole.EMERGENCE_EVIDENCE,
        }

    def test_durable_and_independent_both_map_to_primary_owner_once(self) -> None:
        """DURABLE_PROPOSITION + INDEPENDENT_CONCERN_CANDIDATE → one PRIMARY_OWNER."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[
                    RetentionLevel.DURABLE_PROPOSITION,
                    RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE,
                ]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        # Both map to PRIMARY_OWNER → only one association (deduplicated via set)
        assert len(result) == 1
        assert result[0].role == AssociationRole.PRIMARY_OWNER

    def test_mixed_durable_and_non_durable_produces_only_durable_roles(self) -> None:
        """DURABLE_PROPOSITION + CONTEXT_ONLY → only PRIMARY_OWNER (CONTEXT_ONLY ignored)."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[
                    RetentionLevel.DURABLE_PROPOSITION,
                    RetentionLevel.CONTEXT_ONLY,
                ]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert len(result) == 1
        assert result[0].role == AssociationRole.PRIMARY_OWNER


# ---------------------------------------------------------------------------
# Tests: CONTEXT_ONLY and DISCARD create no association
# ---------------------------------------------------------------------------


class TestNonDurableRetentionLevels:
    """CONTEXT_ONLY and DISCARD produce no associations."""

    def test_context_only_creates_no_association(self) -> None:
        """CONTEXT_ONLY → empty result."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.CONTEXT_ONLY])
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result == []

    def test_discard_creates_no_association(self) -> None:
        """DISCARD → empty result."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DISCARD])
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result == []

    def test_context_only_and_discard_together_no_association(self) -> None:
        """CONTEXT_ONLY + DISCARD → empty result."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.CONTEXT_ONLY, RetentionLevel.DISCARD]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result == []


# ---------------------------------------------------------------------------
# Tests: Assistant-authored propositions never receive durable roles
# ---------------------------------------------------------------------------


class TestAssistantPropositionsExcluded:
    """Assistant-authored propositions never become user-grounded ownership or evidence."""

    def test_assistant_with_durable_proposition_skipped(self) -> None:
        """ASSISTANT speaker + DURABLE_PROPOSITION → no association."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                speaker_role="ASSISTANT",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result == []

    def test_assistant_with_all_roles_skipped(self) -> None:
        """ASSISTANT speaker with all applicable retention levels → no association."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                speaker_role="ASSISTANT",
                retention_levels=[
                    RetentionLevel.DURABLE_PROPOSITION,
                    RetentionLevel.SUPPORTING_EVIDENCE,
                    RetentionLevel.EMERGENCE_EVIDENCE,
                    RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE,
                ],
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result == []

    def test_mixed_user_and_assistant_only_user_gets_associations(self) -> None:
        """Packet with USER and ASSISTANT props → only USER props get associations."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="user-prop",
                proposition_creation_key="req-1:0",
                speaker_role="USER",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            ),
            _make_proposition(
                proposition_id="asst-prop",
                proposition_creation_key="req-1:1",
                speaker_role="ASSISTANT",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            ),
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert len(result) == 1
        assert result[0].proposition_id == "user-prop"
        assert result[0].role == AssociationRole.PRIMARY_OWNER


# ---------------------------------------------------------------------------
# Tests: Association confidence and provenance
# ---------------------------------------------------------------------------


class TestAssociationMetadata:
    """Association confidence is stage-specific, provenance is identity_resolution."""

    def test_confidence_is_supplied_stage_confidence(self) -> None:
        """Association confidence matches the supplied confidence band."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DURABLE_PROPOSITION])
        ]

        for band in BehavioralConfidenceBand:
            result = assembler.assemble_associations(
                packet, propositions, "concern-001", "req-1", band
            )
            assert result[0].confidence == band

    def test_provenance_is_identity_resolution(self) -> None:
        """Association provenance is 'identity_resolution'."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DURABLE_PROPOSITION])
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result[0].provenance == "identity_resolution"

    def test_established_by_packet_id(self) -> None:
        """established_by_packet_id is the packet that triggered the association."""
        assembler = AssociationAssembler()
        packet = _make_packet(packet_id="pkt-test-99")
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DURABLE_PROPOSITION])
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result[0].established_by_packet_id == "pkt-test-99"

    def test_semantic_state_is_active(self) -> None:
        """New associations have ACTIVE semantic state."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DURABLE_PROPOSITION])
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result[0].semantic_state == SemanticState.ACTIVE

    def test_version_is_one(self) -> None:
        """New associations have version=1."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DURABLE_PROPOSITION])
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result[0].version == 1


# ---------------------------------------------------------------------------
# Tests: Deterministic association IDs
# ---------------------------------------------------------------------------


class TestDeterministicIds:
    """Association IDs are generated deterministically from canonical identity."""

    def test_association_id_deterministic(self) -> None:
        """Same inputs produce the same association_id."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_creation_key="req-1:0",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            )
        ]

        result_1 = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )
        result_2 = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result_1[0].association_id == result_2[0].association_id
        assert result_1[0].association_creation_key == result_2[0].association_creation_key

    def test_association_id_uses_correct_key_components(self) -> None:
        """association_creation_key matches build_association_key output."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_creation_key="req-1:0",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        expected_key = build_association_key(
            "req-1", "req-1:0", "concern-001", "PRIMARY_OWNER"
        )
        expected_id = resolve_entity_id("association", expected_key)

        assert result[0].association_creation_key == expected_key
        assert result[0].association_id == expected_id

    def test_different_roles_produce_different_ids(self) -> None:
        """Different roles for the same proposition produce different association IDs."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[
                    RetentionLevel.DURABLE_PROPOSITION,
                    RetentionLevel.SUPPORTING_EVIDENCE,
                ]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert len(result) == 2
        ids = {a.association_id for a in result}
        assert len(ids) == 2  # Different IDs

    def test_different_concerns_produce_different_ids(self) -> None:
        """Same proposition, different concern → different association ID."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DURABLE_PROPOSITION])
        ]

        result_a = assembler.assemble_associations(
            packet, propositions, "concern-A", "req-1", BehavioralConfidenceBand.HIGH
        )
        result_b = assembler.assemble_associations(
            packet, propositions, "concern-B", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result_a[0].association_id != result_b[0].association_id


# ---------------------------------------------------------------------------
# Tests: Multiple propositions in a packet
# ---------------------------------------------------------------------------


class TestMultiplePropositions:
    """Multiple propositions in a single packet are processed correctly."""

    def test_multiple_user_propositions_each_get_associations(self) -> None:
        """Each USER proposition gets its own set of associations."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="p1",
                proposition_creation_key="req-1:0",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            ),
            _make_proposition(
                proposition_id="p2",
                proposition_creation_key="req-1:1",
                retention_levels=[RetentionLevel.SUPPORTING_EVIDENCE],
            ),
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert len(result) == 2
        p1_assoc = [a for a in result if a.proposition_id == "p1"]
        p2_assoc = [a for a in result if a.proposition_id == "p2"]
        assert len(p1_assoc) == 1
        assert p1_assoc[0].role == AssociationRole.PRIMARY_OWNER
        assert len(p2_assoc) == 1
        assert p2_assoc[0].role == AssociationRole.SUPPORTING_EVIDENCE

    def test_empty_propositions_list_returns_empty(self) -> None:
        """No propositions → no associations."""
        assembler = AssociationAssembler()
        packet = _make_packet()

        result = assembler.assemble_associations(
            packet, [], "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result == []

    def test_all_assistant_propositions_returns_empty(self) -> None:
        """All ASSISTANT propositions → no associations."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="a1",
                proposition_creation_key="req-1:0",
                speaker_role="ASSISTANT",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            ),
            _make_proposition(
                proposition_id="a2",
                proposition_creation_key="req-1:1",
                speaker_role="ASSISTANT",
                retention_levels=[RetentionLevel.SUPPORTING_EVIDENCE],
            ),
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result == []


# ---------------------------------------------------------------------------
# Tests: Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    """Edge cases for association assembly."""

    def test_proposition_with_only_non_durable_levels_skipped(self) -> None:
        """Proposition with only CONTEXT_ONLY and DISCARD → skipped."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[RetentionLevel.CONTEXT_ONLY, RetentionLevel.DISCARD]
            )
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result == []

    def test_created_at_is_set(self) -> None:
        """Each association has a non-empty created_at."""
        assembler = AssociationAssembler()
        packet = _make_packet()
        propositions = [
            _make_proposition(retention_levels=[RetentionLevel.DURABLE_PROPOSITION])
        ]

        result = assembler.assemble_associations(
            packet, propositions, "concern-001", "req-1", BehavioralConfidenceBand.HIGH
        )

        assert result[0].created_at
        # Should be a valid ISO timestamp
        assert "T" in result[0].created_at
