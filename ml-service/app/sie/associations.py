"""Normalized association models for the SIE data model.

These models replace ID arrays on concerns with explicit, versioned, auditable
association records. Key design decisions:

- PropositionAssociation is the SINGLE association type for all roles including
  supporting evidence — there is no second independently persisted link type.
- A proposition MAY have multiple associations with different roles (e.g.,
  PRIMARY_OWNER of concern A and SUPPORTING_EVIDENCE for concern B).
- PacketMembership never introduces new source provenance — source comes from
  the proposition itself.
- PacketSplitRecord preserves split lineage; child packets inherit provenance
  from their constituent propositions.
- Invalidation creates a new association event rather than mutating historical
  records — historical associations remain auditable.
"""

from typing import Optional

from pydantic import BaseModel, Field

from .enums import AssociationRole, BehavioralConfidenceBand, SemanticState


class PropositionAssociation(BaseModel):
    """Normalized association between a proposition and a concern.

    A proposition may have multiple associations with different roles.
    A proposition MAY be both PRIMARY_OWNER of one concern and
    SUPPORTING_EVIDENCE for another — roles are per-association, not per-proposition.

    Supporting evidence is modeled as a role-constrained PropositionAssociation
    (role in {SUPPORTING_EVIDENCE, EMERGENCE_EVIDENCE, CONTEXT, CROSS_OBJECT_IMPACT}),
    not as a separate independently persisted type. The same semantic link must never
    be written once as a proposition association and again as a separate evidence record.

    Invalidation/replacement semantics:
    - Re-establishing a previously invalidated association creates a NEW association
      event with a new creation key rather than colliding with the historical ID.
    - An association can be reassigned (role changed, concern changed) via semantic
      repair — the old association is marked INVALIDATED and a new one created.
    - Historical associations remain auditable; they are never overwritten.

    Attributes:
        association_id: Opaque permanent ID resolved from association_creation_key.
        association_creation_key: Retry-stable event key resolved through the
            entity registry. Excludes mutable semantic text.
        proposition_id: The proposition being associated.
        concern_id: The target concern.
        role: The semantic role of this association (PRIMARY_OWNER,
            SUPPORTING_EVIDENCE, EMERGENCE_EVIDENCE, CONTEXT, CROSS_OBJECT_IMPACT).
        confidence: Behavioral confidence band for this association.
        provenance: How this association was established (free-form description
            of the establishment mechanism, e.g., "identity_resolution",
            "cross_object_impact_analysis", "semantic_repair").
        established_by_packet_id: Which packet caused this association to be
            established. Nullable — may be None for associations established
            through repair or migration.
        semantic_state: Lifecycle state. ACTIVE associations are current;
            SUPERSEDED/INVALIDATED associations are historical records.
        created_at: ISO 8601 timestamp of association creation.
        version: Monotonically increasing version for this association record.
    """

    association_id: str
    association_creation_key: str = Field(
        description="Retry-stable event key resolved through the entity registry"
    )
    proposition_id: str
    concern_id: str
    role: AssociationRole
    confidence: BehavioralConfidenceBand
    provenance: str = Field(
        description="How this association was established"
    )
    established_by_packet_id: Optional[str] = Field(
        default=None,
        description="Which packet established this association; nullable for repair/migration",
    )
    semantic_state: SemanticState = SemanticState.ACTIVE
    created_at: str
    version: int = 1


class PacketMembership(BaseModel):
    """Normalized membership of a proposition in a packet.

    Source provenance is INHERITED from the proposition — packet membership
    never introduces new source provenance. The source message IDs, speaker role,
    and extraction provenance all come from the proposition itself.

    Attributes:
        membership_id: Opaque permanent ID resolved from membership_creation_key.
        membership_creation_key: Retry-stable key derived from packet and
            proposition creation keys plus ordinal position.
        packet_id: The packet this membership belongs to.
        proposition_id: The proposition that is a member of the packet.
        ordinal: Position of this proposition within the packet (0-indexed).
        created_at: ISO 8601 timestamp of membership creation.
    """

    membership_id: str
    membership_creation_key: str = Field(
        description="Retry-stable key derived from packet + proposition creation keys + ordinal"
    )
    packet_id: str
    proposition_id: str
    ordinal: int = Field(
        description="Position within packet (0-indexed)",
        ge=0,
    )
    created_at: str


class PacketSplitRecord(BaseModel):
    """Records a packet split event.

    Child packets inherit source provenance from their constituent propositions —
    no new source provenance is introduced by the split. The split record preserves
    lineage so the relationship between original and resulting packets is traceable.

    At the persistence layer, resulting_packet_ids is expanded into normalized
    split-edge rows sharing one split_event_id; each edge receives its own
    split_edge_id. This model represents the API-level split event.

    Attributes:
        split_id: Opaque permanent ID resolved from split_creation_key.
        split_creation_key: Retry-stable key derived from the request and
            original packet creation key.
        original_packet_id: The packet that was split.
        resulting_packet_ids: The child packets produced by the split.
        split_reason: Human-readable reason for the split (e.g., "mixed_cohesion",
            "independent_concerns_detected").
        created_at: ISO 8601 timestamp of when the split occurred.
    """

    split_id: str
    split_creation_key: str = Field(
        description="Retry-stable key derived from request + original packet creation key"
    )
    original_packet_id: str
    resulting_packet_ids: list[str] = Field(
        description="Child packet IDs produced by the split",
        min_length=2,
    )
    split_reason: str
    created_at: str
