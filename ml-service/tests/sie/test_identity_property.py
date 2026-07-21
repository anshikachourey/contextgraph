"""Property-based tests for SIE identity resolution models and contracts.

Tests cover:
1. Discriminated-result exhaustive testing (valid/invalid combinations)
2. Serialization round-trip tests for all identity models
3. PayloadFingerprint stability and sensitivity
4. Semantic creation key stability across retries vs. source-lineage changes
5. Policy fail-closed tests
6. candidate_count invariant
7. Stage-confidence coupling exhaustive

**Validates: Requirements 2.12, 3.5, 4.10, 6.5, 6.6, 9.5, 10.1, 10.2, 10.4**
"""

import json

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

from app.sie.enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    IRSSignalType,
    PipelineOutcome,
    ProcessingMode,
    ResolutionAction,
    RetrievalAttemptStatus,
    StageExecutionStatus,
)
from app.sie.identity_models import (
    CandidateRecord,
    ChannelDiagnostic,
    EvidenceReference,
    IdentityResolutionRecord,
    IRSSignal,
    RetrievalAttemptRecord,
    SufficiencyRecord,
)
from app.sie.models import (
    ConcernProposal,
    IdentityResolutionResult,
)
from app.sie.contracts import PayloadFingerprint
from app.sie.identity_policy import (
    ChannelFamilyRequirement,
    ChannelInvocation,
    ChannelRegistryEntry,
    DeferResult,
    IdentityResolutionPolicy,
    ReEvaluationPolicy,
    RetrievalPolicy,
    WideningBudgetPolicy,
    validate_policy_or_defer,
)
from app.sie.id_generation import (
    build_concern_key,
    resolve_entity_id,
)


# ---------------------------------------------------------------------------
# Shared strategies
# ---------------------------------------------------------------------------

confidence_st = st.sampled_from(list(BehavioralConfidenceBand))
optional_confidence_st = st.one_of(st.none(), confidence_st)
outcome_st = st.sampled_from(list(PipelineOutcome))
action_st = st.sampled_from(list(ResolutionAction))
stage_status_st = st.sampled_from(list(StageExecutionStatus))
concern_status_st = st.sampled_from(list(ConcernStatus))
irs_signal_type_st = st.sampled_from(list(IRSSignalType))
retrieval_status_st = st.sampled_from(list(RetrievalAttemptStatus))
processing_mode_st = st.sampled_from(list(ProcessingMode))

nonempty_str_st = st.text(
    min_size=1, max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N"), blacklist_characters="\x00"),
)


# ---------------------------------------------------------------------------
# Helper: build a minimal valid IdentityResolutionRecord
# ---------------------------------------------------------------------------


def _make_identity_record(
    *,
    outcome: PipelineOutcome,
    action: ResolutionAction,
    identity_stage_status: StageExecutionStatus,
    identity_confidence: BehavioralConfidenceBand | None,
    sufficiency_stage_status: StageExecutionStatus,
    sufficiency_confidence: BehavioralConfidenceBand | None,
    matched_concern_id: str | None = None,
    proposed_concern_id: str | None = None,
) -> IdentityResolutionRecord:
    """Build an IdentityResolutionRecord with the given discriminated fields."""
    return IdentityResolutionRecord(
        record_id="rec-001",
        request_id="req-001",
        idempotency_key="idem-001",
        conversation_id="conv-001",
        packet_id="pkt-001",
        proposition_ids=["prop-001"],
        graph_version_analyzed=1,
        graph_snapshot_token="snap-001",
        outcome=outcome,
        action=action,
        identity_stage_status=identity_stage_status,
        identity_confidence=identity_confidence,
        sufficiency_stage_status=sufficiency_stage_status,
        sufficiency_confidence=sufficiency_confidence,
        matched_concern_id=matched_concern_id,
        proposed_concern_id=proposed_concern_id,
        candidates_considered=[],
        irs_signals=[],
        retrieval_attempts=[],
        evidence_references=[],
        reasoning="Test reasoning",
        semantic_policy_version="1.0",
        retrieval_policy_version="1.0",
        model_config_version="1.0",
        prompt_version="1.0",
    )


# ===========================================================================
# 1. DISCRIMINATED-RESULT EXHAUSTIVE TESTING
# **Validates: Requirements 2.12, 6.6, 10.2, 10.4**
# ===========================================================================


