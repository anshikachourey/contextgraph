"""Batch/incremental Current-State Equivalence tests (Task 19.3).

Validates Requirement 12, AC 6:
    Batch and incremental evaluation SHALL require Current_State_Equivalence
    for active concern identities and proposition ownership after all repairs
    and pending resolutions are applied; identical packet boundaries or
    historical traces SHALL NOT be required.

Current_State_Equivalence means:
- Active concern IDs and identity summaries must match.
- Proposition-to-concern ownership associations must match.
- Evidence role assignments must match.
- Pending decision resolution outcomes must match.
- Hierarchy references must match.

Explicitly allowed differences:
- Packet boundaries (batch may form different packets).
- Historical trace details.
- Intermediate state / processing order.
- Record IDs and timestamps.

Design authority: consolidated final design.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
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
    ParentResolutionState,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    ResolutionAction,
    RetentionLevel,
    RetrievalAttemptStatus,
    SemanticState,
    StageExecutionStatus,
)
from app.sie.evaluator.identity_evaluator import IdentityEvaluationResult
from app.sie.identity_models import (
    CandidateRecord,
    IdentityResolutionRecord,
    RetrievalAttemptRecord,
    SufficiencyRecord,
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
# Current-State snapshot for equivalence comparison
# ===========================================================================


@dataclass
class CurrentStateSnapshot:
    """Captures the final committed state relevant to identity equivalence.

    This is the ONLY state that must be equivalent between batch and incremental
    processing. Intermediate states, packet boundaries, record IDs, and
    processing traces may differ.
    """

    # Active concern IDs and their identity summaries
    active_concerns: dict[str, str] = field(default_factory=dict)
    # Proposition-to-concern ownership: {prop_id: concern_id}
    proposition_ownership: dict[str, str] = field(default_factory=dict)
    # Evidence role assignments: {(prop_id, concern_id): role}
    evidence_roles: dict[tuple[str, str], AssociationRole] = field(
        default_factory=dict
    )
    # Pending resolution outcomes: {packet_id: outcome}
    pending_outcomes: dict[str, PipelineOutcome] = field(default_factory=dict)
    # Hierarchy references: {concern_id: parent_id or None}
    hierarchy_refs: dict[str, str | None] = field(default_factory=dict)


def extract_current_state(result: PipelineResult) -> CurrentStateSnapshot:
    """Extract the current-state snapshot from a pipeline result.

    Focuses on the semantically meaningful final state, ignoring
    packet boundaries, historical traces, and processing details.
    """
    snapshot = CurrentStateSnapshot()

    # Extract active concerns from proposals (newly created)
    for proposal in result.proposals:
        snapshot.active_concerns[proposal.proposed_concern_id] = (
            proposal.identity_summary
        )
        snapshot.hierarchy_refs[proposal.proposed_concern_id] = (
            proposal.proposed_parent_id
        )

    # Extract matched concerns (existing concerns that received assignments)
    for record in result.records:
        if (
            record.outcome == PipelineOutcome.YES
            and record.action == ResolutionAction.ASSIGN_EXISTING
            and record.matched_concern_id
        ):
            # Mark the matched concern as active in our state
            snapshot.active_concerns.setdefault(
                record.matched_concern_id, "existing"
            )
        elif record.outcome in (
            PipelineOutcome.UNRESOLVED,
            PipelineOutcome.DEFER,
            PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            PipelineOutcome.REQUIRES_VALIDATION,
        ):
            snapshot.pending_outcomes[record.packet_id] = record.outcome

    # Extract proposition ownership and evidence roles from associations
    for assoc in result.associations:
        if assoc.role == AssociationRole.PRIMARY_OWNER:
            snapshot.proposition_ownership[assoc.proposition_id] = (
                assoc.concern_id
            )
        snapshot.evidence_roles[(assoc.proposition_id, assoc.concern_id)] = (
            assoc.role
        )

    return snapshot


def assert_current_state_equivalent(
    batch_state: CurrentStateSnapshot,
    incremental_state: CurrentStateSnapshot,
) -> None:
    """Assert Current-State Equivalence between batch and incremental results.

    Checks that all semantically meaningful final state matches.
    Does NOT require identical packet boundaries, record IDs, timestamps,
    intermediate traces, or processing order.
    """
    # 1. Active concern identities must match
    assert batch_state.active_concerns == incremental_state.active_concerns, (
        f"Active concerns differ.\n"
        f"  Batch: {batch_state.active_concerns}\n"
        f"  Incremental: {incremental_state.active_concerns}"
    )

    # 2. Proposition ownership must match
    assert batch_state.proposition_ownership == (
        incremental_state.proposition_ownership
    ), (
        f"Proposition ownership differs.\n"
        f"  Batch: {batch_state.proposition_ownership}\n"
        f"  Incremental: {incremental_state.proposition_ownership}"
    )

    # 3. Evidence role assignments must match
    assert batch_state.evidence_roles == incremental_state.evidence_roles, (
        f"Evidence roles differ.\n"
        f"  Batch: {batch_state.evidence_roles}\n"
        f"  Incremental: {incremental_state.evidence_roles}"
    )

    # 4. Pending resolution outcomes must match
    assert batch_state.pending_outcomes == (
        incremental_state.pending_outcomes
    ), (
        f"Pending outcomes differ.\n"
        f"  Batch: {batch_state.pending_outcomes}\n"
        f"  Incremental: {incremental_state.pending_outcomes}"
    )

    # 5. Hierarchy references must match
    assert batch_state.hierarchy_refs == incremental_state.hierarchy_refs, (
        f"Hierarchy refs differ.\n"
        f"  Batch: {batch_state.hierarchy_refs}\n"
        f"  Incremental: {incremental_state.hierarchy_refs}"
    )


# ===========================================================================
# Test Fixtures and Factories
# ===========================================================================


def _make_policy() -> IdentityResolutionPolicy:
    """Standard policy fixture for batch/incremental tests."""
    return IdentityResolutionPolicy(
        policy_version="equiv-1.0.0",
        retrieval_policy=RetrievalPolicy(
            policy_version="equiv-1.0.0",
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
            irs_signal_channel_mapping={},
        ),
        widening_budget=WideningBudgetPolicy(
            budget_version="equiv-1.0.0",
            max_widening_rounds=2,
            max_total_attempts=6,
            max_latency_ms=3000,
            max_cost_units=50.0,
        ),
        pending_re_evaluation_policy=ReEvaluationPolicy(
            policy_version="equiv-1.0.0",
            triggers=["new_evidence", "alias_change"],
            max_re_evaluation_attempts=3,
            cooldown_between_attempts_ms=30000,
        ),
        permitted_embedding_model_versions=["v1.0"],
    )


def _make_context(
    concerns: list[ConcernSummary] | None = None,
    graph_version: int = 10,
) -> GraphStateContext:
    """Standard graph context."""
    return GraphStateContext(
        graph_version=graph_version,
        snapshot_token=f"snap-v{graph_version}",
        snapshot_digest="sha256-equiv-test",
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
    packet_id: str,
    seq_range: tuple[int, int],
    meaning: str = "Test packet content",
    conversation_id: str = "conv-equiv-001",
) -> SemanticPacket:
    """Create a semantic packet with given parameters."""
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=f"creation-{packet_id}",
        conversation_id=conversation_id,
        source_message_ids=[f"msg-{seq_range[0]}"],
        message_seq_range=seq_range,
        user_grounded_meaning=meaning,
        provenance="test",
        packet_formation_version="1.0.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_proposition(
    prop_id: str,
    meaning: str = "Test proposition",
    retention_levels: list[RetentionLevel] | None = None,
    speaker_role: str = "USER",
    conversation_id: str = "conv-equiv-001",
) -> Proposition:
    """Create a proposition with given parameters."""
    return Proposition(
        proposition_id=prop_id,
        proposition_creation_key=f"creation-{prop_id}",
        conversation_id=conversation_id,
        source_message_ids=["msg-1"],
        speaker_role=speaker_role,
        canonical_meaning=meaning,
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
    concern_id: str,
    identity_summary: str = "Test concern",
    status: ConcernStatus = ConcernStatus.ACTIVE,
) -> ConcernSummary:
    """Create a concern summary."""
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary=identity_summary,
        display_title=identity_summary,
        current_summary=f"Summary of {identity_summary}",
        status=status,
        merged_into_concern_id=None,
        aliases=[],
        canonical_parent_id=None,
        parent_resolution_state=ParentResolutionState.ROOT_CONFIRMED,
        last_active_at="2024-01-01T00:00:00Z",
        semantic_version=1,
    )


def _make_retrieval_attempt(
    attempt_id: str = "attempt-1",
    candidate_ids: list[str] | None = None,
) -> RetrievalAttemptRecord:
    """Create a retrieval attempt record."""
    cids = candidate_ids or []
    return RetrievalAttemptRecord(
        attempt_id=attempt_id,
        channel_id="ch-embed-primary",
        channel_family="embedding_primary",
        query_mode="semantic_similarity",
        query_reference="query-ref",
        scope_description="default",
        status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        if cids
        else RetrievalAttemptStatus.SUCCESS_EMPTY,
        candidate_ids=cids,
        candidate_count=len(cids),
        latency_ms=50,
        retrieval_policy_version="equiv-1.0.0",
    )


# Common kwargs for pipeline.resolve
_RESOLVE_KWARGS = dict(
    request_id="req-equiv",
    idempotency_key="idem-equiv",
    conversation_id="conv-equiv-001",
    semantic_policy_version="1.0.0",
    model_config_version="test-model",
    prompt_version="1.0.0",
)


# ===========================================================================
# Deterministic Pipeline Builder
# ===========================================================================


class DeterministicPipelineBuilder:
    """Builds a pipeline with deterministic mocked components.

    The same semantic inputs always produce the same semantic outputs,
    regardless of whether they are processed in batch or incrementally.
    This allows testing that the pipeline infrastructure itself preserves
    Current-State Equivalence.

    The builder accepts a mapping of packet_id → expected outcome config
    so the same decision is produced whether processed in batch or one-by-one.
    """

    def __init__(
        self,
        packet_outcomes: dict[str, dict[str, Any]],
        existing_concerns: list[ConcernSummary] | None = None,
    ) -> None:
        self._packet_outcomes = packet_outcomes
        self._existing_concerns = existing_concerns or []

    def build(self) -> IdentityResolutionPipeline:
        """Build a pipeline with deterministic behavior per packet."""
        packet_outcomes = self._packet_outcomes
        existing_concerns = self._existing_concerns

        # Retrieval coordinator: returns candidates based on packet
        # Pipeline calls: self._retrieval.retrieve_candidates(packet, context)
        async def _retrieve(packet, context):
            cfg = packet_outcomes.get(packet.packet_id, {})
            candidate_ids = cfg.get("candidate_ids", [])
            candidates = [
                RetrievalCandidate(
                    concern_id=cid,
                    lifecycle_status=ConcernStatus.ACTIVE,
                    contributing_attempt_ids=[f"att-{packet.packet_id}"],
                )
                for cid in candidate_ids
            ]
            return RetrievalResult(
                attempts=[_make_retrieval_attempt(
                    attempt_id=f"att-{packet.packet_id}",
                    candidate_ids=candidate_ids,
                )],
                candidates=candidates,
                total_latency_ms=50,
            )

        retrieval_coordinator = MagicMock()
        retrieval_coordinator.retrieve_candidates = AsyncMock(
            side_effect=_retrieve
        )

        # Evaluator: returns deterministic result per packet
        # Pipeline calls: self._evaluator.evaluate(candidates, retrieval_result, context)
        # We need to identify the packet from the candidates/retrieval context
        # Since each packet has unique attempt_ids, we look at the retrieval_result
        async def _evaluate(candidates, retrieval_result, context):
            # Identify the packet by looking at the attempt_ids in the result
            packet_id = None
            if retrieval_result.attempts:
                # attempt_id format is "att-{packet_id}"
                att_id = retrieval_result.attempts[0].attempt_id
                if att_id.startswith("att-"):
                    packet_id = att_id[4:]
            cfg = packet_outcomes.get(packet_id, {}) if packet_id else {}
            confidence = cfg.get("identity_confidence")
            best_match = cfg.get("best_match")
            competing = cfg.get("competing", [])
            return IdentityEvaluationResult(
                stage_status=StageExecutionStatus.COMPLETED,
                confidence=confidence,
                candidate_records=[],
                best_match_concern_id=best_match,
                competing_candidate_ids=competing,
                substantive_resumption=cfg.get("substantive_resumption"),
                explanation=f"Deterministic eval for {packet_id}",
                failure_reason=None,
            )

        evaluator = MagicMock()
        evaluator.evaluate = AsyncMock(side_effect=_evaluate)

        # Sufficiency gate: deterministic per packet outcome
        # Pipeline calls: self._sufficiency_gate.evaluate(retrieval_result, irs_signals, retrieval_policy)
        def _sufficiency(retrieval_result, irs_signals, retrieval_policy):
            return SufficiencyRecord(
                stage_status=StageExecutionStatus.COMPLETED,
                confidence=BehavioralConfidenceBand.HIGH,
                coverage_summary="adequate",
                unresolved_signals=[],
                failed_coverage_gaps=[],
                rationale="Deterministic adequate",
            )

        sufficiency_gate = MagicMock()
        sufficiency_gate.evaluate = MagicMock(side_effect=_sufficiency)

        # Downstream separator: outcome based on candidates present
        # Pipeline calls: determine_outcome(sufficiency, all_candidates)
        # With HIGH sufficiency + no candidates → novelty eligible
        # With HIGH sufficiency + candidates → UNRESOLVED (ambiguous)
        def _downstream(sufficiency, candidates):
            if not candidates:
                return DownstreamDecision(
                    outcome=PipelineOutcome.NO,
                    action=ResolutionAction.PROPOSE_NEW,
                    matched_concern_id=None,
                    requires_widening=False,
                    novelty_eligible=True,
                    rationale="No candidates, novelty eligible",
                )
            else:
                return DownstreamDecision(
                    outcome=PipelineOutcome.UNRESOLVED,
                    action=ResolutionAction.RETAIN_PENDING,
                    matched_concern_id=None,
                    requires_widening=False,
                    novelty_eligible=False,
                    rationale="Ambiguous candidates",
                )

        separator = MagicMock()
        separator.determine_outcome = MagicMock(side_effect=_downstream)

        # Widener: no widening needed (all adequate since sufficiency is HIGH)
        widener = MagicMock()
        widener.widen = AsyncMock(return_value=WideningResult())

        # Novelty checker: deterministic per packet
        # Pipeline calls: check_novelty(packet, propositions, downstream, request_id)
        def _novelty_check(packet, propositions, downstream, request_id):
            cfg = packet_outcomes.get(packet.packet_id, {})
            if cfg.get("outcome") == "PROPOSE_NEW":
                return NoveltyResult(
                    eligible=True,
                    proposal=ConcernProposal(
                        concern_creation_key=f"novelty-{packet.packet_id}",
                        proposed_concern_id=cfg["proposed_concern_id"],
                        identity_summary=cfg.get(
                            "identity_summary", "New concern"
                        ),
                        display_title=cfg.get("display_title", "New"),
                        initial_summary=cfg.get(
                            "initial_summary", "New concern"
                        ),
                        proposed_parent_id=cfg.get("parent_id"),
                        parent_resolution_state=(
                            ParentResolutionState.PARENT_DEFERRED
                        ),
                    ),
                    outcome=PipelineOutcome.NO,
                    action=ResolutionAction.PROPOSE_NEW,
                    rationale="Novelty confirmed",
                    blocked_reason=None,
                )
            return NoveltyResult(
                eligible=False,
                proposal=None,
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                rationale="Not eligible",
                blocked_reason="test",
            )

        novelty_checker = MagicMock()
        novelty_checker.check_novelty = MagicMock(side_effect=_novelty_check)

        # Lifecycle handler
        lifecycle_handler = MagicMock()
        lifecycle_handler.follow_merge_redirect = MagicMock(
            return_value=MergeRedirectResult(
                resolved=True,
                target_concern=None,
                redirect_path=[],
            )
        )
        lifecycle_handler.build_reactivation_group = MagicMock(
            return_value=SemanticDependencyGroupRef(
                group_id="reactivation-group",
                mutation_refs=[],
                failure_policy="ALL_OR_NONE",
            )
        )

        # Pending decision manager
        pending_mgr = MagicMock()
        pending_mgr.create_pending_decision = MagicMock(
            return_value=MagicMock(is_duplicate=False)
        )

        # Association assembler: deterministic per packet
        # Pipeline calls: assemble_associations(packet, propositions, concern_id, request_id, confidence)
        def _assemble(packet, propositions, concern_id, request_id, confidence):
            cfg = packet_outcomes.get(packet.packet_id, {})
            associations = []
            for prop in propositions:
                role = cfg.get("association_role", AssociationRole.PRIMARY_OWNER)
                associations.append(
                    PropositionAssociation(
                        association_id=f"assoc-{prop.proposition_id}-{concern_id}",
                        association_creation_key=(
                            f"key-{prop.proposition_id}-{concern_id}"
                        ),
                        proposition_id=prop.proposition_id,
                        concern_id=concern_id,
                        role=role,
                        confidence=BehavioralConfidenceBand.HIGH,
                        provenance="identity_resolution",
                        established_by_packet_id=packet.packet_id,
                        semantic_state=SemanticState.ACTIVE,
                        created_at="2024-01-01T00:00:00Z",
                        version=1,
                    )
                )
            return associations

        association_assembler = MagicMock()
        association_assembler.assemble_associations = MagicMock(
            side_effect=_assemble
        )

        # Shared proposal coalescer
        # Pipeline calls: coalesce_proposal(packet, overlay, novelty_result)
        def _coalesce(packet, overlay, novelty_result):
            proposal = novelty_result.proposal
            return CoalescedProposalResult(
                is_shared=False,
                proposal=proposal,
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                is_first_proposer=True,
                dependency_group=SemanticDependencyGroupRef(
                    group_id=f"proposal-group:{proposal.proposed_concern_id}",
                    mutation_refs=[
                        f"create-concern:{proposal.proposed_concern_id}"
                    ],
                    failure_policy="ALL_OR_NONE",
                ),
            )

        coalescer = MagicMock()
        coalescer.coalesce_proposal = MagicMock(side_effect=_coalesce)

        # Proposition validator: always valid
        prop_validator = MagicMock()
        prop_validator.validate_packet_propositions = MagicMock(
            return_value=MagicMock(valid=True)
        )

        return IdentityResolutionPipeline(
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


def merge_incremental_results(results: list[PipelineResult]) -> PipelineResult:
    """Merge multiple incremental PipelineResults into a single combined result.

    This simulates the final committed state after processing all packets
    incrementally. The combined result is what would be committed to the graph.
    """
    merged = PipelineResult()
    for r in results:
        merged.records.extend(r.records)
        merged.dependency_groups.extend(r.dependency_groups)
        merged.mutations.extend(r.mutations)
        merged.associations.extend(r.associations)
        merged.pending_bundles.extend(r.pending_bundles)
        merged.proposals.extend(r.proposals)
    return merged


# ===========================================================================
# Test Scenarios
# ===========================================================================


class TestBatchIncrementalEquivalenceSimpleAssignment:
    """Scenario: Two packets both match existing concerns.

    Both batch and incremental should produce the same assignments.
    """

    @pytest.mark.asyncio
    async def test_simple_dual_assignment_equivalence(self):
        """Two packets each assigned to different existing concerns."""
        existing = [
            _make_concern("concern-python", "Learning Python"),
            _make_concern("concern-rust", "Learning Rust"),
        ]
        context = _make_context(concerns=existing)

        packets = [
            _make_packet("pkt-1", (1, 3), "I want to learn Python"),
            _make_packet("pkt-2", (4, 6), "I want to learn Rust"),
        ]
        propositions = {
            "pkt-1": [_make_proposition("prop-1", "Learn Python")],
            "pkt-2": [_make_proposition("prop-2", "Learn Rust")],
        }

        # Configure deterministic outcomes per packet
        packet_outcomes = {
            "pkt-1": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-python"],
                "best_match": "concern-python",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
            "pkt-2": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-rust"],
                "best_match": "concern-rust",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # --- BATCH: process all packets at once ---
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # --- INCREMENTAL: process packets one-at-a-time ---
        incremental_results = []
        for pkt in packets:
            inc_pipeline = builder.build()
            inc_result = await inc_pipeline.resolve(
                packets=[pkt],
                propositions_map={pkt.packet_id: propositions[pkt.packet_id]},
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-inc-{pkt.packet_id}"},
            )
            incremental_results.append(inc_result)

        merged_incremental = merge_incremental_results(incremental_results)

        # --- COMPARE: Current-State Equivalence ---
        batch_state = extract_current_state(batch_result)
        incremental_state = extract_current_state(merged_incremental)
        assert_current_state_equivalent(batch_state, incremental_state)


class TestBatchIncrementalEquivalenceNoveltyProposal:
    """Scenario: Packets that produce new concern proposals.

    Both batch and incremental should propose the same new concerns.
    """

    @pytest.mark.asyncio
    async def test_novelty_proposals_equivalence(self):
        """Two independent packets each propose new concerns."""
        context = _make_context()  # No existing concerns

        packets = [
            _make_packet("pkt-new-1", (1, 2), "I want to build a compiler"),
            _make_packet("pkt-new-2", (3, 5), "I'm planning a garden"),
        ]
        propositions = {
            "pkt-new-1": [_make_proposition("prop-new-1", "Build a compiler")],
            "pkt-new-2": [_make_proposition("prop-new-2", "Plan a garden")],
        }

        packet_outcomes = {
            "pkt-new-1": {
                "outcome": "PROPOSE_NEW",
                "candidate_ids": [],
                "best_match": None,
                "identity_confidence": BehavioralConfidenceBand.LOW,
                "competing": [],
                "proposed_concern_id": "new-concern-compiler",
                "identity_summary": "Building a compiler",
                "display_title": "Compiler Project",
                "initial_summary": "User wants to build a compiler",
                "parent_id": None,
            },
            "pkt-new-2": {
                "outcome": "PROPOSE_NEW",
                "candidate_ids": [],
                "best_match": None,
                "identity_confidence": BehavioralConfidenceBand.LOW,
                "competing": [],
                "proposed_concern_id": "new-concern-garden",
                "identity_summary": "Planning a garden",
                "display_title": "Garden Planning",
                "initial_summary": "User plans a garden",
                "parent_id": None,
            },
        }

        builder = DeterministicPipelineBuilder(packet_outcomes)

        # --- BATCH ---
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # --- INCREMENTAL ---
        incremental_results = []
        for pkt in packets:
            inc_pipeline = builder.build()
            inc_result = await inc_pipeline.resolve(
                packets=[pkt],
                propositions_map={pkt.packet_id: propositions[pkt.packet_id]},
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-inc-{pkt.packet_id}"},
            )
            incremental_results.append(inc_result)

        merged_incremental = merge_incremental_results(incremental_results)

        # --- COMPARE ---
        batch_state = extract_current_state(batch_result)
        incremental_state = extract_current_state(merged_incremental)
        assert_current_state_equivalent(batch_state, incremental_state)


class TestBatchIncrementalEquivalenceMixedOutcomes:
    """Scenario: Mix of assignment, novelty, and pending outcomes.

    Tests that a conversation with varied outcomes produces equivalent
    final state regardless of processing mode.
    """

    @pytest.mark.asyncio
    async def test_mixed_outcomes_equivalence(self):
        """One assignment, one novelty, one pending — all equivalent."""
        existing = [_make_concern("concern-cooking", "Cooking Italian food")]
        context = _make_context(concerns=existing)

        packets = [
            _make_packet("pkt-assign", (1, 2), "More about Italian cooking"),
            _make_packet("pkt-novel", (3, 4), "Starting a podcast"),
            _make_packet("pkt-pending", (5, 7), "Something ambiguous"),
        ]
        propositions = {
            "pkt-assign": [_make_proposition("prop-cook", "Italian cooking")],
            "pkt-novel": [_make_proposition("prop-podcast", "Start podcast")],
            "pkt-pending": [_make_proposition("prop-ambig", "Ambiguous")],
        }

        packet_outcomes = {
            "pkt-assign": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-cooking"],
                "best_match": "concern-cooking",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
            "pkt-novel": {
                "outcome": "PROPOSE_NEW",
                "candidate_ids": [],
                "best_match": None,
                "identity_confidence": BehavioralConfidenceBand.LOW,
                "competing": [],
                "proposed_concern_id": "new-concern-podcast",
                "identity_summary": "Starting a podcast",
                "display_title": "Podcast Project",
                "initial_summary": "User wants to start a podcast",
                "parent_id": None,
            },
            "pkt-pending": {
                "outcome": "UNRESOLVED",
                "candidate_ids": ["concern-cooking"],
                "best_match": None,
                "identity_confidence": BehavioralConfidenceBand.MEDIUM,
                "competing": ["concern-cooking"],
            },
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # --- BATCH ---
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # --- INCREMENTAL ---
        incremental_results = []
        for pkt in packets:
            inc_pipeline = builder.build()
            inc_result = await inc_pipeline.resolve(
                packets=[pkt],
                propositions_map={pkt.packet_id: propositions[pkt.packet_id]},
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-inc-{pkt.packet_id}"},
            )
            incremental_results.append(inc_result)

        merged_incremental = merge_incremental_results(incremental_results)

        # --- COMPARE ---
        batch_state = extract_current_state(batch_result)
        incremental_state = extract_current_state(merged_incremental)
        assert_current_state_equivalent(batch_state, incremental_state)


class TestBatchIncrementalEquivalenceMultipleEvidenceRoles:
    """Scenario: Propositions with multiple evidence roles.

    Both modes should produce the same evidence role associations.
    """

    @pytest.mark.asyncio
    async def test_multi_role_evidence_equivalence(self):
        """Propositions with SUPPORTING_EVIDENCE roles match across modes."""
        existing = [
            _make_concern("concern-health", "Health and fitness goals"),
        ]
        context = _make_context(concerns=existing)

        packets = [
            _make_packet("pkt-health-1", (1, 2), "My fitness goals"),
            _make_packet("pkt-health-2", (3, 4), "Evidence supporting fitness"),
        ]
        propositions = {
            "pkt-health-1": [
                _make_proposition(
                    "prop-fitness",
                    "I want to get fit",
                    retention_levels=[
                        RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE
                    ],
                ),
            ],
            "pkt-health-2": [
                _make_proposition(
                    "prop-evidence",
                    "Studies show exercise is beneficial",
                    retention_levels=[RetentionLevel.SUPPORTING_EVIDENCE],
                ),
            ],
        }

        packet_outcomes = {
            "pkt-health-1": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-health"],
                "best_match": "concern-health",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
                "association_role": AssociationRole.PRIMARY_OWNER,
            },
            "pkt-health-2": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-health"],
                "best_match": "concern-health",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
                "association_role": AssociationRole.SUPPORTING_EVIDENCE,
            },
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # --- BATCH ---
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # --- INCREMENTAL ---
        incremental_results = []
        for pkt in packets:
            inc_pipeline = builder.build()
            inc_result = await inc_pipeline.resolve(
                packets=[pkt],
                propositions_map={pkt.packet_id: propositions[pkt.packet_id]},
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-inc-{pkt.packet_id}"},
            )
            incremental_results.append(inc_result)

        merged_incremental = merge_incremental_results(incremental_results)

        # --- COMPARE ---
        batch_state = extract_current_state(batch_result)
        incremental_state = extract_current_state(merged_incremental)
        assert_current_state_equivalent(batch_state, incremental_state)


class TestBatchIncrementalEquivalenceHierarchyReferences:
    """Scenario: New concerns with hierarchy (parent) references.

    Tests that hierarchy references are equivalent between modes.
    """

    @pytest.mark.asyncio
    async def test_hierarchy_equivalence(self):
        """Proposed concerns with parent references are equivalent."""
        existing = [
            _make_concern("concern-parent", "Software architecture"),
        ]
        context = _make_context(concerns=existing)

        packets = [
            _make_packet("pkt-child", (1, 3), "Microservices architecture"),
        ]
        propositions = {
            "pkt-child": [
                _make_proposition("prop-micro", "Microservices design")
            ],
        }

        packet_outcomes = {
            "pkt-child": {
                "outcome": "PROPOSE_NEW",
                "candidate_ids": [],
                "best_match": None,
                "identity_confidence": BehavioralConfidenceBand.LOW,
                "competing": [],
                "proposed_concern_id": "new-concern-microservices",
                "identity_summary": "Microservices architecture",
                "display_title": "Microservices",
                "initial_summary": "Designing microservices",
                "parent_id": "concern-parent",
            },
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # --- BATCH ---
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # --- INCREMENTAL ---
        inc_pipeline = builder.build()
        inc_result = await inc_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **{**_RESOLVE_KWARGS, "request_id": "req-inc-child"},
        )

        # --- COMPARE ---
        batch_state = extract_current_state(batch_result)
        incremental_state = extract_current_state(inc_result)
        assert_current_state_equivalent(batch_state, incremental_state)

        # Verify hierarchy is correctly captured
        assert batch_state.hierarchy_refs.get("new-concern-microservices") == (
            "concern-parent"
        )


class TestBatchIncrementalEquivalencePendingResolutions:
    """Scenario: Multiple packets producing pending (UNRESOLVED/DEFER) outcomes.

    Both modes should produce equivalent pending states.
    """

    @pytest.mark.asyncio
    async def test_pending_outcomes_equivalence(self):
        """Multiple UNRESOLVED/DEFER packets are equivalent across modes."""
        existing = [
            _make_concern("concern-a", "Topic A"),
            _make_concern("concern-b", "Topic B"),
        ]
        context = _make_context(concerns=existing)

        packets = [
            _make_packet("pkt-ambig-1", (1, 2), "Something between A and B"),
            _make_packet("pkt-ambig-2", (3, 5), "Another ambiguous statement"),
            _make_packet("pkt-defer", (6, 7), "Deferred content"),
        ]
        propositions = {
            "pkt-ambig-1": [_make_proposition("prop-a1", "Between A and B")],
            "pkt-ambig-2": [_make_proposition("prop-a2", "Ambiguous again")],
            "pkt-defer": [_make_proposition("prop-d", "Deferred")],
        }

        packet_outcomes = {
            "pkt-ambig-1": {
                "outcome": "UNRESOLVED",
                "candidate_ids": ["concern-a", "concern-b"],
                "best_match": None,
                "identity_confidence": BehavioralConfidenceBand.MEDIUM,
                "competing": ["concern-a", "concern-b"],
            },
            "pkt-ambig-2": {
                "outcome": "UNRESOLVED",
                "candidate_ids": ["concern-a", "concern-b"],
                "best_match": None,
                "identity_confidence": BehavioralConfidenceBand.MEDIUM,
                "competing": ["concern-a", "concern-b"],
            },
            "pkt-defer": {
                "outcome": "DEFER",
                "candidate_ids": [],
                "best_match": None,
                "identity_confidence": BehavioralConfidenceBand.LOW,
                "competing": [],
            },
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # --- BATCH ---
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # --- INCREMENTAL ---
        incremental_results = []
        for pkt in packets:
            inc_pipeline = builder.build()
            inc_result = await inc_pipeline.resolve(
                packets=[pkt],
                propositions_map={pkt.packet_id: propositions[pkt.packet_id]},
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-inc-{pkt.packet_id}"},
            )
            incremental_results.append(inc_result)

        merged_incremental = merge_incremental_results(incremental_results)

        # --- COMPARE ---
        batch_state = extract_current_state(batch_result)
        incremental_state = extract_current_state(merged_incremental)
        assert_current_state_equivalent(batch_state, incremental_state)


class TestBatchIncrementalEquivalenceSmallGroups:
    """Scenario: Incremental processing in small groups (2 at a time).

    Tests that grouping packets differently (all-at-once vs 2-at-a-time)
    produces equivalent final state.
    """

    @pytest.mark.asyncio
    async def test_small_group_incremental_equivalence(self):
        """4 packets: batch vs 2-at-a-time produces equivalent state."""
        existing = [
            _make_concern("concern-lang", "Programming languages"),
            _make_concern("concern-data", "Data structures"),
        ]
        context = _make_context(concerns=existing)

        packets = [
            _make_packet("pkt-p1", (1, 2), "Python is great"),
            _make_packet("pkt-p2", (3, 4), "Rust is fast"),
            _make_packet("pkt-d1", (5, 6), "Binary trees"),
            _make_packet("pkt-d2", (7, 8), "Hash maps"),
        ]
        propositions = {
            "pkt-p1": [_make_proposition("prop-py", "Python")],
            "pkt-p2": [_make_proposition("prop-rs", "Rust")],
            "pkt-d1": [_make_proposition("prop-bt", "Binary trees")],
            "pkt-d2": [_make_proposition("prop-hm", "Hash maps")],
        }

        packet_outcomes = {
            "pkt-p1": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-lang"],
                "best_match": "concern-lang",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
            "pkt-p2": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-lang"],
                "best_match": "concern-lang",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
            "pkt-d1": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-data"],
                "best_match": "concern-data",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
            "pkt-d2": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-data"],
                "best_match": "concern-data",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # --- BATCH: all 4 at once ---
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # --- INCREMENTAL: 2-at-a-time ---
        group1_pipeline = builder.build()
        group1_result = await group1_pipeline.resolve(
            packets=packets[:2],
            propositions_map={
                k: v for k, v in propositions.items()
                if k in ("pkt-p1", "pkt-p2")
            },
            context=context,
            policy=_make_policy(),
            **{**_RESOLVE_KWARGS, "request_id": "req-inc-g1"},
        )

        group2_pipeline = builder.build()
        group2_result = await group2_pipeline.resolve(
            packets=packets[2:],
            propositions_map={
                k: v for k, v in propositions.items()
                if k in ("pkt-d1", "pkt-d2")
            },
            context=context,
            policy=_make_policy(),
            **{**_RESOLVE_KWARGS, "request_id": "req-inc-g2"},
        )

        merged_incremental = merge_incremental_results(
            [group1_result, group2_result]
        )

        # --- COMPARE ---
        batch_state = extract_current_state(batch_result)
        incremental_state = extract_current_state(merged_incremental)
        assert_current_state_equivalent(batch_state, incremental_state)


class TestBatchIncrementalAllowedDifferences:
    """Verifies that batch and incremental processing are allowed to differ
    in packet boundaries, historical traces, and processing metadata.

    These tests ensure the equivalence check correctly ignores non-semantic
    differences while still catching semantic divergences.
    """

    @pytest.mark.asyncio
    async def test_different_record_ids_allowed(self):
        """Different record IDs (due to different request_ids) are acceptable."""
        existing = [_make_concern("concern-x", "Topic X")]
        context = _make_context(concerns=existing)

        packets = [_make_packet("pkt-x1", (1, 3), "About topic X")]
        propositions = {"pkt-x1": [_make_proposition("prop-x1", "Topic X")]}

        packet_outcomes = {
            "pkt-x1": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-x"],
                "best_match": "concern-x",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # Batch with one request_id
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **{**_RESOLVE_KWARGS, "request_id": "req-batch-001"},
        )

        # Incremental with different request_id
        inc_pipeline = builder.build()
        inc_result = await inc_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **{**_RESOLVE_KWARGS, "request_id": "req-incremental-001"},
        )

        # Record IDs will differ, but current state should be equivalent
        batch_state = extract_current_state(batch_result)
        inc_state = extract_current_state(inc_result)
        assert_current_state_equivalent(batch_state, inc_state)

        # Verify records actually have different IDs (the allowed difference)
        if batch_result.records and inc_result.records:
            assert batch_result.records[0].record_id != (
                inc_result.records[0].record_id
            )

    @pytest.mark.asyncio
    async def test_different_processing_order_allowed(self):
        """Processing in different order produces same final state."""
        existing = [
            _make_concern("concern-m", "Music theory"),
            _make_concern("concern-p", "Photography"),
        ]
        context = _make_context(concerns=existing)

        packets = [
            _make_packet("pkt-music", (1, 2), "About music"),
            _make_packet("pkt-photo", (3, 4), "About photography"),
        ]
        propositions = {
            "pkt-music": [_make_proposition("prop-music", "Music")],
            "pkt-photo": [_make_proposition("prop-photo", "Photography")],
        }

        packet_outcomes = {
            "pkt-music": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-m"],
                "best_match": "concern-m",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
            "pkt-photo": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-p"],
                "best_match": "concern-p",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            },
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # Forward order
        fwd_pipeline = builder.build()
        fwd_results = []
        for pkt in packets:
            r = await fwd_pipeline.resolve(
                packets=[pkt],
                propositions_map={pkt.packet_id: propositions[pkt.packet_id]},
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-fwd-{pkt.packet_id}"},
            )
            fwd_results.append(r)

        # Reverse order
        rev_pipeline = builder.build()
        rev_results = []
        for pkt in reversed(packets):
            r = await rev_pipeline.resolve(
                packets=[pkt],
                propositions_map={pkt.packet_id: propositions[pkt.packet_id]},
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-rev-{pkt.packet_id}"},
            )
            rev_results.append(r)

        fwd_state = extract_current_state(merge_incremental_results(fwd_results))
        rev_state = extract_current_state(merge_incremental_results(rev_results))
        assert_current_state_equivalent(fwd_state, rev_state)


class TestBatchIncrementalEquivalenceLongConversation:
    """Scenario: Longer conversation with many messages.

    Tests that a conversation with 6 messages processed in various
    granularities produces equivalent final state.
    """

    @pytest.mark.asyncio
    async def test_long_conversation_equivalence(self):
        """6 packets: batch vs one-at-a-time vs 3-at-a-time."""
        existing = [
            _make_concern("concern-travel", "Travel planning"),
        ]
        context = _make_context(concerns=existing)

        packets = [
            _make_packet("pkt-t1", (1, 1), "Planning a trip to Japan"),
            _make_packet("pkt-t2", (2, 2), "Tokyo hotels"),
            _make_packet("pkt-t3", (3, 3), "Kyoto temples"),
            _make_packet("pkt-t4", (4, 4), "Japanese food"),
            _make_packet("pkt-t5", (5, 5), "Travel budget"),
            _make_packet("pkt-t6", (6, 6), "Booking flights"),
        ]
        propositions = {
            f"pkt-t{i}": [_make_proposition(f"prop-t{i}", f"Travel {i}")]
            for i in range(1, 7)
        }

        # All packets assigned to the travel concern
        packet_outcomes = {
            f"pkt-t{i}": {
                "outcome": "ASSIGN_EXISTING",
                "candidate_ids": ["concern-travel"],
                "best_match": "concern-travel",
                "identity_confidence": BehavioralConfidenceBand.HIGH,
                "competing": [],
            }
            for i in range(1, 7)
        }

        builder = DeterministicPipelineBuilder(
            packet_outcomes, existing_concerns=existing
        )

        # --- BATCH: all 6 at once ---
        batch_pipeline = builder.build()
        batch_result = await batch_pipeline.resolve(
            packets=packets,
            propositions_map=propositions,
            context=context,
            policy=_make_policy(),
            **_RESOLVE_KWARGS,
        )

        # --- INCREMENTAL: one-at-a-time ---
        one_at_a_time_results = []
        for pkt in packets:
            p = builder.build()
            r = await p.resolve(
                packets=[pkt],
                propositions_map={pkt.packet_id: propositions[pkt.packet_id]},
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-1x-{pkt.packet_id}"},
            )
            one_at_a_time_results.append(r)

        # --- INCREMENTAL: 3-at-a-time ---
        three_at_a_time_results = []
        for chunk_start in range(0, 6, 3):
            chunk = packets[chunk_start:chunk_start + 3]
            chunk_props = {
                p.packet_id: propositions[p.packet_id] for p in chunk
            }
            p = builder.build()
            r = await p.resolve(
                packets=chunk,
                propositions_map=chunk_props,
                context=context,
                policy=_make_policy(),
                **{**_RESOLVE_KWARGS, "request_id": f"req-3x-{chunk_start}"},
            )
            three_at_a_time_results.append(r)

        # --- COMPARE all three modes ---
        batch_state = extract_current_state(batch_result)
        one_state = extract_current_state(
            merge_incremental_results(one_at_a_time_results)
        )
        three_state = extract_current_state(
            merge_incremental_results(three_at_a_time_results)
        )

        assert_current_state_equivalent(batch_state, one_state)
        assert_current_state_equivalent(batch_state, three_state)
        assert_current_state_equivalent(one_state, three_state)
