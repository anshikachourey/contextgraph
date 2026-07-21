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

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Per-entity-kind namespace UUIDs for UUIDv5 derivation.
# Each namespace is itself a UUIDv5 derived from a fixed root namespace + a unique
# domain string, ensuring deterministic but collision-free ID spaces.
# ---------------------------------------------------------------------------

_SIE_ROOT_NAMESPACE = uuid.UUID("a3f1b2c4-d5e6-7890-abcd-ef1234567890")

ENTITY_NAMESPACES: dict[str, uuid.UUID] = {
    "processing_request": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.processing_request"),
    "retention_decision": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.retention_decision"),
    "proposition": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.proposition"),
    "packet": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.packet"),
    "packet_split": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.packet_split"),
    "concern": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.concern"),
    "association": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.association"),
    "membership": uuid.uuid5(_SIE_ROOT_NAMESPACE, "sie.membership"),
    "pending_semantic_decision": uuid.uuid5(
        _SIE_ROOT_NAMESPACE, "sie.pending_semantic_decision"
    ),
    "identity_resolution_record": uuid.uuid5(
        _SIE_ROOT_NAMESPACE, "sie.identity_resolution_record"
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
#
# Key patterns (from design):
#   request:           f"{conversation_id}:{message_seq_start}-{message_seq_end}:{pipeline_version}"
#   retention_decision: f"{request_id}:{source_message_id}:{sequence_position}"
#   proposition:       f"{request_id}:{extraction_unit_position}"
#   packet:            f"{request_id}:{partition_key}"
#   packet_split:      f"{request_id}:{original_packet_creation_key}:{child_partition_index}"
#   concern:           f"{packet_creation_key}:{identity_resolution_event}"
#   association:       f"{request_id}:{proposition_creation_key}:{concern_id}:{role}"
#   membership:        f"{packet_creation_key}:{proposition_creation_key}:{ordinal}"
#   pending_decision:  f"{request_id}:{stage}:{entity_creation_key}"
# ---------------------------------------------------------------------------


def build_processing_request_key(
    conversation_id: str,
    message_seq_start: int,
    message_seq_end: int,
    pipeline_version: str,
) -> str:
    """Build a stable creation key for a processing request.

    Pattern: f"{conversation_id}:{message_seq_start}-{message_seq_end}:{pipeline_version}"

    Derived from: conversation, source message sequence range, and pipeline version.
    """
    return f"{conversation_id}:{message_seq_start}-{message_seq_end}:{pipeline_version}"


def build_retention_decision_key(
    request_id: str,
    source_message_id: str,
    sequence_position: int,
) -> str:
    """Build a stable creation key for a retention decision.

    Pattern: f"{request_id}:{source_message_id}:{sequence_position}"

    Derived from: the request that produced it, the source message, and
    its sequence position within that request's assessment.
    """
    return f"{request_id}:{source_message_id}:{sequence_position}"


def build_proposition_key(
    request_id: str,
    extraction_unit_position: int,
) -> str:
    """Build a stable creation key for a proposition.

    Pattern: f"{request_id}:{extraction_unit_position}"

    Derived from: the request and the stable extraction-unit position.
    NOT from canonical meaning or any mutable model text.
    """
    return f"{request_id}:{extraction_unit_position}"


def build_packet_key(
    request_id: str,
    partition_key: str,
) -> str:
    """Build a stable creation key for a semantic packet.

    Pattern: f"{request_id}:{partition_key}"

    Derived from: the request and its stable partition key.
    """
    return f"{request_id}:{partition_key}"


def build_packet_split_key(
    request_id: str,
    original_packet_creation_key: str,
    child_partition_index: int,
) -> str:
    """Build a stable creation key for a packet split (child of a split).

    Pattern: f"{request_id}:{original_packet_creation_key}:{child_partition_index}"

    Derived from: the request, the original packet's creation key, and the
    child's stable partition index within the split.
    """
    return f"{request_id}:{original_packet_creation_key}:{child_partition_index}"


def build_concern_key(
    packet_creation_key: str,
    identity_resolution_event: str,
) -> str:
    """Build a stable creation key for a new Persistent Concern.

    Pattern: f"{packet_creation_key}:{identity_resolution_event}"

    Derived from: the packet creation key that triggered creation and the
    identity-resolution event identifier. NOT from identity summary, display
    title, or any mutable semantic text.
    """
    return f"{packet_creation_key}:{identity_resolution_event}"


def build_association_key(
    request_id: str,
    proposition_creation_key: str,
    concern_id: str,
    role: str,
) -> str:
    """Build a stable creation key for a proposition-concern association.

    Pattern: f"{request_id}:{proposition_creation_key}:{concern_id}:{role}"

    Derived from: the request, the proposition's creation key, target concern,
    and role.
    """
    return f"{request_id}:{proposition_creation_key}:{concern_id}:{role}"


def build_membership_key(
    packet_creation_key: str,
    proposition_creation_key: str,
    ordinal: int,
) -> str:
    """Build a stable creation key for a packet membership.

    Pattern: f"{packet_creation_key}:{proposition_creation_key}:{ordinal}"

    Derived from: the packet's creation key, the proposition's creation key,
    and the ordinal position within the packet.
    """
    return f"{packet_creation_key}:{proposition_creation_key}:{ordinal}"


def build_pending_semantic_decision_key(
    request_id: str,
    stage: str,
    entity_creation_key: str,
) -> str:
    """Build a stable creation key for a pending semantic decision.

    Pattern: f"{request_id}:{stage}:{entity_creation_key}"

    Derived from: the request that created it, the pipeline stage, and the
    entity creation key the decision pertains to.
    """
    return f"{request_id}:{stage}:{entity_creation_key}"


# ---------------------------------------------------------------------------
# Convenience: full ref builders (creation key + resolved ID)
# ---------------------------------------------------------------------------


def create_processing_request_ref(
    conversation_id: str,
    message_seq_start: int,
    message_seq_end: int,
    pipeline_version: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a processing request."""
    key = build_processing_request_key(
        conversation_id, message_seq_start, message_seq_end, pipeline_version
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
    extraction_unit_position: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a proposition."""
    key = build_proposition_key(request_id, extraction_unit_position)
    return create_entity_ref("proposition", key)


def create_packet_ref(
    request_id: str,
    partition_key: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a semantic packet."""
    key = build_packet_key(request_id, partition_key)
    return create_entity_ref("packet", key)


def create_packet_split_ref(
    request_id: str,
    original_packet_creation_key: str,
    child_partition_index: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a packet split."""
    key = build_packet_split_key(
        request_id, original_packet_creation_key, child_partition_index
    )
    return create_entity_ref("packet_split", key)


def create_concern_ref(
    packet_creation_key: str,
    identity_resolution_event: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a new Persistent Concern."""
    key = build_concern_key(packet_creation_key, identity_resolution_event)
    return create_entity_ref("concern", key)


def create_association_ref(
    request_id: str,
    proposition_creation_key: str,
    concern_id: str,
    role: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a proposition association."""
    key = build_association_key(request_id, proposition_creation_key, concern_id, role)
    return create_entity_ref("association", key)


def create_membership_ref(
    packet_creation_key: str,
    proposition_creation_key: str,
    ordinal: int,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a packet membership."""
    key = build_membership_key(packet_creation_key, proposition_creation_key, ordinal)
    return create_entity_ref("membership", key)


def create_pending_semantic_decision_ref(
    request_id: str,
    stage: str,
    entity_creation_key: str,
) -> EntityCreationRef:
    """Create a full EntityCreationRef for a pending semantic decision."""
    key = build_pending_semantic_decision_key(request_id, stage, entity_creation_key)
    return create_entity_ref("pending_semantic_decision", key)