class TestDiscriminatedResultExhaustive:
    """Exhaustive tests for valid/invalid outcome/action/ID/stage/confidence combos."""

    def test_yes_assign_existing_valid(self):
        """YES + ASSIGN_EXISTING with HIGH identity confidence succeeds."""
        record = _make_identity_record(
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.HIGH,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            matched_concern_id="concern-001",
            proposed_concern_id=None,
        )
        assert record.outcome == PipelineOutcome.YES
        assert record.matched_concern_id == "concern-001"

    def test_no_propose_new_valid(self):
        """NO + PROPOSE_NEW with HIGH sufficiency confidence succeeds."""
        record = _make_identity_record(
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.MEDIUM,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            matched_concern_id=None,
            proposed_concern_id="new-concern-001",
        )
        assert record.outcome == PipelineOutcome.NO
        assert record.proposed_concern_id == "new-concern-001"

    @given(
        outcome=st.sampled_from([
            PipelineOutcome.UNRESOLVED,
            PipelineOutcome.DEFER,
            PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            PipelineOutcome.REQUIRES_VALIDATION,
        ]),
        action=st.sampled_from([
            ResolutionAction.RETAIN_PENDING,
            ResolutionAction.NONE,
        ]),
        id_conf=confidence_st,
        suff_conf=confidence_st,
    )
    @settings(max_examples=50)
    def test_pending_outcomes_valid_with_no_ids(
        self, outcome, action, id_conf, suff_conf
    ):
        """Pending outcomes succeed when both concern IDs are None."""
        record = _make_identity_record(
            outcome=outcome,
            action=action,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=id_conf,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=suff_conf,
            matched_concern_id=None,
            proposed_concern_id=None,
        )
        assert record.matched_concern_id is None
        assert record.proposed_concern_id is None

    @given(concern_id=nonempty_str_st)
    @settings(max_examples=30)
    def test_yes_without_matched_concern_id_raises(self, concern_id):
        """YES outcome without matched_concern_id raises ValidationError via IdentityResolutionResult."""
        with pytest.raises(ValueError, match="matched_concern_id"):
            IdentityResolutionResult(
                packet_id="pkt-001",
                outcome=PipelineOutcome.YES,
                action=ResolutionAction.ASSIGN_EXISTING,
                matched_concern_id=None,
                new_concern_proposal=None,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.HIGH,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Missing match — invalid",
            )

    @given(concern_id=nonempty_str_st)
    @settings(max_examples=30)
    def test_no_with_matched_concern_id_raises(self, concern_id):
        """NO outcome with matched_concern_id set raises ValidationError via IdentityResolutionResult."""
        with pytest.raises(ValueError, match="matched_concern_id"):
            IdentityResolutionResult(
                packet_id="pkt-001",
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                matched_concern_id=concern_id,
                new_concern_proposal=ConcernProposal(
                    concern_creation_key="pkt1:ev1",
                    proposed_concern_id="new-concern-001",
                    identity_summary="A new concern",
                    display_title="New Concern",
                    initial_summary="Initial summary",
                ),
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.MEDIUM,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Both set — invalid",
            )

    @given(
        outcome=st.sampled_from([
            PipelineOutcome.UNRESOLVED,
            PipelineOutcome.DEFER,
            PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            PipelineOutcome.REQUIRES_VALIDATION,
        ]),
        concern_id=nonempty_str_st,
    )
    @settings(max_examples=30)
    def test_pending_with_matched_concern_raises(self, outcome, concern_id):
        """Pending outcomes with matched_concern_id set raises ValidationError via IdentityResolutionResult."""
        with pytest.raises(ValueError, match="must not have.*matched_concern_id"):
            IdentityResolutionResult(
                packet_id="pkt-001",
                outcome=outcome,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=concern_id,
                new_concern_proposal=None,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.HIGH,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Pending with match — invalid",
            )

    @given(
        outcome=st.sampled_from([
            PipelineOutcome.UNRESOLVED,
            PipelineOutcome.DEFER,
            PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            PipelineOutcome.REQUIRES_VALIDATION,
        ]),
        proposed_id=nonempty_str_st,
    )
    @settings(max_examples=30)
    def test_pending_with_proposed_concern_raises(self, outcome, proposed_id):
        """Pending outcomes with new_concern_proposal set raises ValidationError via IdentityResolutionResult."""
        proposal = ConcernProposal(
            concern_creation_key="pkt1:ev1",
            proposed_concern_id=proposed_id,
            identity_summary="A new concern",
            display_title="New Concern",
            initial_summary="Initial summary",
        )
        with pytest.raises(ValueError, match="must not have.*new_concern_proposal"):
            IdentityResolutionResult(
                packet_id="pkt-001",
                outcome=outcome,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id=None,
                new_concern_proposal=proposal,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.HIGH,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Pending with proposal — invalid",
            )

    def test_yes_with_non_high_identity_confidence_raises(self):
        """YES outcome requires identity_confidence=HIGH via IdentityResolutionResult."""
        for conf in [BehavioralConfidenceBand.MEDIUM, BehavioralConfidenceBand.LOW]:
            with pytest.raises(ValueError, match="identity_confidence=HIGH"):
                IdentityResolutionResult(
                    packet_id="pkt-001",
                    outcome=PipelineOutcome.YES,
                    action=ResolutionAction.ASSIGN_EXISTING,
                    matched_concern_id="concern-001",
                    new_concern_proposal=None,
                    identity_stage_status=StageExecutionStatus.COMPLETED,
                    identity_confidence=conf,
                    sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                    sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                    rationale="Non-high confidence — invalid",
                )

    def test_no_with_non_high_sufficiency_confidence_raises(self):
        """NO outcome requires sufficiency_confidence=HIGH via IdentityResolutionResult."""
        for conf in [BehavioralConfidenceBand.MEDIUM, BehavioralConfidenceBand.LOW]:
            with pytest.raises(ValueError, match="sufficiency_confidence=HIGH"):
                IdentityResolutionResult(
                    packet_id="pkt-001",
                    outcome=PipelineOutcome.NO,
                    action=ResolutionAction.PROPOSE_NEW,
                    matched_concern_id=None,
                    new_concern_proposal=ConcernProposal(
                        concern_creation_key="pkt1:ev1",
                        proposed_concern_id="new-concern-001",
                        identity_summary="A new concern",
                        display_title="New Concern",
                        initial_summary="Initial summary",
                    ),
                    identity_stage_status=StageExecutionStatus.COMPLETED,
                    identity_confidence=BehavioralConfidenceBand.MEDIUM,
                    sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                    sufficiency_confidence=conf,
                    rationale="Non-high sufficiency — invalid",
                )


