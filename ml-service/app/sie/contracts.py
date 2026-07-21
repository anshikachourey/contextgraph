"""Request/response contract models for the SIE Python–TypeScript API boundary.

These models define the versioned contract between the TypeScript orchestrator
and the Python ml-service for the /sie/process-messages endpoint.

Contract invariants:
- current_graph_state.graph_version must equal base_graph_version.
- TypeScript must reject a result whose request, conversation, sequence range,
  contract version, or base graph version does not match the invocation.
- A version conflict requires fresh graph retrieval and re-invocation of Python.
- Stale semantic results are never blindly replayed.
"""

import hashlib
import json
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from .associations import PacketMembership, PacketSplitRecord, PropositionAssociation
from .enums import (
    AssociationRole,
    ConcernStatus,
    ParentResolutionState,
    PipelineOutcome,
    ProcessingMode,
    PropositionType,
    SemanticState,
)
from .identity_models import IdentityResolutionRecord
from .models import (
    ConcernProposal,
    IdentityResolutionResult,
    Proposition,
    RetentionDecision,
    SemanticPacket,
    SIEMessage,
)


class ConcernEmbedding(BaseModel):
    """Version-matched embedding for a concern used in identity retrieval.

    Embeddings are bound to a specific graph version, embedding model version,
    and source text hash. Stale embeddings (where source text or model has changed)
    are excluded from context and marked unavailable.
    """

    concern_id: str
    embedding: list[float]
    source_text_hash: str
    embedding_model_version: str
    graph_version: int


class ConcernAlias(BaseModel):
    """Normalized alias for a concern used in alias-based retrieval.

    Aliases are normalized forms of how a concern has been referenced
    across conversation history.
    """

    concern_id: str
    alias_text: str
    normalized_form: str


class PendingIdentityDetailSummary(BaseModel):
    """Summary of a pending identity decision provided as graph-state context.

    Surfaced so Python can account for prior unresolved identity decisions
    when evaluating new packets — e.g., avoiding duplicate proposals or
    recognizing that earlier evidence now resolves a pending decision.
    """

    decision_id: str
    packet_id: str
    outcome: PipelineOutcome
    proposition_ids: list[str]
    graph_version_analyzed: int


class PacketLineageSummary(BaseModel):
    """Summary of packet split/merge lineage for graph-state context.

    Tracks how packets were derived from splits so identity resolution
    can reason about shared provenance across sibling packets.
    """

    packet_id: str
    split_from_packet_id: str | None = None
    split_reason: str | None = None


class ConcernSummary(BaseModel):
    """Summary of a Persistent Concern provided as graph-state context.

    Includes enough information for Python to perform identity resolution
    without needing to query the database directly.
    """

    concern_id: str
    identity_summary: str
    display_title: str
    current_summary: str
    status: ConcernStatus
    aliases: list[str] = Field(default_factory=list)
    canonical_parent_id: Optional[str] = None
    parent_resolution_state: ParentResolutionState
    last_active_at: str
    semantic_version: int


class PropositionSummary(BaseModel):
    """Summary of an existing proposition provided as graph-state context."""

    proposition_id: str
    canonical_meaning: str
    proposition_type: PropositionType
    speaker_role: str
    semantic_state: SemanticState
    message_seq_range: tuple[int, int]


class AssociationSummary(BaseModel):
    """Summary of an active association provided as graph-state context."""

    association_id: str
    proposition_id: str
    concern_id: str
    role: AssociationRole
    semantic_state: SemanticState


class PendingDecisionSummary(BaseModel):
    """Summary of a pending/unresolved/deferred semantic decision.

    Surfaced in GraphStateContext so Python can account for prior unresolved
    decisions when making new semantic judgments. Examples include:
    - Unresolved identity resolution from a prior invocation.
    - Deferred cohesion analysis awaiting additional context.
    - Pending ownership assignment awaiting structural validation.
    """

    entity_id: str
    stage: str
    outcome: PipelineOutcome
    rationale: Optional[str] = None


