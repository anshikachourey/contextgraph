"""Tests for the IdentityEvaluator.

Verifies:
- Successful evaluation with grounded output produces CandidateRecords.
- Priority order: exact continuity > historical trajectory > return-path > scope.
- LLM total failure produces FAILED stage with null confidence (never LOW).
- Grounding failure produces FAILED stage with null confidence.
- No candidates produces COMPLETED with empty records.
- Confidence assignment follows the priority rubric.
- Competing candidates limit confidence.
"""

from __future__ import annotations

import pytest

from app.sie.contracts import (
    ConcernSummary,
    GraphStateContext,
    PropositionSummary,
)
from app.sie.enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    ParentResolutionState,
    PipelineOutcome,
    PropositionType,
    SemanticState,
    StageExecutionStatus,
)
from app.sie.evaluator.grounding_validator import GroundingValidator
from app.sie.evaluator.identity_evaluator import (
    IdentityEvaluationResult,
    IdentityEvaluator,
)
from app.sie.evaluator.llm_adapter import (
    BoundedLLMInvoker,
    DeterministicFakeAdapter,
    LLMAdapterResult,
)
from app.sie.identity_policy import IdentityEvaluationConfig
from app.sie.retrieval.channel_protocol import RetrievalCandidate, RetrievalResult


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_config() -> IdentityEvaluationConfig:
    """Create a minimal valid IdentityEvaluationConfig for tests."""
    return IdentityEvaluationConfig(
        config_version="1.0.0",
        primary_model="test-model",
        fallback_model=None,
        output_schema_version="1.0.0",
        max_retries_primary=2,
        max_retries_fallback=0,
        retry_backoff_ms=1,
        max_input_tokens=4096,
        max_output_tokens=1024,
        system_prompt_version="1.0.0",
        evaluation_prompt_version="1.0.0",
    )


def _make_context(
    concerns: list[ConcernSummary] | None = None,
    propositions: list[PropositionSummary] | None = None,
) -> GraphStateContext:
    """Create a minimal GraphStateContext for tests."""
    return GraphStateContext(
        graph_version=1,
        snapshot_token="test-snapshot-token",
        snapshot_digest="test-snapshot-digest",
        concerns=concerns or [],
        propositions=propositions or [],
        active_associations=[],
    )


def _make_concern(
    concern_id: str = "concern-1",
    status: ConcernStatus = ConcernStatus.ACTIVE,
) -> ConcernSummary:
    """Create a minimal ConcernSummary for tests."""
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary=f"Identity summary of {concern_id}",
        display_title=f"Title of {concern_id}",
        current_summary=f"Summary of {concern_id}",
        status=status,
        parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
        last_active_at="2024-01-01T00:00:00Z",
        semantic_version=1,
    )


def _make_proposition(
    proposition_id: str = "prop-1",
    speaker_role: str = "USER",
) -> PropositionSummary:
    """Create a minimal PropositionSummary for tests."""
    return PropositionSummary(
        proposition_id=proposition_id,
        canonical_meaning="Some proposition meaning",
        proposition_type=PropositionType.CLAIM,
        speaker_role=speaker_role,
        semantic_state=SemanticState.ACTIVE,
        message_seq_range=(1, 1),
    )


def _make_retrieval_candidate(
    concern_id: str = "concern-1",
    status: ConcernStatus = ConcernStatus.ACTIVE,
) -> RetrievalCandidate:
    """Create a RetrievalCandidate (no confidence)."""
    return RetrievalCandidate(
        concern_id=concern_id,
        lifecycle_status=status,
        contributing_attempt_ids=["attempt-1"],
    )


def _make_successful_llm_output(
    concern_id: str = "concern-1",
    exact_continuity: bool = True,
    historical_trajectory: bool = False,
    return_path_continuity: bool = False,
    scope_compatible: bool = True,
    best_match: str | None = "concern-1",
    competitors: list[str] | None = None,
    substantive_resumption: bool | None = None,
) -> dict:
    """Create a well-formed LLM evaluation output dict."""
    return {
        "candidate_assessments": [
            {
                "concern_id": concern_id,
                "supporting_evidence": [
                    {
                        "entity_id": "prop-1",
                        "entity_type": "proposition",
                        "description": "User stated same concern",
                    }
                ],
                "contrary_evidence": [],
                "exact_continuity": exact_continuity,
                "historical_trajectory": historical_trajectory,
                "return_path_continuity": return_path_continuity,
                "scope_compatible": scope_compatible,
                "substantive_resumption": substantive_resumption,
                "explanation": "Strong identity continuity established.",
            }
        ],
        "best_match_concern_id": best_match,
        "competing_candidate_ids": competitors or [],
        "explanation": "Evaluation found a clear match.",
    }


