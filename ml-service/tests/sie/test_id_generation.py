"""Tests for SIE stable creation keys and opaque ID generation.

Verifies:
- Same creation key produces the same ID (determinism)
- Different entity namespaces with same creation key produce different IDs (no collisions)
- All creation-key builder functions produce valid, consistent keys
- EntityCreationRef serialization/deserialization works correctly
"""

import uuid

import pytest

from app.sie.id_generation import (
    ENTITY_NAMESPACES,
    EntityCreationRef,
    build_association_key,
    build_concern_key,
    build_membership_key,
    build_packet_key,
    build_packet_split_key,
    build_pending_semantic_decision_key,
    build_processing_request_key,
    build_proposition_key,
    build_retention_decision_key,
    create_association_ref,
    create_concern_ref,
    create_entity_ref,
    create_membership_ref,
    create_packet_ref,
    create_packet_split_ref,
    create_pending_semantic_decision_ref,
    create_processing_request_ref,
    create_proposition_ref,
    create_retention_decision_ref,
    resolve_entity_id,
)


# ---------------------------------------------------------------------------
# Determinism tests: same creation key → same ID
# ---------------------------------------------------------------------------


class TestDeterminism:
    """Same creation key always produces the same entity ID."""

    def test_resolve_entity_id_deterministic(self):
        """Calling resolve_entity_id multiple times with same inputs yields same result."""
        kind = "proposition"
        key = "req-123:5"
        id1 = resolve_entity_id(kind, key)
        id2 = resolve_entity_id(kind, key)
        assert id1 == id2

    def test_create_entity_ref_deterministic(self):
        """EntityCreationRef resolves the same ID on repeated creation."""
        ref1 = create_entity_ref("concern", "pkt-key:event-1")
        ref2 = create_entity_ref("concern", "pkt-key:event-1")
        assert ref1.entity_id == ref2.entity_id
        assert ref1 == ref2

    def test_processing_request_ref_deterministic(self):
        """Processing request refs are deterministic."""
        ref1 = create_processing_request_ref("conv-1", 1, 5, "v1.0")
        ref2 = create_processing_request_ref("conv-1", 1, 5, "v1.0")
        assert ref1.entity_id == ref2.entity_id

    def test_retention_decision_ref_deterministic(self):
        """Retention decision refs are deterministic."""
        ref1 = create_retention_decision_ref("req-1", "msg-abc", 3)
        ref2 = create_retention_decision_ref("req-1", "msg-abc", 3)
        assert ref1.entity_id == ref2.entity_id

    def test_proposition_ref_deterministic(self):
        """Proposition refs are deterministic."""
        ref1 = create_proposition_ref("req-1", 7)
        ref2 = create_proposition_ref("req-1", 7)
        assert ref1.entity_id == ref2.entity_id

    def test_packet_ref_deterministic(self):
        """Packet refs are deterministic."""
        ref1 = create_packet_ref("req-1", "partition-0")
        ref2 = create_packet_ref("req-1", "partition-0")
        assert ref1.entity_id == ref2.entity_id

    def test_concern_ref_deterministic(self):
        """Concern refs are deterministic."""
        ref1 = create_concern_ref("pkt-key", "event-1")
        ref2 = create_concern_ref("pkt-key", "event-1")
        assert ref1.entity_id == ref2.entity_id

    def test_association_ref_deterministic(self):
        """Association refs are deterministic."""
        ref1 = create_association_ref("req-1", "prop-key", "concern-1", "PRIMARY_OWNER")
        ref2 = create_association_ref("req-1", "prop-key", "concern-1", "PRIMARY_OWNER")
        assert ref1.entity_id == ref2.entity_id

    def test_membership_ref_deterministic(self):
        """Membership refs are deterministic."""
        ref1 = create_membership_ref("pkt-key", "prop-key", 0)
        ref2 = create_membership_ref("pkt-key", "prop-key", 0)
        assert ref1.entity_id == ref2.entity_id

    def test_pending_decision_ref_deterministic(self):
        """Pending decision refs are deterministic."""
        ref1 = create_pending_semantic_decision_ref("req-1", "identity_resolution", "entity-key")
        ref2 = create_pending_semantic_decision_ref("req-1", "identity_resolution", "entity-key")
        assert ref1.entity_id == ref2.entity_id


# ---------------------------------------------------------------------------
# Namespace collision tests: different entity kinds → different IDs
# ---------------------------------------------------------------------------


