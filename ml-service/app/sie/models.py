"""Core Pydantic models for the Semantic Intelligence Engine.

This module defines the foundational data structures for SIE:
- RetentionDecision: Result of retention assessment with all roles preserved.
- SIEMessage: Input message with attachment and structured content support.
- Proposition: Smallest semantic unit with full provenance.
- ProvisionalConcernBoundary: Provisional cohesion analysis before identity resolution.
- SemanticPacket: Concern-cohesive processing unit.
- IdentityResolutionResult: Discriminated result of identity resolution.
- ConcernProposal: Proposal for a new Persistent Concern.
- PersistentConcern: Durable concern with lifecycle, merge redirects, and deferred parenthood.
- PendingSemanticDecision: Tracks pending/unresolved/deferred semantic decisions.
"""

from typing import Optional

from pydantic import BaseModel, Field, model_validator

from .enums import (
    BehavioralConfidenceBand,
    CohesionStatus,
    ConcernStatus,
    ParentResolutionState,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    ResolutionAction,
    RetentionLevel,
    SemanticState,
    StageExecutionStatus,
)
from .identity_validation import (
    validate_discriminated_result,
    validate_outcome_stage_requirements,
    validate_stage_confidence_coupling,
)


class RetentionDecision(BaseModel):
    """Result of retention assessment. All retention roles are preserved downstream."""

    decision_id: str
    decision_creation_key: str
    conversation_id: str
    primary_level: RetentionLevel
    secondary_roles: list[RetentionLevel] = Field(default_factory=list)
    confidence: BehavioralConfidenceBand
    outcome: PipelineOutcome
    source_message_ids: list[str]
    speaker_role: str  # "USER" or "ASSISTANT"
    sequence_position: int
    extraction_version: str
    assessment_version: str
    rationale: Optional[str] = None


class SIEMessage(BaseModel):
    """Input message for SIE processing.

    Supports attachments (via attachment_refs) and structured content
    (e.g., code blocks, tables) for richer semantic extraction.
    """

    message_id: str
    conversation_id: str
    role: str  # "USER" or "ASSISTANT"
    content: str
    sequence_position: int
    created_at: str
    attachment_refs: list[str] = Field(default_factory=list)
    structured_content: Optional[dict] = None


class Proposition(BaseModel):
    """Smallest semantic unit with full provenance.

    Permanent ID is resolved through the creation-key registry (not derived
    from mutable model text like canonical_meaning). All applicable retention
    levels (primary + secondary) are preserved in retention_levels.
    """

    proposition_id: str
    proposition_creation_key: str
    conversation_id: str
    source_message_ids: list[str]
    speaker_role: str
    canonical_meaning: str
    proposition_type: PropositionType
    message_seq_range: tuple[int, int]
    provenance: PropositionProvenance
    semantic_state: SemanticState = SemanticState.ACTIVE
    retention_levels: list[RetentionLevel]  # ALL applicable levels preserved
    created_at: str
    extraction_version: str
    supersedes_proposition_id: Optional[str] = None


class ProvisionalConcernBoundary(BaseModel):
    """Provisional concern-boundary analysis before identity resolution.

    Determines whether propositions likely belong to the same or different
    primary concerns. Does NOT assign final Persistent Concern ownership.
    The provisional_concern_label is descriptive text, NOT a concern ID.
    """

    boundary_id: str
    proposition_ids: list[str]
    provisional_concern_label: str  # descriptive, not a concern ID
    confidence: BehavioralConfidenceBand
    rationale: Optional[str] = None


class SemanticPacket(BaseModel):
    """Concern-cohesive processing unit with retry-stable creation lineage.

    A packet is NOT automatically a graph object. It groups propositions for
    identity resolution. Cohesion must be validated before proceeding to
    identity resolution.
    """

    packet_id: str
    packet_creation_key: str
    conversation_id: str
    source_message_ids: list[str]  # inherited from constituent propositions
    message_seq_range: tuple[int, int]
    user_grounded_meaning: str
    assistant_context: Optional[str] = None
    continuation_origin: Optional[str] = None
    provenance: str
    packet_formation_version: str
    cohesion_status: CohesionStatus
    provisional_boundaries: list[ProvisionalConcernBoundary] = Field(
        default_factory=list
    )


class ConcernProposal(BaseModel):
    """Proposal for a new Persistent Concern from identity resolution.

    The proposed_concern_id is an opaque ID resolved from concern_creation_key
    through the entity registry. Parent resolution defaults to PARENT_DEFERRED.
    """

    concern_creation_key: str
    proposed_concern_id: str  # opaque ID resolved from concern_creation_key
    identity_summary: str
    display_title: str
    initial_summary: str
    proposed_parent_id: Optional[str] = None
    parent_resolution_state: ParentResolutionState = (
        ParentResolutionState.PARENT_DEFERRED
    )


