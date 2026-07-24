"""Semantic identity evaluator for SIE identity resolution.

This module implements the core identity evaluation stage that determines
whether a packet continues an existing concern using LLM-based structured
evaluation with deterministic grounding validation.

Design authority: design-corrections.md §8.1–§8.4.

Key contract rules:
- Uses BoundedLLMInvoker for LLM calls with structured output.
- Priority order: exact continuity > historical trajectory >
  return-path continuity > semantic scope compatibility.
- Retrieval similarity is diagnostic context only — never proof of ownership.
- RetrievalCandidate (from retrieval layer) carries NO confidence.
- The evaluator assigns confidence AFTER semantic evaluation.
- Produces CandidateRecord (with confidence) only after successful
  evaluation + grounding validation.
- On LLM/grounding total failure: stage_status=FAILED with null confidence.
  NEVER fake LOW or novelty.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..contracts import GraphStateContext
from ..enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    StageExecutionStatus,
)
from ..identity_models import (
    CandidateRecord,
    ChannelDiagnostic,
    EvidenceReference,
)
from ..identity_policy import IdentityEvaluationConfig
from ..retrieval.channel_protocol import RetrievalCandidate, RetrievalResult
from .confidence_evaluator import (
    BehavioralConfidenceEvaluator,
    IdentitySignals,
)
from .grounding_validator import GroundingContext, GroundingResult, GroundingValidator
from .llm_adapter import BoundedInvocationResult, BoundedLLMInvoker


# ---------------------------------------------------------------------------
# Structured output models for the LLM evaluation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CandidateAssessment:
    """Assessment of one candidate concern by the evaluator.

    Each assessment captures the priority-order evaluation criteria and
    evidence for/against identity continuity.

    Attributes:
        concern_id: The candidate concern ID being assessed.
        supporting_evidence: Evidence supporting identity continuity.
        contrary_evidence: Evidence against identity continuity.
        exact_continuity: Whether exact concern continuity was established.
        historical_trajectory: Whether historical trajectory continuity holds.
        return_path_continuity: Whether return-path continuity holds.
        scope_compatible: Whether semantic scope is compatible.
        substantive_resumption: Whether this is a substantive resumption
            (relevant for dormant/retired concerns). None if not applicable.
        explanation: Concise semantic justification for the assessment.
    """

    concern_id: str
    supporting_evidence: list[EvidenceReference]
    contrary_evidence: list[EvidenceReference]
    exact_continuity: bool
    historical_trajectory: bool
    return_path_continuity: bool
    scope_compatible: bool
    substantive_resumption: bool | None
    explanation: str


@dataclass(frozen=True)
class EvaluationOutput:
    """Parsed and validated output from the LLM evaluation.

    Attributes:
        candidate_assessments: Per-candidate evaluations.
        best_match_concern_id: The concern with strongest continuity, or None.
        competing_candidate_ids: IDs of candidates that materially compete.
        explanation: Overall evaluation explanation.
    """

    candidate_assessments: list[CandidateAssessment]
    best_match_concern_id: str | None
    competing_candidate_ids: list[str]
    explanation: str


# ---------------------------------------------------------------------------
# Identity evaluation result
# ---------------------------------------------------------------------------


@dataclass
class IdentityEvaluationResult:
    """Result of the identity evaluation stage.

    On success: stage_status=COMPLETED, confidence is set, candidate_records populated.
    On failure: stage_status=FAILED, confidence=None, NEVER fake LOW or novelty.

    Attributes:
        stage_status: Whether evaluation completed, failed, or was not run.
        confidence: The best-match confidence (None if stage did not complete).
        candidate_records: Evaluated candidates with assigned confidence bands.
        best_match_concern_id: The uniquely actionable match (if any).
        competing_candidate_ids: Materially competing concern IDs.
        substantive_resumption: Whether the best match is a substantive resumption.
        evaluation_output: The full parsed evaluation output (None on failure).
        invocation_result: The raw bounded invocation result for diagnostics.
        explanation: Human-readable summary of the evaluation.
        failure_reason: Why the evaluation failed (None on success).
    """

    stage_status: StageExecutionStatus
    confidence: BehavioralConfidenceBand | None = None
    candidate_records: list[CandidateRecord] = field(default_factory=list)
    best_match_concern_id: str | None = None
    competing_candidate_ids: list[str] = field(default_factory=list)
    substantive_resumption: bool | None = None
    evaluation_output: EvaluationOutput | None = None
    invocation_result: BoundedInvocationResult | None = None
    explanation: str = ""
    failure_reason: str | None = None


# ---------------------------------------------------------------------------
# IdentityEvaluator
# ---------------------------------------------------------------------------


# The structured output schema sent to the LLM for evaluation.
EVALUATION_OUTPUT_SCHEMA: dict = {
    "type": "object",
    "required": [
        "candidate_assessments",
        "best_match_concern_id",
        "competing_candidate_ids",
        "explanation",
    ],
    "properties": {
        "candidate_assessments": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "concern_id",
                    "supporting_evidence",
                    "contrary_evidence",
                    "exact_continuity",
                    "historical_trajectory",
                    "return_path_continuity",
                    "scope_compatible",
                    "explanation",
                ],
                "properties": {
                    "concern_id": {"type": "string"},
                    "supporting_evidence": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["entity_id", "entity_type"],
                            "properties": {
                                "entity_id": {"type": "string"},
                                "entity_type": {"type": "string"},
                                "description": {"type": ["string", "null"]},
                            },
                        },
                    },
                    "contrary_evidence": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["entity_id", "entity_type"],
                            "properties": {
                                "entity_id": {"type": "string"},
                                "entity_type": {"type": "string"},
                                "description": {"type": ["string", "null"]},
                            },
                        },
                    },
                    "exact_continuity": {"type": "boolean"},
                    "historical_trajectory": {"type": "boolean"},
                    "return_path_continuity": {"type": "boolean"},
                    "scope_compatible": {"type": "boolean"},
                    "substantive_resumption": {"type": ["boolean", "null"]},
                    "explanation": {"type": "string"},
                },
            },
        },
        "best_match_concern_id": {"type": ["string", "null"]},
        "competing_candidate_ids": {
            "type": "array",
            "items": {"type": "string"},
        },
        "explanation": {"type": "string"},
    },
}


class IdentityEvaluator:
    """Evaluates identity continuity between a packet and candidate concerns.

    Uses BoundedLLMInvoker for LLM calls with structured output contract.
    Applies deterministic grounding validation to LLM output.

    Priority order for evaluation:
    1. Exact concern continuity
    2. Historical trajectory
    3. Return-path continuity
    4. Semantic scope compatibility
    5. Retrieval similarity (diagnostic context only)

    On successful LLM call + valid grounding: produce CandidateRecords with
    behavioral confidence assigned by the confidence evaluator.

    On failure (LLM exhaustion or grounding total failure):
    stage_status=FAILED with null confidence. NEVER fake LOW or novelty.
    """

    def __init__(
        self,
        invoker: BoundedLLMInvoker,
        grounding_validator: GroundingValidator,
        *,
        confidence_evaluator: BehavioralConfidenceEvaluator | None = None,
        version: str = "1.0.0",
    ) -> None:
        """Initialize the identity evaluator.

        Args:
            invoker: Bounded LLM invoker with retry/fallback orchestration.
            grounding_validator: Deterministic grounding validation.
            confidence_evaluator: Standalone confidence evaluator. If None,
                a default instance is created (stateless, safe to share).
            version: Version identifier for this evaluator.
        """
        self._invoker = invoker
        self._grounding_validator = grounding_validator
        self._confidence_evaluator = (
            confidence_evaluator or BehavioralConfidenceEvaluator()
        )
        self._version = version

    @property
    def version(self) -> str:
        """Version identifier for this evaluator."""
        return self._version

    async def evaluate(
        self,
        retrieval_candidates: list[RetrievalCandidate],
        retrieval_result: RetrievalResult,
        context: GraphStateContext,
    ) -> IdentityEvaluationResult:
        """Evaluate identity match between packet content and candidates.

        This is the core semantic evaluation stage. It:
        1. Builds prompts from the candidates and context.
        2. Invokes the LLM via the bounded invoker.
        3. Validates output grounding against the request context.
        4. Applies the confidence rubric to produce CandidateRecords.

        On total failure, returns FAILED with null confidence.
        On success, returns COMPLETED with confidence and CandidateRecords.

        Args:
            retrieval_candidates: Candidates from retrieval (NO confidence).
            retrieval_result: Full retrieval result with attempt diagnostics.
            context: Immutable graph state context.

        Returns:
            IdentityEvaluationResult with stage status and records.
        """
        # If no candidates, evaluation is trivially completed with no match
        if not retrieval_candidates:
            return IdentityEvaluationResult(
                stage_status=StageExecutionStatus.COMPLETED,
                confidence=None,
                candidate_records=[],
                best_match_concern_id=None,
                competing_candidate_ids=[],
                explanation="No candidates to evaluate.",
            )

        # Build grounding context from the request data
        grounding_ctx = self._build_grounding_context(
            retrieval_candidates, context
        )

        # Build prompts
        system_prompt = self._build_system_prompt()
        user_prompt = self._build_user_prompt(retrieval_candidates, context)

        # Invoke LLM with bounded retry/fallback
        invocation_result = await self._invoker.invoke_with_retry(
            system_prompt, user_prompt, EVALUATION_OUTPUT_SCHEMA
        )

        # Handle total LLM failure
        if not invocation_result.success:
            return IdentityEvaluationResult(
                stage_status=StageExecutionStatus.FAILED,
                confidence=None,
                candidate_records=[],
                best_match_concern_id=None,
                competing_candidate_ids=[],
                invocation_result=invocation_result,
                explanation="LLM evaluation failed after all retry attempts.",
                failure_reason=invocation_result.failure_reason,
            )

        # Validate grounding
        raw_output = invocation_result.output
        assert raw_output is not None  # guaranteed by success=True

        grounding_result = self._grounding_validator.validate(
            raw_output, grounding_ctx
        )

        # Handle grounding failure
        if not grounding_result.valid:
            violation_details = "; ".join(
                v.detail for v in grounding_result.violations
            )
            return IdentityEvaluationResult(
                stage_status=StageExecutionStatus.FAILED,
                confidence=None,
                candidate_records=[],
                best_match_concern_id=None,
                competing_candidate_ids=[],
                invocation_result=invocation_result,
                explanation=(
                    f"Grounding validation failed: {violation_details}"
                ),
                failure_reason=f"Grounding validation failed: {violation_details}",
            )

        # Parse validated output into typed structures
        evaluation_output = self._parse_evaluation_output(raw_output)

        # Build CandidateRecords with confidence assigned
        candidate_records = self._build_candidate_records(
            evaluation_output, retrieval_candidates
        )

        # Determine overall confidence from the best match
        best_confidence = self._determine_best_confidence(
            evaluation_output, candidate_records
        )

        # Determine substantive resumption for the best match
        substantive_resumption = self._get_substantive_resumption(
            evaluation_output
        )

        return IdentityEvaluationResult(
            stage_status=StageExecutionStatus.COMPLETED,
            confidence=best_confidence,
            candidate_records=candidate_records,
            best_match_concern_id=evaluation_output.best_match_concern_id,
            competing_candidate_ids=evaluation_output.competing_candidate_ids,
            substantive_resumption=substantive_resumption,
            evaluation_output=evaluation_output,
            invocation_result=invocation_result,
            explanation=evaluation_output.explanation,
        )

    # -----------------------------------------------------------------------
    # Private methods
    # -----------------------------------------------------------------------

    def _build_grounding_context(
        self,
        candidates: list[RetrievalCandidate],
        context: GraphStateContext,
    ) -> GroundingContext:
        """Build grounding context from the request data."""
        # Collect valid concern IDs from context
        valid_concern_ids = frozenset(
            c.concern_id for c in context.concerns
        )

        # Collect valid proposition IDs
        valid_proposition_ids = frozenset(
            p.proposition_id for p in context.propositions
        )

        # Collect valid message IDs from propositions
        valid_message_ids: set[str] = set()
        for p in context.propositions:
            if hasattr(p, "source_message_id") and p.source_message_id:
                valid_message_ids.add(p.source_message_id)

        # Candidate concern IDs are the ones presented to the LLM
        candidate_concern_ids = frozenset(c.concern_id for c in candidates)

        # Assistant proposition IDs
        assistant_proposition_ids: set[str] = set()
        for p in context.propositions:
            if hasattr(p, "speaker_role") and p.speaker_role == "ASSISTANT":
                assistant_proposition_ids.add(p.proposition_id)

        return GroundingContext(
            valid_concern_ids=valid_concern_ids,
            valid_proposition_ids=valid_proposition_ids,
            valid_message_ids=frozenset(valid_message_ids),
            candidate_concern_ids=candidate_concern_ids,
            assistant_proposition_ids=frozenset(assistant_proposition_ids),
        )

    def _build_system_prompt(self) -> str:
        """Build the system prompt for identity evaluation."""
        return (
            "You are an identity-continuity evaluator for a semantic knowledge graph. "
            "Your task is to evaluate whether a packet of semantic content continues "
            "an existing persistent concern or represents a novel concern.\n\n"
            "Priority order for evaluation:\n"
            "1. Exact concern continuity — the packet explicitly continues the same concern\n"
            "2. Historical trajectory — the packet follows the historical trajectory of the concern\n"
            "3. Return-path continuity — the concern is the coherent location to which the "
            "user would return to continue the same unresolved concern\n"
            "4. Semantic scope compatibility — the packet's scope is compatible with the concern\n"
            "5. Retrieval similarity — diagnostic context only, never proof of ownership\n\n"
            "Rules:\n"
            "- Exact continuity outranks broader topical compatibility\n"
            "- Temporal distance does not break identity continuity\n"
            "- State changes do not create new identities\n"
            "- Assistant-authored content cannot independently establish user concerns\n"
            "- Only reference entity IDs that exist in the provided context\n"
            "- Provide grounded evidence references for all claims"
        )

    def _build_user_prompt(
        self,
        candidates: list[RetrievalCandidate],
        context: GraphStateContext,
    ) -> str:
        """Build the user prompt describing candidates and context."""
        # Build candidate descriptions from context concerns
        candidate_descriptions: list[str] = []
        concern_map = {c.concern_id: c for c in context.concerns}

        for candidate in candidates:
            concern = concern_map.get(candidate.concern_id)
            if concern:
                desc = (
                    f"- Concern {candidate.concern_id}: "
                    f"status={candidate.lifecycle_status.value}, "
                    f"summary='{concern.current_summary}'"
                )
            else:
                desc = (
                    f"- Concern {candidate.concern_id}: "
                    f"status={candidate.lifecycle_status.value}"
                )
            candidate_descriptions.append(desc)

        candidates_text = "\n".join(candidate_descriptions)

        return (
            f"Evaluate the following candidates for identity continuity:\n\n"
            f"Candidates:\n{candidates_text}\n\n"
            f"Assess each candidate using the priority order. "
            f"For each, determine exact_continuity, historical_trajectory, "
            f"return_path_continuity, and scope_compatible. "
            f"Identify the best match (if any) and any competing candidates."
        )

    def _parse_evaluation_output(self, raw_output: dict) -> EvaluationOutput:
        """Parse validated raw output into typed EvaluationOutput."""
        assessments: list[CandidateAssessment] = []

        for raw_assessment in raw_output["candidate_assessments"]:
            supporting = [
                EvidenceReference(
                    entity_id=e["entity_id"],
                    entity_type=e["entity_type"],
                    description=e.get("description"),
                )
                for e in raw_assessment.get("supporting_evidence", [])
            ]
            contrary = [
                EvidenceReference(
                    entity_id=e["entity_id"],
                    entity_type=e["entity_type"],
                    description=e.get("description"),
                )
                for e in raw_assessment.get("contrary_evidence", [])
            ]

            assessments.append(
                CandidateAssessment(
                    concern_id=raw_assessment["concern_id"],
                    supporting_evidence=supporting,
                    contrary_evidence=contrary,
                    exact_continuity=raw_assessment["exact_continuity"],
                    historical_trajectory=raw_assessment["historical_trajectory"],
                    return_path_continuity=raw_assessment["return_path_continuity"],
                    scope_compatible=raw_assessment["scope_compatible"],
                    substantive_resumption=raw_assessment.get(
                        "substantive_resumption"
                    ),
                    explanation=raw_assessment["explanation"],
                )
            )

        return EvaluationOutput(
            candidate_assessments=assessments,
            best_match_concern_id=raw_output["best_match_concern_id"],
            competing_candidate_ids=raw_output["competing_candidate_ids"],
            explanation=raw_output["explanation"],
        )

    def _build_candidate_records(
        self,
        evaluation_output: EvaluationOutput,
        retrieval_candidates: list[RetrievalCandidate],
    ) -> list[CandidateRecord]:
        """Build CandidateRecords with confidence from evaluation assessments.

        Confidence is assigned by the evaluator based on the priority rubric:
        - HIGH: exact continuity or strong trajectory with no competing candidate
        - MEDIUM: partial continuity or meaningful competition
        - LOW: only scope compatibility or insufficient evidence
        """
        # Map retrieval candidates for lookup
        retrieval_map = {
            rc.concern_id: rc for rc in retrieval_candidates
        }

        records: list[CandidateRecord] = []
        for assessment in evaluation_output.candidate_assessments:
            retrieval_candidate = retrieval_map.get(assessment.concern_id)
            if retrieval_candidate is None:
                continue

            # Assign confidence based on priority rubric
            confidence = self._assign_confidence(
                assessment, evaluation_output
            )

            records.append(
                CandidateRecord(
                    concern_id=assessment.concern_id,
                    lifecycle_status=retrieval_candidate.lifecycle_status,
                    resolved_merge_target=None,
                    contributing_attempt_ids=retrieval_candidate.contributing_attempt_ids,
                    channel_local_diagnostics=[],
                    identity_evidence=assessment.supporting_evidence,
                    contrary_evidence=assessment.contrary_evidence,
                    confidence=confidence,
                    explanation=assessment.explanation,
                )
            )

        return records

    def _assign_confidence(
        self,
        assessment: CandidateAssessment,
        evaluation_output: EvaluationOutput,
    ) -> BehavioralConfidenceBand:
        """Assign behavioral confidence based on the priority rubric.

        Delegates to the standalone BehavioralConfidenceEvaluator for
        consistent, independently testable confidence assignment.

        Priority order determines confidence:
        - Exact continuity with no material competitor → HIGH
        - Historical trajectory or return-path continuity without exact → MEDIUM
          (unless there's no competitor, in which case it can be HIGH)
        - Only scope compatibility → LOW

        Material competition (being in competing_candidate_ids) limits confidence.
        """
        is_best_match = (
            evaluation_output.best_match_concern_id == assessment.concern_id
        )
        has_competitors = len(evaluation_output.competing_candidate_ids) > 0

        signals = IdentitySignals(
            exact_continuity=assessment.exact_continuity,
            historical_trajectory=assessment.historical_trajectory,
            return_path_continuity=assessment.return_path_continuity,
            scope_compatible=assessment.scope_compatible,
            is_best_match=is_best_match,
            has_material_competitor=has_competitors,
        )

        result = self._confidence_evaluator.evaluate_identity(signals)
        return result.band

    def _determine_best_confidence(
        self,
        evaluation_output: EvaluationOutput,
        candidate_records: list[CandidateRecord],
    ) -> BehavioralConfidenceBand | None:
        """Determine the overall best-match confidence.

        Returns the confidence of the best-match candidate, or None if
        no best match was identified.
        """
        if evaluation_output.best_match_concern_id is None:
            return None

        for record in candidate_records:
            if record.concern_id == evaluation_output.best_match_concern_id:
                return record.confidence

        return None

    def _get_substantive_resumption(
        self, evaluation_output: EvaluationOutput
    ) -> bool | None:
        """Get substantive_resumption flag for the best match."""
        if evaluation_output.best_match_concern_id is None:
            return None

        for assessment in evaluation_output.candidate_assessments:
            if assessment.concern_id == evaluation_output.best_match_concern_id:
                return assessment.substantive_resumption

        return None
