"""Mandatory failure/observability tests for SIE identity resolution (task 17.3).

Proves:
- Retrieval, model, contract, policy, and context failures produce explicit
  diagnostics and safe (DEFER/RETRIEVAL_INCONCLUSIVE) outcomes.
- Operational failure NEVER becomes NO_MATCH, LOW confidence, or novelty
  by implication.
- Diagnostics are purged/redacted together with their protected source data.

Validates: Requirements 11.1, 11.2, 11.3
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.sie.contracts import (
    ConcernSummary,
    GraphStateContext,
    SemanticDependencyGroupRef,
)
from app.sie.enums import (
    BehavioralConfidenceBand,
    CohesionStatus,
    ConcernStatus,
    IRSSignalType,
    ParentResolutionState,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    ResolutionAction,
    RetrievalAttemptStatus,
    RetentionLevel,
    StageExecutionStatus,
)
from app.sie.evaluator.identity_evaluator import IdentityEvaluationResult
from app.sie.identity_models import (
    CandidateRecord,
    IRSSignal,
    RetrievalAttemptRecord,
    SufficiencyRecord,
    WideningBudget,
)
from app.sie.identity_policy import (
    ChannelFamilyRequirement,
    ChannelInvocation,
    IdentityResolutionPolicy,
    ReEvaluationPolicy,
    RetrievalPolicy,
    WideningBudgetPolicy,
)
from app.sie.models import ConcernProposal, Proposition, SemanticPacket
from app.sie.pipeline import IdentityResolutionPipeline, PipelineResult
from app.sie.privacy_logging import (
    InMemoryAuthorizedStore,
    REDACTED_MARKER,
    configure_authorized_store,
    purge_diagnostic_material,
    sanitize_log_data,
)
from app.sie.retrieval.adaptive_widener import WideningResult
from app.sie.retrieval.channel_protocol import RetrievalCandidate, RetrievalResult
from app.sie.retrieval.downstream_separator import DownstreamDecision
from app.sie.retrieval.lifecycle_handler import MergeRedirectResult
from app.sie.retrieval.novelty_checker import NoveltyResult
from app.sie.retrieval.shared_proposal_coalescer import CoalescedProposalResult


# ---------------------------------------------------------------------------
# Shared factories
# ---------------------------------------------------------------------------

# Outcomes that operational failure MUST NOT produce (requirement 11.2)
_FORBIDDEN_OUTCOMES = {PipelineOutcome.NO, PipelineOutcome.YES}
_FORBIDDEN_ACTIONS = {ResolutionAction.ASSIGN_EXISTING, ResolutionAction.PROPOSE_NEW}

# Safe outcomes for operational failures
_SAFE_OUTCOMES = {
    PipelineOutcome.DEFER,
    PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
    PipelineOutcome.UNRESOLVED,
    PipelineOutcome.REQUIRES_VALIDATION,
}


def _make_policy() -> IdentityResolutionPolicy:
    return IdentityResolutionPolicy(
        policy_version="1.0.0",
        retrieval_policy=RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="ch-embed-1",
                    query_mode="semantic_similarity",
                    scope_overrides={},
                )
            ],
            channel_family_requirements={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=True,
                )
            },
            irs_signal_channel_mapping={},
        ),
        widening_budget=WideningBudgetPolicy(
            budget_version="1.0.0",
            max_widening_rounds=3,
            max_total_attempts=10,
            max_latency_ms=5000,
            max_cost_units=100.0,
        ),
        pending_re_evaluation_policy=ReEvaluationPolicy(
            policy_version="1.0.0",
            triggers=["new_evidence", "policy_change"],
            max_re_evaluation_attempts=3,
            cooldown_between_attempts_ms=60000,
        ),
        permitted_embedding_model_versions=["v1.0"],
    )


def _make_context(
    concerns: list[ConcernSummary] | None = None,
    graph_version: int = 5,
) -> GraphStateContext:
    return GraphStateContext(
        graph_version=graph_version,
        snapshot_token=f"snap-v{graph_version}",
        snapshot_digest="sha256-test",
        concerns=concerns or [],
        propositions=[],
        active_associations=[],
        pending_decisions=[],
        concern_embeddings=[],
        normalized_aliases=[],
        pending_identity_details=[],
        privacy_suppressed_concern_ids=[],
        packet_lineage=[],
    )


def _make_packet(packet_id: str = "pkt-1") -> SemanticPacket:
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=f"creation-{packet_id}",
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        message_seq_range=(1, 3),
        user_grounded_meaning="User wants to learn Python",
        provenance="test",
        packet_formation_version="1.0.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_proposition(prop_id: str = "prop-1") -> Proposition:
    return Proposition(
        proposition_id=prop_id,
        proposition_creation_key=f"creation-{prop_id}",
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        speaker_role="USER",
        canonical_meaning="I want to learn Python",
        proposition_type=PropositionType.GOAL,
        message_seq_range=(1, 3),
        provenance=PropositionProvenance.DIRECT,
        retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
        created_at="2024-01-01T00:00:00Z",
        extraction_version="1.0.0",
    )


def _make_concern(
    concern_id: str = "concern-1",
    status: ConcernStatus = ConcernStatus.ACTIVE,
) -> ConcernSummary:
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary="Learning Python programming",
        display_title="Python Learning",
        current_summary="User's goal to learn Python",
        status=status,
        merged_into_concern_id=None,
        aliases=["python-learning"],
        canonical_parent_id=None,
        parent_resolution_state=ParentResolutionState.ROOT_CONFIRMED,
        last_active_at="2024-01-01T00:00:00Z",
        semantic_version=1,
    )


def _make_retrieval_attempt(
    attempt_id: str = "attempt-1",
    status: RetrievalAttemptStatus = RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
    candidate_ids: list[str] | None = None,
) -> RetrievalAttemptRecord:
    cids = candidate_ids or []
    return RetrievalAttemptRecord(
        attempt_id=attempt_id,
        channel_id="ch-embed-1",
        channel_family="embedding_primary",
        query_mode="semantic_similarity",
        query_reference="query-ref",
        scope_description="default",
        status=status,
        candidate_ids=cids,
        candidate_count=len(cids),
        latency_ms=50,
        retrieval_policy_version="1.0.0",
    )


def _make_sufficiency(
    confidence: BehavioralConfidenceBand = BehavioralConfidenceBand.HIGH,
    unresolved_signals: list[IRSSignal] | None = None,
    failed_coverage_gaps: list[str] | None = None,
) -> SufficiencyRecord:
    return SufficiencyRecord(
        stage_status=StageExecutionStatus.COMPLETED,
        confidence=confidence,
        coverage_summary="adequate",
        unresolved_signals=unresolved_signals or [],
        failed_coverage_gaps=failed_coverage_gaps or [],
        rationale="Retrieval adequate",
    )


def _make_eval_result(
    confidence: BehavioralConfidenceBand | None = BehavioralConfidenceBand.HIGH,
    best_match: str | None = "concern-1",
    stage_status: StageExecutionStatus = StageExecutionStatus.COMPLETED,
    failure_reason: str | None = None,
) -> IdentityEvaluationResult:
    return IdentityEvaluationResult(
        stage_status=stage_status,
        confidence=confidence,
        candidate_records=[],
        best_match_concern_id=best_match,
        competing_candidate_ids=[],
        substantive_resumption=None,
        explanation="test evaluation",
        failure_reason=failure_reason,
    )


# Common resolve kwargs
_RESOLVE_KWARGS = dict(
    request_id="req-001",
    idempotency_key="idem-001",
    conversation_id="conv-001",
    semantic_policy_version="1.0.0",
    model_config_version="gpt-4-turbo",
    prompt_version="1.0.0",
)


def _build_pipeline(
    *,
    retrieval_result: RetrievalResult | None = None,
    retrieval_side_effect: Exception | None = None,
    eval_result: IdentityEvaluationResult | None = None,
    eval_side_effect: Exception | None = None,
    sufficiency: SufficiencyRecord | None = None,
    downstream: DownstreamDecision | None = None,
    widening_result: WideningResult | None = None,
    widening_side_effect: Exception | None = None,
    novelty_result: NoveltyResult | None = None,
    prop_validation_valid: bool = True,
) -> IdentityResolutionPipeline:
    """Build a pipeline with mocked components for failure testing."""
    retrieval_coordinator = MagicMock()
    if retrieval_side_effect:
        retrieval_coordinator.retrieve_candidates = AsyncMock(
            side_effect=retrieval_side_effect
        )
    else:
        retrieval_coordinator.retrieve_candidates = AsyncMock(
            return_value=retrieval_result or RetrievalResult()
        )

    evaluator = MagicMock()
    if eval_side_effect:
        evaluator.evaluate = AsyncMock(side_effect=eval_side_effect)
    else:
        evaluator.evaluate = AsyncMock(
            return_value=eval_result or _make_eval_result()
        )

    sufficiency_gate = MagicMock()
    sufficiency_gate.evaluate = MagicMock(
        return_value=sufficiency or _make_sufficiency()
    )

    separator = MagicMock()
    separator.determine_outcome = MagicMock(
        return_value=downstream or DownstreamDecision(
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            matched_concern_id="concern-1",
            requires_widening=False,
            novelty_eligible=False,
            rationale="test",
        )
    )

    widener = MagicMock()
    if widening_side_effect:
        widener.widen = AsyncMock(side_effect=widening_side_effect)
    else:
        widener.widen = AsyncMock(
            return_value=widening_result or WideningResult()
        )

    novelty_checker = MagicMock()
    novelty_checker.check_novelty = MagicMock(
        return_value=novelty_result or NoveltyResult(
            eligible=False,
            proposal=None,
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            rationale="test",
            blocked_reason="test",
        )
    )

    lifecycle_handler = MagicMock()
    lifecycle_handler.follow_merge_redirect = MagicMock(
        return_value=MergeRedirectResult(
            resolved=True,
            target_concern=_make_concern(),
            redirect_path=["concern-1"],
        )
    )
    lifecycle_handler.build_reactivation_group = MagicMock(
        return_value=SemanticDependencyGroupRef(
            group_id="reactivation-group-1",
            mutation_refs=["status_transition:concern-1:ACTIVE"],
            failure_policy="ALL_OR_NONE",
        )
    )

    pending_mgr = MagicMock()
    pending_mgr.create_pending_decision = MagicMock(
        return_value=MagicMock(is_duplicate=False)
    )

    association_assembler = MagicMock()
    association_assembler.assemble_associations = MagicMock(return_value=[])

    coalescer = MagicMock()
    coalescer.coalesce_proposal = MagicMock(
        return_value=CoalescedProposalResult(
            is_shared=False,
            proposal=ConcernProposal(
                concern_creation_key="novelty-key",
                proposed_concern_id="new-concern-1",
                identity_summary="new concern",
                display_title="New Concern",
                initial_summary="new concern summary",
            ),
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            is_first_proposer=True,
            dependency_group=SemanticDependencyGroupRef(
                group_id="proposal-group:new-concern-1",
                mutation_refs=["create-concern:new-concern-1"],
                failure_policy="ALL_OR_NONE",
            ),
        )
    )

    prop_validator = MagicMock()
    if prop_validation_valid:
        prop_validator.validate_packet_propositions = MagicMock(
            return_value=MagicMock(valid=True)
        )
    else:
        prop_validator.validate_packet_propositions = MagicMock(
            return_value=MagicMock(
                valid=False,
                rationale="Missing propositions",
            )
        )

    pipeline = IdentityResolutionPipeline(
        retrieval_coordinator=retrieval_coordinator,
        identity_evaluator=evaluator,
        sufficiency_gate=sufficiency_gate,
        downstream_separator=separator,
        adaptive_widener=widener,
        novelty_checker=novelty_checker,
        lifecycle_handler=lifecycle_handler,
        pending_decision_manager=pending_mgr,
        association_assembler=association_assembler,
        shared_proposal_coalescer=coalescer,
        proposition_validator=prop_validator,
    )
    return pipeline


# ===========================================================================
# Sub-task 1: Retrieval/model/contract/policy/context failures produce
# explicit diagnostics and safe outcomes
# ===========================================================================


class TestRetrievalFailureProducesSafeOutcome:
    """Retrieval failures (all channels error/timeout) → DEFER or
    RETRIEVAL_INCONCLUSIVE, never NO/PROPOSE_NEW.

    Validates: Requirement 11.1
    """

    @pytest.mark.asyncio
    async def test_all_channels_error_produces_defer(self):
        """When all retrieval channels error, outcome is DEFER."""
        # Retrieval coordinator raises an exception simulating total failure
        pipeline = _build_pipeline(
            retrieval_side_effect=RuntimeError("All channels failed"),
        )
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome in _SAFE_OUTCOMES
        assert record.outcome not in _FORBIDDEN_OUTCOMES
        assert record.action not in _FORBIDDEN_ACTIONS
        assert record.matched_concern_id is None
        assert record.proposed_concern_id is None

    @pytest.mark.asyncio
    async def test_all_channels_timeout_produces_safe_outcome(self):
        """When all retrieval channels timeout, outcome is safe (not NO/YES)."""
        # All attempts have TIMEOUT status
        error_attempts = [
            _make_retrieval_attempt(
                attempt_id="attempt-timeout-1",
                status=RetrievalAttemptStatus.TIMEOUT,
            ),
            _make_retrieval_attempt(
                attempt_id="attempt-timeout-2",
                status=RetrievalAttemptStatus.TIMEOUT,
            ),
        ]
        retrieval_result = RetrievalResult(
            attempts=error_attempts,
            candidates=[],
            total_latency_ms=5000,
        )
        # Evaluator returns FAILED since no candidates
        eval_result = _make_eval_result(
            confidence=None,
            best_match=None,
            stage_status=StageExecutionStatus.FAILED,
            failure_reason="No candidates from timed-out retrieval",
        )
        pipeline = _build_pipeline(
            retrieval_result=retrieval_result,
            eval_result=eval_result,
        )
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome in _SAFE_OUTCOMES
        assert record.outcome not in _FORBIDDEN_OUTCOMES
        assert record.action not in _FORBIDDEN_ACTIONS

    @pytest.mark.asyncio
    async def test_retrieval_failure_has_explicit_diagnostics(self):
        """Retrieval failure produces explicit failure reason in record."""
        pipeline = _build_pipeline(
            retrieval_side_effect=TimeoutError("Retrieval service unavailable"),
        )
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        # The reasoning field should contain explicit failure information
        assert record.reasoning != ""
        assert record.outcome in _SAFE_OUTCOMES


class TestModelFailureProducesSafeOutcome:
    """Model failures (LLM returns garbage) → DEFER, never YES or NO.

    Validates: Requirement 11.1, 11.2
    """

    @pytest.mark.asyncio
    async def test_model_failure_returns_defer(self):
        """When evaluator reports FAILED status, pipeline returns DEFER."""
        eval_result = _make_eval_result(
            confidence=None,
            best_match=None,
            stage_status=StageExecutionStatus.FAILED,
            failure_reason="LLM returned malformed structured output",
        )
        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=["concern-1"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-1",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=eval_result,
        )
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.DEFER
        assert record.action == ResolutionAction.RETAIN_PENDING
        assert record.matched_concern_id is None
        assert record.proposed_concern_id is None
        # Model failure should never fabricate confidence
        assert record.identity_confidence is None
        assert record.identity_stage_status == StageExecutionStatus.FAILED

    @pytest.mark.asyncio
    async def test_model_garbage_never_produces_yes(self):
        """Model garbage/failure cannot produce YES/ASSIGN_EXISTING."""
        eval_result = _make_eval_result(
            confidence=None,
            best_match=None,
            stage_status=StageExecutionStatus.FAILED,
            failure_reason="Grounding validation failed: fabricated IDs",
        )
        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=["concern-1"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-1",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=eval_result,
        )
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome != PipelineOutcome.YES
        assert record.action != ResolutionAction.ASSIGN_EXISTING



# ===========================================================================
# Sub-task 2: Contract/schema validation failures produce safe outcomes
# ===========================================================================


class TestContractValidationFailure:
    """Contract/schema validation failures (missing required fields, invalid
    response structure) → DEFER with explicit diagnostics, never NO_MATCH
    or novelty.

    Validates: Requirement 11.1
    """

    @pytest.mark.asyncio
    async def test_missing_propositions_produces_defer(self):
        """When packet proposition validation fails (missing required fields),
        outcome is DEFER with explicit diagnostics."""
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.DEFER
        assert record.outcome in _SAFE_OUTCOMES
        assert record.outcome not in _FORBIDDEN_OUTCOMES
        assert record.action not in _FORBIDDEN_ACTIONS
        assert record.matched_concern_id is None
        assert record.proposed_concern_id is None
        # Contract failure → no confidence fabricated
        assert record.identity_confidence is None

    @pytest.mark.asyncio
    async def test_contract_failure_has_explicit_reasoning(self):
        """Contract validation failure produces non-empty reasoning."""
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.reasoning != ""
        assert record.reasoning is not None

    @pytest.mark.asyncio
    async def test_contract_failure_never_becomes_novelty(self):
        """Contract/schema failure cannot produce PROPOSE_NEW action."""
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.action != ResolutionAction.PROPOSE_NEW
        assert record.proposed_concern_id is None


# ===========================================================================
# Sub-task 3: Policy failure produces safe outcome
# ===========================================================================


class TestPolicyFailureProducesSafeOutcome:
    """Missing/invalid policy configuration → DEFER with explicit diagnostics,
    never NO_MATCH or novelty by implication.

    When the proposition validator rejects a packet due to missing policy-
    mandated context (channel requirements unmet, policy fields absent),
    the pipeline MUST fail closed to DEFER.

    Validates: Requirement 11.1, 11.2
    """

    @pytest.mark.asyncio
    async def test_missing_channel_config_produces_defer(self):
        """When retrieval policy channels cannot be satisfied (simulated via
        proposition validation failure from missing channel config context),
        outcome is DEFER."""
        # A policy failure manifests as the proposition validator rejecting
        # the packet due to missing channel-policy-required context
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.DEFER
        assert record.outcome in _SAFE_OUTCOMES
        assert record.action == ResolutionAction.RETAIN_PENDING
        assert record.action not in _FORBIDDEN_ACTIONS

    @pytest.mark.asyncio
    async def test_policy_failure_does_not_produce_no_match(self):
        """Policy failure MUST NOT result in NO_MATCH (PipelineOutcome.NO)."""
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome != PipelineOutcome.NO
        assert record.outcome != PipelineOutcome.YES

    @pytest.mark.asyncio
    async def test_policy_failure_confidence_is_none(self):
        """Policy failure MUST NOT fabricate a behavioral confidence value."""
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        # Operational failure → no confidence fabricated
        assert record.identity_confidence is None
        assert record.sufficiency_confidence is None


# ===========================================================================
# Sub-task 4: Context failure produces safe outcome
# ===========================================================================


class TestContextFailureProducesSafeOutcome:
    """Missing/invalid context (packet propositions missing, context dependency
    unavailable) → DEFER with explicit diagnostics.

    Validates: Requirement 11.1
    """

    @pytest.mark.asyncio
    async def test_missing_packet_propositions_produces_defer(self):
        """When propositions_map has no entry for a packet, proposition
        validation fails → DEFER."""
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: []},  # empty propositions
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.DEFER
        assert record.outcome in _SAFE_OUTCOMES
        assert record.action == ResolutionAction.RETAIN_PENDING

    @pytest.mark.asyncio
    async def test_context_failure_never_implies_novelty(self):
        """Context dependency failure cannot produce PROPOSE_NEW."""
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.action != ResolutionAction.PROPOSE_NEW
        assert record.proposed_concern_id is None
        assert record.outcome not in _FORBIDDEN_OUTCOMES

    @pytest.mark.asyncio
    async def test_context_failure_has_diagnostics(self):
        """Context failure includes explicit reasoning for traceability."""
        pipeline = _build_pipeline(prop_validation_valid=False)
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.reasoning is not None
        assert record.reasoning != ""


# ===========================================================================
# Sub-task 5: Operational failure never produces LOW confidence or novelty
# ===========================================================================


class TestOperationalFailureNeverProducesLowConfidenceOrNovelty:
    """Operational failure NEVER becomes LOW confidence, NO_MATCH, or
    PROPOSE_NEW by implication.

    - FAILED stages have confidence=None (not LOW/MEDIUM/HIGH).
    - Outcome cannot be NO (NO_MATCH) or PROPOSE_NEW when failure is operational.
    - Budget exhaustion during widening → RETRIEVAL_INCONCLUSIVE, not NO/PROPOSE_NEW.

    Validates: Requirement 11.2
    """

    @pytest.mark.asyncio
    async def test_failed_evaluator_confidence_is_none_not_low(self):
        """When evaluator fails, confidence is None — never fabricated as LOW."""
        eval_result = _make_eval_result(
            confidence=None,
            best_match=None,
            stage_status=StageExecutionStatus.FAILED,
            failure_reason="Model returned invalid structured output",
        )
        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=["concern-1"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-1",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=eval_result,
        )
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        # Operational failure → confidence is None, never LOW
        assert record.identity_confidence is None
        assert record.identity_confidence != BehavioralConfidenceBand.LOW

    @pytest.mark.asyncio
    async def test_operational_failure_never_implies_novelty(self):
        """Operational failure cannot produce NO (no-match) or PROPOSE_NEW."""
        eval_result = _make_eval_result(
            confidence=None,
            best_match=None,
            stage_status=StageExecutionStatus.FAILED,
            failure_reason="Grounding check failed: hallucinated concern IDs",
        )
        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=["concern-1"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-1",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=eval_result,
        )
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome != PipelineOutcome.NO
        assert record.action != ResolutionAction.PROPOSE_NEW
        assert record.proposed_concern_id is None

    @pytest.mark.asyncio
    async def test_failed_evaluator_with_valid_candidates_returns_defer_not_no_match(
        self,
    ):
        """A failed evaluator with valid retrieval candidates still returns
        DEFER, not NO_MATCH. The presence of candidates does not imply NO."""
        eval_result = _make_eval_result(
            confidence=None,
            best_match=None,
            stage_status=StageExecutionStatus.FAILED,
            failure_reason="JSON parse error in model output",
        )
        # Retrieval succeeded with candidates, but evaluator failed
        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[
                    _make_retrieval_attempt(
                        candidate_ids=["concern-1", "concern-2"]
                    )
                ],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-1",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    ),
                    RetrievalCandidate(
                        concern_id="concern-2",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    ),
                ],
                total_latency_ms=80,
            ),
            eval_result=eval_result,
        )
        context = _make_context(
            concerns=[_make_concern("concern-1"), _make_concern("concern-2")]
        )
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        # MUST be DEFER, not NO (no-match)
        assert record.outcome == PipelineOutcome.DEFER
        assert record.outcome != PipelineOutcome.NO
        assert record.action == ResolutionAction.RETAIN_PENDING

    @pytest.mark.asyncio
    async def test_budget_exhaustion_never_converts_to_no_match_or_propose_new(
        self,
    ):
        """Budget exhaustion during widening → RETRIEVAL_INCONCLUSIVE,
        never NO_MATCH or PROPOSE_NEW."""
        # Sufficiency is not HIGH → triggers widening path
        low_sufficiency = _make_sufficiency(
            confidence=BehavioralConfidenceBand.LOW,
            failed_coverage_gaps=["embedding_primary"],
        )
        # Widening returns budget_exhausted with no new candidates
        exhausted_widening = WideningResult(
            new_attempts=[],
            new_candidate_ids=[],
            budget_exhausted=True,
            rounds_executed=3,
            rationale="Budget exhausted: max rounds reached",
        )
        # Eval result is MEDIUM (not HIGH), so downstream won't short-circuit
        eval_result = _make_eval_result(
            confidence=BehavioralConfidenceBand.MEDIUM,
            best_match=None,
            stage_status=StageExecutionStatus.COMPLETED,
        )
        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=["concern-1"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-1",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=eval_result,
            sufficiency=low_sufficiency,
            widening_result=exhausted_widening,
        )
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        # Budget exhaustion → safe outcome, never NO or PROPOSE_NEW
        assert record.outcome in _SAFE_OUTCOMES
        assert record.outcome != PipelineOutcome.NO
        assert record.action != ResolutionAction.PROPOSE_NEW
        assert record.proposed_concern_id is None


# ===========================================================================
# Sub-task 6: Diagnostics purge with protected source data
# ===========================================================================


class TestDiagnosticsPurgeWithProtectedData:
    """Diagnostics are purged/redacted together with their protected source data.

    The privacy purge/redaction RPC reaches all stored diagnostic and model-
    invocation material.

    Validates: Requirement 11.3
    """

    def test_purge_by_request_id_removes_all_diagnostics(self):
        """Stored diagnostics are purged when purge_diagnostic_material is
        called with their request_id."""
        store = InMemoryAuthorizedStore()
        configure_authorized_store(store)

        # Store diagnostic material for a request
        store.store(
            category="evaluation_prompt",
            request_id="req-purge-001",
            detail={
                "system_prompt": "You are an identity evaluator...",
                "user_prompt": "Evaluate concern identity for...",
                "conversation_id": "conv-001",
            },
        )
        store.store(
            category="model_completion",
            request_id="req-purge-001",
            detail={
                "completion": "Based on analysis, HIGH confidence match...",
                "conversation_id": "conv-001",
            },
        )
        store.store(
            category="retrieval_query",
            request_id="req-purge-001",
            detail={
                "query_text": "learning python programming basics",
                "conversation_id": "conv-001",
            },
        )

        # Verify records exist before purge
        assert len(store.records) == 3

        # Purge by request_id
        purged_count = purge_diagnostic_material(request_id="req-purge-001")

        assert purged_count == 3
        assert len(store.records) == 0

    def test_purge_by_conversation_id_removes_diagnostics(self):
        """Stored diagnostics are purged when purge_diagnostic_material is
        called with their conversation_id."""
        store = InMemoryAuthorizedStore()
        configure_authorized_store(store)

        # Store diagnostics for conversation
        store.store(
            category="evaluation_prompt",
            request_id="req-conv-001",
            detail={
                "system_prompt": "Evaluate...",
                "conversation_id": "conv-target",
            },
        )
        store.store(
            category="model_completion",
            request_id="req-conv-002",
            detail={
                "completion": "Match found...",
                "conversation_id": "conv-target",
            },
        )
        # Different conversation — should NOT be purged
        store.store(
            category="evaluation_prompt",
            request_id="req-conv-003",
            detail={
                "system_prompt": "Other...",
                "conversation_id": "conv-other",
            },
        )

        assert len(store.records) == 3

        # Purge by conversation_id
        purged_count = purge_diagnostic_material(conversation_id="conv-target")

        assert purged_count == 2
        assert len(store.records) == 1
        assert store.records[0]["detail"]["conversation_id"] == "conv-other"

    def test_after_purge_no_sensitive_content_remains(self):
        """After purge, no sensitive content remains accessible in the store."""
        store = InMemoryAuthorizedStore()
        configure_authorized_store(store)

        sensitive_prompt = "The user wants to learn Python programming"
        sensitive_completion = "HIGH confidence: concern-1 matches user's goal"

        store.store(
            category="evaluation_prompt",
            request_id="req-sensitive-001",
            detail={
                "user_prompt": sensitive_prompt,
                "conversation_id": "conv-sensitive",
            },
        )
        store.store(
            category="model_completion",
            request_id="req-sensitive-001",
            detail={
                "completion": sensitive_completion,
                "conversation_id": "conv-sensitive",
            },
        )

        # Purge
        purge_diagnostic_material(request_id="req-sensitive-001")

        # Verify no sensitive content remains
        assert len(store.records) == 0
        # Verify the sensitive strings are not anywhere in remaining records
        for record in store.records:
            detail_str = str(record.get("detail", ""))
            assert sensitive_prompt not in detail_str
            assert sensitive_completion not in detail_str

    def test_redaction_replaces_content_with_marker(self):
        """Redaction replaces content with REDACTED_MARKER."""
        store = InMemoryAuthorizedStore()
        configure_authorized_store(store)

        store.store(
            category="evaluation_prompt",
            request_id="req-redact-001",
            detail={
                "user_prompt": "Sensitive user content here",
                "query_text": "original query about learning Python",
                "conversation_id": "conv-001",
            },
        )

        # Redact a specific field
        redacted = store.redact_field("req-redact-001", "user_prompt")
        assert redacted is True

        # Verify the field now contains REDACTED_MARKER
        remaining = store.records[0]
        assert remaining["detail"]["user_prompt"] == REDACTED_MARKER
        # Other fields unchanged
        assert remaining["detail"]["query_text"] == "original query about learning Python"

    def test_purge_reaches_model_invocation_and_retrieval_query_material(self):
        """Purge reaches model invocation material, LLM prompts/completions,
        and retrieval query text."""
        store = InMemoryAuthorizedStore()
        configure_authorized_store(store)

        # Store various categories of sensitive material
        store.store(
            category="model_invocation",
            request_id="req-full-001",
            detail={
                "model_input": "System: You are an evaluator...",
                "model_output": "Based on my analysis...",
                "conversation_id": "conv-full",
            },
        )
        store.store(
            category="llm_prompt",
            request_id="req-full-001",
            detail={
                "system_prompt": "Evaluate the following packet...",
                "user_prompt": "Packet content: user wants to learn...",
                "conversation_id": "conv-full",
            },
        )
        store.store(
            category="llm_completion",
            request_id="req-full-001",
            detail={
                "completion_text": "HIGH confidence match to concern-1",
                "raw_output": '{"confidence": "HIGH", ...}',
                "conversation_id": "conv-full",
            },
        )
        store.store(
            category="retrieval_query",
            request_id="req-full-001",
            detail={
                "query_text": "learning python programming fundamentals",
                "reformulated_query": "python programming basics tutorial",
                "conversation_id": "conv-full",
            },
        )

        # Verify all categories are stored
        assert len(store.records) == 4
        categories = {r["category"] for r in store.records}
        assert "model_invocation" in categories
        assert "llm_prompt" in categories
        assert "llm_completion" in categories
        assert "retrieval_query" in categories

        # Purge by request_id — should reach ALL material types
        purged_count = purge_diagnostic_material(request_id="req-full-001")

        assert purged_count == 4
        assert len(store.records) == 0
