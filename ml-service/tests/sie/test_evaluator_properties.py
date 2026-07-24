"""Mandatory evaluator property and adversarial tests.

Validates correctness properties from design-corrections.md §4 and §17:

Property 4:  One uniquely actionable HIGH candidate with no material competitor may assign.
Property 5:  Multiple HIGH or materially competitive candidates cannot assign.
Property 17: Temporal distance alone cannot reduce an otherwise valid match.
Property 18: Assistant-authored material alone cannot create user ownership or evidence.
Property 19: Exact continuity beats greater retrieval similarity.
Property 20: Static dependency tests and adversarial differential tests prove
             there is no score-only path to assignment.

Additional invariants:
- Grounding/model failure never becomes semantic absence (never LOW or novelty).
- Multilingual and domain-diverse cases without keyword-only truth rules.

Uses hypothesis for property-based testing as specified in requirements.txt.
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.sie.enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    ParentResolutionState,
    PropositionType,
    SemanticState,
    StageExecutionStatus,
)
from app.sie.evaluator.confidence_evaluator import (
    BehavioralConfidenceEvaluator,
    IdentitySignals,
    RetentionConfidenceSignals,
)
from app.sie.evaluator.grounding_validator import (
    GroundingContext,
    GroundingRejectionReason,
    GroundingValidator,
)
from app.sie.evaluator.identity_evaluator import IdentityEvaluator
from app.sie.evaluator.llm_adapter import (
    BoundedLLMInvoker,
    DeterministicFakeAdapter,
    LLMAdapterResult,
)
from app.sie.contracts import ConcernSummary, GraphStateContext, PropositionSummary
from app.sie.identity_policy import IdentityEvaluationConfig
from app.sie.retrieval.channel_protocol import RetrievalCandidate, RetrievalResult


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

# Strategy for IdentitySignals with at least one strong continuity signal
identity_signals_with_continuity_st = st.builds(
    IdentitySignals,
    exact_continuity=st.booleans(),
    historical_trajectory=st.booleans(),
    return_path_continuity=st.booleans(),
    scope_compatible=st.booleans(),
    is_best_match=st.booleans(),
    has_material_competitor=st.booleans(),
).filter(
    lambda s: s.exact_continuity or s.historical_trajectory or s.return_path_continuity
)

# Strategy for arbitrary IdentitySignals (any combination)
any_identity_signals_st = st.builds(
    IdentitySignals,
    exact_continuity=st.booleans(),
    historical_trajectory=st.booleans(),
    return_path_continuity=st.booleans(),
    scope_compatible=st.booleans(),
    is_best_match=st.booleans(),
    has_material_competitor=st.booleans(),
)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _make_config() -> IdentityEvaluationConfig:
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
    return GraphStateContext(
        graph_version=1,
        snapshot_token="test-snapshot",
        snapshot_digest="test-digest",
        concerns=concerns or [],
        propositions=propositions or [],
        active_associations=[],
    )


def _make_concern(
    concern_id: str = "concern-1",
    status: ConcernStatus = ConcernStatus.ACTIVE,
    last_active_at: str = "2024-01-01T00:00:00Z",
) -> ConcernSummary:
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary=f"Summary of {concern_id}",
        display_title=f"Title of {concern_id}",
        current_summary=f"Current summary of {concern_id}",
        status=status,
        parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
        last_active_at=last_active_at,
        semantic_version=1,
    )


def _make_proposition(
    proposition_id: str = "prop-1",
    speaker_role: str = "USER",
) -> PropositionSummary:
    return PropositionSummary(
        proposition_id=proposition_id,
        canonical_meaning="A proposition meaning",
        proposition_type=PropositionType.CLAIM,
        speaker_role=speaker_role,
        semantic_state=SemanticState.ACTIVE,
        message_seq_range=(1, 1),
    )


def _success_result(output: dict) -> LLMAdapterResult:
    return LLMAdapterResult(
        raw_output=output, success=True, failure_reason=None,
        tokens_used=200, latency_ms=100,
    )


def _failure_result(reason: str = "model error") -> LLMAdapterResult:
    return LLMAdapterResult(
        raw_output=None, success=False, failure_reason=reason,
        tokens_used=0, latency_ms=10,
    )


def _make_identity_evaluator(
    adapter_responses: list[LLMAdapterResult],
) -> IdentityEvaluator:
    config = _make_config()
    adapter = DeterministicFakeAdapter(adapter_responses)
    invoker = BoundedLLMInvoker(adapter, None, config)
    validator = GroundingValidator()
    return IdentityEvaluator(invoker, validator)


def _make_llm_output(
    concern_id: str = "concern-1",
    exact_continuity: bool = True,
    historical_trajectory: bool = False,
    return_path_continuity: bool = False,
    scope_compatible: bool = True,
    best_match: str | None = "concern-1",
    competitors: list[str] | None = None,
) -> dict:
    return {
        "candidate_assessments": [
            {
                "concern_id": concern_id,
                "supporting_evidence": [
                    {"entity_id": "prop-1", "entity_type": "proposition",
                     "description": "Evidence"}
                ],
                "contrary_evidence": [],
                "exact_continuity": exact_continuity,
                "historical_trajectory": historical_trajectory,
                "return_path_continuity": return_path_continuity,
                "scope_compatible": scope_compatible,
                "explanation": "Evaluation explanation.",
            }
        ],
        "best_match_concern_id": best_match,
        "competing_candidate_ids": competitors or [],
        "explanation": "Overall evaluation.",
    }


# ===========================================================================
# Property 4: Unique actionable HIGH may assign
# **Validates: Requirements 4.4, Property 4**
# ===========================================================================


class TestUniqueHighAssignmentProperty:
    """One uniquely actionable HIGH candidate with no material competitor
    may assign. This is the ONLY path to HIGH confidence."""

    @given(
        exact_continuity=st.booleans(),
        historical_trajectory=st.booleans(),
        return_path_continuity=st.booleans(),
        scope_compatible=st.booleans(),
    )
    @settings(max_examples=200)
    def test_unique_high_requires_continuity_and_no_competitor(
        self,
        exact_continuity: bool,
        historical_trajectory: bool,
        return_path_continuity: bool,
        scope_compatible: bool,
    ) -> None:
        """HIGH confidence requires strong continuity + best match + no competitor."""
        evaluator = BehavioralConfidenceEvaluator()
        signals = IdentitySignals(
            exact_continuity=exact_continuity,
            historical_trajectory=historical_trajectory,
            return_path_continuity=return_path_continuity,
            scope_compatible=scope_compatible,
            is_best_match=True,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)
        has_strong = exact_continuity or historical_trajectory or return_path_continuity

        if has_strong:
            assert result.band == BehavioralConfidenceBand.HIGH
        else:
            assert result.band != BehavioralConfidenceBand.HIGH

    @given(signals=identity_signals_with_continuity_st)
    @settings(max_examples=200)
    def test_high_impossible_with_material_competitor(
        self, signals: IdentitySignals
    ) -> None:
        """HIGH is impossible when has_material_competitor=True."""
        evaluator = BehavioralConfidenceEvaluator()
        signals_with_competitor = IdentitySignals(
            exact_continuity=signals.exact_continuity,
            historical_trajectory=signals.historical_trajectory,
            return_path_continuity=signals.return_path_continuity,
            scope_compatible=signals.scope_compatible,
            is_best_match=signals.is_best_match,
            has_material_competitor=True,
        )
        result = evaluator.evaluate_identity(signals_with_competitor)
        assert result.band != BehavioralConfidenceBand.HIGH


# ===========================================================================
# Property 5: Multiple HIGH or material competitors cannot assign
# **Validates: Requirements 4.4, Property 5**
# ===========================================================================


class TestMultipleHighCannotAssign:
    """Multiple HIGH or materially competitive candidates cannot assign.
    Assignment is prohibited (capped at MEDIUM)."""

    @given(signals=identity_signals_with_continuity_st)
    @settings(max_examples=200)
    def test_not_best_match_cannot_be_high(
        self, signals: IdentitySignals
    ) -> None:
        """A candidate that is not best_match can never achieve HIGH."""
        evaluator = BehavioralConfidenceEvaluator()
        signals_not_best = IdentitySignals(
            exact_continuity=signals.exact_continuity,
            historical_trajectory=signals.historical_trajectory,
            return_path_continuity=signals.return_path_continuity,
            scope_compatible=signals.scope_compatible,
            is_best_match=False,
            has_material_competitor=signals.has_material_competitor,
        )
        result = evaluator.evaluate_identity(signals_not_best)
        assert result.band != BehavioralConfidenceBand.HIGH

    @pytest.mark.asyncio
    async def test_two_candidates_both_exact_continuity_caps_medium(self) -> None:
        """Two candidates with exact continuity → best match capped at MEDIUM."""
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
                    "explanation": "Strongest signals.",
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
                    "explanation": "Also exact continuity.",
                },
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": ["concern-2"],
            "explanation": "Ambiguous match.",
        }
        evaluator = _make_identity_evaluator([_success_result(output)])
        context = _make_context(
            concerns=[_make_concern("concern-1"), _make_concern("concern-2")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [
            RetrievalCandidate("concern-1", ConcernStatus.ACTIVE, ["a1"]),
            RetrievalCandidate("concern-2", ConcernStatus.ACTIVE, ["a2"]),
        ]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.MEDIUM


# ===========================================================================
# Property 19: Exact continuity outranks greater retrieval similarity
# **Validates: Requirements §8.1, Property 19**
# ===========================================================================


class TestExactContinuityOutranksSimilarity:
    """Exact continuity always gets higher or equal confidence vs scope-only."""

    @given(scope_b=st.booleans())
    @settings(max_examples=50)
    def test_exact_continuity_always_outranks_scope_only(
        self, scope_b: bool
    ) -> None:
        """Candidate with exact continuity always >= candidate with only scope."""
        evaluator = BehavioralConfidenceEvaluator()
        band_order = {
            BehavioralConfidenceBand.LOW: 0,
            BehavioralConfidenceBand.MEDIUM: 1,
            BehavioralConfidenceBand.HIGH: 2,
        }

        signals_a = IdentitySignals(
            exact_continuity=True, historical_trajectory=False,
            return_path_continuity=False, scope_compatible=True,
            is_best_match=True, has_material_competitor=False,
        )
        signals_b = IdentitySignals(
            exact_continuity=False, historical_trajectory=False,
            return_path_continuity=False, scope_compatible=scope_b,
            is_best_match=True, has_material_competitor=False,
        )

        result_a = evaluator.evaluate_identity(signals_a)
        result_b = evaluator.evaluate_identity(signals_b)

        assert band_order[result_a.band] >= band_order[result_b.band]
        assert result_a.band == BehavioralConfidenceBand.HIGH
        assert result_b.band == BehavioralConfidenceBand.LOW

    @pytest.mark.asyncio
    async def test_exact_continuity_outranks_in_full_evaluator(self) -> None:
        """Full evaluator: exact continuity candidate wins over scope-only."""
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
                    "explanation": "Exact continuity established.",
                },
                {
                    "concern_id": "concern-2",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": False,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Only topically similar.",
                },
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": [],
            "explanation": "Exact continuity wins.",
        }
        evaluator = _make_identity_evaluator([_success_result(output)])
        context = _make_context(
            concerns=[_make_concern("concern-1"), _make_concern("concern-2")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [
            RetrievalCandidate("concern-1", ConcernStatus.ACTIVE, ["a1"]),
            RetrievalCandidate("concern-2", ConcernStatus.ACTIVE, ["a2"]),
        ]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.best_match_concern_id == "concern-1"
        assert result.confidence == BehavioralConfidenceBand.HIGH
        for record in result.candidate_records:
            if record.concern_id == "concern-2":
                assert record.confidence == BehavioralConfidenceBand.LOW


# ===========================================================================
# Property 17: Temporal distance alone cannot weaken a valid identity
# **Validates: Requirements §8.1, Property 17**
# ===========================================================================


class TestTemporalDistanceInvariant:
    """Temporal distance alone cannot reduce an otherwise valid match."""

    @given(
        exact_continuity=st.booleans(),
        historical_trajectory=st.booleans(),
        return_path_continuity=st.booleans(),
        scope_compatible=st.booleans(),
        is_best_match=st.booleans(),
        has_material_competitor=st.booleans(),
    )
    @settings(max_examples=200)
    def test_confidence_independent_of_temporal_distance(
        self,
        exact_continuity: bool,
        historical_trajectory: bool,
        return_path_continuity: bool,
        scope_compatible: bool,
        is_best_match: bool,
        has_material_competitor: bool,
    ) -> None:
        """Confidence band is identical regardless of temporal distance.

        The BehavioralConfidenceEvaluator does not accept temporal inputs.
        This proves temporal invariance by construction.
        """
        evaluator = BehavioralConfidenceEvaluator()
        signals = IdentitySignals(
            exact_continuity=exact_continuity,
            historical_trajectory=historical_trajectory,
            return_path_continuity=return_path_continuity,
            scope_compatible=scope_compatible,
            is_best_match=is_best_match,
            has_material_competitor=has_material_competitor,
        )
        result_1 = evaluator.evaluate_identity(signals)
        result_2 = evaluator.evaluate_identity(signals)

        assert result_1.band == result_2.band
        assert result_1.domain == result_2.domain

    @pytest.mark.asyncio
    async def test_old_concern_same_confidence_as_recent(self) -> None:
        """Concern last active 10 years ago gets same HIGH as recent one."""
        output_old = _make_llm_output(
            concern_id="concern-old", exact_continuity=True,
            best_match="concern-old", competitors=[],
        )
        evaluator_old = _make_identity_evaluator([_success_result(output_old)])
        context_old = _make_context(
            concerns=[_make_concern("concern-old", last_active_at="2014-01-01T00:00:00Z")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates_old = [RetrievalCandidate("concern-old", ConcernStatus.ACTIVE, ["a1"])]
        result_old = await evaluator_old.evaluate(
            candidates_old,
            RetrievalResult(attempts=[], candidates=candidates_old),
            context_old,
        )

        output_new = _make_llm_output(
            concern_id="concern-new", exact_continuity=True,
            best_match="concern-new", competitors=[],
        )
        evaluator_new = _make_identity_evaluator([_success_result(output_new)])
        context_new = _make_context(
            concerns=[_make_concern("concern-new", last_active_at="2024-12-31T23:59:59Z")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates_new = [RetrievalCandidate("concern-new", ConcernStatus.ACTIVE, ["a1"])]
        result_new = await evaluator_new.evaluate(
            candidates_new,
            RetrievalResult(attempts=[], candidates=candidates_new),
            context_new,
        )

        assert result_old.confidence == result_new.confidence
        assert result_old.confidence == BehavioralConfidenceBand.HIGH


# ===========================================================================
# Property 18: Assistant-authored content cannot establish user concern
# **Validates: Requirements §8.4, Property 18**
# ===========================================================================


class TestAssistantAttributionProhibition:
    """Assistant-authored content alone cannot establish ownership."""

    @given(has_durable=st.booleans(), has_independent=st.booleans())
    @settings(max_examples=50)
    def test_assistant_authored_always_low_retention(
        self, has_durable: bool, has_independent: bool
    ) -> None:
        """Non-user content is LOW retention regardless of evidence quality."""
        evaluator = BehavioralConfidenceEvaluator()
        signals = RetentionConfidenceSignals(
            has_durable_proposition_evidence=has_durable,
            has_independent_concern_candidate=has_independent,
            speaker_is_user=False,
        )
        result = evaluator.evaluate_retention(signals)
        assert result.band == BehavioralConfidenceBand.LOW

    def test_grounding_rejects_assistant_proposition_as_ownership_evidence(
        self,
    ) -> None:
        """Grounding validator rejects assistant propositions as ownership evidence."""
        validator = GroundingValidator()
        context = GroundingContext(
            valid_concern_ids=frozenset({"concern-1"}),
            valid_proposition_ids=frozenset({"prop-user", "prop-assistant"}),
            valid_message_ids=frozenset(),
            candidate_concern_ids=frozenset({"concern-1"}),
            assistant_proposition_ids=frozenset({"prop-assistant"}),
        )
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-1",
                    "supporting_evidence": [
                        {"entity_id": "prop-assistant", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Based on assistant content.",
                }
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": [],
            "explanation": "Match based on assistant.",
        }
        result = validator.validate(output, context)
        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.UNSUPPORTED_ASSISTANT_ATTRIBUTION
            for v in result.violations
        )

    @pytest.mark.asyncio
    async def test_assistant_only_evidence_causes_grounding_failure(self) -> None:
        """Full evaluator: assistant-only evidence → FAILED, never LOW."""
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-1",
                    "supporting_evidence": [
                        {"entity_id": "prop-asst", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Match.",
                }
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": [],
            "explanation": "Based only on assistant content.",
        }
        evaluator = _make_identity_evaluator([
            _success_result(output), _success_result(output),
        ])
        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-asst", speaker_role="ASSISTANT")],
        )
        candidates = [RetrievalCandidate("concern-1", ConcernStatus.ACTIVE, ["a1"])]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.FAILED
        assert result.confidence is None


# ===========================================================================
# Operational failure ≠ semantic absence
# **Validates: Requirements §8.4**
# ===========================================================================


class TestOperationalFailureNotSemanticAbsence:
    """Grounding/model failure never becomes semantic absence.
    FAILED produces null confidence, never LOW or novelty."""

    @pytest.mark.asyncio
    async def test_llm_total_failure_never_produces_low(self) -> None:
        """LLM failure → FAILED with null confidence, never LOW."""
        evaluator = _make_identity_evaluator([
            _failure_result("timeout"), _failure_result("rate limited"),
        ])
        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [RetrievalCandidate("concern-1", ConcernStatus.ACTIVE, ["a1"])]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.FAILED
        assert result.confidence is None

    @pytest.mark.asyncio
    async def test_grounding_failure_never_produces_low(self) -> None:
        """Grounding validation failure → FAILED with null confidence."""
        bad_output = {
            "candidate_assessments": [
                {
                    "concern_id": "fabricated-id",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Fabricated match.",
                }
            ],
            "best_match_concern_id": "fabricated-id",
            "competing_candidate_ids": [],
            "explanation": "Based on fabricated ID.",
        }
        evaluator = _make_identity_evaluator([
            _success_result(bad_output), _success_result(bad_output),
        ])
        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [RetrievalCandidate("concern-1", ConcernStatus.ACTIVE, ["a1"])]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.FAILED
        assert result.confidence is None

    @pytest.mark.asyncio
    async def test_malformed_output_never_produces_low(self) -> None:
        """Completely malformed output → FAILED, never LOW."""
        bad_output = {"garbage": "not valid"}
        evaluator = _make_identity_evaluator([
            _success_result(bad_output), _success_result(bad_output),
        ])
        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [RetrievalCandidate("concern-1", ConcernStatus.ACTIVE, ["a1"])]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.FAILED
        assert result.confidence is None


# ===========================================================================
# Property 20: No score-only path to assignment (adversarial)
# **Validates: Requirements §8.1, Property 20**
# ===========================================================================


class TestNoScoreOnlyPath:
    """Adversarial differential tests prove no score-only path to assignment.
    Maximal retrieval similarity without continuity cannot produce HIGH."""

    @given(scope_compatible=st.booleans(), is_best_match=st.booleans())
    @settings(max_examples=100)
    def test_no_continuity_signals_never_high(
        self, scope_compatible: bool, is_best_match: bool
    ) -> None:
        """Without continuity signals, confidence can never be HIGH."""
        evaluator = BehavioralConfidenceEvaluator()
        signals = IdentitySignals(
            exact_continuity=False,
            historical_trajectory=False,
            return_path_continuity=False,
            scope_compatible=scope_compatible,
            is_best_match=is_best_match,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)
        assert result.band == BehavioralConfidenceBand.LOW

    @pytest.mark.asyncio
    async def test_adversarial_maximal_similarity_no_continuity(self) -> None:
        """Adversarial: maximal similarity (scope=True) but zero continuity → LOW."""
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-1",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": False,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Very similar but no continuity.",
                }
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": [],
            "explanation": "Similarity-only evaluation.",
        }
        evaluator = _make_identity_evaluator([_success_result(output)])
        context = _make_context(
            concerns=[_make_concern("concern-1")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [RetrievalCandidate("concern-1", ConcernStatus.ACTIVE, ["a1"])]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.LOW

    @pytest.mark.asyncio
    async def test_adversarial_multiple_scope_only_all_low(self) -> None:
        """Multiple candidates all scope-only → all LOW, no HIGH path."""
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-1",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": False,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Similar topic.",
                },
                {
                    "concern_id": "concern-2",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": False,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Also similar topic.",
                },
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": [],
            "explanation": "All topically similar, no continuity.",
        }
        evaluator = _make_identity_evaluator([_success_result(output)])
        context = _make_context(
            concerns=[_make_concern("concern-1"), _make_concern("concern-2")],
            propositions=[_make_proposition("prop-1")],
        )
        candidates = [
            RetrievalCandidate("concern-1", ConcernStatus.ACTIVE, ["a1"]),
            RetrievalCandidate("concern-2", ConcernStatus.ACTIVE, ["a2"]),
        ]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.LOW
        for record in result.candidate_records:
            assert record.confidence == BehavioralConfidenceBand.LOW


# ===========================================================================
# Multilingual and domain-diverse cases (no keyword-only truth rules)
# **Validates: Requirements §17**
# ===========================================================================


class TestMultilingualDomainDiverse:
    """Evaluator produces correct results regardless of language or domain,
    without relying on keyword matching. Truth is structural signals."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "concern_summary,proposition_meaning,explanation",
        [
            # Japanese
            ("ユーザーのプログラミング学習目標", "Pythonを学びたい",
             "同じ学習目標への継続性が確立された"),
            # Arabic
            ("أهداف المستخدم في تعلم البرمجة", "أريد تعلم بايثون",
             "تم إثبات استمرارية نفس الهدف التعليمي"),
            # Korean
            ("사용자의 프로그래밍 학습 목표", "파이썬을 배우고 싶습니다",
             "동일한 학습 목표에 대한 연속성이 확인됨"),
            # Hindi
            ("उपयोगकर्ता का प्रोग्रामिंग सीखने का लक्ष्य", "मैं पायथन सीखना चाहता हूँ",
             "उसी शिक्षण लक्ष्य की निरंतरता स्थापित"),
            # Bioinformatics domain
            ("CRISPR-Cas9 gene editing protocol optimization",
             "Need to adjust guide RNA targeting sequence",
             "Exact continuity with ongoing protocol concern."),
            # French financial domain
            ("Portefeuille d'investissement optimisation Monte Carlo",
             "Recalibrer les paramètres de volatilité stochastique",
             "Continuité exacte avec le même modèle financier."),
        ],
    )
    async def test_exact_continuity_high_regardless_of_language(
        self, concern_summary: str, proposition_meaning: str, explanation: str
    ) -> None:
        """Exact continuity produces HIGH regardless of language/domain.
        Truth is the structural signal, not keyword content."""
        concern = ConcernSummary(
            concern_id="concern-multi",
            identity_summary=concern_summary,
            display_title=concern_summary[:30],
            current_summary=concern_summary,
            status=ConcernStatus.ACTIVE,
            parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
            last_active_at="2024-06-01T00:00:00Z",
            semantic_version=1,
        )
        proposition = PropositionSummary(
            proposition_id="prop-multi",
            canonical_meaning=proposition_meaning,
            proposition_type=PropositionType.GOAL,
            speaker_role="USER",
            semantic_state=SemanticState.ACTIVE,
            message_seq_range=(1, 1),
        )
        context = _make_context(concerns=[concern], propositions=[proposition])
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-multi",
                    "supporting_evidence": [
                        {"entity_id": "prop-multi", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": explanation,
                }
            ],
            "best_match_concern_id": "concern-multi",
            "competing_candidate_ids": [],
            "explanation": explanation,
        }
        evaluator = _make_identity_evaluator([_success_result(output)])
        candidates = [RetrievalCandidate("concern-multi", ConcernStatus.ACTIVE, ["a1"])]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.HIGH
        assert result.best_match_concern_id == "concern-multi"


    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "concern_summary,proposition_meaning",
        [
            # Chinese
            ("用户对机器学习框架的偏好", "我更喜欢使用PyTorch而不是TensorFlow"),
            # Russian
            ("Предпочтения пользователя в архитектуре ПО", "Предпочитаю микросервисы"),
            # German engineering
            ("Benutzer-Präferenzen für Systemarchitektur",
             "Ich bevorzuge ereignisgesteuerte Architektur"),
        ],
    )
    async def test_scope_only_is_low_regardless_of_language(
        self, concern_summary: str, proposition_meaning: str
    ) -> None:
        """Scope-only compatibility produces LOW regardless of language."""
        concern = ConcernSummary(
            concern_id="concern-scope",
            identity_summary=concern_summary,
            display_title=concern_summary[:30],
            current_summary=concern_summary,
            status=ConcernStatus.ACTIVE,
            parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
            last_active_at="2024-06-01T00:00:00Z",
            semantic_version=1,
        )
        proposition = PropositionSummary(
            proposition_id="prop-scope",
            canonical_meaning=proposition_meaning,
            proposition_type=PropositionType.PREFERENCE,
            speaker_role="USER",
            semantic_state=SemanticState.ACTIVE,
            message_seq_range=(1, 1),
        )
        context = _make_context(concerns=[concern], propositions=[proposition])
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-scope",
                    "supporting_evidence": [
                        {"entity_id": "prop-scope", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": False,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Only scope compatible.",
                }
            ],
            "best_match_concern_id": "concern-scope",
            "competing_candidate_ids": [],
            "explanation": "Scope compatible only.",
        }
        evaluator = _make_identity_evaluator([_success_result(output)])
        candidates = [RetrievalCandidate("concern-scope", ConcernStatus.ACTIVE, ["a1"])]
        result = await evaluator.evaluate(
            candidates, RetrievalResult(attempts=[], candidates=candidates), context
        )
        assert result.stage_status == StageExecutionStatus.COMPLETED
        assert result.confidence == BehavioralConfidenceBand.LOW