def _success_result(output: dict) -> LLMAdapterResult:
    """Create a successful LLMAdapterResult with the given output."""
    return LLMAdapterResult(
        raw_output=output,
        success=True,
        failure_reason=None,
        tokens_used=200,
        latency_ms=100,
    )


def _failure_result(reason: str = "model error") -> LLMAdapterResult:
    """Create a failed LLMAdapterResult."""
    return LLMAdapterResult(
        raw_output=None,
        success=False,
        failure_reason=reason,
        tokens_used=0,
        latency_ms=10,
    )


def _make_evaluator(
    adapter_responses: list[LLMAdapterResult],
) -> IdentityEvaluator:
    """Create an IdentityEvaluator with a fake adapter and real grounding."""
    config = _make_config()
    adapter = DeterministicFakeAdapter(adapter_responses)
    invoker = BoundedLLMInvoker(adapter, None, config)
    validator = GroundingValidator()
    return IdentityEvaluator(invoker, validator)


# ---------------------------------------------------------------------------
# Tests: Successful evaluation
# ---------------------------------------------------------------------------


class TestSuccessfulEvaluation:
    """Tests for successful evaluation producing CandidateRecords."""

    @pytest.mark.asyncio
    async def test_exact_continuity_produces_high_confidence(self) -> None:
        """Exact continuity with no competitor produces HIGH confidence."""
        output = _make_successful_llm_output(
            exact_continuity=True,
            best_match="concern-1",
            competitors=[],
        )
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [_make_retrieval_candidate("concern-1")]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.HIGH
        assert result.best_match_concern_id == "concern-1"
        assert len(result.candidate_records) == 1
        assert result.candidate_records[0].confidence == BehavioralConfidenceBand.HIGH
        assert result.candidate_records[0].concern_id == "concern-1"

    @pytest.mark.asyncio
    async def test_historical_trajectory_without_competitor_is_high(self) -> None:
        """Historical trajectory with no exact continuity and no competitor → HIGH."""
        output = _make_successful_llm_output(
            exact_continuity=False,
            historical_trajectory=True,
            best_match="concern-1",
            competitors=[],
        )
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [_make_retrieval_candidate("concern-1")]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.HIGH

    @pytest.mark.asyncio
    async def test_return_path_without_competitor_is_high(self) -> None:
        """Return-path continuity with no competitor → HIGH."""
        output = _make_successful_llm_output(
            exact_continuity=False,
            historical_trajectory=False,
            return_path_continuity=True,
            best_match="concern-1",
            competitors=[],
        )
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [_make_retrieval_candidate("concern-1")]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.HIGH

    @pytest.mark.asyncio
    async def test_scope_compatible_only_is_low(self) -> None:
        """Only scope compatibility (no continuity) produces LOW confidence."""
        output = _make_successful_llm_output(
            exact_continuity=False,
            historical_trajectory=False,
            return_path_continuity=False,
            scope_compatible=True,
            best_match="concern-1",
            competitors=[],
        )
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [_make_retrieval_candidate("concern-1")]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.LOW

    @pytest.mark.asyncio
    async def test_substantive_resumption_preserved(self) -> None:
        """Substantive resumption flag is preserved in the result."""
        output = _make_successful_llm_output(
            exact_continuity=True,
            best_match="concern-1",
            substantive_resumption=True,
        )
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1", ConcernStatus.DORMANT)],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [
            _make_retrieval_candidate("concern-1", ConcernStatus.DORMANT)
        ]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.substantive_resumption is True


# ---------------------------------------------------------------------------
# Tests: Priority order
# ---------------------------------------------------------------------------


class TestPriorityOrder:
    """Tests verifying the priority order of evaluation criteria."""

    @pytest.mark.asyncio
    async def test_exact_continuity_outranks_competitors(self) -> None:
        """Exact continuity with competitors produces MEDIUM (not HIGH)."""
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-1",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Exact continuity but competitors exist.",
                },
                {
                    "concern_id": "concern-2",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": False,
                    "historical_trajectory": True,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Historical trajectory only.",
                },
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": ["concern-2"],
            "explanation": "Multiple candidates with competing signals.",
        }
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1"), _make_concern("concern-2")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [
            _make_retrieval_candidate("concern-1"),
            _make_retrieval_candidate("concern-2"),
        ]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.COMPLETED
        # Best match has exact continuity but competitor limits to MEDIUM
        assert result.confidence == BehavioralConfidenceBand.MEDIUM
        assert result.best_match_concern_id == "concern-1"
        assert result.competing_candidate_ids == ["concern-2"]


# ---------------------------------------------------------------------------
# Tests: LLM failure
# ---------------------------------------------------------------------------