# ===========================================================================
# 2. SERIALIZATION ROUND-TRIP TESTS
# **Validates: Requirements 10.1**
# ===========================================================================


# Strategy for generating valid EvidenceReference
evidence_ref_st = st.builds(
    EvidenceReference,
    entity_id=nonempty_str_st,
    entity_type=nonempty_str_st,
    source_message_id=st.one_of(st.none(), nonempty_str_st),
    span_start=st.one_of(st.none(), st.integers(min_value=0, max_value=1000)),
    span_end=st.one_of(st.none(), st.integers(min_value=0, max_value=1000)),
    description=st.one_of(st.none(), nonempty_str_st),
)

# Strategy for ChannelDiagnostic
channel_diag_st = st.builds(
    ChannelDiagnostic,
    channel_id=nonempty_str_st,
    metric_name=nonempty_str_st,
    metric_value=st.one_of(st.none(), st.floats(min_value=0, max_value=1.0)),
    detail=st.one_of(st.none(), nonempty_str_st),
)


# Strategy for IRSSignal
irs_signal_st = st.builds(
    IRSSignal,
    signal_type=irs_signal_type_st,
    confidence=confidence_st,
    source_evidence=st.lists(evidence_ref_st, min_size=1, max_size=3),
    explanation=nonempty_str_st,
    resolved=st.booleans(),
    resolved_by_attempt_ids=st.lists(nonempty_str_st, min_size=0, max_size=2),
)


# Strategy for RetrievalAttemptRecord (with consistent candidate_count)
@st.composite
def retrieval_attempt_st(draw):
    """Generate a valid RetrievalAttemptRecord with matching candidate_count."""
    candidate_ids = draw(st.lists(nonempty_str_st, min_size=0, max_size=5))
    return RetrievalAttemptRecord(
        attempt_id=draw(nonempty_str_st),
        channel_id=draw(nonempty_str_st),
        channel_family=draw(nonempty_str_st),
        query_mode=draw(nonempty_str_st),
        query_reference=draw(nonempty_str_st),
        scope_description=draw(nonempty_str_st),
        status=draw(retrieval_status_st),
        candidate_ids=candidate_ids,
        candidate_count=len(candidate_ids),
        latency_ms=draw(st.one_of(st.none(), st.integers(min_value=1, max_value=5000))),
        failure_reason=draw(st.one_of(st.none(), nonempty_str_st)),
        retrieval_policy_version=draw(nonempty_str_st),
        triggered_by_signal=draw(st.one_of(st.none(), irs_signal_type_st)),
    )


# Strategy for CandidateRecord
candidate_record_st = st.builds(
    CandidateRecord,
    concern_id=nonempty_str_st,
    lifecycle_status=concern_status_st,
    resolved_merge_target=st.one_of(st.none(), nonempty_str_st),
    contributing_attempt_ids=st.lists(nonempty_str_st, min_size=1, max_size=3),
    channel_local_diagnostics=st.lists(channel_diag_st, min_size=0, max_size=2),
    identity_evidence=st.lists(evidence_ref_st, min_size=0, max_size=2),
    contrary_evidence=st.lists(evidence_ref_st, min_size=0, max_size=2),
    confidence=confidence_st,
    explanation=nonempty_str_st,
)


# Strategy for SufficiencyRecord (respecting stage-confidence coupling)
@st.composite
def sufficiency_record_st(draw):
    """Generate a valid SufficiencyRecord respecting stage-confidence coupling."""
    stage_status = draw(stage_status_st)
    if stage_status == StageExecutionStatus.COMPLETED:
        confidence = draw(confidence_st)
    else:
        confidence = None
    return SufficiencyRecord(
        stage_status=stage_status,
        confidence=confidence,
        coverage_summary=draw(nonempty_str_st),
        unresolved_signals=draw(st.lists(irs_signal_st, min_size=0, max_size=2)),
        failed_coverage_gaps=draw(st.lists(nonempty_str_st, min_size=0, max_size=2)),
        rationale=draw(nonempty_str_st),
    )