class IdentityResolutionResult(BaseModel):
    """Result of identity resolution (performed in Python).

    Enforces the discriminated-result invariant per the finalized design:
    - YES/ASSIGN_EXISTING: matched_concern_id IS NOT NULL,
      new_concern_proposal IS NULL. Requires completed identity stage
      with HIGH confidence.
    - NO/PROPOSE_NEW: matched_concern_id IS NULL,
      new_concern_proposal IS NOT NULL. Requires completed sufficiency
      stage with HIGH confidence.
    - Pending outcomes (UNRESOLVED, DEFER, RETRIEVAL_INCONCLUSIVE,
      REQUIRES_VALIDATION): both matched_concern_id and
      new_concern_proposal must be None.

    Stage-status/confidence coupling:
    - COMPLETED stage requires non-null confidence.
    - NOT_RUN or FAILED stage requires null confidence.
    """

    packet_id: str
    outcome: PipelineOutcome
    action: ResolutionAction
    matched_concern_id: Optional[str] = None
    new_concern_proposal: Optional[ConcernProposal] = None
    identity_stage_status: StageExecutionStatus
    identity_confidence: Optional[BehavioralConfidenceBand] = None
    sufficiency_stage_status: StageExecutionStatus
    sufficiency_confidence: Optional[BehavioralConfidenceBand] = None
    candidates_considered: list[str] = Field(default_factory=list)
    rationale: str

    @model_validator(mode="after")
    def validate_identity_result(self) -> "IdentityResolutionResult":
        """Enforce all discriminated-result, stage-coupling, and outcome invariants."""
        # 1. Stage-confidence coupling for both stages
        validate_stage_confidence_coupling(
            self.identity_stage_status,
            self.identity_confidence,
            stage_name="identity_stage",
        )
        validate_stage_confidence_coupling(
            self.sufficiency_stage_status,
            self.sufficiency_confidence,
            stage_name="sufficiency_stage",
        )

        # 2. Discriminated result: outcome ↔ concern IDs
        validate_discriminated_result(
            self.outcome,
            self.matched_concern_id,
            self.new_concern_proposal is not None,
        )

        # 3. Outcome-specific stage requirements
        validate_outcome_stage_requirements(
            self.outcome,
            self.identity_stage_status,
            self.identity_confidence,
            self.sufficiency_stage_status,
            self.sufficiency_confidence,
        )

        return self


class PersistentConcern(BaseModel):
    """Durable concern state with lifecycle, merge redirects, and deferred parenthood.

    Lifecycle semantics:
    - ACTIVE/DORMANT: same semantic identity; dormancy never removes from retrieval.
    - RETIRED: historically queryable, may be reactivated if genuinely resumed.
    - MERGED: retains source ID as redirect to merged_into_concern_id.

    Parent-resolution semantics:
    - ROOT_CONFIRMED: canonical_parent_id must be None (legitimate root).
    - PARENT_DEFERRED: canonical_parent_id must be None (parent unresolved).
    - PARENT_ASSIGNED: canonical_parent_id must be set.
    """

    concern_id: str
    conversation_id: str
    identity_summary: str
    display_title: str
    current_summary: str
    status: ConcernStatus
    created_at: str
    last_active_at: str
    canonical_parent_id: Optional[str] = None
    parent_resolution_state: ParentResolutionState
    semantic_version: int
    merged_into_concern_id: Optional[str] = None
    aliases: list[str] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_concern_invariants(self) -> "PersistentConcern":
        """Enforce concern lifecycle and parent-resolution invariants.

        - MERGED status requires merged_into_concern_id.
        - Non-MERGED status requires merged_into_concern_id to be None.
        - PARENT_ASSIGNED requires canonical_parent_id.
        - ROOT_CONFIRMED/PARENT_DEFERRED require canonical_parent_id=None.
        """
        # Merge redirect invariant
        if self.status == ConcernStatus.MERGED:
            if self.merged_into_concern_id is None:
                raise ValueError(
                    "PersistentConcern with status=MERGED must have "
                    "merged_into_concern_id set."
                )
        else:
            if self.merged_into_concern_id is not None:
                raise ValueError(
                    f"PersistentConcern with status={self.status.value} "
                    "must not have merged_into_concern_id set."
                )

        # Parent-resolution invariant
        if self.parent_resolution_state == ParentResolutionState.PARENT_ASSIGNED:
            if self.canonical_parent_id is None:
                raise ValueError(
                    "PersistentConcern with parent_resolution_state=PARENT_ASSIGNED "
                    "must have canonical_parent_id set."
                )
        else:
            # ROOT_CONFIRMED or PARENT_DEFERRED
            if self.canonical_parent_id is not None:
                raise ValueError(
                    f"PersistentConcern with parent_resolution_state="
                    f"{self.parent_resolution_state.value} "
                    "must have canonical_parent_id=None."
                )

        return self


# Valid lifecycle states for PendingSemanticDecision
_VALID_LIFECYCLE_STATES = frozenset({"pending", "unresolved", "deferred", "resolved"})


class PendingSemanticDecision(BaseModel):
    """Tracks pending, unresolved, or deferred semantic decisions.

    These represent decisions that could not be fully resolved during a pipeline
    invocation and must be persisted for later resolution. Examples include:
    - Unresolved identity resolution (no confident match, no confident new-concern).
    - Deferred cohesion analysis requiring additional context.
    - Pending ownership assignment awaiting structural validation.

    Lifecycle states:
    - pending: decision created, awaiting first resolution attempt.
    - unresolved: resolution attempted but failed (e.g., retrieval inconclusive).
    - deferred: explicitly deferred for later processing with more context.
    - resolved: decision resolved in a later pipeline invocation.
    """

    decision_id: str
    decision_creation_key: str
    conversation_id: str
    stage: str  # pipeline stage that created this decision
    entity_creation_key: str  # creation key of the entity this decision pertains to
    outcome: PipelineOutcome
    lifecycle_state: str  # "pending" | "unresolved" | "deferred" | "resolved"
    originating_request_id: str
    dependency_refs: list[str] = Field(default_factory=list)
    resolution_metadata: Optional[dict] = None
    rationale: Optional[str] = None
    created_at: str
    resolved_at: Optional[str] = None

    @model_validator(mode="after")
    def validate_lifecycle_state(self) -> "PendingSemanticDecision":
        """Ensure lifecycle_state is one of the allowed values."""
        if self.lifecycle_state not in _VALID_LIFECYCLE_STATES:
            raise ValueError(
                f"lifecycle_state must be one of {sorted(_VALID_LIFECYCLE_STATES)}, "
                f"got '{self.lifecycle_state}'."
            )
        return self