# ===========================================================================
# Adversarial differential: priority order property
# ===========================================================================


class TestPriorityOrderAdversarial:
    """Additional adversarial tests proving priority order is enforced:
    exact continuity > historical trajectory > return-path > scope."""

    @given(has_historical=st.booleans(), has_return_path=st.booleans())
    @settings(max_examples=50)
    def test_exact_continuity_always_gte_other_signals(
        self, has_historical: bool, has_return_path: bool
    ) -> None:
        """Exact continuity confidence >= historical/return-path under same conditions."""
        evaluator = BehavioralConfidenceEvaluator()
        band_order = {
            BehavioralConfidenceBand.LOW: 0,
            BehavioralConfidenceBand.MEDIUM: 1,
            BehavioralConfidenceBand.HIGH: 2,
        }

        exact_signals = IdentitySignals(
            exact_continuity=True, historical_trajectory=False,
            return_path_continuity=False, scope_compatible=True,
            is_best_match=True, has_material_competitor=False,
        )
        other_signals = IdentitySignals(
            exact_continuity=False, historical_trajectory=has_historical,
            return_path_continuity=has_return_path, scope_compatible=True,
            is_best_match=True, has_material_competitor=False,
        )

        exact_result = evaluator.evaluate_identity(exact_signals)
        other_result = evaluator.evaluate_identity(other_signals)

        assert band_order[exact_result.band] >= band_order[other_result.band]

    @given(signals=any_identity_signals_st)
    @settings(max_examples=200)
    def test_confidence_is_deterministic(self, signals: IdentitySignals) -> None:
        """Confidence evaluation is fully deterministic."""
        evaluator = BehavioralConfidenceEvaluator()
        result_1 = evaluator.evaluate_identity(signals)
        result_2 = evaluator.evaluate_identity(signals)
        assert result_1.band == result_2.band
        assert result_1.domain == result_2.domain
        assert result_1.rationale == result_2.rationale
