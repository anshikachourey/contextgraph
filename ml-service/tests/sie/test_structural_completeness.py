"""Structural completeness integration tests for SIE identity resolution.

Validates that all canonical output models enforce their required fields,
all cross-field invariants hold, and no structural shortcuts exist.

Task 18.4 — Test structural completeness.
Design authority: consolidated final design.md + design-corrections.md.

Tests:
1. CandidateRecord has contributing_attempt_ids (not channel names) and all fields.
2. RetrievalAttemptRecord has all required fields with candidate_count constraint.
3. IdentityResolutionRecord has stage statuses, nullable confidences, policy versions.
4. IRSSignal has signal_type, confidence, source_evidence, explanation, resolved.
5. SufficiencyRecord has stage_status, confidence, coverage fields.
6. Stage-confidence coupling: COMPLETED → non-null; NOT_RUN/FAILED → null.
7. Deterministic IDs from canonical semantic request identity.
8. Dependency groups with group_id, failure_policy, mutations.
9. candidate_count == len(candidate_ids) constraint enforcement.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.sie.contracts import SemanticDependencyGroupRef
from app.sie.enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    IRSSignalType,
    PipelineOutcome,
    ResolutionAction,
    RetrievalAttemptStatus,
    StageExecutionStatus,
)
from app.sie.id_generation import resolve_entity_id
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


# ===========================================================================
# Shared fixtures / factories
# ===========================================================================


def _evidence_ref(entity_id: str = "prop-1") -> EvidenceReference:
    return EvidenceReference(
        entity_id=entity_id,
        entity_type="proposition",
        source_message_id="msg-1",
        span_start=0,
        span_end=42,
        description="grounding evidence",
    )


def _irs_signal(
    resolved: bool = False,
    signal_type: IRSSignalType = IRSSignalType.REVISIT_LANGUAGE,
) -> IRSSignal:
    return IRSSignal(
        signal_type=signal_type,
        confidence=BehavioralConfidenceBand.HIGH,
        source_evidence=[_evidence_ref()],
        explanation="Detected revisit language cue",
        resolved=resolved,
        resolved_by_attempt_ids=["attempt-1"] if resolved else [],
    )


def _retrieval_attempt(
    attempt_id: str = "attempt-1",
    candidate_ids: list[str] | None = None,
) -> RetrievalAttemptRecord:
    ids = candidate_ids if candidate_ids is not None else ["concern-1"]
    return RetrievalAttemptRecord(
        attempt_id=attempt_id,
        channel_id="ch-embed-primary",
        channel_family="embedding_primary",
        query_mode="semantic_similarity",
        query_reference="ref:conv-1:pkt-1:embed",
        scope_description="Active and dormant concerns within conversation",
        status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
        candidate_ids=ids,
        candidate_count=len(ids),
        latency_ms=120,
        failure_reason=None,
        retrieval_policy_version="policy-1.0.0",
        triggered_by_signal=None,
    )


def _candidate_record(concern_id: str = "concern-1") -> CandidateRecord:
    return CandidateRecord(
        concern_id=concern_id,
        lifecycle_status=ConcernStatus.ACTIVE,
        resolved_merge_target=None,
        contributing_attempt_ids=["attempt-1", "attempt-2"],
        channel_local_diagnostics=[
            ChannelDiagnostic(
                channel_id="ch-embed-primary",
                metric_name="cosine_similarity",
                metric_value=0.89,
            )
        ],
        identity_evidence=[_evidence_ref("prop-1")],
        contrary_evidence=[_evidence_ref("prop-2")],
        confidence=BehavioralConfidenceBand.HIGH,
        explanation="Strong identity continuity via exact concern match",
    )


def _full_resolution_record(
    outcome: PipelineOutcome = PipelineOutcome.YES,
    action: ResolutionAction = ResolutionAction.ASSIGN_EXISTING,
    matched_concern_id: str | None = "concern-1",
    proposed_concern_id: str | None = None,
    identity_stage_status: StageExecutionStatus = StageExecutionStatus.COMPLETED,
    identity_confidence: BehavioralConfidenceBand | None = BehavioralConfidenceBand.HIGH,
    sufficiency_stage_status: StageExecutionStatus = StageExecutionStatus.COMPLETED,
    sufficiency_confidence: BehavioralConfidenceBand | None = BehavioralConfidenceBand.HIGH,
) -> IdentityResolutionRecord:
    return IdentityResolutionRecord(
        record_id=resolve_entity_id(
            "identity_resolution_record", "conv-1:pkt-1:ir-event-1"
        ),
        request_id="req-001",
        idempotency_key="idem-001",
        conversation_id="conv-1",
        packet_id="pkt-1",
        proposition_ids=["prop-1", "prop-2"],
        graph_version_analyzed=5,
        graph_snapshot_token="snap-token-abc",
        outcome=outcome,
        action=action,
        identity_stage_status=identity_stage_status,
        identity_confidence=identity_confidence,
        sufficiency_stage_status=sufficiency_stage_status,
        sufficiency_confidence=sufficiency_confidence,
        matched_concern_id=matched_concern_id,
        proposed_concern_id=proposed_concern_id,
        candidates_considered=[_candidate_record()],
        irs_signals=[_irs_signal(resolved=True)],
        retrieval_attempts=[_retrieval_attempt()],
        evidence_references=[_evidence_ref()],
        reasoning="Unique HIGH match with no competing candidate.",
        semantic_policy_version="sem-1.0.0",
        retrieval_policy_version="ret-1.0.0",
        model_config_version="model-1.0.0",
        prompt_version="prompt-1.0.0",
        proposed_dependency_group_id=None,
    )


# ===========================================================================
# 1. CandidateRecord structural completeness
# ===========================================================================


class TestCandidateRecordStructure:
    """CandidateRecord must have contributing_attempt_ids (list of attempt IDs),
    concern_id, resolved_merge_target, lifecycle_status, identity_evidence,
    contrary_evidence, confidence, and explanation."""

    def test_all_required_fields_present(self):
        """Verify all canonical fields exist on a valid CandidateRecord."""
        cr = _candidate_record()
        assert isinstance(cr.concern_id, str)
        assert isinstance(cr.lifecycle_status, ConcernStatus)
        assert cr.resolved_merge_target is None  # optional
        assert isinstance(cr.contributing_attempt_ids, list)
        assert all(isinstance(a, str) for a in cr.contributing_attempt_ids)
        assert isinstance(cr.identity_evidence, list)
        assert isinstance(cr.contrary_evidence, list)
        assert isinstance(cr.confidence, BehavioralConfidenceBand)
        assert isinstance(cr.explanation, str)

    def test_contributing_attempt_ids_not_channel_names(self):
        """contributing_attempt_ids must contain attempt IDs, not channel names."""
        cr = _candidate_record()
        # attempt IDs follow the pattern used in retrieval attempts
        assert cr.contributing_attempt_ids == ["attempt-1", "attempt-2"]
        # Must not be channel family names
        for aid in cr.contributing_attempt_ids:
            assert aid not in (
                "embedding_primary",
                "identity_summary",
                "alias_normalized",
            )

    def test_merged_candidate_has_resolve_target(self):
        """A MERGED candidate must have resolved_merge_target."""
        cr = CandidateRecord(
            concern_id="concern-merged",
            lifecycle_status=ConcernStatus.MERGED,
            resolved_merge_target="concern-survivor",
            contributing_attempt_ids=["attempt-3"],
            channel_local_diagnostics=[],
            identity_evidence=[_evidence_ref()],
            contrary_evidence=[],
            confidence=BehavioralConfidenceBand.MEDIUM,
            explanation="Merged concern with redirect",
        )
        assert cr.resolved_merge_target == "concern-survivor"

    def test_missing_required_field_raises(self):
        """Missing required field raises ValidationError."""
        with pytest.raises(ValidationError):
            CandidateRecord(
                concern_id="c-1",
                lifecycle_status=ConcernStatus.ACTIVE,
                # contributing_attempt_ids missing
                channel_local_diagnostics=[],
                identity_evidence=[],
                contrary_evidence=[],
                confidence=BehavioralConfidenceBand.LOW,
                explanation="test",
            )


# ===========================================================================
# 2. RetrievalAttemptRecord structural completeness
# ===========================================================================


class TestRetrievalAttemptRecordStructure:
    """RetrievalAttemptRecord must have attempt_id, channel_id, channel_family,
    query_mode, query_reference, scope_description, status, candidate_ids,
    candidate_count, latency_ms, failure_reason, retrieval_policy_version,
    triggered_by_signal."""

    def test_all_required_fields_present(self):
        """Verify all canonical fields exist."""
        ra = _retrieval_attempt()
        assert isinstance(ra.attempt_id, str)
        assert isinstance(ra.channel_id, str)
        assert isinstance(ra.channel_family, str)
        assert isinstance(ra.query_mode, str)
        assert isinstance(ra.query_reference, str)
        assert isinstance(ra.scope_description, str)
        assert isinstance(ra.status, RetrievalAttemptStatus)
        assert isinstance(ra.candidate_ids, list)
        assert isinstance(ra.candidate_count, int)
        assert ra.latency_ms is None or isinstance(ra.latency_ms, int)
        assert ra.failure_reason is None or isinstance(ra.failure_reason, str)
        assert isinstance(ra.retrieval_policy_version, str)
        assert ra.triggered_by_signal is None or isinstance(
            ra.triggered_by_signal, IRSSignalType
        )

    def test_query_mode_required_not_defaulted(self):
        """query_mode is required — cannot omit it."""
        with pytest.raises(ValidationError):
            RetrievalAttemptRecord(
                attempt_id="a-1",
                channel_id="ch-1",
                channel_family="embedding_primary",
                # query_mode missing
                query_reference="ref:1",
                scope_description="all active",
                status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                candidate_ids=[],
                candidate_count=0,
                retrieval_policy_version="1.0",
            )

    def test_query_reference_required_not_defaulted(self):
        """query_reference is required — cannot omit it."""
        with pytest.raises(ValidationError):
            RetrievalAttemptRecord(
                attempt_id="a-1",
                channel_id="ch-1",
                channel_family="embedding_primary",
                query_mode="semantic_similarity",
                # query_reference missing
                scope_description="all active",
                status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                candidate_ids=[],
                candidate_count=0,
                retrieval_policy_version="1.0",
            )

    def test_scope_description_required_not_defaulted(self):
        """scope_description is required — cannot omit it."""
        with pytest.raises(ValidationError):
            RetrievalAttemptRecord(
                attempt_id="a-1",
                channel_id="ch-1",
                channel_family="embedding_primary",
                query_mode="semantic_similarity",
                query_reference="ref:1",
                # scope_description missing
                status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                candidate_ids=[],
                candidate_count=0,
                retrieval_policy_version="1.0",
            )


    def test_widening_attempt_with_irs_trigger(self):
        """Widening attempts carry triggered_by_signal referencing the IRS signal."""
        ra = RetrievalAttemptRecord(
            attempt_id="attempt-w1",
            channel_id="ch-alias",
            channel_family="alias_normalized",
            query_mode="alias_lookup",
            query_reference="ref:alias:conv-1",
            scope_description="All aliases in conversation",
            status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
            candidate_ids=["concern-5"],
            candidate_count=1,
            latency_ms=45,
            failure_reason=None,
            retrieval_policy_version="policy-1.0.0",
            triggered_by_signal=IRSSignalType.ALIAS_OR_VOCABULARY_DRIFT,
        )
        assert ra.triggered_by_signal == IRSSignalType.ALIAS_OR_VOCABULARY_DRIFT

    def test_error_attempt_records_failure_reason(self):
        """ERROR status attempts should carry a failure_reason."""
        ra = RetrievalAttemptRecord(
            attempt_id="attempt-e1",
            channel_id="ch-hist",
            channel_family="historical_region",
            query_mode="temporal_scan",
            query_reference="ref:hist:conv-1",
            scope_description="Historical region scan",
            status=RetrievalAttemptStatus.ERROR,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=5000,
            failure_reason="Embedding index unavailable",
            retrieval_policy_version="policy-1.0.0",
            triggered_by_signal=None,
        )
        assert ra.failure_reason == "Embedding index unavailable"


# ===========================================================================
# 3. IdentityResolutionRecord structural completeness
# ===========================================================================


class TestIdentityResolutionRecordStructure:
    """IdentityResolutionRecord must have stage statuses, confidences (nullable),
    matched/proposed concern IDs (mutually exclusive), policy/model versions,
    graph_snapshot_token, evidence_references, and reasoning."""

    def test_all_required_fields_for_yes_outcome(self):
        """YES/ASSIGN_EXISTING record has all fields."""
        rec = _full_resolution_record()
        assert isinstance(rec.record_id, str)
        assert isinstance(rec.request_id, str)
        assert isinstance(rec.idempotency_key, str)
        assert isinstance(rec.conversation_id, str)
        assert isinstance(rec.packet_id, str)
        assert isinstance(rec.proposition_ids, list)
        assert isinstance(rec.graph_version_analyzed, int)
        assert isinstance(rec.graph_snapshot_token, str)
        assert isinstance(rec.outcome, PipelineOutcome)
        assert isinstance(rec.action, ResolutionAction)
        assert isinstance(rec.identity_stage_status, StageExecutionStatus)
        assert isinstance(rec.identity_confidence, BehavioralConfidenceBand)
        assert isinstance(rec.sufficiency_stage_status, StageExecutionStatus)
        assert isinstance(rec.sufficiency_confidence, BehavioralConfidenceBand)
        assert rec.matched_concern_id == "concern-1"
        assert rec.proposed_concern_id is None
        assert isinstance(rec.candidates_considered, list)
        assert isinstance(rec.irs_signals, list)
        assert isinstance(rec.retrieval_attempts, list)
        assert isinstance(rec.evidence_references, list)
        assert isinstance(rec.reasoning, str)
        assert isinstance(rec.semantic_policy_version, str)
        assert isinstance(rec.retrieval_policy_version, str)
        assert isinstance(rec.model_config_version, str)
        assert isinstance(rec.prompt_version, str)


    def test_mutually_exclusive_matched_proposed(self):
        """matched_concern_id and proposed_concern_id are mutually exclusive."""
        # YES has matched, no proposed
        rec_yes = _full_resolution_record()
        assert rec_yes.matched_concern_id is not None
        assert rec_yes.proposed_concern_id is None

        # NO/PROPOSE_NEW has proposed, no matched
        rec_no = _full_resolution_record(
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            matched_concern_id=None,
            proposed_concern_id="concern-new-1",
            identity_confidence=BehavioralConfidenceBand.LOW,
        )
        assert rec_no.proposed_concern_id is not None
        assert rec_no.matched_concern_id is None

    def test_pending_outcomes_have_neither_concern_id(self):
        """UNRESOLVED/DEFER/RETRIEVAL_INCONCLUSIVE have neither matched nor proposed."""
        for outcome, action in [
            (PipelineOutcome.UNRESOLVED, ResolutionAction.RETAIN_PENDING),
            (PipelineOutcome.DEFER, ResolutionAction.NONE),
            (PipelineOutcome.RETRIEVAL_INCONCLUSIVE, ResolutionAction.RETAIN_PENDING),
        ]:
            rec = _full_resolution_record(
                outcome=outcome,
                action=action,
                matched_concern_id=None,
                proposed_concern_id=None,
                identity_confidence=BehavioralConfidenceBand.MEDIUM
                if outcome == PipelineOutcome.UNRESOLVED
                else None,
                identity_stage_status=StageExecutionStatus.COMPLETED
                if outcome == PipelineOutcome.UNRESOLVED
                else StageExecutionStatus.NOT_RUN,
                sufficiency_stage_status=StageExecutionStatus.NOT_RUN
                if outcome == PipelineOutcome.DEFER
                else StageExecutionStatus.COMPLETED,
                sufficiency_confidence=None
                if outcome == PipelineOutcome.DEFER
                else BehavioralConfidenceBand.MEDIUM,
            )
            assert rec.matched_concern_id is None
            assert rec.proposed_concern_id is None

    def test_policy_and_model_versions_required(self):
        """All four version fields are required."""
        with pytest.raises(ValidationError):
            IdentityResolutionRecord(
                record_id="rec-1",
                request_id="req-1",
                idempotency_key="idem-1",
                conversation_id="conv-1",
                packet_id="pkt-1",
                proposition_ids=["prop-1"],
                graph_version_analyzed=1,
                graph_snapshot_token="snap-1",
                outcome=PipelineOutcome.DEFER,
                action=ResolutionAction.NONE,
                identity_stage_status=StageExecutionStatus.NOT_RUN,
                identity_confidence=None,
                sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
                sufficiency_confidence=None,
                matched_concern_id=None,
                proposed_concern_id=None,
                candidates_considered=[],
                irs_signals=[],
                retrieval_attempts=[],
                evidence_references=[],
                reasoning="deferred",
                # Missing: semantic_policy_version, retrieval_policy_version,
                # model_config_version, prompt_version
            )


# ===========================================================================
# 4. IRSSignal structural completeness
# ===========================================================================


class TestIRSSignalStructure:
    """IRSSignal must have signal_type, confidence, source_evidence,
    explanation, resolved, resolved_by_attempt_ids."""

    def test_all_fields_present(self):
        """Verify all canonical IRSSignal fields exist."""
        sig = _irs_signal(resolved=True)
        assert isinstance(sig.signal_type, IRSSignalType)
        assert isinstance(sig.confidence, BehavioralConfidenceBand)
        assert isinstance(sig.source_evidence, list)
        assert len(sig.source_evidence) >= 1
        assert isinstance(sig.explanation, str)
        assert isinstance(sig.resolved, bool)
        assert isinstance(sig.resolved_by_attempt_ids, list)

    def test_resolved_signal_has_attempt_ids(self):
        """A resolved signal carries the IDs of resolving attempts."""
        sig = _irs_signal(resolved=True)
        assert sig.resolved is True
        assert len(sig.resolved_by_attempt_ids) > 0
        assert all(isinstance(aid, str) for aid in sig.resolved_by_attempt_ids)

    def test_unresolved_signal_empty_attempt_ids(self):
        """An unresolved signal has empty resolved_by_attempt_ids."""
        sig = _irs_signal(resolved=False)
        assert sig.resolved is False
        assert sig.resolved_by_attempt_ids == []

    def test_all_irs_signal_types_valid(self):
        """Every defined IRS signal type can be used."""
        for sig_type in IRSSignalType:
            sig = IRSSignal(
                signal_type=sig_type,
                confidence=BehavioralConfidenceBand.MEDIUM,
                source_evidence=[_evidence_ref()],
                explanation=f"Test for {sig_type.value}",
                resolved=False,
                resolved_by_attempt_ids=[],
            )
            assert sig.signal_type == sig_type

    def test_missing_source_evidence_raises(self):
        """source_evidence is required."""
        with pytest.raises(ValidationError):
            IRSSignal(
                signal_type=IRSSignalType.REVISIT_LANGUAGE,
                confidence=BehavioralConfidenceBand.HIGH,
                # source_evidence missing
                explanation="test",
                resolved=False,
                resolved_by_attempt_ids=[],
            )


# ===========================================================================
# 5. SufficiencyRecord structural completeness
# ===========================================================================


class TestSufficiencyRecordStructure:
    """SufficiencyRecord must have stage_status, confidence (nullable),
    coverage_summary, unresolved_signals, failed_coverage_gaps, rationale."""

    def test_completed_adequate_record(self):
        """A completed adequate sufficiency record has all fields."""
        rec = SufficiencyRecord(
            stage_status=StageExecutionStatus.COMPLETED,
            confidence=BehavioralConfidenceBand.HIGH,
            coverage_summary="All required families covered",
            unresolved_signals=[],
            failed_coverage_gaps=[],
            rationale="All channels successful, no unresolved IRS signals",
        )
        assert rec.stage_status == StageExecutionStatus.COMPLETED
        assert rec.confidence == BehavioralConfidenceBand.HIGH
        assert isinstance(rec.coverage_summary, str)
        assert isinstance(rec.unresolved_signals, list)
        assert isinstance(rec.failed_coverage_gaps, list)
        assert isinstance(rec.rationale, str)

    def test_completed_inconclusive_record(self):
        """INCONCLUSIVE (MEDIUM confidence) sufficiency with unresolved signals."""
        rec = SufficiencyRecord(
            stage_status=StageExecutionStatus.COMPLETED,
            confidence=BehavioralConfidenceBand.MEDIUM,
            coverage_summary="Partial coverage — alias channel failed",
            unresolved_signals=[_irs_signal(resolved=False)],
            failed_coverage_gaps=["alias_normalized"],
            rationale="IRS-5 unresolved, alias channel error",
        )
        assert rec.confidence == BehavioralConfidenceBand.MEDIUM
        assert len(rec.unresolved_signals) == 1
        assert "alias_normalized" in rec.failed_coverage_gaps

    def test_not_run_sufficiency_requires_null_confidence(self):
        """NOT_RUN stage requires null confidence."""
        rec = SufficiencyRecord(
            stage_status=StageExecutionStatus.NOT_RUN,
            confidence=None,
            coverage_summary="Stage did not execute",
            unresolved_signals=[],
            failed_coverage_gaps=[],
            rationale="Identity found HIGH match; sufficiency skipped",
        )
        assert rec.confidence is None

    def test_not_run_with_confidence_raises(self):
        """NOT_RUN with non-null confidence is invalid."""
        with pytest.raises(ValidationError, match="must have null confidence"):
            SufficiencyRecord(
                stage_status=StageExecutionStatus.NOT_RUN,
                confidence=BehavioralConfidenceBand.HIGH,
                coverage_summary="invalid",
                unresolved_signals=[],
                failed_coverage_gaps=[],
                rationale="invalid",
            )

    def test_completed_without_confidence_raises(self):
        """COMPLETED without confidence is invalid."""
        with pytest.raises(ValidationError, match="must have non-null confidence"):
            SufficiencyRecord(
                stage_status=StageExecutionStatus.COMPLETED,
                confidence=None,
                coverage_summary="invalid",
                unresolved_signals=[],
                failed_coverage_gaps=[],
                rationale="invalid",
            )


# ===========================================================================
# 6. Stage status ↔ confidence coupling
# ===========================================================================


class TestStageConfidenceCoupling:
    """COMPLETED requires non-null confidence; NOT_RUN/FAILED requires null."""

    def test_completed_identity_requires_confidence(self):
        """Identity stage COMPLETED must have non-null confidence."""
        with pytest.raises(ValidationError):
            _full_resolution_record(
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=None,
                # Need a pending outcome to avoid YES/HIGH requirement
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
            )

    def test_not_run_identity_requires_null_confidence(self):
        """Identity stage NOT_RUN must have null confidence."""
        with pytest.raises(ValidationError):
            _full_resolution_record(
                identity_stage_status=StageExecutionStatus.NOT_RUN,
                identity_confidence=BehavioralConfidenceBand.LOW,
                outcome=PipelineOutcome.DEFER,
                action=ResolutionAction.NONE,
                matched_concern_id=None,
                sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
                sufficiency_confidence=None,
            )

    def test_failed_identity_requires_null_confidence(self):
        """Identity stage FAILED must have null confidence."""
        with pytest.raises(ValidationError):
            _full_resolution_record(
                identity_stage_status=StageExecutionStatus.FAILED,
                identity_confidence=BehavioralConfidenceBand.MEDIUM,
                outcome=PipelineOutcome.DEFER,
                action=ResolutionAction.NONE,
                matched_concern_id=None,
                sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
                sufficiency_confidence=None,
            )

    def test_completed_sufficiency_requires_confidence(self):
        """Sufficiency stage COMPLETED must have non-null confidence."""
        with pytest.raises(ValidationError):
            _full_resolution_record(
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=None,
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.MEDIUM,
            )

    def test_failed_sufficiency_requires_null_confidence(self):
        """Sufficiency stage FAILED must have null confidence."""
        with pytest.raises(ValidationError):
            _full_resolution_record(
                sufficiency_stage_status=StageExecutionStatus.FAILED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.LOW,
            )

    def test_valid_not_run_stages_with_null_confidence(self):
        """NOT_RUN stages with null confidence are valid."""
        rec = _full_resolution_record(
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.NONE,
            matched_concern_id=None,
            identity_stage_status=StageExecutionStatus.NOT_RUN,
            identity_confidence=None,
            sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
            sufficiency_confidence=None,
        )
        assert rec.identity_confidence is None
        assert rec.sufficiency_confidence is None


# ===========================================================================
# 7. Deterministic IDs from canonical semantic request identity
# ===========================================================================


class TestDeterministicIds:
    """record_id, attempt_id, decision_id are deterministic from canonical
    semantic request identity."""

    def test_record_id_deterministic(self):
        """Same creation key always produces the same record_id."""
        key = "conv-1:pkt-1:ir-event-1"
        id1 = resolve_entity_id("identity_resolution_record", key)
        id2 = resolve_entity_id("identity_resolution_record", key)
        assert id1 == id2

    def test_record_id_differs_for_different_key(self):
        """Different creation keys produce different IDs."""
        id1 = resolve_entity_id("identity_resolution_record", "conv-1:pkt-1:ir-1")
        id2 = resolve_entity_id("identity_resolution_record", "conv-1:pkt-2:ir-1")
        assert id1 != id2

    def test_record_id_differs_across_entity_kinds(self):
        """Same key with different entity kinds produces different IDs."""
        key = "conv-1:pkt-1:ir-event-1"
        record_id = resolve_entity_id("identity_resolution_record", key)
        decision_id = resolve_entity_id("pending_semantic_decision", key)
        assert record_id != decision_id

    def test_resolution_record_uses_deterministic_id(self):
        """IdentityResolutionRecord.record_id is a deterministic UUIDv5."""
        rec = _full_resolution_record()
        expected = resolve_entity_id(
            "identity_resolution_record", "conv-1:pkt-1:ir-event-1"
        )
        assert rec.record_id == expected

    def test_retry_stable_ids(self):
        """Retries of the same semantic creation event get the same IDs."""
        # Simulates retries — same inputs produce same outputs
        key = "conv-1:0-3:pipeline-1.0.0"
        first = resolve_entity_id("processing_request", key)
        retry = resolve_entity_id("processing_request", key)
        assert first == retry

    def test_different_source_lineage_creates_different_id(self):
        """Genuine extraction repair produces a different semantic request identity."""
        original_key = "conv-1:pkt-1:ir-original"
        repair_key = "conv-1:pkt-1:ir-repair-v2"
        original_id = resolve_entity_id("identity_resolution_record", original_key)
        repair_id = resolve_entity_id("identity_resolution_record", repair_key)
        assert original_id != repair_id


# ===========================================================================
# 8. Dependency groups
# ===========================================================================


class TestDependencyGroupStructure:
    """Dependency groups contain group_id, failure_policy, mutations array."""

    def test_all_or_none_group(self):
        """ALL_OR_NONE group with mutations."""
        group = SemanticDependencyGroupRef(
            group_id="dg-reactivation-1",
            mutation_refs=["mut-ownership", "mut-status-change", "mut-audit"],
            failure_policy="ALL_OR_NONE",
        )
        assert isinstance(group.group_id, str)
        assert isinstance(group.failure_policy, str)
        assert group.failure_policy == "ALL_OR_NONE"
        assert isinstance(group.mutation_refs, list)
        assert len(group.mutation_refs) == 3

    def test_independent_group(self):
        """INDEPENDENT failure policy is valid."""
        group = SemanticDependencyGroupRef(
            group_id="dg-evidence-1",
            mutation_refs=["mut-assoc-1", "mut-assoc-2"],
            failure_policy="INDEPENDENT",
        )
        assert group.failure_policy == "INDEPENDENT"

    def test_derived_group(self):
        """DERIVED failure policy is valid."""
        group = SemanticDependencyGroupRef(
            group_id="dg-derived-1",
            mutation_refs=["mut-child-1"],
            failure_policy="DERIVED",
        )
        assert group.failure_policy == "DERIVED"

    def test_invalid_failure_policy_raises(self):
        """Invalid failure_policy raises ValidationError."""
        with pytest.raises(ValidationError, match="failure_policy"):
            SemanticDependencyGroupRef(
                group_id="dg-bad",
                mutation_refs=["mut-1"],
                failure_policy="BEST_EFFORT",
            )

    def test_empty_mutations_allowed(self):
        """A group with empty mutations is structurally valid."""
        group = SemanticDependencyGroupRef(
            group_id="dg-empty",
            mutation_refs=[],
            failure_policy="ALL_OR_NONE",
        )
        assert group.mutation_refs == []


# ===========================================================================
# 9. candidate_count == len(candidate_ids) constraint
# ===========================================================================


class TestCandidateCountConstraint:
    """candidate_count must equal len(candidate_ids)."""

    def test_valid_count_matches_ids(self):
        """Valid when candidate_count == len(candidate_ids)."""
        ra = _retrieval_attempt(candidate_ids=["c-1", "c-2", "c-3"])
        assert ra.candidate_count == 3
        assert len(ra.candidate_ids) == 3

    def test_zero_candidates(self):
        """Zero candidates is valid for SUCCESS_EMPTY."""
        ra = RetrievalAttemptRecord(
            attempt_id="a-empty",
            channel_id="ch-lex",
            channel_family="lexical_entity",
            query_mode="entity_search",
            query_reference="ref:lex:conv-1",
            scope_description="Lexical entity search",
            status=RetrievalAttemptStatus.SUCCESS_EMPTY,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=30,
            failure_reason=None,
            retrieval_policy_version="policy-1.0.0",
            triggered_by_signal=None,
        )
        assert ra.candidate_count == 0
        assert ra.candidate_ids == []

    def test_count_mismatch_too_high_raises(self):
        """candidate_count > len(candidate_ids) raises ValidationError."""
        with pytest.raises(ValidationError, match="candidate_count"):
            RetrievalAttemptRecord(
                attempt_id="a-bad",
                channel_id="ch-1",
                channel_family="embedding_primary",
                query_mode="semantic_similarity",
                query_reference="ref:1",
                scope_description="test",
                status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                candidate_ids=["c-1"],
                candidate_count=5,  # Mismatch!
                retrieval_policy_version="1.0",
            )

    def test_count_mismatch_too_low_raises(self):
        """candidate_count < len(candidate_ids) raises ValidationError."""
        with pytest.raises(ValidationError, match="candidate_count"):
            RetrievalAttemptRecord(
                attempt_id="a-bad2",
                channel_id="ch-1",
                channel_family="embedding_primary",
                query_mode="semantic_similarity",
                query_reference="ref:1",
                scope_description="test",
                status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                candidate_ids=["c-1", "c-2", "c-3"],
                candidate_count=1,  # Mismatch!
                retrieval_policy_version="1.0",
            )

    def test_count_zero_with_nonempty_ids_raises(self):
        """candidate_count=0 with non-empty candidate_ids raises."""
        with pytest.raises(ValidationError, match="candidate_count"):
            RetrievalAttemptRecord(
                attempt_id="a-bad3",
                channel_id="ch-1",
                channel_family="embedding_primary",
                query_mode="semantic_similarity",
                query_reference="ref:1",
                scope_description="test",
                status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                candidate_ids=["c-1"],
                candidate_count=0,  # Mismatch!
                retrieval_policy_version="1.0",
            )