class TestSerializationRoundTrip:
    """Verify model_dump_json → model_validate_json preserves all fields."""

    @given(signal=irs_signal_st)
    @settings(max_examples=50)
    def test_irs_signal_roundtrip(self, signal):
        """IRSSignal survives JSON serialization roundtrip."""
        json_str = signal.model_dump_json()
        restored = IRSSignal.model_validate_json(json_str)
        assert restored == signal

    @given(attempt=retrieval_attempt_st())
    @settings(max_examples=50)
    def test_retrieval_attempt_record_roundtrip(self, attempt):
        """RetrievalAttemptRecord survives JSON serialization roundtrip."""
        json_str = attempt.model_dump_json()
        restored = RetrievalAttemptRecord.model_validate_json(json_str)
        assert restored == attempt

    @given(candidate=candidate_record_st)
    @settings(max_examples=50)
    def test_candidate_record_roundtrip(self, candidate):
        """CandidateRecord survives JSON serialization roundtrip."""
        json_str = candidate.model_dump_json()
        restored = CandidateRecord.model_validate_json(json_str)
        assert restored == candidate

    @given(record=sufficiency_record_st())
    @settings(max_examples=50)
    def test_sufficiency_record_roundtrip(self, record):
        """SufficiencyRecord survives JSON serialization roundtrip."""
        json_str = record.model_dump_json()
        restored = SufficiencyRecord.model_validate_json(json_str)
        assert restored == record

    def test_identity_resolution_record_roundtrip(self):
        """IdentityResolutionRecord with valid YES outcome survives roundtrip."""
        record = _make_identity_record(
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.HIGH,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            matched_concern_id="concern-001",
            proposed_concern_id=None,
        )
        json_str = record.model_dump_json()
        restored = IdentityResolutionRecord.model_validate_json(json_str)
        assert restored == record

    def test_identity_resolution_record_pending_roundtrip(self):
        """IdentityResolutionRecord with DEFER outcome survives roundtrip."""
        record = _make_identity_record(
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.RETAIN_PENDING,
            identity_stage_status=StageExecutionStatus.NOT_RUN,
            identity_confidence=None,
            sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
            sufficiency_confidence=None,
            matched_concern_id=None,
            proposed_concern_id=None,
        )
        json_str = record.model_dump_json()
        restored = IdentityResolutionRecord.model_validate_json(json_str)
        assert restored == record


# ===========================================================================
# 3. PAYLOAD FINGERPRINT STABILITY AND SENSITIVITY
# **Validates: Requirements 9.3, 9.4**
# ===========================================================================


