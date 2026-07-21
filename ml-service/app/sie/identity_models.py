"""Canonical models for SIE identity resolution.

This module defines the authoritative Pydantic models for:
- EvidenceReference and ChannelDiagnostic (shared value types)
- IRSSignal (intelligent retrieval signals)
- RetrievalAttemptRecord (per-attempt diagnostics)
- CandidateRecord (evaluated candidate with contributing attempts)
- SufficiencyRecord (retrieval adequacy judgment)
- WideningBudget (adaptive widening budget tracking)
- IdentityResolutionRecord (complete append-only decision record)

Design authority: design-corrections.md (consolidated final design).
"""

from pydantic import BaseModel, model_validator

from .enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    IRSSignalType,
    PipelineOutcome,
    ResolutionAction,
    RetrievalAttemptStatus,
    StageExecutionStatus,
)
from .identity_validation import (
    validate_discriminated_result,
    validate_outcome_stage_requirements,
    validate_stage_confidence_coupling,
)


# ---------------------------------------------------------------------------
# Shared value types
# ---------------------------------------------------------------------------


class EvidenceReference(BaseModel):
    """A reference to grounding evidence used in identity evaluation.

    Points to a stable entity (proposition, concern, etc.) and optionally
    a source-message span for audit traceability.
    """

    entity_id: str
    entity_type: str
    source_message_id: str | None = None
    span_start: int | None = None
    span_end: int | None = None
    description: str | None = None


class ChannelDiagnostic(BaseModel):
    """Channel-local diagnostic score or metadata.

    Retrieval scores are channel-local diagnostics only.
    No score, rank, or threshold can directly cause YES.
    """

    channel_id: str
    metric_name: str
    metric_value: float | None = None
    detail: str | None = None


# ---------------------------------------------------------------------------
# IRS Signal
# ---------------------------------------------------------------------------


class IRSSignal(BaseModel):
    """An Intelligent Retrieval Signal indicating a retrieval gap or concern.

    Every signal must be grounded in source evidence.
    """

    signal_type: IRSSignalType
    confidence: BehavioralConfidenceBand
    source_evidence: list[EvidenceReference]
    explanation: str
    resolved: bool
    resolved_by_attempt_ids: list[str]


# ---------------------------------------------------------------------------
# Retrieval Attempt Record
# ---------------------------------------------------------------------------


class RetrievalAttemptRecord(BaseModel):
    """Record of a single retrieval attempt with full diagnostics.

    candidate_count must equal len(candidate_ids).
    query_mode, query_reference, and scope_description are required.
    """

    attempt_id: str
    channel_id: str
    channel_family: str
    query_mode: str
    query_reference: str
    scope_description: str
    status: RetrievalAttemptStatus
    candidate_ids: list[str]
    candidate_count: int
    latency_ms: int | None = None
    failure_reason: str | None = None
    retrieval_policy_version: str
    triggered_by_signal: IRSSignalType | None = None

    @model_validator(mode="after")
    def validate_candidate_count(self) -> "RetrievalAttemptRecord":
        """Enforce candidate_count == len(candidate_ids)."""
        if self.candidate_count != len(self.candidate_ids):
            raise ValueError(
                f"candidate_count ({self.candidate_count}) must equal "
                f"len(candidate_ids) ({len(self.candidate_ids)})"
            )
        return self


# ---------------------------------------------------------------------------
# Candidate Record
# ---------------------------------------------------------------------------


class CandidateRecord(BaseModel):
    """An evaluated identity candidate with contributing retrieval attempts.

    Uses contributing_attempt_ids (not contributing_channels).
    Uses confidence (not confidence_band).
    """

    concern_id: str
    lifecycle_status: ConcernStatus
    resolved_merge_target: str | None = None
    contributing_attempt_ids: list[str]
    channel_local_diagnostics: list[ChannelDiagnostic]
    identity_evidence: list[EvidenceReference]
    contrary_evidence: list[EvidenceReference]
    confidence: BehavioralConfidenceBand
    explanation: str