class TestNamespaceIsolation:
    """Different entity namespaces with same creation key produce different IDs."""

    def test_same_key_different_kinds_produce_different_ids(self):
        """The same creation key resolved in different namespaces yields different IDs."""
        shared_key = "shared-creation-key:123"
        ids = set()
        for kind in ENTITY_NAMESPACES:
            entity_id = resolve_entity_id(kind, shared_key)
            ids.add(entity_id)
        # All IDs should be unique — one per entity kind
        assert len(ids) == len(ENTITY_NAMESPACES)

    def test_proposition_vs_concern_no_collision(self):
        """A proposition and a concern with the same creation key have different IDs."""
        key = "test-key:42"
        prop_id = resolve_entity_id("proposition", key)
        concern_id = resolve_entity_id("concern", key)
        assert prop_id != concern_id

    def test_packet_vs_packet_split_no_collision(self):
        """Packets and packet splits with similar keys have different IDs."""
        key = "req-1:partition-0"
        packet_id = resolve_entity_id("packet", key)
        split_id = resolve_entity_id("packet_split", key)
        assert packet_id != split_id

    def test_all_namespaces_are_unique_uuids(self):
        """All entity namespace UUIDs are distinct."""
        namespace_values = list(ENTITY_NAMESPACES.values())
        assert len(set(namespace_values)) == len(namespace_values)


# ---------------------------------------------------------------------------
# Creation key builder tests
# ---------------------------------------------------------------------------


class TestCreationKeyBuilders:
    """All creation-key builder functions produce valid, consistent keys."""

    def test_processing_request_key_format(self):
        """Processing request key follows the design pattern."""
        key = build_processing_request_key("conv-abc", 1, 10, "v2.1")
        assert key == "conv-abc:1-10:v2.1"

    def test_retention_decision_key_format(self):
        """Retention decision key follows the design pattern."""
        key = build_retention_decision_key("req-1", "msg-xyz", 3)
        assert key == "req-1:msg-xyz:3"

    def test_proposition_key_format(self):
        """Proposition key follows the design pattern (excludes canonical meaning)."""
        key = build_proposition_key("req-1", 5)
        assert key == "req-1:5"

    def test_packet_key_format(self):
        """Packet key follows the design pattern."""
        key = build_packet_key("req-1", "partition-0")
        assert key == "req-1:partition-0"

    def test_packet_split_key_format(self):
        """Packet split key follows the design pattern."""
        key = build_packet_split_key("req-1", "req-1:partition-0", 2)
        assert key == "req-1:req-1:partition-0:2"

    def test_concern_key_format(self):
        """Concern key follows the design pattern (excludes identity summary/title)."""
        key = build_concern_key("req-1:partition-0", "new-concern-event-1")
        assert key == "req-1:partition-0:new-concern-event-1"

    def test_association_key_format(self):
        """Association key follows the design pattern."""
        key = build_association_key("req-1", "req-1:5", "concern-abc", "PRIMARY_OWNER")
        assert key == "req-1:req-1:5:concern-abc:PRIMARY_OWNER"

    def test_membership_key_format(self):
        """Membership key follows the design pattern."""
        key = build_membership_key("req-1:partition-0", "req-1:5", 0)
        assert key == "req-1:partition-0:req-1:5:0"

    def test_pending_decision_key_format(self):
        """Pending decision key follows the design pattern."""
        key = build_pending_semantic_decision_key("req-1", "cohesion", "entity-key-1")
        assert key == "req-1:cohesion:entity-key-1"

    def test_different_inputs_produce_different_keys(self):
        """Different inputs produce different creation keys."""
        key1 = build_proposition_key("req-1", 0)
        key2 = build_proposition_key("req-1", 1)
        key3 = build_proposition_key("req-2", 0)
        assert key1 != key2
        assert key1 != key3
        assert key2 != key3

    def test_mutable_fields_excluded_from_proposition_key(self):
        """Proposition key does NOT include canonical meaning — only request and position."""
        # The same position in the same request always produces the same key,
        # regardless of what canonical meaning the model generates.
        key = build_proposition_key("req-1", 3)
        # Key must not contain any model-generated text
        assert "canonical" not in key
        assert "meaning" not in key
        # Format is purely positional
        assert key == "req-1:3"

    def test_mutable_fields_excluded_from_concern_key(self):
        """Concern key does NOT include identity summary, display title, or current summary."""
        key = build_concern_key("pkt-key", "resolution-event-1")
        assert "summary" not in key
        assert "title" not in key
        assert "identity" not in key.lower() or "identity" in "resolution-event-1"


# ---------------------------------------------------------------------------
# EntityCreationRef serialization tests
# ---------------------------------------------------------------------------