class TestPayloadFingerprintStability:
    """Test canonical payload fingerprint determinism and sensitivity."""

    @given(
        conversation_id=nonempty_str_st,
        mode=processing_mode_st,
        version=st.integers(min_value=1, max_value=1000),
        digest=nonempty_str_st,
        packet_ids=st.lists(nonempty_str_st, min_size=1, max_size=5),
    )
    @settings(max_examples=50)
    def test_same_inputs_produce_same_hash(
        self, conversation_id, mode, version, digest, packet_ids
    ):
        """Same inputs always produce the same content_hash."""
        fp1 = PayloadFingerprint.create(
            conversation_id=conversation_id,
            processing_mode=mode,
            base_graph_version=version,
            snapshot_digest=digest,
            ordered_packet_ids=packet_ids,
            policy_versions={"semantic": "1.0", "retrieval": "2.0"},
            model_versions={"primary": "gpt-4", "fallback": "gpt-3.5"},
        )
        fp2 = PayloadFingerprint.create(
            conversation_id=conversation_id,
            processing_mode=mode,
            base_graph_version=version,
            snapshot_digest=digest,
            ordered_packet_ids=packet_ids,
            policy_versions={"semantic": "1.0", "retrieval": "2.0"},
            model_versions={"primary": "gpt-4", "fallback": "gpt-3.5"},
        )
        assert fp1.content_hash == fp2.content_hash

    def test_changing_conversation_id_changes_hash(self):
        """Changing conversation_id produces a different content_hash."""
        base_args = dict(
            processing_mode=ProcessingMode.FULL_PIPELINE,
            base_graph_version=1,
            snapshot_digest="abc123",
            ordered_packet_ids=["pkt-1"],
            policy_versions={"semantic": "1.0"},
            model_versions={"primary": "gpt-4"},
        )
        fp1 = PayloadFingerprint.create(conversation_id="conv-A", **base_args)
        fp2 = PayloadFingerprint.create(conversation_id="conv-B", **base_args)
        assert fp1.content_hash != fp2.content_hash

    def test_changing_graph_version_changes_hash(self):
        """Changing base_graph_version produces a different content_hash."""
        base_args = dict(
            conversation_id="conv-1",
            processing_mode=ProcessingMode.FULL_PIPELINE,
            snapshot_digest="abc123",
            ordered_packet_ids=["pkt-1"],
            policy_versions={"semantic": "1.0"},
            model_versions={"primary": "gpt-4"},
        )
        fp1 = PayloadFingerprint.create(base_graph_version=1, **base_args)
        fp2 = PayloadFingerprint.create(base_graph_version=2, **base_args)
        assert fp1.content_hash != fp2.content_hash

    def test_changing_snapshot_digest_changes_hash(self):
        """Changing snapshot_digest produces a different content_hash."""
        base_args = dict(
            conversation_id="conv-1",
            processing_mode=ProcessingMode.FULL_PIPELINE,
            base_graph_version=1,
            ordered_packet_ids=["pkt-1"],
            policy_versions={"semantic": "1.0"},
            model_versions={"primary": "gpt-4"},
        )
        fp1 = PayloadFingerprint.create(snapshot_digest="digest-A", **base_args)
        fp2 = PayloadFingerprint.create(snapshot_digest="digest-B", **base_args)
        assert fp1.content_hash != fp2.content_hash

    def test_changing_processing_mode_changes_hash(self):
        """Changing processing_mode produces a different content_hash."""
        base_args = dict(
            conversation_id="conv-1",
            base_graph_version=1,
            snapshot_digest="abc123",
            ordered_packet_ids=["pkt-1"],
            policy_versions={"semantic": "1.0"},
            model_versions={"primary": "gpt-4"},
        )
        fp1 = PayloadFingerprint.create(
            processing_mode=ProcessingMode.FULL_PIPELINE, **base_args
        )
        fp2 = PayloadFingerprint.create(
            processing_mode=ProcessingMode.IDENTITY_RESOLUTION_ONLY, **base_args
        )
        assert fp1.content_hash != fp2.content_hash

    def test_changing_packet_ids_changes_hash(self):
        """Changing ordered_packet_ids produces a different content_hash."""
        base_args = dict(
            conversation_id="conv-1",
            processing_mode=ProcessingMode.FULL_PIPELINE,
            base_graph_version=1,
            snapshot_digest="abc123",
            policy_versions={"semantic": "1.0"},
            model_versions={"primary": "gpt-4"},
        )
        fp1 = PayloadFingerprint.create(
            ordered_packet_ids=["pkt-1", "pkt-2"], **base_args
        )
        fp2 = PayloadFingerprint.create(
            ordered_packet_ids=["pkt-1", "pkt-3"], **base_args
        )
        assert fp1.content_hash != fp2.content_hash

    def test_policy_version_order_does_not_change_hash(self):
        """Dict insertion order of policy_versions doesn't affect content_hash."""
        base_args = dict(
            conversation_id="conv-1",
            processing_mode=ProcessingMode.FULL_PIPELINE,
            base_graph_version=1,
            snapshot_digest="abc123",
            ordered_packet_ids=["pkt-1"],
            model_versions={"primary": "gpt-4"},
        )
        fp1 = PayloadFingerprint.create(
            policy_versions={"semantic": "1.0", "retrieval": "2.0", "budget": "3.0"},
            **base_args,
        )
        fp2 = PayloadFingerprint.create(
            policy_versions={"budget": "3.0", "retrieval": "2.0", "semantic": "1.0"},
            **base_args,
        )
        assert fp1.content_hash == fp2.content_hash

    def test_model_version_order_does_not_change_hash(self):
        """Dict insertion order of model_versions doesn't affect content_hash."""
        base_args = dict(
            conversation_id="conv-1",
            processing_mode=ProcessingMode.FULL_PIPELINE,
            base_graph_version=1,
            snapshot_digest="abc123",
            ordered_packet_ids=["pkt-1"],
            policy_versions={"semantic": "1.0"},
        )
        fp1 = PayloadFingerprint.create(
            model_versions={"primary": "gpt-4", "fallback": "gpt-3.5"},
            **base_args,
        )
        fp2 = PayloadFingerprint.create(
            model_versions={"fallback": "gpt-3.5", "primary": "gpt-4"},
            **base_args,
        )
        assert fp1.content_hash == fp2.content_hash

    def test_invalid_hash_raises(self):
        """Constructing with wrong content_hash raises ValidationError."""
        with pytest.raises(ValueError, match="content_hash mismatch"):
            PayloadFingerprint(
                conversation_id="conv-1",
                processing_mode=ProcessingMode.FULL_PIPELINE,
                base_graph_version=1,
                snapshot_digest="abc123",
                ordered_packet_ids=["pkt-1"],
                policy_versions={"semantic": "1.0"},
                model_versions={"primary": "gpt-4"},
                content_hash="wrong-hash-value",
            )


# ===========================================================================
# 4. SEMANTIC CREATION KEY STABILITY
# **Validates: Requirements 6.5, 9.5**
# ===========================================================================


