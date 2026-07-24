"""End-to-end semantic flow integration tests for SIE identity resolution.

Tests the FULL pipeline flow end-to-end: packet enters → retrieval →
evaluation → sufficiency → widening → novelty/assignment → output.

Uses deterministic fake adapters (no real LLM calls) to test complete
semantic flows through the IdentityResolutionPipeline.

Covers:
1. Existing assignment: packet matches one HIGH concern → YES/ASSIGN_EXISTING
2. Adequate ambiguity: two HIGH candidates → UNRESOLVED/RETAIN_PENDING
3. Adequate novelty: no match + adequate retrieval + independent → NO/PROPOSE_NEW
4. Inconclusive widening: initial fails → widening → still inconclusive
5. Dormant reactivation: HIGH match to dormant → YES + reactivation group
6. Retired reopening: HIGH match to retired → reactivation
7. Merge redirect: match merged → follow redirect → match survivor
8. Pending resolution: previously pending resolved by new evidence
9. Multi-role associations: multiple retention roles → multiple associations
10. Shared proposals: multiple packets → same uncommitted proposal

Task 18.1 — mandatory end-to-end integration tests.
Design authority: consolidated final design.md.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.sie.associations import PropositionAssociation
from app.sie.contracts import (
    ConcernSummary,
    GraphStateContext,
    SemanticDependencyGroupRef,
)
from app.sie.enums import (
    AssociationRole,
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
    ChannelDiagnostic,
    EvidenceReference,
    IRSSignal,
    IdentityResolutionRecord,
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


# ===========================================================================
# Factories
# ===========================================================================


def _policy() -> IdentityResolutionPolicy:
    """Standard policy fixture for all e2e tests."""
    return IdentityResolutionPolicy(
        policy_version="e2e-1.0.0",
        retrieval_policy=RetrievalPolicy(
            policy_version="e2e-1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="ch-embed-primary",
                    query_mode="semantic_similarity",
                    scope_overrides={},
                ),
            ],
            channel_family_requirements={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=True,
                ),
            },
            irs_signal_channel_mapping={
                "ALIAS_OR_VOCABULARY_DRIFT": [
                    ChannelInvocation(
                        channel_id="ch-alias-norm",
                        query_mode="alias_normalized",
                        scope_overrides={},
                    ),
                ],
                "HISTORICAL_REFERENT": [
                    ChannelInvocation(
                        channel_id="ch-historical",
                        query_mode="historical_region",
                        scope_overrides={},
                    ),
                ],
            },
        ),
        widening_budget=WideningBudgetPolicy(
            budget_version="e2e-1.0.0",
            max_widening_rounds=2,
            max_total_attempts=6,
            max_latency_ms=3000,
            max_cost_units=50.0,
        ),
        pending_re_evaluation_policy=ReEvaluationPolicy(
            policy_version="e2e-1.0.0",
            triggers=["new_evidence", "alias_change", "policy_change"],
            max_re_evaluation_attempts=3,
            cooldown_between_attempts_ms=30000,
        ),
        permitted_embedding_model_versions=["v1.0"],
    )


def _context(
    concerns: list[ConcernSummary] | None = None,
    graph_version: int = 10,
) -> GraphStateContext:
    """Standard immutable graph context."""
    return GraphStateContext(
        graph_version=graph_version,
        snapshot_token=f"snap-v{graph_version}",
        snapshot_digest="sha256-e2e-test",
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


def _packet(
    packet_id: str = "e2e-pkt-1",
    seq_range: tuple[int, int] = (1, 3),
) -> SemanticPacket:
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=f"creation-{packet_id}",
        conversation_id="conv-e2e-001",
        source_message_ids=["msg-1"],
        message_seq_range=seq_range,
        user_grounded_meaning="User wants to learn Python programming",
        provenance="e2e-test",
        packet_formation_version="1.0.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _proposition(
    prop_id: str = "e2e-prop-1",
    retention_levels: list[RetentionLevel] | None = None,
    speaker_role: str = "USER",
) -> Proposition:
    return Proposition(
        proposition_id=prop_id,
        proposition_creation_key=f"creation-{prop_id}",
        conversation_id="conv-e2e-001",
        source_message_ids=["msg-1"],
        speaker_role=speaker_role,
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


def _concern(
    concern_id: str = "concern-1",
    status: ConcernStatus = ConcernStatus.ACTIVE,
    merged_into: str | None = None,
    identity_summary: str = "Learning Python programming",
) -> ConcernSummary:
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary=identity_summary,
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


def _attempt(
    attempt_id: str = "attempt-1",
    status: RetrievalAttemptStatus = RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
    candidate_ids: list[str] | None = None,
    channel_family: str = "embedding_primary",
) -> RetrievalAttemptRecord:
    cids = candidate_ids or []
    return RetrievalAttemptRecord(
        attempt_id=attempt_id,
        channel_id="ch-embed-primary",
        channel_family=channel_family,
        query_mode="semantic_similarity",
        query_reference="query-ref-e2e",
        scope_description="default scope",
        status=status,
        candidate_ids=cids,
        candidate_count=len(cids),
        latency_ms=45,
        retrieval_policy_version="e2e-1.0.0",
    )


def _sufficiency(
    confidence: BehavioralConfidenceBand = BehavioralConfidenceBand.HIGH,
    unresolved_signals: list[IRSSignal] | None = None,
) -> SufficiencyRecord:
    return SufficiencyRecord(
        stage_status=StageExecutionStatus.COMPLETED,
        confidence=confidence,
        coverage_summary="All required channels succeeded",
        unresolved_signals=unresolved_signals or [],
        failed_coverage_gaps=[],
        rationale="Retrieval adequacy established",
    )


def _eval_result(
    confidence: BehavioralConfidenceBand | None = BehavioralConfidenceBand.HIGH,
    best_match: str | None = "concern-1",
    competing: list[str] | None = None,
    stage_status: StageExecutionStatus = StageExecutionStatus.COMPLETED,
    substantive_resumption: bool | None = None,
    failure_reason: str | None = None,
    candidate_records: list[CandidateRecord] | None = None,
) -> IdentityEvaluationResult:
    return IdentityEvaluationResult(
        stage_status=stage_status,
        confidence=confidence,
        candidate_records=candidate_records or [],
        best_match_concern_id=best_match,
        competing_candidate_ids=competing or [],
        substantive_resumption=substantive_resumption,
        explanation="e2e evaluation result",
        failure_reason=failure_reason,
    )


# ===========================================================================
# Pipeline builder
# ===========================================================================


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
    associations: list[PropositionAssociation] | None = None,
) -> IdentityResolutionPipeline:
    """Build pipeline with mocked components for full end-to-end tests."""
    retrieval_coordinator = MagicMock()
    retrieval_coordinator.retrieve_candidates = AsyncMock(
        return_value=retrieval_result or RetrievalResult()
    )

    evaluator = MagicMock()
    evaluator.evaluate = AsyncMock(
        return_value=eval_result or _eval_result()
    )

    sufficiency_gate = MagicMock()
    sufficiency_gate.evaluate = MagicMock(
        return_value=sufficiency or _sufficiency()
    )

    separator = MagicMock()
    separator.determine_outcome = MagicMock(
        return_value=downstream or DownstreamDecision(
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            matched_concern_id="concern-1",
            requires_widening=False,
            novelty_eligible=False,
            rationale="e2e test",
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
            rationale="e2e test",
            blocked_reason="test",
        )
    )

    lifecycle_handler = MagicMock()
    lifecycle_handler.follow_merge_redirect = MagicMock(
        return_value=merge_redirect or MergeRedirectResult(
            resolved=True,
            target_concern=_concern(),
            redirect_path=["concern-1"],
        )
    )
    lifecycle_handler.build_reactivation_group = MagicMock(
        return_value=SemanticDependencyGroupRef(
            group_id="reactivation-group-e2e",
            mutation_refs=["status_transition:reactivate"],
            failure_policy="ALL_OR_NONE",
        )
    )

    pending_mgr = MagicMock()
    pending_mgr.create_pending_decision = MagicMock(
        return_value=MagicMock(is_duplicate=False)
    )

    association_assembler = MagicMock()
    association_assembler.assemble_associations = MagicMock(
        return_value=associations or []
    )

    coalescer = MagicMock()
    coalescer.coalesce_proposal = MagicMock(
        return_value=coalesced or CoalescedProposalResult(
            is_shared=False,
            proposal=ConcernProposal(
                concern_creation_key="novelty-key-e2e",
                proposed_concern_id="new-concern-e2e",
                identity_summary="new e2e concern",
                display_title="New E2E Concern",
                initial_summary="new e2e concern summary",
            ),
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            is_first_proposer=True,
            dependency_group=SemanticDependencyGroupRef(
                group_id="proposal-group:new-concern-e2e",
                mutation_refs=["create-concern:new-concern-e2e"],
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
            return_value=MagicMock(valid=False, rationale="Missing propositions")
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


_RESOLVE_KWARGS = dict(
    request_id="e2e-req-001",
    idempotency_key="e2e-idem-001",
    conversation_id="conv-e2e-001",
    semantic_policy_version="e2e-1.0.0",
    model_config_version="gpt-4-turbo",
    prompt_version="e2e-1.0.0",
)


# ===========================================================================
# Flow 1: Existing Assignment
# Packet matches one HIGH concern → YES/ASSIGN_EXISTING
# ===========================================================================


class TestFlowExistingAssignment:
    """Full end-to-end: packet retrieves one HIGH match → assign to existing."""

    @pytest.mark.asyncio
    async def test_full_flow_existing_assignment(self):
        """Packet enters → retrieval finds concern → evaluator returns HIGH →
        pipeline short-circuits before sufficiency → YES/ASSIGN_EXISTING."""
        concern = _concern("concern-python", identity_summary="Python learning")
        ctx = _context(concerns=[concern])
        pkt = _packet()
        prop = _proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(candidate_ids=["concern-python"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-python",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=45,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-python",
                competing=[],
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        # Verify complete output structure
        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        assert record.matched_concern_id == "concern-python"
        assert record.proposed_concern_id is None
        assert record.identity_confidence == BehavioralConfidenceBand.HIGH
        assert record.identity_stage_status == StageExecutionStatus.COMPLETED
        # Sufficiency NOT_RUN because short-circuited before sufficiency gate
        assert record.sufficiency_stage_status == StageExecutionStatus.NOT_RUN
        assert record.sufficiency_confidence is None
        # Metadata preserved
        assert record.packet_id == pkt.packet_id
        assert record.conversation_id == "conv-e2e-001"
        assert record.graph_version_analyzed == 10
        assert record.request_id == "e2e-req-001"
        assert record.semantic_policy_version == "e2e-1.0.0"


# ===========================================================================
# Flow 2: Adequate Ambiguity
# Two HIGH candidates → UNRESOLVED/RETAIN_PENDING
# ===========================================================================


class TestFlowAdequateAmbiguity:
    """Full end-to-end: two competing HIGH candidates → UNRESOLVED."""

    @pytest.mark.asyncio
    async def test_full_flow_adequate_ambiguity(self):
        """Packet enters → retrieval finds two concerns → evaluator returns
        MEDIUM with two competing → sufficiency ADEQUATE → downstream
        produces UNRESOLVED/RETAIN_PENDING."""
        concerns = [
            _concern("concern-a", identity_summary="Python web dev"),
            _concern("concern-b", identity_summary="Python data science"),
        ]
        ctx = _context(concerns=concerns)
        pkt = _packet()
        prop = _proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(
                    candidate_ids=["concern-a", "concern-b"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-a",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    ),
                    RetrievalCandidate(
                        concern_id="concern-b",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    ),
                ],
                total_latency_ms=55,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.MEDIUM,
                best_match=None,
                competing=["concern-a", "concern-b"],
            ),
            sufficiency=_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH,
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=False,
                rationale="Multiple competitive candidates, identity ambiguity",
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.UNRESOLVED
        assert record.action == ResolutionAction.RETAIN_PENDING
        assert record.matched_concern_id is None
        assert record.proposed_concern_id is None
        # Identity evaluated but non-actionable
        assert record.identity_stage_status == StageExecutionStatus.COMPLETED
        assert record.identity_confidence == BehavioralConfidenceBand.MEDIUM
        # Sufficiency completed and adequate
        assert record.sufficiency_stage_status == StageExecutionStatus.COMPLETED
        assert record.sufficiency_confidence == BehavioralConfidenceBand.HIGH
        # Pending decision created
        assert len(result.pending_bundles) == 1
        # No dependency groups (no ownership mutation)
        assert len(result.dependency_groups) == 0


# ===========================================================================
# Flow 3: Adequate Novelty
# No match + adequate retrieval + independent concern → NO/PROPOSE_NEW
# ===========================================================================


class TestFlowAdequateNovelty:
    """Full end-to-end: no match + adequate → novelty confirmed."""

    @pytest.mark.asyncio
    async def test_full_flow_adequate_novelty(self):
        """Packet enters → retrieval finds nothing → evaluator LOW →
        sufficiency ADEQUATE → downstream novelty_eligible →
        novelty checker confirms → coalescer → NO/PROPOSE_NEW."""
        ctx = _context(concerns=[])
        pkt = _packet()
        prop = _proposition(
            retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE]
        )

        proposal = ConcernProposal(
            concern_creation_key="novelty-key-python",
            proposed_concern_id="new-concern-python",
            identity_summary="Learning Python programming",
            display_title="Python Learning",
            initial_summary="User wants to learn Python",
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=40,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.LOW,
                best_match=None,
                competing=[],
            ),
            sufficiency=_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH,
            ),
            downstream=DownstreamDecision(
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                matched_concern_id=None,
                requires_widening=False,
                novelty_eligible=True,
                rationale="Adequate retrieval, no plausible candidates",
            ),
            novelty_result=NoveltyResult(
                eligible=True,
                proposal=proposal,
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                rationale="Novelty confirmed: independent concern candidate",
                blocked_reason=None,
            ),
            coalesced=CoalescedProposalResult(
                is_shared=False,
                proposal=proposal,
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                is_first_proposer=True,
                dependency_group=SemanticDependencyGroupRef(
                    group_id="proposal-group:new-concern-python",
                    mutation_refs=["create-concern:new-concern-python"],
                    failure_policy="ALL_OR_NONE",
                ),
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.NO
        assert record.action == ResolutionAction.PROPOSE_NEW
        assert record.proposed_concern_id == "new-concern-python"
        assert record.matched_concern_id is None
        # Sufficiency must be COMPLETED/HIGH for novelty
        assert record.sufficiency_stage_status == StageExecutionStatus.COMPLETED
        assert record.sufficiency_confidence == BehavioralConfidenceBand.HIGH
        # Dependency group for concern creation
        assert len(result.dependency_groups) == 1
        assert result.dependency_groups[0].failure_policy == "ALL_OR_NONE"
        # Proposal tracked
        assert len(result.proposals) == 1
        assert result.proposals[0].proposed_concern_id == "new-concern-python"


# ===========================================================================
# Flow 4: Inconclusive Widening
# Initial retrieval fails → widening → still inconclusive
# ===========================================================================


class TestFlowInconclusiveWidening:
    """Full end-to-end: widening attempted but budget exhausted → INCONCLUSIVE."""

    @pytest.mark.asyncio
    async def test_full_flow_inconclusive_widening(self):
        """Packet enters → retrieval finds nothing → sufficiency MEDIUM
        (inconclusive) → widening attempted → budget exhausted → still
        MEDIUM → RETRIEVAL_INCONCLUSIVE/RETAIN_PENDING."""
        ctx = _context(concerns=[])
        pkt = _packet()
        prop = _proposition()

        inconclusive = _sufficiency(
            confidence=BehavioralConfidenceBand.MEDIUM,
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=50,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.LOW,
                best_match=None,
                competing=[],
            ),
            sufficiency=inconclusive,
            widening_result=WideningResult(
                new_attempts=[
                    _attempt(
                        attempt_id="widening-1",
                        candidate_ids=[],
                        channel_family="historical_region",
                    ),
                ],
                new_candidate_ids=[],
                budget_exhausted=True,
                rationale="Budget exhausted without finding candidates",
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert record.action == ResolutionAction.RETAIN_PENDING
        assert record.matched_concern_id is None
        assert record.proposed_concern_id is None
        # Never produces novelty when inconclusive
        assert record.proposed_concern_id is None
        # Pending decision created
        assert len(result.pending_bundles) == 1
        # No dependency groups
        assert len(result.dependency_groups) == 0


# ===========================================================================
# Flow 5: Dormant Reactivation
# HIGH match to dormant concern → YES/ASSIGN_EXISTING + reactivation group
# ===========================================================================


class TestFlowDormantReactivation:
    """Full end-to-end: dormant concern matched → reactivation."""

    @pytest.mark.asyncio
    async def test_full_flow_dormant_reactivation(self):
        """Packet enters → retrieval finds dormant concern → evaluator HIGH
        with substantive_resumption=True → YES + reactivation dependency group
        containing status transition DORMANT→ACTIVE."""
        dormant = _concern(
            "concern-dormant-python",
            status=ConcernStatus.DORMANT,
            identity_summary="Python advanced topics",
        )
        ctx = _context(concerns=[dormant])
        pkt = _packet()
        prop = _proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(
                    candidate_ids=["concern-dormant-python"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-dormant-python",
                        lifecycle_status=ConcernStatus.DORMANT,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-dormant-python",
                competing=[],
                substantive_resumption=True,
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        assert record.matched_concern_id == "concern-dormant-python"
        assert record.identity_confidence == BehavioralConfidenceBand.HIGH
        # Reactivation dependency group emitted
        assert len(result.dependency_groups) == 1
        reactivation_group = result.dependency_groups[0]
        assert reactivation_group.failure_policy == "ALL_OR_NONE"
        assert "reactivat" in reactivation_group.group_id.lower() or \
               "status_transition" in str(reactivation_group.mutation_refs)
        # Associations assembled for the matched concern
        pipeline._association_assembler.assemble_associations.assert_called()


# ===========================================================================
# Flow 6: Retired Reopening
# HIGH match to retired concern → reactivation
# ===========================================================================


class TestFlowRetiredReopening:
    """Full end-to-end: retired concern substantively resumed → reactivation."""

    @pytest.mark.asyncio
    async def test_full_flow_retired_reopening(self):
        """Packet enters → retrieval finds retired concern → evaluator HIGH
        with substantive_resumption=True → YES + reactivation group."""
        retired = _concern(
            "concern-retired-rust",
            status=ConcernStatus.RETIRED,
            identity_summary="Learning Rust programming",
        )
        ctx = _context(concerns=[retired])
        pkt = _packet()
        prop = _proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(
                    candidate_ids=["concern-retired-rust"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-retired-rust",
                        lifecycle_status=ConcernStatus.RETIRED,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-retired-rust",
                competing=[],
                substantive_resumption=True,
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        assert record.matched_concern_id == "concern-retired-rust"
        # Reactivation group emitted (retired → active)
        assert len(result.dependency_groups) == 1
        assert result.dependency_groups[0].failure_policy == "ALL_OR_NONE"


# ===========================================================================
# Flow 7: Merge Redirect
# Match merged concern → follow redirect → match surviving concern
# ===========================================================================


class TestFlowMergeRedirect:
    """Full end-to-end: merged concern → redirect → assign to survivor."""

    @pytest.mark.asyncio
    async def test_full_flow_merge_redirect(self):
        """Packet enters → retrieval finds merged concern → evaluator HIGH →
        lifecycle follows merge redirect → assigns to surviving concern."""
        merged = _concern(
            "concern-merged-old",
            status=ConcernStatus.MERGED,
            merged_into="concern-survivor",
            identity_summary="Old Python learning concern",
        )
        survivor = _concern(
            "concern-survivor",
            status=ConcernStatus.ACTIVE,
            identity_summary="Python learning (canonical)",
        )
        ctx = _context(concerns=[merged, survivor])
        pkt = _packet()
        prop = _proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(
                    candidate_ids=["concern-merged-old"]
                )],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-merged-old",
                        lifecycle_status=ConcernStatus.MERGED,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-merged-old",
                competing=[],
            ),
            merge_redirect=MergeRedirectResult(
                resolved=True,
                target_concern=survivor,
                redirect_path=["concern-merged-old", "concern-survivor"],
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        # Resolved to the SURVIVING concern, not the merged one
        assert record.matched_concern_id == "concern-survivor"
        assert record.proposed_concern_id is None


# ===========================================================================
# Flow 8: Pending Resolution
# Previously pending decision resolved by new evidence
# ===========================================================================


class TestFlowPendingResolution:
    """Full end-to-end: new packet resolves a previously pending decision."""

    @pytest.mark.asyncio
    async def test_full_flow_pending_resolution(self):
        """First packet → UNRESOLVED (pending). Second packet in same request
        provides new evidence → pipeline processes both packets. The first
        remains UNRESOLVED (pending decisions are resolved by separate
        re-evaluation triggers, not within the same resolve call).

        This test verifies that the pending decision is created and a subsequent
        packet can still be processed independently without corrupting the
        pending state.
        """
        concern = _concern("concern-ambig", identity_summary="Ambiguous concern")
        ctx = _context(concerns=[concern])
        pkt1 = _packet("pkt-pending-1", seq_range=(1, 2))
        pkt2 = _packet("pkt-new-evidence", seq_range=(3, 4))
        prop1 = _proposition("prop-1")
        prop2 = _proposition("prop-2")

        # For pkt1: ambiguous → UNRESOLVED
        # For pkt2: HIGH match → YES
        eval_unresolved = _eval_result(
            confidence=BehavioralConfidenceBand.MEDIUM,
            best_match=None,
            competing=["concern-ambig"],
        )
        eval_resolved = _eval_result(
            confidence=BehavioralConfidenceBand.HIGH,
            best_match="concern-ambig",
            competing=[],
        )

        downstream_unresolved = DownstreamDecision(
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            matched_concern_id=None,
            requires_widening=False,
            novelty_eligible=False,
            rationale="Ambiguous, pending resolution",
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(candidate_ids=["concern-ambig"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-ambig",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=50,
            ),
            sufficiency=_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH,
            ),
        )

        # Configure evaluator to return different results per call
        pipeline._evaluator.evaluate = AsyncMock(
            side_effect=[eval_unresolved, eval_resolved]
        )
        # Configure downstream to return UNRESOLVED for first, not called for second
        # (second short-circuits at HIGH match)
        pipeline._separator.determine_outcome = MagicMock(
            return_value=downstream_unresolved
        )

        result = await pipeline.resolve(
            packets=[pkt1, pkt2],
            propositions_map={
                pkt1.packet_id: [prop1],
                pkt2.packet_id: [prop2],
            },
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 2

        # First packet: UNRESOLVED
        rec1 = result.records[0]
        assert rec1.packet_id == "pkt-pending-1"
        assert rec1.outcome == PipelineOutcome.UNRESOLVED
        assert rec1.action == ResolutionAction.RETAIN_PENDING
        assert rec1.matched_concern_id is None

        # Second packet: YES (resolved with HIGH evidence)
        rec2 = result.records[1]
        assert rec2.packet_id == "pkt-new-evidence"
        assert rec2.outcome == PipelineOutcome.YES
        assert rec2.action == ResolutionAction.ASSIGN_EXISTING
        assert rec2.matched_concern_id == "concern-ambig"

        # Pending decision created for first packet
        assert len(result.pending_bundles) >= 1


# ===========================================================================
# Flow 9: Multi-Role Associations
# Packet carries multiple retention roles → multiple associations created
# ===========================================================================


class TestFlowMultiRoleAssociations:
    """Full end-to-end: proposition with multiple roles → multiple associations."""

    @pytest.mark.asyncio
    async def test_full_flow_multi_role_associations(self):
        """Packet enters with proposition having both INDEPENDENT_CONCERN_CANDIDATE
        and SUPPORTING_EVIDENCE retention roles → assignment creates multiple
        normalized associations (PRIMARY_OWNER + SUPPORTING_EVIDENCE)."""
        concern = _concern("concern-multi", identity_summary="Multi-role target")
        ctx = _context(concerns=[concern])
        pkt = _packet()

        # Proposition with multiple retention levels
        prop = _proposition(
            "prop-multi-role",
            retention_levels=[
                RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE,
                RetentionLevel.SUPPORTING_EVIDENCE,
            ],
        )

        # Simulate the association assembler returning multiple associations
        multi_associations = [
            PropositionAssociation(
                association_id="assoc-primary-1",
                association_creation_key="key-primary-1",
                proposition_id="prop-multi-role",
                concern_id="concern-multi",
                role=AssociationRole.PRIMARY_OWNER,
                confidence=BehavioralConfidenceBand.HIGH,
                provenance="identity_resolution",
                established_by_packet_id=pkt.packet_id,
                semantic_state=SemanticState.ACTIVE,
                created_at="2024-01-01T00:00:00Z",
                version=1,
            ),
            PropositionAssociation(
                association_id="assoc-evidence-1",
                association_creation_key="key-evidence-1",
                proposition_id="prop-multi-role",
                concern_id="concern-multi",
                role=AssociationRole.SUPPORTING_EVIDENCE,
                confidence=BehavioralConfidenceBand.HIGH,
                provenance="identity_resolution",
                established_by_packet_id=pkt.packet_id,
                semantic_state=SemanticState.ACTIVE,
                created_at="2024-01-01T00:00:00Z",
                version=1,
            ),
        ]

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(candidate_ids=["concern-multi"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-multi",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=45,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-multi",
                competing=[],
            ),
            associations=multi_associations,
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        assert len(result.records) == 1
        record = result.records[0]
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        assert record.matched_concern_id == "concern-multi"

        # Multiple associations created (one per applicable role)
        assert len(result.associations) == 2
        roles = {a.role for a in result.associations}
        assert AssociationRole.PRIMARY_OWNER in roles
        assert AssociationRole.SUPPORTING_EVIDENCE in roles

        # All associations target the same concern
        for assoc in result.associations:
            assert assoc.concern_id == "concern-multi"
            assert assoc.proposition_id == "prop-multi-role"
            assert assoc.established_by_packet_id == pkt.packet_id
            assert assoc.semantic_state == SemanticState.ACTIVE


# ===========================================================================
# Flow 10: Shared Proposals
# Multiple packets matching same uncommitted proposal → same concern_id
# ===========================================================================


class TestFlowSharedProposals:
    """Full end-to-end: two packets both propose the same new concern."""

    @pytest.mark.asyncio
    async def test_full_flow_shared_proposals(self):
        """Two packets in same request → both novelty-eligible → coalescer
        assigns both to the same proposed concern_id. Only ONE concern-
        creation mutation emitted (first proposer), second references shared
        proposal without duplicating the dependency group."""
        ctx = _context(concerns=[])
        pkt1 = _packet("pkt-share-1", seq_range=(1, 2))
        pkt2 = _packet("pkt-share-2", seq_range=(3, 4))
        prop1 = _proposition(
            "prop-share-1",
            retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
        )
        prop2 = _proposition(
            "prop-share-2",
            retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE],
        )

        shared_proposal = ConcernProposal(
            concern_creation_key="shared-novelty-key",
            proposed_concern_id="new-concern-shared",
            identity_summary="Shared novel Python concern",
            display_title="Shared Python",
            initial_summary="Both packets describe same new concern",
        )

        # First call: first proposer with dependency group
        first_coalesced = CoalescedProposalResult(
            is_shared=False,
            proposal=shared_proposal,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            is_first_proposer=True,
            dependency_group=SemanticDependencyGroupRef(
                group_id="proposal-group:new-concern-shared",
                mutation_refs=["create-concern:new-concern-shared"],
                failure_policy="ALL_OR_NONE",
            ),
        )
        # Second call: shared, not first proposer, no new dependency group
        second_coalesced = CoalescedProposalResult(
            is_shared=True,
            proposal=shared_proposal,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            is_first_proposer=False,
            dependency_group=None,
        )

        novelty = NoveltyResult(
            eligible=True,
            proposal=shared_proposal,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            rationale="Novelty confirmed",
            blocked_reason=None,
        )

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(candidate_ids=[])],
                candidates=[],
                total_latency_ms=40,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.LOW,
                best_match=None,
                competing=[],
            ),
            sufficiency=_sufficiency(
                confidence=BehavioralConfidenceBand.HIGH,
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
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        # Both packets processed
        assert len(result.records) == 2

        # Both records: NO/PROPOSE_NEW referencing the SAME proposed concern
        for record in result.records:
            assert record.outcome == PipelineOutcome.NO
            assert record.action == ResolutionAction.PROPOSE_NEW
            assert record.proposed_concern_id == "new-concern-shared"
            assert record.matched_concern_id is None

        # Only ONE dependency group (concern creation) emitted
        assert len(result.dependency_groups) == 1
        assert result.dependency_groups[0].group_id == \
            "proposal-group:new-concern-shared"
        assert result.dependency_groups[0].failure_policy == "ALL_OR_NONE"

        # Only ONE proposal tracked (not duplicated)
        assert len(result.proposals) == 1
        assert result.proposals[0].proposed_concern_id == "new-concern-shared"

        # Associations created for BOTH packets to the shared concern
        assert pipeline._association_assembler.assemble_associations.call_count == 2


# ===========================================================================
# Additional structural validation tests
# ===========================================================================


class TestE2EOutputStructuralCompleteness:
    """Verify complete output structure on successful assignment."""

    @pytest.mark.asyncio
    async def test_record_contains_all_required_fields(self):
        """IdentityResolutionRecord has all mandatory fields populated."""
        concern = _concern("concern-struct")
        ctx = _context(concerns=[concern])
        pkt = _packet()
        prop = _proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(candidate_ids=["concern-struct"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-struct",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=42,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-struct",
                competing=[],
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        record = result.records[0]

        # Required identity fields
        assert record.record_id is not None and record.record_id != ""
        assert record.request_id == "e2e-req-001"
        assert record.idempotency_key == "e2e-idem-001"
        assert record.conversation_id == "conv-e2e-001"
        assert record.packet_id == pkt.packet_id
        assert record.proposition_ids == [prop.proposition_id]
        assert record.graph_version_analyzed == 10
        assert record.graph_snapshot_token == "snap-v10"

        # Decision fields
        assert record.outcome == PipelineOutcome.YES
        assert record.action == ResolutionAction.ASSIGN_EXISTING
        assert record.identity_stage_status == StageExecutionStatus.COMPLETED
        assert record.identity_confidence == BehavioralConfidenceBand.HIGH

        # Policy version fields
        assert record.semantic_policy_version == "e2e-1.0.0"
        assert record.retrieval_policy_version == "e2e-1.0.0"
        assert record.model_config_version == "gpt-4-turbo"
        assert record.prompt_version == "e2e-1.0.0"

        # Reasoning present
        assert record.reasoning is not None and record.reasoning != ""

    @pytest.mark.asyncio
    async def test_pipeline_result_bundle_structure(self):
        """PipelineResult contains all expected bundle sections."""
        ctx = _context(concerns=[_concern()])
        pkt = _packet()
        prop = _proposition()

        pipeline = _build_pipeline(
            retrieval_result=RetrievalResult(
                attempts=[_attempt(candidate_ids=["concern-1"])],
                candidates=[
                    RetrievalCandidate(
                        concern_id="concern-1",
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=["attempt-1"],
                    )
                ],
                total_latency_ms=45,
            ),
            eval_result=_eval_result(
                confidence=BehavioralConfidenceBand.HIGH,
                best_match="concern-1",
                competing=[],
            ),
        )

        result = await pipeline.resolve(
            packets=[pkt],
            propositions_map={pkt.packet_id: [prop]},
            context=ctx,
            policy=_policy(),
            **_RESOLVE_KWARGS,
        )

        # PipelineResult has all expected attributes
        assert hasattr(result, "records")
        assert hasattr(result, "dependency_groups")
        assert hasattr(result, "mutations")
        assert hasattr(result, "associations")
        assert hasattr(result, "pending_bundles")
        assert hasattr(result, "proposals")
        assert isinstance(result.records, list)
        assert isinstance(result.dependency_groups, list)
        assert isinstance(result.associations, list)
