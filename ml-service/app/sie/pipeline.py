"""Identity Resolution Pipeline for SIE.

Composes retrieval, evaluation, sufficiency, widening, novelty, lifecycle,
pending, association, and provisional-overlay stages. Emits one complete
IdentityResolutionRecord per packet and complete dependency groups/mutations.

Preserves retrieval adequacy/identity ambiguity separation throughout.

Design authority: design-corrections.md §3.1.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

from .associations import PropositionAssociation
from .contracts import (
    ConcernEmbedding,
    ConcernSummary,
    GraphStateContext,
    SemanticDependencyGroupRef,
)
from .enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    PipelineOutcome,
    ResolutionAction,
    StageExecutionStatus,
)
from .id_generation import resolve_entity_id
from .identity_models import (
    CandidateRecord,
    EvidenceReference,
    IdentityResolutionRecord,
    IRSSignal,
    RetrievalAttemptRecord,
    SufficiencyRecord,
    WideningBudget,
)
from .identity_policy import IdentityResolutionPolicy
from .models import ConcernProposal, Proposition, SemanticPacket
from .retrieval.adaptive_widener import AdaptiveWidener, WideningResult
from .retrieval.association_assembler import AssociationAssembler
from .retrieval.channel_protocol import RetrievalCandidate, RetrievalResult
from .retrieval.downstream_separator import DownstreamDecision, DownstreamSeparator
from .retrieval.lifecycle_handler import LifecycleHandler, MergeRedirectResult
from .retrieval.novelty_checker import NoveltyChecker, NoveltyResult
from .retrieval.pending_decision_manager import (
    PENDING_OUTCOMES,
    PendingDecisionBundle,
    PendingDecisionManager,
)
from .retrieval.proposition_validator import (
    PropositionDetailValidator,
    PropositionValidationResult,
)
from .retrieval.provisional_overlay import ProvisionalOverlay
from .retrieval.retrieval_coordinator import RetrievalCoordinator
from .retrieval.shared_proposal_coalescer import (
    CoalescedProposalResult,
    SharedProposalCoalescer,
)
from .retrieval.sufficiency_gate import SufficiencyGate
from .evaluator.identity_evaluator import IdentityEvaluator, IdentityEvaluationResult
from .metrics import MetricsCollector, create_metrics_collector


# ---------------------------------------------------------------------------
# Embedding eligibility statuses
# ---------------------------------------------------------------------------

_ELIGIBLE_CONCERN_STATUSES = frozenset(
    {ConcernStatus.ACTIVE, ConcernStatus.DORMANT, ConcernStatus.RETIRED}
)
"""Concerns whose embeddings MAY participate in retrieval."""


# ---------------------------------------------------------------------------
# Pipeline result bundle
# ---------------------------------------------------------------------------


@dataclass
class PipelineResult:
    """Full output of the identity resolution pipeline for one request.

    Attributes:
        records: One IdentityResolutionRecord per packet.
        dependency_groups: ALL_OR_NONE groups (proposals, reactivations).
        mutations: Proposed identity mutations.
        associations: All proposition-concern associations.
        pending_bundles: Pending decision bundles for unresolved outcomes.
        proposals: New concern proposals (deduplicated).
    """

    records: list[IdentityResolutionRecord] = field(default_factory=list)
    dependency_groups: list[SemanticDependencyGroupRef] = field(
        default_factory=list
    )
    mutations: list[dict] = field(default_factory=list)
    associations: list[PropositionAssociation] = field(default_factory=list)
    pending_bundles: list[PendingDecisionBundle] = field(default_factory=list)
    proposals: list[ConcernProposal] = field(default_factory=list)


# ---------------------------------------------------------------------------
# IdentityResolutionPipeline
# ---------------------------------------------------------------------------


class IdentityResolutionPipeline:
    """Composes all identity resolution stages into a single pipeline.

    Accepts all component dependencies via constructor injection.
    Main method: resolve(packets, propositions_map, context, policy, request_meta)

    Embedding eligibility gate is MANDATORY — fail-closed before retrieval.
    Missing policy → DEFER. Incomplete context → DEFER.
    Operational failure NEVER becomes semantic novelty or LOW confidence.
    YES refers only to committed concerns — uncommitted proposals use NO/PROPOSE_NEW.
    """

    def __init__(
        self,
        retrieval_coordinator: RetrievalCoordinator,
        identity_evaluator: IdentityEvaluator,
        sufficiency_gate: SufficiencyGate,
        downstream_separator: DownstreamSeparator,
        adaptive_widener: AdaptiveWidener,
        novelty_checker: NoveltyChecker,
        lifecycle_handler: LifecycleHandler,
        pending_decision_manager: PendingDecisionManager,
        association_assembler: AssociationAssembler,
        shared_proposal_coalescer: SharedProposalCoalescer,
        proposition_validator: PropositionDetailValidator,
        metrics_collector: MetricsCollector | None = None,
    ) -> None:
        self._retrieval = retrieval_coordinator
        self._evaluator = identity_evaluator
        self._sufficiency_gate = sufficiency_gate
        self._separator = downstream_separator
        self._widener = adaptive_widener
        self._novelty_checker = novelty_checker
        self._lifecycle = lifecycle_handler
        self._pending_mgr = pending_decision_manager
        self._association_assembler = association_assembler
        self._coalescer = shared_proposal_coalescer
        self._prop_validator = proposition_validator
        self._metrics: MetricsCollector | None = metrics_collector

    # -------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------

    async def resolve(
        self,
        packets: list[SemanticPacket],
        propositions_map: dict[str, list[Proposition]],
        context: GraphStateContext,
        policy: IdentityResolutionPolicy,
        *,
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
    ) -> PipelineResult:
        """Run identity resolution across all packets in deterministic order.

        Args:
            packets: Concern-cohesive semantic packets.
            propositions_map: packet_id → list of propositions.
            context: Immutable graph-state snapshot from TypeScript.
            policy: Approved versioned identity resolution policy.
            request_id: Processing request identifier.
            idempotency_key: Request-level idempotency key.
            conversation_id: Conversation this request belongs to.
            semantic_policy_version: Version of the semantic policy.
            model_config_version: Version of the model configuration.
            prompt_version: Version of the evaluation prompt.

        Returns:
            PipelineResult with records, groups, mutations, associations.
        """
        result = PipelineResult()

        # Initialize metrics collector for this request if not injected
        metrics = self._metrics or create_metrics_collector(
            conversation_id, request_id
        )
        metrics.record_pipeline_start()

        # Apply embedding eligibility gate BEFORE retrieval
        eligible_embeddings = self._filter_eligible_embeddings(context, policy)

        # Build a filtered context with only eligible embeddings
        filtered_context = self._build_filtered_context(
            context, eligible_embeddings
        )

        # Provisional overlay for multi-packet ordering
        overlay = ProvisionalOverlay(filtered_context)
        ordered_packets = overlay.order_packets(packets)

        for packet in ordered_packets:
            propositions = propositions_map.get(packet.packet_id, [])

            record = await self._resolve_single_packet(
                packet=packet,
                propositions=propositions,
                overlay=overlay,
                policy=policy,
                request_id=request_id,
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                semantic_policy_version=semantic_policy_version,
                model_config_version=model_config_version,
                prompt_version=prompt_version,
                result=result,
                metrics=metrics,
            )
            result.records.append(record)

        # Emit aggregate request summary metrics
        assigned_count = sum(
            1 for r in result.records
            if r.outcome == PipelineOutcome.YES
        )
        proposed_count = sum(
            1 for r in result.records
            if r.action == ResolutionAction.PROPOSE_NEW
        )
        pending_count = sum(
            1 for r in result.records
            if r.outcome == PipelineOutcome.UNRESOLVED
        )
        deferred_count = sum(
            1 for r in result.records
            if r.outcome == PipelineOutcome.DEFER
        )
        reactivation_count = sum(
            1 for r in result.records
            if r.outcome == PipelineOutcome.YES
            and r.proposed_dependency_group_id is not None
        )
        total_retrieval_attempts = sum(
            len(r.retrieval_attempts) for r in result.records
        )

        # Emit per-event dormant reactivation metrics from records
        for r in result.records:
            if (
                r.outcome == PipelineOutcome.YES
                and r.proposed_dependency_group_id is not None
                and r.matched_concern_id
            ):
                metrics.record_dormant_reactivation(
                    packet_id=r.packet_id,
                    concern_id=r.matched_concern_id,
                    from_status="DORMANT",
                )

        # Emit per-event new concern proposal metrics
        for proposal in result.proposals:
            metrics.record_new_concern_proposal(
                packet_id=proposal.packet_id if hasattr(proposal, 'packet_id') else "",
                proposal_id=proposal.proposed_concern_id if hasattr(proposal, 'proposed_concern_id') else "",
            )

        metrics.record_request_summary(
            packet_count=len(ordered_packets),
            assigned_count=assigned_count,
            proposed_count=proposed_count,
            pending_count=pending_count,
            deferred_count=deferred_count,
            reactivation_count=reactivation_count,
            widening_count=sum(
                1 for r in result.records
                if r.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
            ),
            total_retrieval_attempts=total_retrieval_attempts,
            total_model_invocations=0,  # tracked per-packet via metrics
        )
        metrics.record_pipeline_end(
            outcome=(
                result.records[-1].outcome.value
                if result.records
                else "EMPTY"
            ),
            packet_count=len(ordered_packets),
        )
        metrics.flush()

        return result

    # -------------------------------------------------------------------
    # Embedding eligibility gate (fail-closed)
    # -------------------------------------------------------------------

    def _filter_eligible_embeddings(
        self,
        context: GraphStateContext,
        policy: IdentityResolutionPolicy,
    ) -> list[ConcernEmbedding]:
        """Filter embeddings through the mandatory fail-closed eligibility gate.

        An embedding may participate in retrieval ONLY when ALL of:
        - concern status is ACTIVE, DORMANT, or RETIRED
        - privacy_eligible (not in privacy_suppressed_concern_ids)
        - compatible graph-version provenance
        - matching identity-summary source hash vs concern state
        - embedding model version permitted by policy

        Any doubt excludes the embedding (fail-closed).
        If NO eligible embeddings remain, retrieval still proceeds
        (it may use non-embedding channels).
        """
        if not context.concern_embeddings:
            return []

        # Build lookup structures
        concern_map: dict[str, ConcernSummary] = {
            c.concern_id: c for c in context.concerns
        }
        suppressed_ids = set(context.privacy_suppressed_concern_ids)
        graph_version = context.graph_version

        eligible: list[ConcernEmbedding] = []

        for emb in context.concern_embeddings:
            # Gate 1: Concern must exist and have eligible status
            concern = concern_map.get(emb.concern_id)
            if concern is None:
                continue
            if concern.status not in _ELIGIBLE_CONCERN_STATUSES:
                continue

            # Gate 2: Privacy-eligible (not suppressed)
            if emb.concern_id in suppressed_ids:
                continue

            # Gate 3: Compatible graph-version provenance
            # Embedding graph_version must be <= current snapshot version
            # (created at or before the current snapshot)
            if emb.graph_version > graph_version:
                continue

            # Gate 4: Source text hash must match concern's identity_summary
            # The embedding was generated from specific text; if the concern's
            # identity summary has since changed, the embedding is stale.
            concern_identity_hash = self._compute_source_hash(
                concern.identity_summary
            )
            if emb.source_text_hash != concern_identity_hash:
                continue

            # Gate 5: Embedding model version permitted by policy
            # Fail-closed: if we cannot confirm the model is permitted, exclude
            if not self._is_model_version_permitted(
                emb.embedding_model_version, policy
            ):
                continue

            eligible.append(emb)

        return eligible

    @staticmethod
    def _compute_source_hash(text: str) -> str:
        """Compute a deterministic hash of identity-summary source text."""
        import hashlib

        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    @staticmethod
    def _is_model_version_permitted(
        model_version: str,
        policy: IdentityResolutionPolicy,
    ) -> bool:
        """Check if an embedding model version is permitted by policy.

        Fail-closed: the policy must explicitly list permitted embedding model
        versions. Empty/whitespace model versions are always excluded. Model
        versions not in the policy's allowlist are excluded. An empty allowlist
        means NO embeddings are permitted.
        """
        if not model_version or not model_version.strip():
            return False
        return model_version.strip() in policy.permitted_embedding_model_versions

    @staticmethod
    def _build_filtered_context(
        context: GraphStateContext,
        eligible_embeddings: list[ConcernEmbedding],
    ) -> GraphStateContext:
        """Return a new context with only eligible embeddings."""
        return GraphStateContext(
            graph_version=context.graph_version,
            snapshot_token=context.snapshot_token,
            snapshot_digest=context.snapshot_digest,
            concerns=context.concerns,
            propositions=context.propositions,
            active_associations=context.active_associations,
            pending_decisions=context.pending_decisions,
            concern_embeddings=eligible_embeddings,
            normalized_aliases=context.normalized_aliases,
            pending_identity_details=context.pending_identity_details,
            privacy_suppressed_concern_ids=context.privacy_suppressed_concern_ids,
            packet_lineage=context.packet_lineage,
        )

    # -------------------------------------------------------------------
    # Per-packet resolution
    # -------------------------------------------------------------------

    async def _resolve_single_packet(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        overlay: ProvisionalOverlay,
        policy: IdentityResolutionPolicy,
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
        result: PipelineResult,
        metrics: MetricsCollector,
    ) -> IdentityResolutionRecord:
        """Resolve identity for a single packet following §3.1 processing sequence."""
        # Get the current overlaid context for this packet
        current_context = overlay.get_context_with_overlay()
        graph_version = current_context.graph_version

        # Step 3: Validate packet cohesion and required context
        validation = self._prop_validator.validate_packet_propositions(
            packet, propositions
        )
        if not validation.valid:
            record = self._build_defer_record(
                packet=packet,
                propositions=propositions,
                context=current_context,
                request_id=request_id,
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                semantic_policy_version=semantic_policy_version,
                model_config_version=model_config_version,
                prompt_version=prompt_version,
                reason=validation.rationale,
                policy=policy,
            )
            overlay.record_pending(packet.packet_id, PipelineOutcome.DEFER)
            self._create_pending_if_needed(
                packet, propositions, PipelineOutcome.DEFER,
                request_id, graph_version, result
            )
            metrics.record_pending_decision(
                packet_id=packet.packet_id, outcome="DEFER"
            )
            return record

        # Step 4: Initial retrieval
        retrieval_start = time.time() * 1000
        retrieval_result = await self._retrieval.retrieve_candidates(
            packet, current_context
        )
        retrieval_elapsed = (time.time() * 1000) - retrieval_start

        # Emit per-channel attempt metrics
        for attempt in retrieval_result.attempts:
            metrics.record_channel_attempt(
                packet_id=packet.packet_id,
                channel_id=attempt.channel_id,
                channel_family=attempt.channel_family,
                status=attempt.status.value if hasattr(attempt.status, 'value') else str(attempt.status),
                latency_ms=attempt.latency_ms or 0.0,
                candidate_count=attempt.candidate_count,
                is_widening=False,
            )
            if attempt.status not in (
                "SUCCESS_WITH_CANDIDATES", "SUCCESS_EMPTY"
            ) and hasattr(attempt.status, 'value') and attempt.status.value not in (
                "SUCCESS_WITH_CANDIDATES", "SUCCESS_EMPTY"
            ):
                metrics.record_retrieval_failure(
                    packet_id=packet.packet_id,
                    channel_id=attempt.channel_id,
                    channel_family=attempt.channel_family,
                    failure_reason=attempt.failure_reason or "unknown",
                )

        metrics.record_retrieval_latency(
            packet_id=packet.packet_id,
            latency_ms=retrieval_elapsed,
            channel_count=len(retrieval_result.attempts),
            candidate_count=len(retrieval_result.candidates),
        )

        # Emit channel summary
        successful_channels = sum(
            1 for a in retrieval_result.attempts
            if hasattr(a.status, 'value') and a.status.value in (
                "SUCCESS_WITH_CANDIDATES", "SUCCESS_EMPTY"
            )
        )
        failed_channels = len(retrieval_result.attempts) - successful_channels
        metrics.record_channel_summary(
            packet_id=packet.packet_id,
            total_channels=len(retrieval_result.attempts),
            successful_channels=successful_channels,
            failed_channels=failed_channels,
        )

        # Step 5: Semantic evaluation of candidates
        eval_start = time.time() * 1000
        eval_result = await self._evaluator.evaluate(
            retrieval_result.candidates, retrieval_result, current_context
        )
        eval_elapsed = (time.time() * 1000) - eval_start
        metrics.record_evaluation_latency(
            packet_id=packet.packet_id,
            latency_ms=eval_elapsed,
            model_id=model_config_version,
        )

        # Handle evaluation failure (operational) → DEFER
        if eval_result.stage_status == StageExecutionStatus.FAILED:
            record = self._build_defer_record(
                packet=packet,
                propositions=propositions,
                context=current_context,
                request_id=request_id,
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                semantic_policy_version=semantic_policy_version,
                model_config_version=model_config_version,
                prompt_version=prompt_version,
                reason=eval_result.failure_reason or "Identity evaluation failed",
                policy=policy,
                retrieval_attempts=retrieval_result.attempts,
                candidates=eval_result.candidate_records,
            )
            overlay.record_pending(packet.packet_id, PipelineOutcome.DEFER)
            self._create_pending_if_needed(
                packet, propositions, PipelineOutcome.DEFER,
                request_id, graph_version, result
            )
            return record

        # Step 6: Check for uniquely actionable HIGH match
        if (
            eval_result.confidence == BehavioralConfidenceBand.HIGH
            and eval_result.best_match_concern_id is not None
            and len(eval_result.competing_candidate_ids) == 0
        ):
            # Uniquely actionable HIGH → handle lifecycle and assign
            return await self._handle_assign_existing(
                packet=packet,
                propositions=propositions,
                eval_result=eval_result,
                retrieval_result=retrieval_result,
                context=current_context,
                overlay=overlay,
                policy=policy,
                request_id=request_id,
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                semantic_policy_version=semantic_policy_version,
                model_config_version=model_config_version,
                prompt_version=prompt_version,
                result=result,
            )

        # Step 7: Assess retrieval sufficiency
        irs_signals: list[IRSSignal] = []  # IRS signals from evaluation
        suff_start = time.time() * 1000
        sufficiency = self._sufficiency_gate.evaluate(
            retrieval_result, irs_signals, policy.retrieval_policy
        )
        suff_elapsed = (time.time() * 1000) - suff_start
        metrics.record_sufficiency_latency(
            packet_id=packet.packet_id, latency_ms=suff_elapsed
        )

        # Step 8: If inconclusive, try widening
        all_attempts = list(retrieval_result.attempts)
        all_candidates = list(eval_result.candidate_records)

        if sufficiency.confidence != BehavioralConfidenceBand.HIGH:
            # Emit widening triggered metric
            metrics.record_widening_triggered(
                packet_id=packet.packet_id,
                trigger_signals=[s.signal_type.value for s in irs_signals],
                coverage_gaps=sufficiency.failed_coverage_gaps,
            )

            # Attempt adaptive widening within budget
            budget = WideningBudget(
                max_rounds=policy.widening_budget.max_widening_rounds,
                max_attempts=policy.widening_budget.max_total_attempts,
                max_latency_ms=policy.widening_budget.max_latency_ms,
                max_cost_units=policy.widening_budget.max_cost_units,
                rounds_used=0,
                attempts_used=0,
                latency_used_ms=0,
                cost_used=0.0,
                exhausted=False,
            )

            widening_start = time.time() * 1000
            widening_result = await self._widener.widen(
                packet, current_context, sufficiency, budget
            )
            widening_elapsed = (time.time() * 1000) - widening_start
            all_attempts.extend(widening_result.new_attempts)

            # Emit widening attempt metrics
            for attempt in widening_result.new_attempts:
                metrics.record_channel_attempt(
                    packet_id=packet.packet_id,
                    channel_id=attempt.channel_id,
                    channel_family=attempt.channel_family,
                    status=attempt.status.value if hasattr(attempt.status, 'value') else str(attempt.status),
                    latency_ms=attempt.latency_ms or 0.0,
                    candidate_count=attempt.candidate_count,
                    is_widening=True,
                )

            metrics.record_widening_latency(
                packet_id=packet.packet_id,
                latency_ms=widening_elapsed,
                rounds=budget.rounds_used,
                new_candidates=len(widening_result.new_candidate_ids),
            )
            metrics.record_widening_completed(
                packet_id=packet.packet_id,
                rounds_used=budget.rounds_used,
                attempts_used=len(widening_result.new_attempts),
                budget_exhausted=budget.exhausted,
                new_candidates_found=len(widening_result.new_candidate_ids),
            )

            # Re-evaluate with new candidates if widening found any
            if widening_result.new_candidate_ids:
                new_retrieval_candidates = [
                    RetrievalCandidate(
                        concern_id=cid,
                        lifecycle_status=ConcernStatus.ACTIVE,
                        contributing_attempt_ids=[],
                    )
                    for cid in widening_result.new_candidate_ids
                ]
                # Merge new candidates with existing for re-evaluation
                combined_candidates = (
                    retrieval_result.candidates + new_retrieval_candidates
                )
                combined_result = RetrievalResult(
                    attempts=all_attempts,
                    candidates=combined_candidates,
                    total_latency_ms=(
                        retrieval_result.total_latency_ms
                        + sum(
                            a.latency_ms or 0
                            for a in widening_result.new_attempts
                        )
                    ),
                )
                # Re-evaluate identity
                eval_result = await self._evaluator.evaluate(
                    combined_candidates, combined_result, current_context
                )
                all_candidates = list(eval_result.candidate_records)

                # Check again for uniquely actionable HIGH after widening
                if (
                    eval_result.stage_status == StageExecutionStatus.COMPLETED
                    and eval_result.confidence == BehavioralConfidenceBand.HIGH
                    and eval_result.best_match_concern_id is not None
                    and len(eval_result.competing_candidate_ids) == 0
                ):
                    return await self._handle_assign_existing(
                        packet=packet,
                        propositions=propositions,
                        eval_result=eval_result,
                        retrieval_result=combined_result,
                        context=current_context,
                        overlay=overlay,
                        policy=policy,
                        request_id=request_id,
                        idempotency_key=idempotency_key,
                        conversation_id=conversation_id,
                        semantic_policy_version=semantic_policy_version,
                        model_config_version=model_config_version,
                        prompt_version=prompt_version,
                        result=result,
                    )

            # Re-assess sufficiency after widening
            sufficiency = self._sufficiency_gate.evaluate(
                RetrievalResult(
                    attempts=all_attempts,
                    candidates=retrieval_result.candidates,
                    total_latency_ms=retrieval_result.total_latency_ms,
                ),
                irs_signals,
                policy.retrieval_policy,
            )

            # If still inconclusive after budget → RETRIEVAL_INCONCLUSIVE
            if sufficiency.confidence != BehavioralConfidenceBand.HIGH:
                record = self._build_inconclusive_record(
                    packet=packet,
                    propositions=propositions,
                    context=current_context,
                    sufficiency=sufficiency,
                    eval_result=eval_result,
                    all_attempts=all_attempts,
                    request_id=request_id,
                    idempotency_key=idempotency_key,
                    conversation_id=conversation_id,
                    semantic_policy_version=semantic_policy_version,
                    model_config_version=model_config_version,
                    prompt_version=prompt_version,
                    policy=policy,
                )
                overlay.record_pending(
                    packet.packet_id,
                    PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
                )
                self._create_pending_if_needed(
                    packet, propositions,
                    PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
                    request_id, graph_version, result,
                )
                metrics.record_pending_decision(
                    packet_id=packet.packet_id,
                    outcome="RETRIEVAL_INCONCLUSIVE",
                )
                return record

        # Step 9: Downstream separation (adequate retrieval path)
        downstream = self._separator.determine_outcome(
            sufficiency, all_candidates
        )

        # Handle downstream paths
        if downstream.outcome == PipelineOutcome.YES:
            # Adequate retrieval + uniquely actionable HIGH
            return await self._handle_assign_existing_from_downstream(
                packet=packet,
                propositions=propositions,
                downstream=downstream,
                eval_result=eval_result,
                sufficiency=sufficiency,
                all_attempts=all_attempts,
                context=current_context,
                overlay=overlay,
                policy=policy,
                request_id=request_id,
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                semantic_policy_version=semantic_policy_version,
                model_config_version=model_config_version,
                prompt_version=prompt_version,
                result=result,
            )

        if downstream.novelty_eligible:
            # Adequate + no plausible candidates → novelty check
            return self._handle_novelty_path(
                packet=packet,
                propositions=propositions,
                downstream=downstream,
                eval_result=eval_result,
                sufficiency=sufficiency,
                all_attempts=all_attempts,
                irs_signals=irs_signals,
                context=current_context,
                overlay=overlay,
                policy=policy,
                request_id=request_id,
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                semantic_policy_version=semantic_policy_version,
                model_config_version=model_config_version,
                prompt_version=prompt_version,
                result=result,
            )

        # UNRESOLVED / RETAIN_PENDING (adequate but ambiguous)
        record = self._build_unresolved_record(
            packet=packet,
            propositions=propositions,
            context=current_context,
            sufficiency=sufficiency,
            eval_result=eval_result,
            all_attempts=all_attempts,
            irs_signals=irs_signals,
            request_id=request_id,
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            semantic_policy_version=semantic_policy_version,
            model_config_version=model_config_version,
            prompt_version=prompt_version,
            policy=policy,
            downstream=downstream,
        )
        overlay.record_pending(packet.packet_id, PipelineOutcome.UNRESOLVED)
        self._create_pending_if_needed(
            packet, propositions, PipelineOutcome.UNRESOLVED,
            request_id, graph_version, result,
        )
        metrics.record_pending_decision(
            packet_id=packet.packet_id, outcome="UNRESOLVED"
        )
        return record

    # -------------------------------------------------------------------
    # Assign existing concern (from early HIGH match or downstream)
    # -------------------------------------------------------------------

    async def _handle_assign_existing(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        eval_result: IdentityEvaluationResult,
        retrieval_result: RetrievalResult,
        context: GraphStateContext,
        overlay: ProvisionalOverlay,
        policy: IdentityResolutionPolicy,
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
        result: PipelineResult,
    ) -> IdentityResolutionRecord:
        """Handle YES/ASSIGN_EXISTING path with lifecycle checks."""
        matched_id = eval_result.best_match_concern_id
        assert matched_id is not None

        # Lifecycle: check if concern is MERGED → follow redirect
        concern_map = {c.concern_id: c for c in context.concerns}
        matched_concern = concern_map.get(matched_id)

        if matched_concern and matched_concern.status == ConcernStatus.MERGED:
            redirect = self._lifecycle.follow_merge_redirect(
                matched_concern, context
            )
            if not redirect.resolved:
                # Merge redirect failed → REQUIRES_VALIDATION
                return self._build_requires_validation_record(
                    packet, propositions, context, eval_result,
                    retrieval_result.attempts, request_id, idempotency_key,
                    conversation_id, semantic_policy_version,
                    model_config_version, prompt_version, policy,
                    f"Merge redirect failed: {redirect.failure_reason}",
                )
            # Use the resolved target
            matched_id = redirect.target_concern.concern_id
            matched_concern = redirect.target_concern

        # Build reactivation group if dormant/retired with substantive resumption
        dep_group: SemanticDependencyGroupRef | None = None
        if matched_concern and matched_concern.status in (
            ConcernStatus.DORMANT, ConcernStatus.RETIRED
        ):
            if eval_result.substantive_resumption:
                dep_group = self._lifecycle.build_reactivation_group(
                    matched_id, packet.packet_id, request_id
                )
                result.dependency_groups.append(dep_group)
                overlay.record_reactivation(matched_id)

        # Assemble associations
        associations = self._association_assembler.assemble_associations(
            packet, propositions, matched_id, request_id,
            BehavioralConfidenceBand.HIGH,
        )
        result.associations.extend(associations)

        # Record assignment in overlay
        overlay.record_assignment(matched_id, packet.packet_id)

        # Build record
        record_id = self._build_record_id(request_id, packet.packet_id)
        record = IdentityResolutionRecord(
            record_id=record_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            packet_id=packet.packet_id,
            proposition_ids=[p.proposition_id for p in propositions],
            graph_version_analyzed=context.graph_version,
            graph_snapshot_token=context.snapshot_token,
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.HIGH,
            sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
            sufficiency_confidence=None,
            matched_concern_id=matched_id,
            proposed_concern_id=None,
            candidates_considered=eval_result.candidate_records,
            irs_signals=[],
            retrieval_attempts=retrieval_result.attempts,
            evidence_references=self._collect_evidence(eval_result),
            reasoning=eval_result.explanation,
            semantic_policy_version=semantic_policy_version,
            retrieval_policy_version=policy.retrieval_policy.policy_version,
            model_config_version=model_config_version,
            prompt_version=prompt_version,
            proposed_dependency_group_id=(
                dep_group.group_id if dep_group else None
            ),
        )
        return record

    async def _handle_assign_existing_from_downstream(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        downstream: DownstreamDecision,
        eval_result: IdentityEvaluationResult,
        sufficiency: SufficiencyRecord,
        all_attempts: list[RetrievalAttemptRecord],
        context: GraphStateContext,
        overlay: ProvisionalOverlay,
        policy: IdentityResolutionPolicy,
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
        result: PipelineResult,
    ) -> IdentityResolutionRecord:
        """Handle YES from downstream separator (adequate + HIGH match)."""
        matched_id = downstream.matched_concern_id
        assert matched_id is not None

        concern_map = {c.concern_id: c for c in context.concerns}
        matched_concern = concern_map.get(matched_id)

        # Lifecycle: merge redirect
        if matched_concern and matched_concern.status == ConcernStatus.MERGED:
            redirect = self._lifecycle.follow_merge_redirect(
                matched_concern, context
            )
            if not redirect.resolved:
                return self._build_requires_validation_record(
                    packet, propositions, context, eval_result,
                    all_attempts, request_id, idempotency_key,
                    conversation_id, semantic_policy_version,
                    model_config_version, prompt_version, policy,
                    f"Merge redirect failed: {redirect.failure_reason}",
                )
            matched_id = redirect.target_concern.concern_id
            matched_concern = redirect.target_concern

        # Reactivation for dormant/retired
        dep_group: SemanticDependencyGroupRef | None = None
        if matched_concern and matched_concern.status in (
            ConcernStatus.DORMANT, ConcernStatus.RETIRED
        ):
            if eval_result.substantive_resumption:
                dep_group = self._lifecycle.build_reactivation_group(
                    matched_id, packet.packet_id, request_id
                )
                result.dependency_groups.append(dep_group)
                overlay.record_reactivation(matched_id)

        # Assemble associations
        associations = self._association_assembler.assemble_associations(
            packet, propositions, matched_id, request_id,
            BehavioralConfidenceBand.HIGH,
        )
        result.associations.extend(associations)
        overlay.record_assignment(matched_id, packet.packet_id)

        record_id = self._build_record_id(request_id, packet.packet_id)
        return IdentityResolutionRecord(
            record_id=record_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            packet_id=packet.packet_id,
            proposition_ids=[p.proposition_id for p in propositions],
            graph_version_analyzed=context.graph_version,
            graph_snapshot_token=context.snapshot_token,
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.HIGH,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=sufficiency.confidence,
            matched_concern_id=matched_id,
            proposed_concern_id=None,
            candidates_considered=eval_result.candidate_records,
            irs_signals=[],
            retrieval_attempts=all_attempts,
            evidence_references=self._collect_evidence(eval_result),
            reasoning=downstream.rationale,
            semantic_policy_version=semantic_policy_version,
            retrieval_policy_version=policy.retrieval_policy.policy_version,
            model_config_version=model_config_version,
            prompt_version=prompt_version,
            proposed_dependency_group_id=(
                dep_group.group_id if dep_group else None
            ),
        )

    # -------------------------------------------------------------------
    # Novelty path
    # -------------------------------------------------------------------

    def _handle_novelty_path(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        downstream: DownstreamDecision,
        eval_result: IdentityEvaluationResult,
        sufficiency: SufficiencyRecord,
        all_attempts: list[RetrievalAttemptRecord],
        irs_signals: list[IRSSignal],
        context: GraphStateContext,
        overlay: ProvisionalOverlay,
        policy: IdentityResolutionPolicy,
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
        result: PipelineResult,
    ) -> IdentityResolutionRecord:
        """Handle novelty-eligible path: check novelty, coalesce proposals."""
        # Run novelty checker
        novelty_result = self._novelty_checker.check_novelty(
            packet, propositions, downstream, request_id
        )

        if not novelty_result.eligible:
            # Novelty denied → UNRESOLVED or DEFER depending on reason
            outcome = novelty_result.outcome
            action = novelty_result.action
            record_id = self._build_record_id(request_id, packet.packet_id)

            # Determine stage statuses based on outcome
            suff_status = StageExecutionStatus.COMPLETED
            suff_conf = sufficiency.confidence
            id_status = eval_result.stage_status
            id_conf = eval_result.confidence

            record = IdentityResolutionRecord(
                record_id=record_id,
                request_id=request_id,
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                packet_id=packet.packet_id,
                proposition_ids=[p.proposition_id for p in propositions],
                graph_version_analyzed=context.graph_version,
                graph_snapshot_token=context.snapshot_token,
                outcome=outcome,
                action=action,
                identity_stage_status=id_status,
                identity_confidence=id_conf,
                sufficiency_stage_status=suff_status,
                sufficiency_confidence=suff_conf,
                matched_concern_id=None,
                proposed_concern_id=None,
                candidates_considered=eval_result.candidate_records,
                irs_signals=irs_signals,
                retrieval_attempts=all_attempts,
                evidence_references=[],
                reasoning=novelty_result.rationale,
                semantic_policy_version=semantic_policy_version,
                retrieval_policy_version=policy.retrieval_policy.policy_version,
                model_config_version=model_config_version,
                prompt_version=prompt_version,
                proposed_dependency_group_id=None,
            )

            if outcome in PENDING_OUTCOMES:
                overlay.record_pending(packet.packet_id, outcome)
                self._create_pending_if_needed(
                    packet, propositions, outcome,
                    request_id, context.graph_version, result,
                )
            return record

        # Novelty eligible → coalesce shared proposals
        coalesced = self._coalescer.coalesce_proposal(
            packet, overlay, novelty_result
        )
        proposal = coalesced.proposal

        # Track proposal and dependency group
        if coalesced.is_first_proposer and coalesced.dependency_group:
            result.dependency_groups.append(coalesced.dependency_group)
            result.proposals.append(proposal)

        # Assemble associations to the proposed concern
        associations = self._association_assembler.assemble_associations(
            packet, propositions, proposal.proposed_concern_id, request_id,
            BehavioralConfidenceBand.HIGH,
        )
        result.associations.extend(associations)

        record_id = self._build_record_id(request_id, packet.packet_id)
        return IdentityResolutionRecord(
            record_id=record_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            packet_id=packet.packet_id,
            proposition_ids=[p.proposition_id for p in propositions],
            graph_version_analyzed=context.graph_version,
            graph_snapshot_token=context.snapshot_token,
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            identity_stage_status=eval_result.stage_status,
            identity_confidence=eval_result.confidence,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            matched_concern_id=None,
            proposed_concern_id=proposal.proposed_concern_id,
            candidates_considered=eval_result.candidate_records,
            irs_signals=irs_signals,
            retrieval_attempts=all_attempts,
            evidence_references=[],
            reasoning=novelty_result.rationale,
            semantic_policy_version=semantic_policy_version,
            retrieval_policy_version=policy.retrieval_policy.policy_version,
            model_config_version=model_config_version,
            prompt_version=prompt_version,
            proposed_dependency_group_id=(
                coalesced.dependency_group.group_id
                if coalesced.dependency_group
                else None
            ),
        )

    # -------------------------------------------------------------------
    # Helper: build records for non-assignment outcomes
    # -------------------------------------------------------------------

    def _build_defer_record(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        context: GraphStateContext,
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
        reason: str,
        policy: IdentityResolutionPolicy,
        retrieval_attempts: list[RetrievalAttemptRecord] | None = None,
        candidates: list[CandidateRecord] | None = None,
    ) -> IdentityResolutionRecord:
        """Build a DEFER record — operational failure, never semantic novelty."""
        record_id = self._build_record_id(request_id, packet.packet_id)
        return IdentityResolutionRecord(
            record_id=record_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            packet_id=packet.packet_id,
            proposition_ids=[p.proposition_id for p in propositions],
            graph_version_analyzed=context.graph_version,
            graph_snapshot_token=context.snapshot_token,
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.RETAIN_PENDING,
            identity_stage_status=StageExecutionStatus.NOT_RUN,
            identity_confidence=None,
            sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
            sufficiency_confidence=None,
            matched_concern_id=None,
            proposed_concern_id=None,
            candidates_considered=candidates or [],
            irs_signals=[],
            retrieval_attempts=retrieval_attempts or [],
            evidence_references=[],
            reasoning=reason,
            semantic_policy_version=semantic_policy_version,
            retrieval_policy_version=policy.retrieval_policy.policy_version,
            model_config_version=model_config_version,
            prompt_version=prompt_version,
            proposed_dependency_group_id=None,
        )

    def _build_inconclusive_record(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        context: GraphStateContext,
        sufficiency: SufficiencyRecord,
        eval_result: IdentityEvaluationResult,
        all_attempts: list[RetrievalAttemptRecord],
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
        policy: IdentityResolutionPolicy,
    ) -> IdentityResolutionRecord:
        """Build RETRIEVAL_INCONCLUSIVE record."""
        record_id = self._build_record_id(request_id, packet.packet_id)
        return IdentityResolutionRecord(
            record_id=record_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            packet_id=packet.packet_id,
            proposition_ids=[p.proposition_id for p in propositions],
            graph_version_analyzed=context.graph_version,
            graph_snapshot_token=context.snapshot_token,
            outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            action=ResolutionAction.RETAIN_PENDING,
            identity_stage_status=eval_result.stage_status,
            identity_confidence=eval_result.confidence,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=sufficiency.confidence,
            matched_concern_id=None,
            proposed_concern_id=None,
            candidates_considered=eval_result.candidate_records,
            irs_signals=sufficiency.unresolved_signals,
            retrieval_attempts=all_attempts,
            evidence_references=[],
            reasoning=sufficiency.rationale,
            semantic_policy_version=semantic_policy_version,
            retrieval_policy_version=policy.retrieval_policy.policy_version,
            model_config_version=model_config_version,
            prompt_version=prompt_version,
            proposed_dependency_group_id=None,
        )

    def _build_unresolved_record(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        context: GraphStateContext,
        sufficiency: SufficiencyRecord,
        eval_result: IdentityEvaluationResult,
        all_attempts: list[RetrievalAttemptRecord],
        irs_signals: list[IRSSignal],
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
        policy: IdentityResolutionPolicy,
        downstream: DownstreamDecision,
    ) -> IdentityResolutionRecord:
        """Build UNRESOLVED/RETAIN_PENDING record."""
        record_id = self._build_record_id(request_id, packet.packet_id)
        return IdentityResolutionRecord(
            record_id=record_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            packet_id=packet.packet_id,
            proposition_ids=[p.proposition_id for p in propositions],
            graph_version_analyzed=context.graph_version,
            graph_snapshot_token=context.snapshot_token,
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            identity_stage_status=eval_result.stage_status,
            identity_confidence=eval_result.confidence,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=sufficiency.confidence,
            matched_concern_id=None,
            proposed_concern_id=None,
            candidates_considered=eval_result.candidate_records,
            irs_signals=irs_signals,
            retrieval_attempts=all_attempts,
            evidence_references=[],
            reasoning=downstream.rationale,
            semantic_policy_version=semantic_policy_version,
            retrieval_policy_version=policy.retrieval_policy.policy_version,
            model_config_version=model_config_version,
            prompt_version=prompt_version,
            proposed_dependency_group_id=None,
        )

    def _build_requires_validation_record(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        context: GraphStateContext,
        eval_result: IdentityEvaluationResult,
        all_attempts: list[RetrievalAttemptRecord],
        request_id: str,
        idempotency_key: str,
        conversation_id: str,
        semantic_policy_version: str,
        model_config_version: str,
        prompt_version: str,
        policy: IdentityResolutionPolicy,
        reason: str,
    ) -> IdentityResolutionRecord:
        """Build REQUIRES_VALIDATION record (e.g. merge redirect failure)."""
        record_id = self._build_record_id(request_id, packet.packet_id)
        return IdentityResolutionRecord(
            record_id=record_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            packet_id=packet.packet_id,
            proposition_ids=[p.proposition_id for p in propositions],
            graph_version_analyzed=context.graph_version,
            graph_snapshot_token=context.snapshot_token,
            outcome=PipelineOutcome.REQUIRES_VALIDATION,
            action=ResolutionAction.RETAIN_PENDING,
            identity_stage_status=eval_result.stage_status,
            identity_confidence=eval_result.confidence,
            sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
            sufficiency_confidence=None,
            matched_concern_id=None,
            proposed_concern_id=None,
            candidates_considered=eval_result.candidate_records,
            irs_signals=[],
            retrieval_attempts=all_attempts,
            evidence_references=[],
            reasoning=reason,
            semantic_policy_version=semantic_policy_version,
            retrieval_policy_version=policy.retrieval_policy.policy_version,
            model_config_version=model_config_version,
            prompt_version=prompt_version,
            proposed_dependency_group_id=None,
        )

    # -------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------

    def _create_pending_if_needed(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        outcome: PipelineOutcome,
        request_id: str,
        graph_version: int,
        result: PipelineResult,
    ) -> None:
        """Create a pending decision bundle for unresolved outcomes."""
        if outcome in PENDING_OUTCOMES:
            bundle = self._pending_mgr.create_pending_decision(
                packet, propositions, outcome, request_id, graph_version
            )
            result.pending_bundles.append(bundle)

    @staticmethod
    def _build_record_id(request_id: str, packet_id: str) -> str:
        """Build deterministic record ID from request + packet."""
        creation_key = f"{request_id}:{packet_id}"
        return resolve_entity_id("identity_resolution_record", creation_key)

    @staticmethod
    def _collect_evidence(
        eval_result: IdentityEvaluationResult,
    ) -> list[EvidenceReference]:
        """Collect evidence references from evaluation result."""
        evidence: list[EvidenceReference] = []
        for candidate in eval_result.candidate_records:
            evidence.extend(candidate.identity_evidence)
        return evidence