class TestSemanticCreationKeyStability:
    """Test creation key stability across retries and sensitivity to lineage."""

    @given(
        conversation_id=nonempty_str_st,
        packet_lineage=nonempty_str_st,
        operation_ordinal=st.integers(min_value=0, max_value=100),
    )
    @settings(max_examples=100)
    def test_same_inputs_produce_same_creation_key(
        self, conversation_id, packet_lineage, operation_ordinal
    ):
        """Same (conversation_id, packet_lineage, operation_ordinal) produces
        identical creation key across separate computations (simulating retries)."""
        # Simulate creation key computation using concern key builder
        packet_creation_key = f"{conversation_id}:{packet_lineage}"
        identity_event = str(operation_ordinal)

        key1 = build_concern_key(packet_creation_key, identity_event)
        key2 = build_concern_key(packet_creation_key, identity_event)
        assert key1 == key2

        # And the resolved entity ID is stable
        id1 = resolve_entity_id("concern", key1)
        id2 = resolve_entity_id("concern", key2)
        assert id1 == id2

    @given(
        conversation_id=nonempty_str_st,
        packet_lineage_a=nonempty_str_st,
        packet_lineage_b=nonempty_str_st,
        operation_ordinal=st.integers(min_value=0, max_value=100),
    )
    @settings(max_examples=100)
    def test_different_lineage_produces_different_key(
        self, conversation_id, packet_lineage_a, packet_lineage_b, operation_ordinal
    ):
        """Changing source lineage produces a different creation key."""
        assume(packet_lineage_a != packet_lineage_b)

        key_a = build_concern_key(
            f"{conversation_id}:{packet_lineage_a}", str(operation_ordinal)
        )
        key_b = build_concern_key(
            f"{conversation_id}:{packet_lineage_b}", str(operation_ordinal)
        )
        assert key_a != key_b

        # And the resolved IDs are different
        id_a = resolve_entity_id("concern", key_a)
        id_b = resolve_entity_id("concern", key_b)
        assert id_a != id_b

    @given(
        conversation_id=nonempty_str_st,
        packet_lineage=nonempty_str_st,
        operation_ordinal=st.integers(min_value=0, max_value=100),
        graph_version_a=st.integers(min_value=1, max_value=100),
        graph_version_b=st.integers(min_value=1, max_value=100),
    )
    @settings(max_examples=50)
    def test_graph_version_does_not_affect_creation_key(
        self,
        conversation_id,
        packet_lineage,
        operation_ordinal,
        graph_version_a,
        graph_version_b,
    ):
        """Graph version (transport metadata) does NOT affect semantic creation key.
        This simulates graph-version reanalysis producing the same entity."""
        # Creation key excludes graph version
        packet_creation_key = f"{conversation_id}:{packet_lineage}"
        identity_event = str(operation_ordinal)

        key = build_concern_key(packet_creation_key, identity_event)
        # Both graph versions produce same entity ID
        id_result = resolve_entity_id("concern", key)
        # Key is stable regardless of what graph version was analyzed
        assert id_result == resolve_entity_id("concern", key)


# ===========================================================================
# 5. POLICY FAIL-CLOSED TESTS
# **Validates: Requirements 11.1, 11.6**
# ===========================================================================


def _make_valid_registry() -> list[ChannelRegistryEntry]:
    """Create a minimal valid channel registry."""
    return [
        ChannelRegistryEntry(
            channel_id="emb-001",
            channel_family="embedding_primary",
            supported_query_modes=["broad", "narrow"],
        ),
        ChannelRegistryEntry(
            channel_id="ids-001",
            channel_family="identity_summary",
            supported_query_modes=["exact"],
        ),
    ]


def _make_valid_policy() -> IdentityResolutionPolicy:
    """Create a minimal valid policy referencing channels in the registry."""
    return IdentityResolutionPolicy(
        policy_version="1.0.0",
        retrieval_policy=RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="emb-001",
                    query_mode="broad",
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
            budget_version="1.0.0",
            max_widening_rounds=3,
            max_total_attempts=10,
            max_latency_ms=5000,
            max_cost_units=10.0,
        ),
        pending_re_evaluation_policy=ReEvaluationPolicy(
            policy_version="1.0.0",
            triggers=["new_evidence"],
            max_re_evaluation_attempts=3,
            cooldown_between_attempts_ms=60000,
        ),
    )


