"""Stable creation keys and opaque ID generation for SIE entities.

This module implements the idempotent ID strategy described in the SIE data-model
design: permanent IDs are opaque, namespaced identifiers resolved once from stable
creation keys and then reused. They are NOT derived from mutable or model-generated
text (canonicalMeaning, identitySummary, displayTitle, currentSummary, aliases, parent).

Key properties:
- Same creation key always resolves to the same entity ID (determinism).
- Different entity namespaces with the same creation key produce different IDs (collision safety).
- Creation keys exclude all mutable/model-generated fields.
- UUIDv5 is used with a unique namespace UUID per entity_kind.
"""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Per-entity-kind namespace UUIDs for UUIDv5 derivation.
# Each namespace is itself a UUIDv5 derived from the DNS namespace + a unique
# domain string, ensuring deterministic but collision-free ID spaces.
# ---------------------------------------------------------------------------

_SIE_ROOT_NAMESPACE = uuid.UUID("a3f1b2c4-d5e6-7890-abcd-ef1234567890")

ENTITY_NAMESPACES: dict[str, uuid.UUID] = {
    "processing_request": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.processing_request"),
    "retention_decision": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.retention_decision"),
    "proposition": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.proposition"),
    "packet": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.packet"),
    "packet_partition": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.packet_partition"),
    "packet_split": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.packet_split"),
    "concern": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.concern"),
    "association": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.association"),
    "membership": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.membership"),
    "pending_semantic_decision": uuid.uuid5(
        _SIE_ROOT_NAMESPACE, "sie.pending_semantic_decision"
    ),
}


# ---------------------------------------------------------------------------
# EntityCreationRef — the stable creation reference model
# ---------------------------------------------------------------------------


class EntityCreationRef(BaseModel):
    """Stable creation reference for an SIE entity.

    Attributes:
        entity_kind: The type/namespace of the entity (must be a key in ENTITY_NAMESPACES).
        creation_key: Stable idempotency key excluding mutable model text.
        entity_id: Namespaced opaque ID resolved deterministically from creation_key.
    """

    entity_kind: str
    creation_key: str = Field(
        description="Stable idempotency key; excludes mutable model text"
    )
    entity_id: str = Field(
        description="Namespaced opaque ID resolved from creation_key via UUIDv5"
    )


# ---------------------------------------------------------------------------
# Core ID resolution function
# ---------------------------------------------------------------------------


def resolve_entity_id(entity_kind: str, creation_key: str) -> str:
    """Resolve a stable opaque entity ID from an entity kind and creation key.

    Uses UUIDv5 with a namespace unique to the entity_kind, ensuring:
    - Same (entity_kind, creation_key) always produces the same ID.
    - Different entity_kinds with the same creation_key produce different IDs.

    Args:
        entity_kind: The entity type namespace (e.g., "proposition", "concern").
        creation_key: The stable, immutable creation key for the entity.

    Returns:
        A string representation of the deterministic UUID.

    Raises:
        ValueError: If entity_kind is not a recognized namespace.
    """
    namespace = ENTITY_NAMESPACES.get(entity_kind)
    if namespace is None:
        raise ValueError(
            f"Unknown entity_kind '{entity_kind}'. "
            f"Valid kinds: {sorted(ENTITY_NAMESPACES.keys())}"
        )
    return str(uuid.uuid5(namespace, creation_key))


def create_entity_ref(entity_kind: str, creation_key: str) -> EntityCreationRef:
    """Create an EntityCreationRef with the resolved entity ID.

    Args:
        entity_kind: The entity type namespace.
        creation_key: The stable creation key.

    Returns:
        An EntityCreationRef with entity_id resolved via UUIDv5.
    """
    entity_id = resolve_entity_id(entity_kind, creation_key)
    return EntityCreationRef(
        entity_kind=entity_kind,
        creation_key=creation_key,
        entity_id=entity_id,
    )


# ---------------------------------------------------------------------------
# Creation-key builders
#
# Each builder constructs a stable key from ONLY immutable provenance fields.
# Mutable/model-generated fields (canonical meaning, identity summary,
# display title, current summary, aliases, parent) are EXCLUDED.
# ---------------------------------------------------------------------------


def build_processing_request_key(
    conversation_id: str,
    message_seq_start: int,
    message_seq_end: int,
    pipeline_invocation_id: str,
) -> str:
    """Build a stable creation key for a processing request.

    Derived from: conversation, source message sequence range, and pipeline
    invocation identity.
    """
    return f"req:{conversation_id}:{message_seq_start}:{message_seq_end}:{pipeline_invocation_id}"


def build_retention_decision_key(
    request_id: str,
    source_message_id: str,
    sequence_position: int,
) -> str:
    """Build a stable creation key for a retention decision.

    Derived from: the request that produced it, the source message, and
    its sequence position within that request's assessment.
    """
    return f"ret:{request_id}:{source_message_id}:{sequence_position}"