class GraphStateContext(BaseModel):
    """Graph state provided by TypeScript for Python to reason over.

    Contains the current state of concerns, propositions, associations, and
    pending decisions. The graph_version must match the base_graph_version
    in the enclosing ProcessRequest.

    Extended fields for identity resolution:
    - snapshot_token: Opaque token binding the exact graph state snapshot.
    - snapshot_digest: Hash of snapshot content for payload fingerprinting.
    - concern_embeddings: Version-matched embeddings for retrieval.
    - normalized_aliases: Normalized concern aliases for alias-based retrieval.
    - pending_identity_details: Pending identity decisions with full detail.
    - privacy_suppressed_concern_ids: IDs of suppressed concerns (already excluded).
    - packet_lineage: Packet split/merge lineage summaries.
    """

    graph_version: int
    snapshot_token: str = Field(
        description="Opaque token binding the exact graph state snapshot"
    )
    snapshot_digest: str = Field(
        description="Hash of snapshot content for fingerprinting"
    )
    concerns: list[ConcernSummary]
    propositions: list[PropositionSummary]
    active_associations: list[AssociationSummary]
    pending_decisions: list[PendingDecisionSummary] = Field(default_factory=list)
    concern_embeddings: list[ConcernEmbedding] = Field(default_factory=list)
    normalized_aliases: list[ConcernAlias] = Field(default_factory=list)
    pending_identity_details: list[PendingIdentityDetailSummary] = Field(
        default_factory=list
    )
    privacy_suppressed_concern_ids: list[str] = Field(default_factory=list)
    packet_lineage: list[PacketLineageSummary] = Field(default_factory=list)


class ProcessRequest(BaseModel):
    """Full semantic processing pipeline request.

    Input: messages + current graph state (concerns, associations).
    Python performs ALL semantic decisions. TypeScript only needs to validate
    structural invariants and commit.

    Contract invariant: current_graph_state.graph_version == base_graph_version.

    The processing_mode controls which pipeline stages execute:
    - FULL_PIPELINE: All stages from extraction through identity resolution.
    - IDENTITY_RESOLUTION_ONLY: Requires complete proposition detail and all
      primary/secondary retention roles pre-supplied.
    - PENDING_RE_EVALUATION: Re-evaluate previously pending identity decisions.
    """

    api_contract_version: str
    pipeline_version: str
    model_version: str
    extraction_version: str
    request_id: str
    idempotency_key: str
    conversation_id: str
    base_graph_version: int
    message_seq_start: int
    message_seq_end: int
    messages: list[SIEMessage]
    context_window: list[SIEMessage] = Field(default_factory=list)
    current_graph_state: GraphStateContext
    processing_mode: ProcessingMode = ProcessingMode.FULL_PIPELINE
    semantic_policy_version: str = Field(
        description="Version of the semantic evaluation policy governing this request"
    )
    retrieval_policy_version: str = Field(
        description="Version of the retrieval policy governing channel plans"
    )

    @model_validator(mode="after")
    def validate_graph_version_consistency(self) -> "ProcessRequest":
        """Enforce that current_graph_state.graph_version == base_graph_version.

        This ensures the graph state provided to Python is consistent with
        the base version the orchestrator intends to commit against.
        """
        if self.current_graph_state.graph_version != self.base_graph_version:
            raise ValueError(
                f"current_graph_state.graph_version ({self.current_graph_state.graph_version}) "
                f"must equal base_graph_version ({self.base_graph_version}). "
                "A version mismatch indicates stale graph state."
            )
        return self


class PipelineDiagnostics(BaseModel):
    """Diagnostics from the semantic processing pipeline.

    Includes stage versions for traceability, any warnings generated during
    processing, and entity IDs that were deferred for later resolution.
    """

    stage_versions: dict[str, str]
    warnings: list[str] = Field(default_factory=list)
    deferred_entity_ids: list[str] = Field(default_factory=list)


_VALID_FAILURE_POLICIES = frozenset({"ALL_OR_NONE", "INDEPENDENT", "DERIVED"})


class SemanticDependencyGroupRef(BaseModel):
    """Transport-level grouping for semantic dependency groups.

    Full mutation semantics are defined by the evolution/integration
    specification. The failure_policy determines how failures within
    the group are handled:
    - ALL_OR_NONE: all mutations succeed or all are rolled back.
    - INDEPENDENT: mutations are independent; partial success is acceptable.
    - DERIVED: mutations are derived from a parent; failure propagates.
    """

    group_id: str
    mutation_refs: list[str]
    failure_policy: str  # ALL_OR_NONE, INDEPENDENT, or DERIVED

    @model_validator(mode="after")
    def validate_failure_policy(self) -> "SemanticDependencyGroupRef":
        """Ensure failure_policy is one of the allowed values."""
        if self.failure_policy not in _VALID_FAILURE_POLICIES:
            raise ValueError(
                f"failure_policy must be one of {sorted(_VALID_FAILURE_POLICIES)}, "
                f"got '{self.failure_policy}'."
            )
        return self