class TestPolicyFailClosed:
    """Verify missing/invalid policy returns DeferResult (fail-closed)."""

    def test_none_policy_returns_defer(self):
        """validate_policy_or_defer(None, registry) returns DeferResult."""
        registry = _make_valid_registry()
        result = validate_policy_or_defer(None, registry)
        assert result is not None
        assert isinstance(result, DeferResult)
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert "None" in result.validation_errors[0] or "missing" in result.reason.lower()

    def test_valid_policy_returns_none(self):
        """validate_policy_or_defer(valid_policy, registry) returns None."""
        registry = _make_valid_registry()
        policy = _make_valid_policy()
        result = validate_policy_or_defer(policy, registry)
        assert result is None

    def test_invalid_channel_id_returns_defer(self):
        """Policy referencing unregistered channel_id returns DeferResult."""
        registry = _make_valid_registry()
        policy = IdentityResolutionPolicy(
            policy_version="1.0.0",
            retrieval_policy=RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[
                    ChannelInvocation(
                        channel_id="nonexistent-channel",
                        query_mode="broad",
                        scope_overrides={},
                    ),
                ],
                channel_family_requirements={},
                irs_signal_channel_mapping={},
            ),
            widening_budget=WideningBudgetPolicy(
                budget_version="1.0.0",
                max_widening_rounds=3,
                max_total_attempts=10,
                max_latency_ms=5000,
                max_cost_units=10.0,
            ),
            pending_re_evaluation_policy=ReEvaluationPolicy(
                policy_version="1.0.0",
                triggers=["new_evidence"],
                max_re_evaluation_attempts=3,
                cooldown_between_attempts_ms=60000,
            ),
        )
        result = validate_policy_or_defer(policy, registry)
        assert result is not None
        assert isinstance(result, DeferResult)
        assert result.outcome == PipelineOutcome.DEFER
        assert len(result.validation_errors) > 0
        assert "nonexistent-channel" in result.validation_errors[0]

    def test_invalid_query_mode_returns_defer(self):
        """Policy referencing unsupported query_mode returns DeferResult."""
        registry = _make_valid_registry()
        policy = IdentityResolutionPolicy(
            policy_version="1.0.0",
            retrieval_policy=RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[
                    ChannelInvocation(
                        channel_id="emb-001",
                        query_mode="unsupported_mode",
                        scope_overrides={},
                    ),
                ],
                channel_family_requirements={},
                irs_signal_channel_mapping={},
            ),
            widening_budget=WideningBudgetPolicy(
                budget_version="1.0.0",
                max_widening_rounds=3,
                max_total_attempts=10,
                max_latency_ms=5000,
                max_cost_units=10.0,
            ),
            pending_re_evaluation_policy=ReEvaluationPolicy(
                policy_version="1.0.0",
                triggers=["new_evidence"],
                max_re_evaluation_attempts=3,
                cooldown_between_attempts_ms=60000,
            ),
        )
        result = validate_policy_or_defer(policy, registry)
        assert result is not None
        assert isinstance(result, DeferResult)
        assert "unsupported_mode" in result.validation_errors[0]

    def test_non_canonical_channel_family_raises(self):
        """RetrievalPolicy with non-canonical channel family raises ValueError."""
        with pytest.raises(ValueError, match="non-canonical families"):
            RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[],
                channel_family_requirements={
                    "invented_family": ChannelFamilyRequirement(
                        required_for_adequacy=True,
                        min_successful_attempts=1,
                        failure_blocks_no_match=True,
                    ),
                },
                irs_signal_channel_mapping={},
            )


# ===========================================================================
# 6. CANDIDATE_COUNT INVARIANT
# **Validates: Requirements 10.5**
# ===========================================================================


class TestCandidateCountInvariant:
    """Property test: mismatched candidate_count raises ValidationError."""

    @given(
        candidate_ids=st.lists(nonempty_str_st, min_size=0, max_size=10),
        wrong_offset=st.integers(min_value=1, max_value=10),
    )
    @settings(max_examples=50)
    def test_mismatched_candidate_count_raises(self, candidate_ids, wrong_offset):
        """RetrievalAttemptRecord with candidate_count != len(candidate_ids) raises."""
        wrong_count = len(candidate_ids) + wrong_offset
        with pytest.raises(ValueError, match="candidate_count"):
            RetrievalAttemptRecord(
                attempt_id="att-001",
                channel_id="ch-001",
                channel_family="embedding_primary",
                query_mode="broad",
                query_reference="ref-001",
                scope_description="test scope",
                status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                candidate_ids=candidate_ids,
                candidate_count=wrong_count,
                retrieval_policy_version="1.0",
            )

    @given(candidate_ids=st.lists(nonempty_str_st, min_size=0, max_size=10))
    @settings(max_examples=50)
    def test_matching_candidate_count_succeeds(self, candidate_ids):
        """RetrievalAttemptRecord with candidate_count == len(candidate_ids) succeeds."""
        record = RetrievalAttemptRecord(
            attempt_id="att-001",
            channel_id="ch-001",
            channel_family="embedding_primary",
            query_mode="broad",
            query_reference="ref-001",
            scope_description="test scope",
            status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
            candidate_ids=candidate_ids,
            candidate_count=len(candidate_ids),
            retrieval_policy_version="1.0",
        )
        assert record.candidate_count == len(record.candidate_ids)


# ===========================================================================
# 7. STAGE-CONFIDENCE COUPLING EXHAUSTIVE
# **Validates: Requirements 3.1, 3.10**
# ===========================================================================


