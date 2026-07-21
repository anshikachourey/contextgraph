"""Tests for SIE normalized association models.

Validates:
- PropositionAssociation, PacketMembership, PacketSplitRecord models
- established_by_packet_id presence and nullability
- Supporting evidence as a role-constrained PropositionAssociation
- Multiple association roles for one proposition
- PacketMembership does not introduce new source provenance
- PacketSplitRecord preserves lineage without new provenance
- Invalidation/replacement semantics (new event, not mutation)
"""

import pytest
from pydantic import ValidationError

from app.sie.associations import (
    PacketMembership,
    PacketSplitRecord,
    PropositionAssociation,
)
from app.sie.enums import (
    AssociationRole,
    BehavioralConfidenceBand,
    SemanticState,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _make_association(
    *,
    role: AssociationRole = AssociationRole.PRIMARY_OWNER,
    established_by_packet_id: str | None = "packet-001",
    semantic_state: SemanticState = SemanticState.ACTIVE,
    version: int = 1,
) -> PropositionAssociation:
    return PropositionAssociation(
        association_id="assoc-001",
        association_creation_key="req-1:prop-key-1:concern-A:PRIMARY_OWNER",
        proposition_id="prop-001",
        concern_id="concern-A",
        role=role,
        confidence=BehavioralConfidenceBand.HIGH,
        provenance="identity_resolution",
        established_by_packet_id=established_by_packet_id,
        semantic_state=semantic_state,
        created_at="2024-01-15T10:00:00Z",
        version=version,
    )


def _make_membership() -> PacketMembership:
    return PacketMembership(
        membership_id="mem-001",
        membership_creation_key="packet-key-1:prop-key-1:0",
        packet_id="packet-001",
        proposition_id="prop-001",
        ordinal=0,
        created_at="2024-01-15T10:00:00Z",
    )


def _make_split_record() -> PacketSplitRecord:
    return PacketSplitRecord(
        split_id="split-001",
        split_creation_key="req-1:packet-key-original:0",
        original_packet_id="packet-original",
        resulting_packet_ids=["packet-child-A", "packet-child-B"],
        split_reason="mixed_cohesion",
        created_at="2024-01-15T10:00:00Z",
    )


# ---------------------------------------------------------------------------
# PropositionAssociation tests
# ---------------------------------------------------------------------------


class TestPropositionAssociation:
    """Tests for the PropositionAssociation model."""

    def test_basic_construction(self):
        """A valid association is constructible with all required fields."""
        assoc = _make_association()
        assert assoc.association_id == "assoc-001"
        assert assoc.proposition_id == "prop-001"
        assert assoc.concern_id == "concern-A"
        assert assoc.role == AssociationRole.PRIMARY_OWNER
        assert assoc.confidence == BehavioralConfidenceBand.HIGH
        assert assoc.provenance == "identity_resolution"
        assert assoc.semantic_state == SemanticState.ACTIVE
        assert assoc.version == 1

    def test_established_by_packet_id_present(self):
        """established_by_packet_id is explicitly included and matches persistence schema."""
        assoc = _make_association(established_by_packet_id="packet-xyz")
        assert assoc.established_by_packet_id == "packet-xyz"

    def test_established_by_packet_id_nullable(self):
        """established_by_packet_id may be None for repair/migration associations."""
        assoc = _make_association(established_by_packet_id=None)
        assert assoc.established_by_packet_id is None

    def test_established_by_packet_id_defaults_to_none(self):
        """established_by_packet_id defaults to None when not provided."""
        assoc = PropositionAssociation(
            association_id="assoc-002",
            association_creation_key="req-1:prop-key-2:concern-B:CONTEXT",
            proposition_id="prop-002",
            concern_id="concern-B",
            role=AssociationRole.CONTEXT,
            confidence=BehavioralConfidenceBand.MEDIUM,
            provenance="cross_object_analysis",
            created_at="2024-01-15T10:00:00Z",
        )
        assert assoc.established_by_packet_id is None

    def test_supporting_evidence_is_role_constrained_association(self):
        """Supporting evidence uses PropositionAssociation with role=SUPPORTING_EVIDENCE,
        not a separate type."""
        evidence_assoc = _make_association(role=AssociationRole.SUPPORTING_EVIDENCE)
        assert isinstance(evidence_assoc, PropositionAssociation)
        assert evidence_assoc.role == AssociationRole.SUPPORTING_EVIDENCE

    def test_emergence_evidence_is_role_constrained_association(self):
        """Emergence evidence also uses PropositionAssociation with the appropriate role."""
        evidence_assoc = _make_association(role=AssociationRole.EMERGENCE_EVIDENCE)
        assert isinstance(evidence_assoc, PropositionAssociation)
        assert evidence_assoc.role == AssociationRole.EMERGENCE_EVIDENCE

    def test_multiple_roles_for_same_proposition(self):
        """A proposition may be PRIMARY_OWNER of one concern and
        SUPPORTING_EVIDENCE for another — different associations."""
        primary = PropositionAssociation(
            association_id="assoc-primary",
            association_creation_key="req-1:prop-key-1:concern-A:PRIMARY_OWNER",
            proposition_id="prop-001",
            concern_id="concern-A",
            role=AssociationRole.PRIMARY_OWNER,
            confidence=BehavioralConfidenceBand.HIGH,
            provenance="identity_resolution",
            established_by_packet_id="packet-001",
            created_at="2024-01-15T10:00:00Z",
        )

        supporting = PropositionAssociation(
            association_id="assoc-supporting",
            association_creation_key="req-1:prop-key-1:concern-B:SUPPORTING_EVIDENCE",
            proposition_id="prop-001",
            concern_id="concern-B",
            role=AssociationRole.SUPPORTING_EVIDENCE,
            confidence=BehavioralConfidenceBand.MEDIUM,
            provenance="cross_object_impact_analysis",
            established_by_packet_id="packet-001",
            created_at="2024-01-15T10:00:00Z",
        )

        # Both are valid — same proposition, different concerns, different roles
        assert primary.proposition_id == supporting.proposition_id
        assert primary.concern_id != supporting.concern_id
        assert primary.role != supporting.role

    def test_invalidation_creates_new_event(self):
        """Invalidation marks the old association INVALIDATED; replacement is a new record."""
        old_assoc = _make_association(semantic_state=SemanticState.INVALIDATED)
        assert old_assoc.semantic_state == SemanticState.INVALIDATED

        # A replacement creates a new association with a different creation key
        new_assoc = PropositionAssociation(
            association_id="assoc-002",
            association_creation_key="req-2:prop-key-1:concern-A:PRIMARY_OWNER",
            proposition_id="prop-001",
            concern_id="concern-A",
            role=AssociationRole.PRIMARY_OWNER,
            confidence=BehavioralConfidenceBand.HIGH,
            provenance="semantic_repair",
            established_by_packet_id=None,
            semantic_state=SemanticState.ACTIVE,
            created_at="2024-01-16T10:00:00Z",
            version=1,
        )
        # Old and new have different IDs and creation keys — history preserved
        assert old_assoc.association_id != new_assoc.association_id
        assert old_assoc.association_creation_key != new_assoc.association_creation_key

    def test_serialization_roundtrip(self):
        """Association serializes and deserializes correctly preserving all fields."""
        assoc = _make_association(established_by_packet_id="packet-xyz")
        data = assoc.model_dump()
        restored = PropositionAssociation(**data)
        assert restored == assoc
        assert restored.established_by_packet_id == "packet-xyz"

    def test_json_roundtrip(self):
        """Association roundtrips through JSON correctly."""
        assoc = _make_association(established_by_packet_id="packet-001")
        json_str = assoc.model_dump_json()
        restored = PropositionAssociation.model_validate_json(json_str)
        assert restored == assoc

    def test_all_association_roles_valid(self):
        """All AssociationRole values produce valid associations."""
        for role in AssociationRole:
            assoc = _make_association(role=role)
            assert assoc.role == role

    def test_all_semantic_states_valid(self):
        """All SemanticState values are valid for associations."""
        for state in SemanticState:
            assoc = _make_association(semantic_state=state)
            assert assoc.semantic_state == state


# ---------------------------------------------------------------------------
# PacketMembership tests
# ---------------------------------------------------------------------------


class TestPacketMembership:
    """Tests for the PacketMembership model."""

    def test_basic_construction(self):
        """A valid membership is constructible with all required fields."""
        mem = _make_membership()
        assert mem.membership_id == "mem-001"
        assert mem.packet_id == "packet-001"
        assert mem.proposition_id == "prop-001"
        assert mem.ordinal == 0

    def test_no_source_provenance_fields(self):
        """PacketMembership does NOT have source_message_ids, speaker_role,
        or any other provenance field — provenance comes from the proposition."""
        mem = _make_membership()
        # These fields should not exist on the model
        assert not hasattr(mem, "source_message_ids")
        assert not hasattr(mem, "speaker_role")
        assert not hasattr(mem, "provenance")
        assert not hasattr(mem, "extraction_version")

    def test_ordinal_must_be_non_negative(self):
        """Ordinal must be >= 0."""
        with pytest.raises(ValidationError):
            PacketMembership(
                membership_id="mem-bad",
                membership_creation_key="pkt-key:prop-key:-1",
                packet_id="packet-001",
                proposition_id="prop-001",
                ordinal=-1,
                created_at="2024-01-15T10:00:00Z",
            )

    def test_serialization_roundtrip(self):
        """Membership serializes and deserializes correctly."""
        mem = _make_membership()
        data = mem.model_dump()
        restored = PacketMembership(**data)
        assert restored == mem

    def test_json_roundtrip(self):
        """Membership roundtrips through JSON correctly."""
        mem = _make_membership()
        json_str = mem.model_dump_json()
        restored = PacketMembership.model_validate_json(json_str)
        assert restored == mem


# ---------------------------------------------------------------------------
# PacketSplitRecord tests
# ---------------------------------------------------------------------------


class TestPacketSplitRecord:
    """Tests for the PacketSplitRecord model."""

    def test_basic_construction(self):
        """A valid split record is constructible with all required fields."""
        split = _make_split_record()
        assert split.split_id == "split-001"
        assert split.original_packet_id == "packet-original"
        assert split.resulting_packet_ids == ["packet-child-A", "packet-child-B"]
        assert split.split_reason == "mixed_cohesion"

    def test_no_source_provenance_fields(self):
        """PacketSplitRecord does NOT introduce new source provenance —
        child packets inherit provenance from constituent propositions."""
        split = _make_split_record()
        assert not hasattr(split, "source_message_ids")
        assert not hasattr(split, "provenance")
        assert not hasattr(split, "speaker_role")

    def test_resulting_packet_ids_minimum_two(self):
        """A split must produce at least two resulting packets."""
        with pytest.raises(ValidationError):
            PacketSplitRecord(
                split_id="split-bad",
                split_creation_key="req-1:packet-key-original:bad",
                original_packet_id="packet-original",
                resulting_packet_ids=["only-one"],
                split_reason="mixed_cohesion",
                created_at="2024-01-15T10:00:00Z",
            )

    def test_resulting_packet_ids_more_than_two(self):
        """A split may produce more than two resulting packets."""
        split = PacketSplitRecord(
            split_id="split-multi",
            split_creation_key="req-1:packet-key-original:multi",
            original_packet_id="packet-original",
            resulting_packet_ids=["child-A", "child-B", "child-C"],
            split_reason="multiple_independent_concerns",
            created_at="2024-01-15T10:00:00Z",
        )
        assert len(split.resulting_packet_ids) == 3

    def test_preserves_split_lineage(self):
        """Split record preserves the relationship between original and children."""
        split = _make_split_record()
        # The original_packet_id and resulting_packet_ids establish traceable lineage
        assert split.original_packet_id == "packet-original"
        assert "packet-child-A" in split.resulting_packet_ids
        assert "packet-child-B" in split.resulting_packet_ids

    def test_serialization_roundtrip(self):
        """Split record serializes and deserializes correctly."""
        split = _make_split_record()
        data = split.model_dump()
        restored = PacketSplitRecord(**data)
        assert restored == split

    def test_json_roundtrip(self):
        """Split record roundtrips through JSON correctly."""
        split = _make_split_record()
        json_str = split.model_dump_json()
        restored = PacketSplitRecord.model_validate_json(json_str)
        assert restored == split

    def test_empty_resulting_packet_ids_rejected(self):
        """An empty resulting_packet_ids list is rejected."""
        with pytest.raises(ValidationError):
            PacketSplitRecord(
                split_id="split-empty",
                split_creation_key="req-1:packet-key-original:empty",
                original_packet_id="packet-original",
                resulting_packet_ids=[],
                split_reason="mixed_cohesion",
                created_at="2024-01-15T10:00:00Z",
            )
