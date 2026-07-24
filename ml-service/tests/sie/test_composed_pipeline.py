"""Comprehensive composed-pipeline integration tests for SIE identity resolution.

Tests the FULL pipeline flow (IdentityResolutionPipeline.resolve) with mocked
components, covering every terminal outcome path, lifecycle paths, multi-packet
shared proposals, widening, and fail-closed invariants.

Design authority: design-corrections.md §4.2.
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
    SemanticState,
    StageExecutionStatus,
)
from app.sie.evaluator.identity_evaluator import IdentityEvaluationResult
from app.sie.identity_models import (
    CandidateRecord,
    EvidenceReference,
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
from app.sie.retrieval.adaptive_widener import WideningResult
from app.sie.retrieval.channel_protocol import RetrievalCandidate, RetrievalResult
from app.sie.retrieval.downstream_separator import DownstreamDecision
from app.sie.retrieval.lifecycle_handler import MergeRedirectResult
from app.sie.retrieval.novelty_checker import NoveltyResult
from app.sie.retrieval.shared_proposal_coalescer import CoalescedProposalResult


# ---------------------------------------------------------------------------
# Factories
# ---------------------------------------------------------------------------


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
            triggers=["new_evidence", "policy_change", "alias_change"],
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


def _make_packet(
    packet_id: str = "pkt-1",
    seq_range: tuple[int, int] = (1, 3),
) -> SemanticPacket:
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=f"creation-{packet_id}",
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        message_seq_range=seq_range,
        user_grounded_meaning="User wants to learn Python programming",
        provenance="test",
        packet_formation_version="1.0.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_proposition(
    prop_id: str = "prop-1",
    retention_levels: list[RetentionLevel] | None = None,
) -> Proposition:
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
        retention_levels=retention_levels or [
            RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE
        ],
        created_at="2024-01-01T00:00:00Z",
        extraction_version="1.0.0",
    )


def _make_concern(
    concern_id: str = "concern-1",
    status: ConcernStatus = ConcernStatus.ACTIVE,
    merged_into: str | None = None,
) -> ConcernSummary:
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary="Learning Python programming",
        display_title="Python Learning",
        current_summary="User's goal to learn Python",
        status=status,
        merged_into_concern_id=merged_into,
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
) -> SufficiencyRecord:
    return SufficiencyRecord(
        stage_status=StageExecutionStatus.COMPLETED,
        confidence=confidence,
        coverage_summary="adequate",
        unresolved_signals=unresolved_signals or [],
        failed_coverage_gaps=[],
        rationale="Retrieval adequate",
    )


def _make_eval_result(
    confidence: BehavioralConfidenceBand | None = BehavioralConfidenceBand.HIGH,
    best_match: str | None = "concern-1",
    competing: list[str] | None = None,
    stage_status: StageExecutionStatus = StageExecutionStatus.COMPLETED,
    substantive_resumption: bool | None = None,
    failure_reason: str | None = None,
    candidate_records: list[CandidateRecord] | None = None,
) -> IdentityEvaluationResult:
    records = candidate_records or []
    return IdentityEvaluationResult(
        stage_status=stage_status,
        confidence=confidence,
        candidate_records=records,
        best_match_concern_id=best_match,
        competing_candidate_ids=competing or [],
        substantive_resumption=substantive_resumption,
        explanation="test evaluation",
        failure_reason=failure_reason,
    )


# ---------------------------------------------------------------------------
# Pipeline construction helper
# ---------------------------------------------------------------------------


def _build_pipeline(
    *,
    retrieval_result: RetrievalResult | None = None,
    eval_result: IdentityEvaluationResult | None = None,
    sufficiency: SufficiencyRecord | None = None,
    downstream: DownstreamDecision | None = None,
    widening_result: WideningResult | None = None,
    novelty_result: NoveltyResult | None = None,
    coalesced: CoalescedProposalResult | None = None,
    merge_redirect: MergeRedirectResult | None = None,
    prop_validation_valid: bool = True,
) -> IdentityResolutionPipeline:
    """Build a pipeline with mocked components configured for the given scenario."""
    retrieval_coordinator = MagicMock()
    retrieval_coordinator.retrieve_candidates = AsyncMock(
        return_value=retrieval_result or RetrievalResult()
    )

    evaluator = MagicMock()
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
        return_value=merge_redirect or MergeRedirectResult(
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
        return_value=coalesced or CoalescedProposalResult(
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


# Common kwargs for pipeline.resolve
_RESOLVE_KWARGS = dict(
    request_id="req-001",
    idempotency_key="idem-001",
    conversation_id="conv-001",
    semantic_policy_version="1.0.0",
    model_config_version="gpt-4-turbo",
    prompt_version="1.0.0",
)


# ===========================================================================
# 1. Terminal Outcome Paths
# ===========================================================================


class TestTerminalOutcomeYesAssignExistingDirectHigh:
    """YES/ASSIGN_EXISTING: direct HIGH match, short-circuit before sufficiency."""

    @pytest.mark.asyncio
    async def test_direct_high_match_assigns_existing(self):
        concern = _make_concern()
        context = _make_context(concerns=[concern])
        packet = _make_packet()
        prop = _make_proposition()

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
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-1",
                competing=[],
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        assert record.matched_concern_id == "concern-1"
        assert record.identity_confidence == BehavioralConfidenceBand.HIGH


class TestTerminalOutcomeYesViaDownstream:
    """YES/ASSIGN_EXISTING: via downstream separator after sufficiency."""

    @pytest.mark.asyncio
    async def test_yes_via_downstream_separator(self):
        """Adequate retrieval + HIGH candidate via downstream → YES."""
        concern = _make_concern()
        context = _make_context(concerns=[concern])
        packet = _make_packet()
        prop = _make_proposition()

        # Eval returns no early HIGH (competing candidates prevent short-circuit)
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
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.MEDIUM,
                best_match="concern-1",
                competing=["concern-2"],  # has competing → no short-circuit
            ),
            sufficiency=_make_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.YES,
                action=ResolutionAction.ASSIGN_EXISTING,
                matched_concern_id="concern-1",
                requires_widening=False,
                novelty_eligible=False,
                rationale="Adequate retrieval, one HIGH candidate via downstream",
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        assert record.matched_concern_id == "concern-1"


class TestTerminalOutcomeNoProposeNew:
    """NO/PROPOSE_NEW: adequate retrieval + novelty eligible."""

    @pytest.mark.asyncio
    async def test_novelty_produces_propose_new(self):
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.LOW,
                best_match=None,
                competing=[],
                stage_status=StageExecutionStatus.COMPLETED,
            ),
            sufficiency=_make_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=True,
                rationale="Adequate, no plausible candidates",
            ),
            novelty_result=NoveltyResult(
                eligible=True,
                proposal=ConcernProposal(
                    concern_creation_key="novelty-key",
                    proposed_concern_id="new-concern-1",
                    identity_summary="Learning Python",
                    display_title="Python Learning",
                    initial_summary="User wants to learn Python",
                ),
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                rationale="Novelty confirmed",
                blocked_reason=None,
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.NO
        assert record.action == ResolutionAction.PROPOSE_NEW
        assert record.proposed_concern_id == "new-concern-1"
        assert record.matched_concern_id is None


class TestTerminalOutcomeUnresolvedRetainPending:
    """UNRESOLVED/RETAIN_PENDING: adequate but ambiguous — multiple MEDIUM."""

    @pytest.mark.asyncio
    async def test_ambiguous_candidates_produce_unresolved(self):
        concerns = [
            _make_concern("concern-1"),
            _make_concern("concern-2"),
        ]
        context = _make_context(concerns=concerns)
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(
                    candidate_ids=["concern-1", "concern-2"]
                )],
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
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.MEDIUM,
                best_match=None,
                competing=["concern-1", "concern-2"],
            ),
            sufficiency=_make_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=False,
                rationale="Multiple MEDIUM candidates, identity ambiguity",
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.UNRESOLVED
        assert record.action == ResolutionAction.RETAIN_PENDING
        assert record.matched_concern_id is None
        assert record.proposed_concern_id is None


class TestTerminalOutcomeDefer:
    """DEFER outcomes: evaluation failure and proposition validation failure."""

    @pytest.mark.asyncio
    async def test_evaluation_failure_produces_defer(self):
        """Evaluation FAILED → DEFER, never LOW, never novelty."""
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

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
            eval_result=_make_eval_result(
                confidence=None,
                best_match=None,
                stage_status=StageExecutionStatus.FAILED,
                failure_reason="LLM quota exhausted",
            ),
        )

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
        assert record.identity_confidence is None
        # Ensures FAILED never becomes LOW or novelty
        assert record.proposed_concern_id is None

    @pytest.mark.asyncio
    async def test_proposition_validation_failure_produces_defer(self):
        """Missing propositions → DEFER."""
        context = _make_context()
        packet = _make_packet()

        pipeline = _build_pipeline(prop_validation_valid=False)

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: []},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.DEFER


class TestTerminalOutcomeRetrievalInconclusive:
    """RETRIEVAL_INCONCLUSIVE: widening budget exhausted."""

    @pytest.mark.asyncio
    async def test_widening_budget_exhausted_produces_inconclusive(self):
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        # Sufficiency returns MEDIUM (inconclusive) both before and after widening
        inconclusive_sufficiency = _make_sufficiency(
            confidence=BehavioralConfidenceBand.MEDIUM
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.LOW,
                best_match=None,
                competing=[],
                stage_status=StageExecutionStatus.COMPLETED,
            ),
            sufficiency=inconclusive_sufficiency,
            widening_result=WideningResult(
                new_attempts=[],
                new_candidate_ids=[],
                budget_exhausted=True,
                rationale="Budget exhausted",
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert record.action == ResolutionAction.RETAIN_PENDING
        # Never produces novelty when inconclusive
        assert record.proposed_concern_id is None


class TestTerminalOutcomeRequiresValidation:
    """REQUIRES_VALIDATION: merge redirect failure."""

    @pytest.mark.asyncio
    async def test_merge_redirect_failure_produces_requires_validation(self):
        merged_concern = _make_concern(
            "concern-merged", status=ConcernStatus.MERGED,
            merged_into="concern-missing",
        )
        context = _make_context(concerns=[merged_concern])
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(
                    candidate_ids=["concern-merged"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-merged",
                        lifecycle_status=ConcernStatus.MERGED,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-merged",
                competing=[],
            ),
            merge_redirect=MergeRedirectResult(
                resolved=False,
                target_concern=None,
                redirect_path=["concern-merged", "concern-missing"],
                failure_reason="missing_target",
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.REQUIRES_VALIDATION
        assert record.action == ResolutionAction.RETAIN_PENDING


# ===========================================================================
# 2. Lifecycle Paths
# ===========================================================================


class TestLifecycleDormantReactivation:
    """Dormant concern reactivation with substantive resumption."""

    @pytest.mark.asyncio
    async def test_dormant_concern_substantive_resumption_reactivates(self):
        dormant = _make_concern("concern-dormant", status=ConcernStatus.DORMANT)
        context = _make_context(concerns=[dormant])
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(
                    candidate_ids=["concern-dormant"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-dormant",
                        lifecycle_status=ConcernStatus.DORMANT,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-dormant",
                competing=[],
                substantive_resumption=True,
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        # Reactivation group should be present
        assert len(result.dependency_groups) == 1
        assert result.dependency_groups[0].failure_policy == "ALL_OR_NONE"


class TestLifecycleRetiredReactivation:
    """Retired concern reactivation with substantive resumption."""

    @pytest.mark.asyncio
    async def test_retired_concern_substantive_resumption_reactivates(self):
        retired = _make_concern("concern-retired", status=ConcernStatus.RETIRED)
        context = _make_context(concerns=[retired])
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(
                    candidate_ids=["concern-retired"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-retired",
                        lifecycle_status=ConcernStatus.RETIRED,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-retired",
                competing=[],
                substantive_resumption=True,
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert len(result.dependency_groups) == 1


class TestLifecycleMergeRedirectFollow:
    """Merge redirect → follow to surviving concern."""

    @pytest.mark.asyncio
    async def test_merged_concern_follows_redirect_to_survivor(self):
        merged = _make_concern(
            "concern-merged", status=ConcernStatus.MERGED,
            merged_into="concern-survivor",
        )
        survivor = _make_concern("concern-survivor", status=ConcernStatus.ACTIVE)
        context = _make_context(concerns=[merged, survivor])
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(
                    candidate_ids=["concern-merged"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-merged",
                        lifecycle_status=ConcernStatus.MERGED,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-merged",
                competing=[],
            ),
            merge_redirect=MergeRedirectResult(
                resolved=True,
                target_concern=survivor,
                redirect_path=["concern-merged", "concern-survivor"],
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        # Should resolve to survivor, not the merged concern
        assert record.matched_concern_id == "concern-survivor"


class TestLifecycleHistoricalReferenceNoReactivation:
    """Historical reference without reactivation (no substantive resumption)."""

    @pytest.mark.asyncio
    async def test_historical_reference_does_not_reactivate(self):
        dormant = _make_concern("concern-dormant", status=ConcernStatus.DORMANT)
        context = _make_context(concerns=[dormant])
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(
                    candidate_ids=["concern-dormant"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-dormant",
                        lifecycle_status=ConcernStatus.DORMANT,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-dormant",
                competing=[],
                substantive_resumption=False,  # historical, not substantive
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        # No reactivation group for historical reference
        assert len(result.dependency_groups) == 0


# ===========================================================================
# 3. Multi-Packet and Shared Proposals
# ===========================================================================


class TestMultiPacketSharedProposals:
    """Two packets matching same uncommitted proposal → one concern mutation."""

    @pytest.mark.asyncio
    async def test_two_packets_share_single_proposal(self):
        """Second packet references shared proposal, no duplicate mutation."""
        context = _make_context()
        pkt1 = _make_packet("pkt-1", seq_range=(1, 2))
        pkt2 = _make_packet("pkt-2", seq_range=(3, 4))
        prop1 = _make_proposition("prop-1")
        prop2 = _make_proposition("prop-2")

        proposal = ConcernProposal(
            concern_creation_key="novelty-key",
            proposed_concern_id="new-concern-shared",
            identity_summary="Shared novel concern",
            display_title="Shared",
            initial_summary="Shared summary",
        )

        # First packet: first proposer
        first_coalesced = CoalescedProposalResult(
            is_shared=False,
            proposal=proposal,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            is_first_proposer=True,
            dependency_group=SemanticDependencyGroupRef(
                group_id="proposal-group:new-concern-shared",
                mutation_refs=["create-concern:new-concern-shared"],
                failure_policy="ALL_OR_NONE",
            ),
        )
        # Second packet: shared, not first proposer
        second_coalesced = CoalescedProposalResult(
            is_shared=True,
            proposal=proposal,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            is_first_proposer=False,
            dependency_group=None,
        )

        # Build pipeline with side_effect to return different results per call
        novelty = NoveltyResult(
            eligible=True,
            proposal=proposal,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            rationale="Novelty confirmed",
            blocked_reason=None,
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.LOW,
                best_match=None,
                competing=[],
                stage_status=StageExecutionStatus.COMPLETED,
            ),
            sufficiency=_make_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=True,
                rationale="No plausible candidates",
            ),
            novelty_result=novelty,
        )
        # Override coalescer with side_effect for sequential calls
        pipeline._coalescer.coalesce_proposal = MagicMock(
            side_effect=[first_coalesced, second_coalesced]
        )

        result = await pipeline.resolve(
            packets=[pkt1, pkt2],
            propositions_map={
                pkt1.packet_id: [prop1],
                pkt2.packet_id: [prop2],
            },
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 2
        # Both should be NO/PROPOSE_NEW
        for record in result.records:
            assert record.outcome == PipelineOutcome.NO
            assert record.action == ResolutionAction.PROPOSE_NEW
            assert record.proposed_concern_id == "new-concern-shared"
        # Only one concern-creation dependency group
        assert len(result.dependency_groups) == 1
        # Only one proposal emitted
        assert len(result.proposals) == 1


class TestMultiPacketDeterministicOrdering:
    """Deterministic ordering by (message_seq_start, message_seq_end, packet_id)."""

    @pytest.mark.asyncio
    async def test_packets_processed_in_deterministic_order(self):
        """Packets are ordered by seq_range then packet_id regardless of input order."""
        context = _make_context()
        # Create packets out of order
        pkt_c = _make_packet("pkt-c", seq_range=(5, 6))
        pkt_a = _make_packet("pkt-a", seq_range=(1, 2))
        pkt_b = _make_packet("pkt-b", seq_range=(3, 4))
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.LOW, best_match=None,
                stage_status=StageExecutionStatus.COMPLETED,
            ),
            sufficiency=_make_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=False,
                rationale="test",
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt_c, pkt_a, pkt_b],  # intentionally out of order
            propositions_map={
                "pkt-a": [prop],
                "pkt-b": [prop],
                "pkt-c": [prop],
            },
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # Records should be in deterministic order: pkt-a, pkt-b, pkt-c
        assert len(result.records) == 3
        assert result.records[0].packet_id == "pkt-a"
        assert result.records[1].packet_id == "pkt-b"
        assert result.records[2].packet_id == "pkt-c"


class TestMultiPacketOverlayVisibility:
    """Earlier results visible to later packets via overlay."""

    @pytest.mark.asyncio
    async def test_overlay_provides_context_to_later_packets(self):
        """Verify pipeline calls resolve for each packet in order."""
        context = _make_context()
        pkt1 = _make_packet("pkt-1", seq_range=(1, 2))
        pkt2 = _make_packet("pkt-2", seq_range=(3, 4))
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.LOW, best_match=None,
                stage_status=StageExecutionStatus.COMPLETED,
            ),
            sufficiency=_make_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=False,
                rationale="test",
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt1, pkt2],
            propositions_map={
                pkt1.packet_id: [prop],
                pkt2.packet_id: [prop],
            },
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # Both packets processed, second packet had overlay from first
        assert len(result.records) == 2
        # Retrieval coordinator called twice (once per packet)
        assert pipeline._retrieval.retrieve_candidates.call_count == 2


# ===========================================================================
# 4. Widening
# ===========================================================================


class TestWideningResolves:
    """Initial retrieval inconclusive → widening → resolve."""

    @pytest.mark.asyncio
    async def test_widening_finds_candidate_then_resolves(self):
        """Widening finds new candidate → re-evaluation → YES."""
        concern = _make_concern("concern-found")
        context = _make_context(concerns=[concern])
        packet = _make_packet()
        prop = _make_proposition()

        # Initial sufficiency is MEDIUM (inconclusive), triggers widening
        inconclusive = _make_sufficiency(
            confidence=BehavioralConfidenceBand.MEDIUM
        )
        # After widening + re-eval, sufficiency becomes HIGH
        adequate = _make_sufficiency(confidence=BehavioralConfidenceBand.HIGH)

        # Initial eval: no HIGH match
        initial_eval = _make_eval_result(
            confidence=BehavioralConfidenceBand.LOW,
            best_match=None,
            competing=[],
        )
        # Re-eval after widening: HIGH match
        post_widening_eval = _make_eval_result(
            confidence=BehavioralConfidenceBand.HIGH,
            best_match="concern-found",
            competing=[],
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=50,
            ),
            eval_result=initial_eval,
            sufficiency=inconclusive,
            widening_result=WideningResult(
                new_attempts=[_make_retrieval_attempt(
                    attempt_id="widening-1",
                    candidate_ids=["concern-found"],
                )],
                new_candidate_ids=["concern-found"],
                budget_exhausted=False,
                rationale="Found new candidate via widening",
            ),
        )
        # Override evaluator to return different results on successive calls
        pipeline._evaluator.evaluate = AsyncMock(
            side_effect=[initial_eval, post_widening_eval]
        )
        # Override sufficiency to return adequate after widening
        pipeline._sufficiency_gate.evaluate = MagicMock(
            side_effect=[inconclusive, adequate]
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.matched_concern_id == "concern-found"


class TestWideningBudgetExhausted:
    """Initial retrieval inconclusive → widening budget exhausted → INCONCLUSIVE."""

    @pytest.mark.asyncio
    async def test_widening_budget_exhausted_stays_inconclusive(self):
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        inconclusive = _make_sufficiency(
            confidence=BehavioralConfidenceBand.MEDIUM
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.LOW,
                best_match=None,
                competing=[],
                stage_status=StageExecutionStatus.COMPLETED,
            ),
            sufficiency=inconclusive,
            widening_result=WideningResult(
                new_attempts=[],
                new_candidate_ids=[],
                budget_exhausted=True,
                rationale="Max attempts reached",
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert record.action == ResolutionAction.RETAIN_PENDING


class TestWideningNewCandidateHighMatch:
    """Widening finds new candidate → re-evaluation produces HIGH → YES."""

    @pytest.mark.asyncio
    async def test_widening_new_candidate_high_match(self):
        concern = _make_concern("concern-widened")
        context = _make_context(concerns=[concern])
        packet = _make_packet()
        prop = _make_proposition()

        inconclusive = _make_sufficiency(
            confidence=BehavioralConfidenceBand.MEDIUM
        )
        initial_eval = _make_eval_result(
            confidence=BehavioralConfidenceBand.LOW,
            best_match=None,
            competing=[],
            stage_status=StageExecutionStatus.COMPLETED,
        )
        high_eval = _make_eval_result(
            confidence=BehavioralConfidenceBand.HIGH,
            best_match="concern-widened",
            competing=[],
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=50,
            ),
            eval_result=initial_eval,
            sufficiency=inconclusive,
            widening_result=WideningResult(
                new_attempts=[_make_retrieval_attempt(
                    attempt_id="widen-1",
                    candidate_ids=["concern-widened"],
                )],
                new_candidate_ids=["concern-widened"],
                budget_exhausted=False,
                rationale="Found candidate via widening",
            ),
        )
        pipeline._evaluator.evaluate = AsyncMock(
            side_effect=[initial_eval, high_eval]
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.matched_concern_id == "concern-widened"
        assert record.identity_confidence == BehavioralConfidenceBand.HIGH


# ===========================================================================
# 5. Fail-Closed Invariants
# ===========================================================================


class TestFailClosedInvariants:
    """Fail-closed: pipeline never fabricates outcomes or bypasses gates."""

    @pytest.mark.asyncio
    async def test_missing_propositions_produces_defer(self):
        """Missing propositions → DEFER (validation fails)."""
        context = _make_context()
        packet = _make_packet()

        pipeline = _build_pipeline(prop_validation_valid=False)

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: []},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.DEFER
        assert record.matched_concern_id is None
        assert record.proposed_concern_id is None

    @pytest.mark.asyncio
    async def test_evaluation_failed_never_becomes_low_or_novelty(self):
        """Evaluation FAILED → DEFER, never LOW confidence, never novelty."""
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

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
            eval_result=_make_eval_result(
                confidence=None,
                best_match=None,
                stage_status=StageExecutionStatus.FAILED,
                failure_reason="Model unavailable",
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]
        assert record.outcome == PipelineOutcome.DEFER
        # NEVER becomes LOW
        assert record.identity_confidence is None
        # NEVER becomes novelty
        assert record.proposed_concern_id is None
        assert record.action == ResolutionAction.RETAIN_PENDING

    @pytest.mark.asyncio
    async def test_empty_retrieval_adequate_sufficiency_checks_novelty(self):
        """Empty retrieval + adequate sufficiency → novelty check (not auto-novelty)."""
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_make_retrieval_attempt(
                    status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                    candidate_ids=[],
                )],
                candidates=[],
                total_latency_ms=50,
            ),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.LOW,
                best_match=None,
                competing=[],
                stage_status=StageExecutionStatus.COMPLETED,
            ),
            sufficiency=_make_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=True,
                rationale="Empty retrieval, adequate coverage",
            ),
            novelty_result=NoveltyResult(
                eligible=True,
                proposal=ConcernProposal(
                    concern_creation_key="novel-key",
                    proposed_concern_id="new-concern-novel",
                    identity_summary="Novel concern",
                    display_title="Novel",
                    initial_summary="Novel summary",
                ),
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                rationale="Novelty passes all preconditions",
                blocked_reason=None,
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # Novelty checker was called (not auto-granted)
        pipeline._novelty_checker.check_novelty.assert_called_once()
        record = result.records[0]
        assert record.outcome == PipelineOutcome.NO
        assert record.action == ResolutionAction.PROPOSE_NEW


# ===========================================================================
# 6. Route-Level Integration (supplementing existing tests)
# ===========================================================================


class TestRouteIdentityResolutionOnlyComplete:
    """IDENTITY_RESOLUTION_ONLY produces complete ProcessResult with records."""

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_produces_complete_process_result(self):
        from unittest.mock import AsyncMock, MagicMock

        from fastapi.testclient import TestClient

        from app.main import app
        from app.sie.routes import set_pipeline, set_policy

        try:
            set_policy(_make_policy())
            mock_pipeline = MagicMock()
            mock_pipeline.resolve = AsyncMock(
                return_value=PipelineResult(
                    records=[],
                    dependency_groups=[],
                    mutations=[{"type": "assign", "concern_id": "c-1"}],
                    associations=[],
                    pending_bundles=[],
                    proposals=[],
                )
            )
            set_pipeline(mock_pipeline)

            client = TestClient(app)
            body = {
                "api_contract_version": "1.0.0",
                "pipeline_version": "1.0.0",
                "model_version": "gpt-4-turbo",
                "extraction_version": "1.0.0",
                "request_id": "req-route-1",
                "idempotency_key": "idem-route-1",
                "conversation_id": "conv-route-1",
                "base_graph_version": 5,
                "message_seq_start": 1,
                "message_seq_end": 3,
                "semantic_policy_version": "1.0.0",
                "retrieval_policy_version": "1.0.0",
                "processing_mode": "IDENTITY_RESOLUTION_ONLY",
                "messages": [
                    {
                        "message_id": "msg-1",
                        "conversation_id": "conv-route-1",
                        "role": "USER",
                        "content": "Test message",
                        "sequence_position": 1,
                        "created_at": "2024-01-01T00:00:00Z",
                    }
                ],
                "context_window": [],
                "current_graph_state": {
                    "graph_version": 5,
                    "snapshot_token": "snap-v5",
                    "snapshot_digest": "sha256-test",
                    "concerns": [],
                    "propositions": [],
                    "active_associations": [],
                    "pending_decisions": [],
                    "pending_identity_details": [
                        {
                            "decision_id": "dec-1",
                            "packet_id": "pkt-1",
                            "outcome": "UNRESOLVED",
                            "proposition_ids": ["prop-1"],
                            "graph_version_analyzed": 5,
                        }
                    ],
                },
            }

            response = client.post("/sie/process-messages", json=body)
            assert response.status_code == 200
            result = response.json()
            # Complete ProcessResult shape
            assert "identity_resolution_records" in result
            assert "identity_mutations" in result
            assert result["identity_mutations"] == [
                {"type": "assign", "concern_id": "c-1"}
            ]
            assert result["request_id"] == "req-route-1"
            assert result["conversation_id"] == "conv-route-1"
            assert result["base_graph_version"] == 5
            assert "diagnostics" in result
        finally:
            set_pipeline(None)
            set_policy(None)


class TestRoutePendingReEvaluationComplete:
    """PENDING_RE_EVALUATION with valid trigger produces complete result."""

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_produces_complete_result_with_trigger(self):
        from unittest.mock import AsyncMock, MagicMock

        from fastapi.testclient import TestClient

        from app.main import app
        from app.sie.routes import set_pipeline, set_policy

        try:
            set_policy(_make_policy())
            mock_pipeline = MagicMock()
            mock_pipeline.resolve = AsyncMock(
                return_value=PipelineResult(
                    records=[],
                    dependency_groups=[],
                    mutations=[],
                    associations=[],
                    pending_bundles=[],
                    proposals=[],
                )
            )
            set_pipeline(mock_pipeline)

            client = TestClient(app)
            body = {
                "api_contract_version": "1.0.0",
                "pipeline_version": "1.0.0",
                "model_version": "gpt-4-turbo",
                "extraction_version": "1.0.0",
                "request_id": "req-reeval-1",
                "idempotency_key": "idem-reeval-1",
                "conversation_id": "conv-reeval-1",
                "base_graph_version": 7,
                "message_seq_start": 1,
                "message_seq_end": 5,
                "semantic_policy_version": "1.0.0",
                "retrieval_policy_version": "1.0.0",
                "processing_mode": "PENDING_RE_EVALUATION",
                "re_evaluation_trigger": "new_evidence",
                "messages": [
                    {
                        "message_id": "msg-1",
                        "conversation_id": "conv-reeval-1",
                        "role": "USER",
                        "content": "New evidence arrived",
                        "sequence_position": 1,
                        "created_at": "2024-01-01T00:00:00Z",
                    }
                ],
                "context_window": [],
                "current_graph_state": {
                    "graph_version": 7,
                    "snapshot_token": "snap-v7",
                    "snapshot_digest": "sha256-test",
                    "concerns": [],
                    "propositions": [],
                    "active_associations": [],
                    "pending_decisions": [],
                    "pending_identity_details": [
                        {
                            "decision_id": "dec-reeval-1",
                            "packet_id": "pkt-reeval-1",
                            "outcome": "UNRESOLVED",
                            "proposition_ids": ["prop-r1"],
                            "graph_version_analyzed": 6,
                        }
                    ],
                },
            }

            response = client.post("/sie/process-messages", json=body)
            assert response.status_code == 200
            result = response.json()
            assert result["request_id"] == "req-reeval-1"
            assert result["base_graph_version"] == 7
            diag = result["diagnostics"]
            assert diag["stage_versions"]["re_evaluation_trigger"] == "new_evidence"
            mock_pipeline.resolve.assert_called_once()
        finally:
            set_pipeline(None)
            set_policy(None)


# ===========================================================================
# 7. Upstream Stage Reuse (no duplicate extraction/retention logic)
# ===========================================================================


class TestUpstreamStageReuse:
    """Verify pipeline reuses upstream stages without introducing duplicates."""

    @pytest.mark.asyncio
    async def test_retrieval_coordinator_called_once_per_packet(self):
        """Each packet's retrieval is called exactly once (no duplicate)."""
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

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
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-1",
                competing=[],
            ),
        )

        await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # Retrieval called exactly once (not duplicated)
        pipeline._retrieval.retrieve_candidates.assert_called_once()

    @pytest.mark.asyncio
    async def test_evaluator_called_once_for_early_high(self):
        """Early HIGH match short-circuits — evaluator called once."""
        context = _make_context(concerns=[_make_concern()])
        packet = _make_packet()
        prop = _make_proposition()

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
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-1",
                competing=[],
            ),
        )

        await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # Early HIGH short-circuits: evaluator called once, sufficiency not called
        pipeline._evaluator.evaluate.assert_called_once()
        pipeline._sufficiency_gate.evaluate.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_extraction_or_retention_logic_in_pipeline(self):
        """Pipeline does not perform extraction or retention (upstream stages).
        
        This verifies the pipeline only does identity resolution, not
        extraction or retention, avoiding duplicate logic.
        """
        context = _make_context()
        packet = _make_packet()
        prop = _make_proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(),
            eval_result=_make_eval_result(
                confidence=BehavioralConfidenceBand.LOW, best_match=None,
                stage_status=StageExecutionStatus.COMPLETED,
            ),
            sufficiency=_make_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=False,
                rationale="test",
            ),
        )

        result = await pipeline.resolve(
            packets=[packet],
            propositions_map={packet.packet_id: [prop]},
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # Pipeline produces identity records only — no retention decisions
        # or propositions (those are upstream concerns)
        assert isinstance(result, PipelineResult)
        # Pipeline result has no retention_decisions field
        assert not hasattr(result, "retention_decisions")