# ---------------------------------------------------------------------------
# Sufficiency Record
# ---------------------------------------------------------------------------


class SufficiencyRecord(BaseModel):
    """Record of retrieval-sufficiency assessment.

    Adequacy requires:
    - All policy-required channel families completed successfully.
    - Every material HIGH/MEDIUM IRS signal addressed.
    - No failed attempt could plausibly conceal a match.
    - Required lifecycle and historical scopes covered.
    """

    stage_status: StageExecutionStatus
    confidence: BehavioralConfidenceBand | None = None
    coverage_summary: str
    unresolved_signals: list[IRSSignal]
    failed_coverage_gaps: list[str]
    rationale: str

    @model_validator(mode="after")
    def validate_stage_confidence(self) -> "SufficiencyRecord":
        """COMPLETED requires non-null confidence; NOT_RUN/FAILED require null."""
        if self.stage_status == StageExecutionStatus.COMPLETED:
            if self.confidence is None:
                raise ValueError(
                    "SufficiencyRecord with stage_status=COMPLETED "
                    "must have non-null confidence."
                )
        else:
            if self.confidence is not None:
                raise ValueError(
                    f"SufficiencyRecord with stage_status={self.stage_status.value} "
                    "must have null confidence."
                )
        return self


# ---------------------------------------------------------------------------
# Widening Budget
# ---------------------------------------------------------------------------


class WideningBudget(BaseModel):
    """Tracks adaptive widening budget consumption.

    All limits come from approved versioned configuration with no defaults.
    Budget exhaustion before adequacy produces RETRIEVAL_INCONCLUSIVE or DEFER.
    """

    max_rounds: int
    max_attempts: int
    max_latency_ms: int
    max_cost_units: float
    rounds_used: int
    attempts_used: int
    latency_used_ms: int
    cost_used: float
    exhausted: bool


# ---------------------------------------------------------------------------
# Identity Resolution Record
# ---------------------------------------------------------------------------


class IdentityResolutionRecord(BaseModel):
    """Complete append-only identity resolution decision record.

    Stores the full reasoning, diagnostics, and version-bound context for
    one packet's identity resolution. This is the first-class record returned
    in ProcessResult.identity_resolution_records.

    Stage confidence rules:
    - COMPLETED stage status requires non-null confidence.
    - NOT_RUN/FAILED stage status requires null confidence.
    """

    record_id: str
    request_id: str
    idempotency_key: str
    conversation_id: str
    packet_id: str
    proposition_ids: list[str]
    graph_version_analyzed: int
    graph_snapshot_token: str
    outcome: PipelineOutcome
    action: ResolutionAction
    identity_stage_status: StageExecutionStatus
    identity_confidence: BehavioralConfidenceBand | None = None
    sufficiency_stage_status: StageExecutionStatus
    sufficiency_confidence: BehavioralConfidenceBand | None = None
    matched_concern_id: str | None = None
    proposed_concern_id: str | None = None
    candidates_considered: list[CandidateRecord]
    irs_signals: list[IRSSignal]
    retrieval_attempts: list[RetrievalAttemptRecord]
    evidence_references: list[EvidenceReference]
    reasoning: str
    semantic_policy_version: str
    retrieval_policy_version: str
    model_config_version: str
    prompt_version: str
    proposed_dependency_group_id: str | None = None

    @model_validator(mode="after")
    def validate_stage_confidence_invariants(self) -> "IdentityResolutionRecord":
        """Enforce all identity-resolution invariants:

        1. Stage-status/confidence coupling (COMPLETED ↔ non-null confidence).
        2. Discriminated result (outcome ↔ matched/proposed concern IDs).
        3. Outcome-specific stage requirements (YES→HIGH identity, NO→HIGH sufficiency).
        """
        # 1. Stage-confidence coupling
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
            self.proposed_concern_id is not None,
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