class TestEntityCreationRefSerialization:
    """EntityCreationRef serialization/deserialization works correctly."""

    def test_model_fields(self):
        """EntityCreationRef has the required fields."""
        ref = EntityCreationRef(
            entity_kind="proposition",
            creation_key="req-1:5",
            entity_id="some-uuid-string",
        )
        assert ref.entity_kind == "proposition"
        assert ref.creation_key == "req-1:5"
        assert ref.entity_id == "some-uuid-string"

    def test_json_serialization_roundtrip(self):
        """EntityCreationRef survives JSON serialization/deserialization."""
        ref = create_entity_ref("concern", "pkt-key:event-1")
        json_data = ref.model_dump_json()
        restored = EntityCreationRef.model_validate_json(json_data)
        assert restored == ref
        assert restored.entity_kind == ref.entity_kind
        assert restored.creation_key == ref.creation_key
        assert restored.entity_id == ref.entity_id

    def test_dict_serialization_roundtrip(self):
        """EntityCreationRef survives dict serialization/deserialization."""
        ref = create_entity_ref("association", "req-1:prop-key:concern-1:PRIMARY_OWNER")
        data = ref.model_dump()
        restored = EntityCreationRef.model_validate(data)
        assert restored == ref

    def test_entity_id_is_valid_uuid_string(self):
        """The resolved entity_id is a valid UUID string."""
        ref = create_entity_ref("packet", "req-1:partition-0")
        # Should not raise
        parsed = uuid.UUID(ref.entity_id)
        assert parsed.version == 5  # UUIDv5

    def test_create_entity_ref_populates_all_fields(self):
        """create_entity_ref correctly fills entity_kind, creation_key, and entity_id."""
        ref = create_entity_ref("membership", "pkt-key:prop-key:0")
        assert ref.entity_kind == "membership"
        assert ref.creation_key == "pkt-key:prop-key:0"
        assert ref.entity_id  # non-empty
        # Verify it's a UUIDv5
        assert uuid.UUID(ref.entity_id).version == 5


# ---------------------------------------------------------------------------
# Error handling tests
# ---------------------------------------------------------------------------


class TestErrorHandling:
    """Invalid inputs are properly rejected."""

    def test_unknown_entity_kind_raises_value_error(self):
        """resolve_entity_id raises ValueError for unknown entity_kind."""
        with pytest.raises(ValueError, match="Unknown entity_kind"):
            resolve_entity_id("nonexistent_kind", "some-key")

    def test_create_entity_ref_unknown_kind_raises(self):
        """create_entity_ref raises ValueError for unknown entity_kind."""
        with pytest.raises(ValueError, match="Unknown entity_kind"):
            create_entity_ref("invalid_kind", "some-key")


# ---------------------------------------------------------------------------
# Integration tests: full ref builders produce valid refs
# ---------------------------------------------------------------------------


class TestFullRefBuilders:
    """Convenience ref builders produce valid EntityCreationRef instances."""

    def test_processing_request_ref(self):
        """Full processing request ref has correct kind and valid UUID."""
        ref = create_processing_request_ref("conv-1", 1, 5, "v1.0")
        assert ref.entity_kind == "processing_request"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "conv-1:1-5:v1.0" == ref.creation_key

    def test_retention_decision_ref(self):
        """Full retention decision ref has correct kind and valid UUID."""
        ref = create_retention_decision_ref("req-1", "msg-abc", 3)
        assert ref.entity_kind == "retention_decision"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "req-1:msg-abc:3" == ref.creation_key

    def test_proposition_ref(self):
        """Full proposition ref has correct kind and valid UUID."""
        ref = create_proposition_ref("req-1", 7)
        assert ref.entity_kind == "proposition"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "req-1:7" == ref.creation_key

    def test_packet_ref(self):
        """Full packet ref has correct kind and valid UUID."""
        ref = create_packet_ref("req-1", "partition-0")
        assert ref.entity_kind == "packet"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "req-1:partition-0" == ref.creation_key

    def test_packet_split_ref(self):
        """Full packet split ref has correct kind and valid UUID."""
        ref = create_packet_split_ref("req-1", "req-1:partition-0", 2)
        assert ref.entity_kind == "packet_split"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "req-1:req-1:partition-0:2" == ref.creation_key

    def test_concern_ref(self):
        """Full concern ref has correct kind and valid UUID."""
        ref = create_concern_ref("pkt-key", "event-1")
        assert ref.entity_kind == "concern"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "pkt-key:event-1" == ref.creation_key

    def test_association_ref(self):
        """Full association ref has correct kind and valid UUID."""
        ref = create_association_ref("req-1", "prop-key", "concern-1", "PRIMARY_OWNER")
        assert ref.entity_kind == "association"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "req-1:prop-key:concern-1:PRIMARY_OWNER" == ref.creation_key

    def test_membership_ref(self):
        """Full membership ref has correct kind and valid UUID."""
        ref = create_membership_ref("pkt-key", "prop-key", 0)
        assert ref.entity_kind == "membership"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "pkt-key:prop-key:0" == ref.creation_key

    def test_pending_semantic_decision_ref(self):
        """Full pending decision ref has correct kind and valid UUID."""
        ref = create_pending_semantic_decision_ref("req-1", "identity_resolution", "entity-key")
        assert ref.entity_kind == "pending_semantic_decision"
        assert uuid.UUID(ref.entity_id).version == 5
        assert "req-1:identity_resolution:entity-key" == ref.creation_key