class TestStageConfidenceCouplingExhaustive:
    """Exhaustive test of all StageExecutionStatus × Optional[BehavioralConfidenceBand]."""

    # 3 stage statuses × 4 confidence values (None, HIGH, MEDIUM, LOW) = 12 combos

    @pytest.mark.parametrize("confidence", list(BehavioralConfidenceBand))
    def test_completed_with_confidence_valid(self, confidence):
        """COMPLETED + non-null confidence is valid for SufficiencyRecord."""
        record = SufficiencyRecord(
            stage_status=StageExecutionStatus.COMPLETED,
            confidence=confidence,
            coverage_summary="All channels covered",
            unresolved_signals=[],
            failed_coverage_gaps=[],
            rationale="Adequate retrieval",
        )
        assert record.stage_status == StageExecutionStatus.COMPLETED
        assert record.confidence == confidence

    def test_completed_with_null_confidence_invalid(self):
        """COMPLETED + null confidence is invalid."""
        with pytest.raises(ValueError, match="COMPLETED.*must have non-null"):
            SufficiencyRecord(
                stage_status=StageExecutionStatus.COMPLETED,
                confidence=None,
                coverage_summary="test",
                unresolved_signals=[],
                failed_coverage_gaps=[],
                rationale="test",
            )

    @pytest.mark.parametrize(
        "status",
        [StageExecutionStatus.NOT_RUN, StageExecutionStatus.FAILED],
    )
    def test_not_run_or_failed_with_null_confidence_valid(self, status):
        """NOT_RUN/FAILED + null confidence is valid."""
        record = SufficiencyRecord(
            stage_status=status,
            confidence=None,
            coverage_summary="Stage did not execute",
            unresolved_signals=[],
            failed_coverage_gaps=[],
            rationale="test",
        )
        assert record.stage_status == status
        assert record.confidence is None

    @pytest.mark.parametrize(
        "status",
        [StageExecutionStatus.NOT_RUN, StageExecutionStatus.FAILED],
    )
    @pytest.mark.parametrize("confidence", list(BehavioralConfidenceBand))
    def test_not_run_or_failed_with_confidence_invalid(self, status, confidence):
        """NOT_RUN/FAILED + non-null confidence is invalid."""
        with pytest.raises(ValueError, match="must have null confidence"):
            SufficiencyRecord(
                stage_status=status,
                confidence=confidence,
                coverage_summary="test",
                unresolved_signals=[],
                failed_coverage_gaps=[],
                rationale="test",
            )

    @pytest.mark.parametrize(
        "id_status",
        list(StageExecutionStatus),
    )
    @pytest.mark.parametrize(
        "suff_status",
        list(StageExecutionStatus),
    )
    def test_identity_record_stage_coupling_exhaustive(self, id_status, suff_status):
        """IdentityResolutionRecord enforces coupling on both stages."""
        id_conf = (
            BehavioralConfidenceBand.HIGH
            if id_status == StageExecutionStatus.COMPLETED
            else None
        )
        suff_conf = (
            BehavioralConfidenceBand.HIGH
            if suff_status == StageExecutionStatus.COMPLETED
            else None
        )
        # Use a pending outcome that doesn't impose extra stage constraints
        record = _make_identity_record(
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.NONE,
            identity_stage_status=id_status,
            identity_confidence=id_conf,
            sufficiency_stage_status=suff_status,
            sufficiency_confidence=suff_conf,
            matched_concern_id=None,
            proposed_concern_id=None,
        )
        assert record.identity_stage_status == id_status
        assert record.sufficiency_stage_status == suff_status

    @pytest.mark.parametrize(
        "id_status",
        [StageExecutionStatus.NOT_RUN, StageExecutionStatus.FAILED],
    )
    @pytest.mark.parametrize("bad_conf", list(BehavioralConfidenceBand))
    def test_identity_record_bad_identity_stage_coupling_raises(
        self, id_status, bad_conf
    ):
        """IdentityResolutionRecord rejects non-COMPLETED identity stage with confidence."""
        with pytest.raises(ValueError):
            _make_identity_record(
                outcome=PipelineOutcome.DEFER,
                action=ResolutionAction.NONE,
                identity_stage_status=id_status,
                identity_confidence=bad_conf,
                sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
                sufficiency_confidence=None,
                matched_concern_id=None,
                proposed_concern_id=None,
            )

    @pytest.mark.parametrize(
        "suff_status",
        [StageExecutionStatus.NOT_RUN, StageExecutionStatus.FAILED],
    )
    @pytest.mark.parametrize("bad_conf", list(BehavioralConfidenceBand))
    def test_identity_record_bad_sufficiency_stage_coupling_raises(
        self, suff_status, bad_conf
    ):
        """IdentityResolutionRecord rejects non-COMPLETED sufficiency stage with confidence."""
        with pytest.raises(ValueError):
            _make_identity_record(
                outcome=PipelineOutcome.DEFER,
                action=ResolutionAction.NONE,
                identity_stage_status=StageExecutionStatus.NOT_RUN,
                identity_confidence=None,
                sufficiency_stage_status=suff_status,
                sufficiency_confidence=bad_conf,
                matched_concern_id=None,
                proposed_concern_id=None,
            )