class ProcessResult(BaseModel):
    """Full semantic processing pipeline result.

    Contains all semantic decisions made by Python: retention decisions,
    propositions, packets, memberships, splits, identity resolutions,
    new concern proposals, proposed associations, dependency groups,
    and pipeline diagnostics.

    The identity_resolution_records field is the first-class append-only
    decision record for identity resolution — not hidden in diagnostics.
    identity_mutations and identity_dependency_groups carry proposed
    identity-specific mutations and their atomic grouping.
    """

    api_contract_version: str
    pipeline_version: str
    model_version: str
    extraction_version: str
    request_id: str
    idempotency_key: str
    conversation_id: str
    base_graph_version: int
    lowest_seq: int
    highest_seq: int
    retention_decisions: list[RetentionDecision]
    propositions: list[Proposition]
    packets: list[SemanticPacket]
    packet_memberships: list[PacketMembership]
    splits: list[PacketSplitRecord]
    identity_resolutions: list[IdentityResolutionResult]
    identity_resolution_records: list[IdentityResolutionRecord] = Field(
        default_factory=list,
        description="First-class append-only identity resolution decision records",
    )
    identity_mutations: list[dict] = Field(
        default_factory=list,
        description="Proposed identity mutations (concern creation, reactivation, merge)",
    )
    identity_dependency_groups: list[SemanticDependencyGroupRef] = Field(
        default_factory=list,
        description="Identity-specific semantic dependency groups",
    )
    new_concern_proposals: list[ConcernProposal]
    proposed_associations: list[PropositionAssociation]
    dependency_groups: list[SemanticDependencyGroupRef] = Field(default_factory=list)
    diagnostics: PipelineDiagnostics


# ---------------------------------------------------------------------------
# Canonical payload fingerprint
# ---------------------------------------------------------------------------


class PayloadFingerprint(BaseModel):
    """Canonical payload fingerprint for idempotency and stale-result detection.

    The payload fingerprint is SEPARATE from semantic request identity. Semantic
    request identity determines whether two requests represent the same logical
    creation event (and is stable across retries and graph-version reanalysis).
    The payload fingerprint additionally binds the exact analysis inputs —
    graph version, snapshot digest, policy/model versions — so that materially
    different inputs cannot reuse an idempotency result.

    Two requests with the same semantic request identity but different payload
    fingerprints represent the same logical event analyzed with different inputs
    (e.g., after a graph-version conflict and fresh retrieval). The later
    fingerprint supersedes the earlier one.

    The content_hash is computed from the ordered, deterministic JSON serialization
    of all fingerprint fields except content_hash itself.
    """

    conversation_id: str
    processing_mode: ProcessingMode
    base_graph_version: int
    snapshot_digest: str
    ordered_packet_ids: list[str] = Field(
        description="Deterministically ordered packet IDs included in this request"
    )
    policy_versions: dict[str, str] = Field(
        description="Map of policy domain to version (e.g., semantic, retrieval, budget)"
    )
    model_versions: dict[str, str] = Field(
        description="Map of model role to version (e.g., primary, fallback, extraction)"
    )
    content_hash: str = Field(
        description="SHA-256 hash of the deterministic serialization of all other fields"
    )

    @model_validator(mode="after")
    def validate_content_hash(self) -> "PayloadFingerprint":
        """Validate that content_hash matches the deterministic hash of all other fields."""
        expected = self._compute_content_hash()
        if self.content_hash != expected:
            raise ValueError(
                f"content_hash mismatch: expected '{expected}', got '{self.content_hash}'. "
                "The fingerprint content_hash must be the SHA-256 of the canonical "
                "JSON serialization of all other fields."
            )
        return self

    def _compute_content_hash(self) -> str:
        """Compute the deterministic content hash from all fields except content_hash."""
        canonical = {
            "conversation_id": self.conversation_id,
            "processing_mode": self.processing_mode.value,
            "base_graph_version": self.base_graph_version,
            "snapshot_digest": self.snapshot_digest,
            "ordered_packet_ids": self.ordered_packet_ids,
            "policy_versions": dict(sorted(self.policy_versions.items())),
            "model_versions": dict(sorted(self.model_versions.items())),
        }
        serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @classmethod
    def create(
        cls,
        *,
        conversation_id: str,
        processing_mode: ProcessingMode,
        base_graph_version: int,
        snapshot_digest: str,
        ordered_packet_ids: list[str],
        policy_versions: dict[str, str],
        model_versions: dict[str, str],
    ) -> "PayloadFingerprint":
        """Factory method that computes content_hash automatically.

        Use this instead of direct construction to ensure correct hashing.
        """
        canonical = {
            "conversation_id": conversation_id,
            "processing_mode": processing_mode.value,
            "base_graph_version": base_graph_version,
            "snapshot_digest": snapshot_digest,
            "ordered_packet_ids": ordered_packet_ids,
            "policy_versions": dict(sorted(policy_versions.items())),
            "model_versions": dict(sorted(model_versions.items())),
        }
        serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        content_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()

        return cls(
            conversation_id=conversation_id,
            processing_mode=processing_mode,
            base_graph_version=base_graph_version,
            snapshot_digest=snapshot_digest,
            ordered_packet_ids=ordered_packet_ids,
            policy_versions=policy_versions,
            model_versions=model_versions,
            content_hash=content_hash,
        )