class TestLLMFailure:
    """Tests for LLM failure producing FAILED stage with null confidence."""

    @pytest.mark.asyncio
    async def test_total_llm_failure_returns_failed_status(self) -> None:
        """Total LLM failure produces FAILED stage, null confidence."""
        evaluator = _make_evaluator([
            _failure_result("model overloaded"),
            _failure_result("model overloaded"),
        ])

        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [_make_retrieval_candidate("concern-1")]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.FAILED
        assert result.confidence is None
        assert result.candidate_records == []
        assert result.best_match_concern_id is None
        assert result.failure_reason is not None
        assert "failed" in result.explanation.lower() or "failed" in (
            result.failure_reason or ""
        ).lower()

    @pytest.mark.asyncio
    async def test_llm_failure_never_produces_low_confidence(self) -> None:
        """LLM failure NEVER produces LOW confidence or novelty."""
        evaluator = _make_evaluator([_failure_result(), _failure_result()])

        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [_make_retrieval_candidate("concern-1")]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        # CRITICAL: Never fake LOW or infer novelty on failure
        assert result.confidence is None
        assert result.stage_status == StageExecutionStatus.FAILED


# ---------------------------------------------------------------------------
# Tests: Grounding failure
# ---------------------------------------------------------------------------


class TestGroundingFailure:
    """Tests for grounding validation failure."""

    @pytest.mark.asyncio
    async def test_fabricated_id_causes_failed_status(self) -> None:
        """Fabricated concern ID in LLM output causes FAILED status."""
        # Output references a concern ID not in context
        output = _make_successful_llm_output(concern_id="fabricated-concern")
        output["best_match_concern_id"] = "fabricated-concern"
        output["candidate_assessments"][0]["concern_id"] = "fabricated-concern"
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        # Only real candidate is concern-1
        candidates = [_make_retrieval_candidate("concern-1")]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.FAILED
        assert result.confidence is None
        assert "grounding" in result.explanation.lower() or "grounding" in (
            result.failure_reason or ""
        ).lower()

    @pytest.mark.asyncio
    async def test_grounding_failure_never_produces_low(self) -> None:
        """Grounding failure NEVER produces LOW confidence."""
        # Missing required fields
        output = {"missing": "everything"}
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [_make_retrieval_candidate("concern-1")]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.FAILED
        assert result.confidence is None


# ---------------------------------------------------------------------------
# Tests: No candidates
# ---------------------------------------------------------------------------


class TestNoCandidates:
    """Tests for evaluation with no candidates."""

    @pytest.mark.asyncio
    async def test_no_candidates_returns_completed_empty(self) -> None:
        """No candidates produces COMPLETED stage with empty records."""
        evaluator = _make_evaluator([])  # no adapter calls needed

        context = _make_context()
        candidates: list[RetrievalCandidate] = []
        retrieval_result = RetrievalResult(attempts=[], candidates=[])

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence is None
        assert result.candidate_records == []
        assert result.best_match_concern_id is None

    @pytest.mark.asyncio
    async def test_no_candidates_does_not_invoke_llm(self) -> None:
        """No candidates means no LLM call is made."""
        config = _make_config()
        adapter = DeterministicFakeAdapter([])  # empty = would raise if called
        invoker = BoundedLLMInvoker(adapter, None, config)
        validator = GroundingValidator()
        evaluator = IdentityEvaluator(invoker, validator)

        context = _make_context()
        candidates: list[RetrievalCandidate] = []
        retrieval_result = RetrievalResult(attempts=[], candidates=[])

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert adapter.call_count == 0


# ---------------------------------------------------------------------------
# Tests: Multiple candidates with competition
# ---------------------------------------------------------------------------


class TestMultipleCandidates:
    """Tests for evaluation with multiple competing candidates."""

    @pytest.mark.asyncio
    async def test_competitor_limits_best_match_confidence(self) -> None:
        """A competitor in competing_candidate_ids limits confidence to MEDIUM."""
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-1",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": True,
                    "return_path_continuity": True,
                    "scope_compatible": True,
                    "explanation": "Very strong match.",
                },
                {
                    "concern_id": "concern-2",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Also has exact continuity.",
                },
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": ["concern-2"],
            "explanation": "Both have exact continuity, ambiguous.",
        }
        evaluator = _make_evaluator([_success_result(output)])

        context = _make_context(
            concerns=[_make_concern("concern-1"), _make_concern("concern-2")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [
            _make_retrieval_candidate("concern-1"),
            _make_retrieval_candidate("concern-2"),
        ]
        retrieval_result = RetrievalResult(attempts=[], candidates=candidates)

        result = await evaluator.evaluate(candidates, retrieval_result, context)

        assert result.stage_status == StageExecutionStatus.COMPLETED
        # Competition limits to MEDIUM
        assert result.confidence == BehavioralConfidenceBand.MEDIUM
        assert len(result.candidate_records) == 2