def build_proposition_key(
    request_id: str,
    source_message_ids: list[str],
    extraction_unit_position: int,
) -> str:
    """Build a stable creation key for a proposition.

    Derived from: immutable source provenance and the stable extraction-unit
    position within the request. NOT from canonical wording.

    Args:
        request_id: The stable request ID that produced this extraction.
        source_message_ids: The source message UUIDs (sorted for stability).
        extraction_unit_position: The ordinal position of this proposition
            within the extraction batch for the given source messages.
    """
    sorted_ids = ",".join(sorted(source_message_ids))
    return f"prop:{request_id}:{sorted_ids}:{extraction_unit_position}"


def build_packet_key(
    request_id: str,
    partition_index: int,
) -> str:
    """Build a stable creation key for a semantic packet.

    Derived from: the request and its stable partition lineage/index.
    """
    return f"pkt:{request_id}:{partition_index}"


def build_packet_partition_key(
    parent_packet_key: str,
    child_partition_index: int,
) -> str:
    """Build a stable creation key for a packet partition (child of a split).

    Derived from: the parent packet's creation key and the child's stable
    partition index within the split.
    """
    return f"part:{parent_packet_key}:{child_partition_index}"


def build_packet_split_key(
    original_packet_id: str,
    split_ordinal: int,
) -> str:
    """Build a stable creation key for a packet split event.

    Derived from: the original packet being split and the split ordinal
    (to support multiple splits of the same packet in edge cases).
    """
    return f"split:{original_packet_id}:{split_ordinal}"


def build_concern_key(
    packet_id: str,
    identity_resolution_event_ordinal: int,
) -> str:
    """Build a stable creation key for a new Persistent Concern.

    Derived from: the packet that triggered creation and the identity-resolution
    creation event ordinal. NOT from identity summary, display title, or any
    mutable semantic text.
    """
    return f"concern:{packet_id}:{identity_resolution_event_ordinal}"


def build_association_key(
    proposition_id: str,
    concern_id: str,
    role: str,
    establishing_packet_id: str,
) -> str:
    """Build a stable creation key for a proposition-concern association.

    Derived from: the proposition, target concern, role, and the packet
    that established the association.
    """
    return f"assoc:{proposition_id}:{concern_id}:{role}:{establishing_packet_id}"


def build_membership_key(
    packet_id: str,
    proposition_id: str,
) -> str:
    """Build a stable creation key for a packet membership.

    Derived from: the packet and the proposition being included.
    """
    return f"memb:{packet_id}:{proposition_id}"


def build_pending_semantic_decision_key(
    request_id: str,
    stage: str,
    entity_id: str,
) -> str:
    """Build a stable creation key for a pending semantic decision.

    Derived from: the request that created it, the pipeline stage, and the
    entity the decision pertains to.
    """
    return f"psd:{request_id}:{stage}:{entity_id}"


# ---------------------------------------------------------------------------
# Convenience: full ref builders (creation key + resolved ID)
# ---------------------------------------------------------------------------


def create_processing_request_ref(
    conversation_id: str,
    message_seq_start: int,
    message_seq_end: int,
    pipeline_invocation_id: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a processing request."""
    key = build_processing_request_key(
        conversation_id, message_seq_start, message_seq_end, pipeline_invocation_id
    )
    return create_entity_ref("processing_request", key)


def create_retention_decision_ref(
    request_id: str,
    source_message_id: str,
    sequence_position: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a retention decision."""
    key = build_retention_decision_key(request_id, source_message_id, sequence_position)
    return create_entity_ref("retention_decision", key)


def create_proposition_ref(
    request_id: str,
    source_message_ids: list[str],
    extraction_unit_position: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a proposition."""
    key = build_proposition_key(request_id, source_message_ids, extraction_unit_position)
    return create_entity_ref("proposition", key)


def create_packet_ref(
    request_id: str,
    partition_index: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a semantic packet."""
    key = build_packet_key(request_id, partition_index)
    return create_entity_ref("packet", key)


def create_packet_partition_ref(
    parent_packet_key: str,
    child_partition_index: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a packet partition."""
    key = build_packet_partition_key(parent_packet_key, child_partition_index)
    return create_entity_ref("packet_partition", key)


def create_packet_split_ref(
    original_packet_id: str,
    split_ordinal: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a packet split event."""
    key = build_packet_split_key(original_packet_id, split_ordinal)
    return create_entity_ref("packet_split", key)


def create_concern_ref(
    packet_id: str,
    identity_resolution_event_ordinal: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a new Persistent Concern."""
    key = build_concern_key(packet_id, identity_resolution_event_ordinal)
    return create_entity_ref("concern", key)


def create_association_ref(
    proposition_id: str,
    concern_id: str,
    role: str,
    establishing_packet_id: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a proposition association."""
    key = build_association_key(
        proposition_id, concern_id, role, establishing_packet_id
    )
    return create_entity_ref("association", key)


def create_membership_ref(
    packet_id: str,
    proposition_id: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a packet membership."""
    key = build_membership_key(packet_id, proposition_id)
    return create_entity_ref("membership", key)


def create_pending_semantic_decision_ref(
    request_id: str,
    stage: str,
    entity_id: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a pending semantic decision."""
    key = build_pending_semantic_decision_key(request_id, stage, entity_id)
    return create_entity_ref("pending_semantic_decision", key)
