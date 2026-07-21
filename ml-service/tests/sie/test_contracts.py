"""Tests for SIE request/response contract models.

Validates:
- ProcessRequest/ProcessResult construction and serialization
- Graph version consistency validation (graph_version != base_graph_version raises)
- PendingDecisionSummary inclusion in GraphStateContext
- All contract models survive JSON roundtrip
- SemanticDependencyGroupRef failure_policy validation
"""

import json

import pytest
from pydantic import ValidationError

from app.sie.contracts import (
    AssociationSummary,
    ConcernSummary,
    GraphStateContext,
    PendingDecisionSummary,
    PipelineDiagnostics,
    ProcessRequest,
    ProcessResult,
    PropositionSummary,
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
    RetentionLevel,
    SemanticState,
)


# --- Fixtures / Helpers ---


def _make_graph_state(graph_version: int = 5) -> GraphStateContext:
    """Create a minimal valid GraphStateContext."""
    return GraphStateContext(
        graph_version=graph_version,
        snapshot_token=f"snap-token-v{graph_version}",
        snapshot_digest=f"sha256-digest-v{graph_version}",
        concerns=[
            ConcernSummary(
                concern_id="concern-1",
                identity_summary="User's career goals",
                display_title="Career Goals",
                current_summary="Exploring career options in tech",
                status=ConcernStatus.ACTIVE,
                aliases=["job search", "career"],
                canonical_parent_id=None,
                parent_resolution_state=ParentResolutionState.ROOT_CONFIRMED,
                last_active_at="2024-01-15T10:00:00Z",
                semantic_version=3,
            )
        ],
        propositions=[
            PropositionSummary(
                proposition_id="prop-1",
                canonical_meaning="User wants to switch to AI engineering",
                proposition_type=PropositionType.GOAL,
                speaker_role="USER",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(1, 3),
            )
        ],
        active_associations=[
            AssociationSummary(
                association_id="assoc-1",
                proposition_id="prop-1",
                concern_id="concern-1",
                role=AssociationRole.PRIMARY_OWNER,
                semantic_state=SemanticState.ACTIVE,
            )
        ],
        pending_decisions=[],
    )


def _make_sie_message(seq: int = 1) -> dict:
    """Create a minimal SIEMessage dict."""
    return {
        "message_id": f"msg-{seq}",
        "conversation_id": "conv-123",
        "role": "USER",
        "content": f"Test message {seq}",
        "sequence_position": seq,
        "created_at": "2024-01-15T10:00:00Z",
    }


def _make_process_request(
    base_graph_version: int = 5,
    graph_state_version: int = 5,
) -> ProcessRequest:
    """Create a minimal valid ProcessRequest."""
    return ProcessRequest(
        api_contract_version="1.0.0",
        pipeline_version="0.1.0",
        model_version="gpt-4-turbo-2024-04",
        extraction_version="ext-v1",
        request_id="req-abc-123",
        idempotency_key="idem-conv123-seq1-3-v1",
        conversation_id="conv-123",
        base_graph_version=base_graph_version,
        message_seq_start=1,
        message_seq_end=3,
        messages=[_make_sie_message(1), _make_sie_message(2)],
        context_window=[],
        current_graph_state=_make_graph_state(graph_state_version),
        semantic_policy_version="1.0.0",
        retrieval_policy_version="1.0.0",
    )


def _make_process_result() -> ProcessResult:
    """Create a minimal valid ProcessResult."""
    return ProcessResult(
        api_contract_version="1.0.0",
        pipeline_version="0.1.0",
        model_version="gpt-4-turbo-2024-04",
        extraction_version="ext-v1",
        request_id="req-abc-123",
        idempotency_key="idem-conv123-seq1-3-v1",
        conversation_id="conv-123",
        base_graph_version=5,
        lowest_seq=1,
        highest_seq=3,
        retention_decisions=[],
        propositions=[],
        packets=[],
        packet_memberships=[],
        splits=[],
        identity_resolutions=[],
        new_concern_proposals=[],
        proposed_associations=[],
        dependency_groups=[],
        diagnostics=PipelineDiagnostics(
            stage_versions={"retention": "v1", "extraction": "v1"},
            warnings=[],
            deferred_entity_ids=[],
        ),
    )


# --- ProcessRequest Construction and Serialization ---


class TestProcessRequestConstruction:
    """Test that ProcessRequest can be constructed with valid inputs."""

    def test_valid_construction(self):
        req = _make_process_request()
        assert req.api_contract_version == "1.0.0"
        assert req.pipeline_version == "0.1.0"
        assert req.model_version == "gpt-4-turbo-2024-04"
        assert req.extraction_version == "ext-v1"
        assert req.request_id == "req-abc-123"
        assert req.idempotency_key == "idem-conv123-seq1-3-v1"
        assert req.conversation_id == "conv-123"
        assert req.base_graph_version == 5
        assert req.message_seq_start == 1
        assert req.message_seq_end == 3
        assert len(req.messages) == 2
        assert req.context_window == []
        assert req.current_graph_state.graph_version == 5

    def test_required_version_fields(self):
        """All version fields are required and cannot be omitted."""
        with pytest.raises(ValidationError):
            ProcessRequest(
                # missing api_contract_version
                pipeline_version="0.1.0",
                model_version="gpt-4-turbo",
                extraction_version="ext-v1",
                request_id="req-1",
                idempotency_key="idem-1",
                conversation_id="conv-1",
                base_graph_version=1,
                message_seq_start=1,
                message_seq_end=1,
                messages=[_make_sie_message(1)],
                current_graph_state=_make_graph_state(1),
            )

    def test_context_window_defaults_empty(self):
        req = _make_process_request()
        assert req.context_window == []

    def test_serialization_roundtrip(self):
        req = _make_process_request()
        json_str = req.model_dump_json()
        restored = ProcessRequest.model_validate_json(json_str)
        assert restored == req


# --- Graph Version Consistency Validation ---


class TestGraphVersionConsistency:
    """Test the model_validator enforcing graph_version == base_graph_version."""

    def test_matching_versions_accepted(self):
        """When graph_version == base_graph_version, no error."""
        req = _make_process_request(base_graph_version=7, graph_state_version=7)
        assert req.base_graph_version == 7
        assert req.current_graph_state.graph_version == 7

    def test_mismatched_versions_raises(self):
        """When graph_version != base_graph_version, ValidationError is raised."""
        with pytest.raises(ValidationError) as exc_info:
            _make_process_request(base_graph_version=5, graph_state_version=3)

        error_str = str(exc_info.value)
        assert "graph_version" in error_str.lower() or "base_graph_version" in error_str.lower()

    def test_graph_version_ahead_raises(self):
        """Graph version ahead of base_graph_version also raises."""
        with pytest.raises(ValidationError):
            _make_process_request(base_graph_version=5, graph_state_version=8)

    def test_version_zero_valid(self):
        """Version 0 is valid (empty graph initial state)."""
        req = _make_process_request(base_graph_version=0, graph_state_version=0)
        assert req.base_graph_version == 0


# --- PendingDecisionSummary in GraphStateContext ---


class TestPendingDecisions:
    """Test that pending decisions are correctly included in GraphStateContext."""

    def test_pending_decisions_default_empty(self):
        state = GraphStateContext(
            graph_version=1,
            snapshot_token="snap-token-v1",
            snapshot_digest="sha256-digest-v1",
            concerns=[],
            propositions=[],
            active_associations=[],
        )
        assert state.pending_decisions == []

    def test_pending_decisions_included(self):
        decisions = [
            PendingDecisionSummary(
                entity_id="entity-abc",
                stage="identity_resolution",
                outcome=PipelineOutcome.UNRESOLVED,
                rationale="No confident match found",
            ),
            PendingDecisionSummary(
                entity_id="entity-def",
                stage="cohesion_analysis",
                outcome=PipelineOutcome.DEFER,
                rationale=None,
            ),
        ]
        state = GraphStateContext(
            graph_version=3,
            snapshot_token="snap-token-v3",
            snapshot_digest="sha256-digest-v3",
            concerns=[],
            propositions=[],
            active_associations=[],
            pending_decisions=decisions,
        )
        assert len(state.pending_decisions) == 2
        assert state.pending_decisions[0].entity_id == "entity-abc"
        assert state.pending_decisions[0].outcome == PipelineOutcome.UNRESOLVED
        assert state.pending_decisions[1].outcome == PipelineOutcome.DEFER
        assert state.pending_decisions[1].rationale is None

    def test_pending_decisions_in_process_request(self):
        """Pending decisions are surfaced through ProcessRequest graph state."""
        graph_state = GraphStateContext(
            graph_version=5,
            snapshot_token="snap-token-v5",
            snapshot_digest="sha256-digest-v5",
            concerns=[],
            propositions=[],
            active_associations=[],
            pending_decisions=[
                PendingDecisionSummary(
                    entity_id="entity-xyz",
                    stage="retention",
                    outcome=PipelineOutcome.REQUIRES_VALIDATION,
                )
            ],
        )
        req = ProcessRequest(
            api_contract_version="1.0.0",
            pipeline_version="0.1.0",
            model_version="gpt-4-turbo",
            extraction_version="ext-v1",
            request_id="req-1",
            idempotency_key="idem-1",
            conversation_id="conv-1",
            base_graph_version=5,
            message_seq_start=1,
            message_seq_end=1,
            messages=[_make_sie_message(1)],
            current_graph_state=graph_state,
            semantic_policy_version="1.0.0",
            retrieval_policy_version="1.0.0",
        )
        assert len(req.current_graph_state.pending_decisions) == 1
        assert req.current_graph_state.pending_decisions[0].entity_id == "entity-xyz"

    def test_pending_decision_all_outcomes(self):
        """PendingDecisionSummary supports all PipelineOutcome values."""
        for outcome in PipelineOutcome:
            decision = PendingDecisionSummary(
                entity_id="test-entity",
                stage="test_stage",
                outcome=outcome,
            )
            assert decision.outcome == outcome


# --- JSON Roundtrip for All Contract Models ---


class TestJsonRoundtrip:
    """Test that all contract models survive JSON serialization and deserialization."""

    def test_concern_summary_roundtrip(self):
        obj = ConcernSummary(
            concern_id="c-1",
            identity_summary="Test concern identity",
            display_title="Test Concern",
            current_summary="Currently testing",
            status=ConcernStatus.DORMANT,
            aliases=["test", "testing"],
            canonical_parent_id="c-parent",
            parent_resolution_state=ParentResolutionState.PARENT_ASSIGNED,
            last_active_at="2024-01-10T08:00:00Z",
            semantic_version=5,
        )
        restored = ConcernSummary.model_validate_json(obj.model_dump_json())
        assert restored == obj

    def test_proposition_summary_roundtrip(self):
        obj = PropositionSummary(
            proposition_id="p-1",
            canonical_meaning="I want to learn Rust",
            proposition_type=PropositionType.GOAL,
            speaker_role="USER",
            semantic_state=SemanticState.ACTIVE,
            message_seq_range=(2, 4),
        )
        restored = PropositionSummary.model_validate_json(obj.model_dump_json())
        assert restored == obj

    def test_association_summary_roundtrip(self):
        obj = AssociationSummary(
            association_id="a-1",
            proposition_id="p-1",
            concern_id="c-1",
            role=AssociationRole.SUPPORTING_EVIDENCE,
            semantic_state=SemanticState.ACTIVE,
        )
        restored = AssociationSummary.model_validate_json(obj.model_dump_json())
        assert restored == obj

    def test_pending_decision_summary_roundtrip(self):
        obj = PendingDecisionSummary(
            entity_id="e-1",
            stage="identity_resolution",
            outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            rationale="Embeddings too similar between candidates",
        )
        restored = PendingDecisionSummary.model_validate_json(obj.model_dump_json())
        assert restored == obj

    def test_graph_state_context_roundtrip(self):
        state = _make_graph_state()
        restored = GraphStateContext.model_validate_json(state.model_dump_json())
        assert restored == state

    def test_pipeline_diagnostics_roundtrip(self):
        obj = PipelineDiagnostics(
            stage_versions={"retention": "v2", "extraction": "v3", "cohesion": "v1"},
            warnings=["Low confidence on 2 propositions"],
            deferred_entity_ids=["entity-a", "entity-b"],
        )
        restored = PipelineDiagnostics.model_validate_json(obj.model_dump_json())
        assert restored == obj

    def test_semantic_dependency_group_ref_roundtrip(self):
        obj = SemanticDependencyGroupRef(
            group_id="grp-1",
            mutation_refs=["mut-1", "mut-2", "mut-3"],
            failure_policy="ALL_OR_NONE",
        )
        restored = SemanticDependencyGroupRef.model_validate_json(obj.model_dump_json())
        assert restored == obj

    def test_process_request_roundtrip(self):
        req = _make_process_request()
        restored = ProcessRequest.model_validate_json(req.model_dump_json())
        assert restored == req

    def test_process_result_roundtrip(self):
        result = _make_process_result()
        restored = ProcessResult.model_validate_json(result.model_dump_json())
        assert restored == result

    def test_process_request_json_dict_roundtrip(self):
        """Verify roundtrip through dict serialization (model_dump/model_validate)."""
        req = _make_process_request()
        data = req.model_dump()
        restored = ProcessRequest.model_validate(data)
        assert restored == req

    def test_process_result_json_dict_roundtrip(self):
        """Verify roundtrip through dict serialization (model_dump/model_validate)."""
        result = _make_process_result()
        data = result.model_dump()
        restored = ProcessResult.model_validate(data)
        assert restored == result


# --- SemanticDependencyGroupRef Validation ---


class TestSemanticDependencyGroupRef:
    """Test failure_policy validation on SemanticDependencyGroupRef."""

    def test_valid_all_or_none(self):
        obj = SemanticDependencyGroupRef(
            group_id="g-1", mutation_refs=["m-1"], failure_policy="ALL_OR_NONE"
        )
        assert obj.failure_policy == "ALL_OR_NONE"

    def test_valid_independent(self):
        obj = SemanticDependencyGroupRef(
            group_id="g-1", mutation_refs=["m-1"], failure_policy="INDEPENDENT"
        )
        assert obj.failure_policy == "INDEPENDENT"

    def test_valid_derived(self):
        obj = SemanticDependencyGroupRef(
            group_id="g-1", mutation_refs=["m-1"], failure_policy="DERIVED"
        )
        assert obj.failure_policy == "DERIVED"

    def test_invalid_failure_policy_raises(self):
        with pytest.raises(ValidationError) as exc_info:
            SemanticDependencyGroupRef(
                group_id="g-1", mutation_refs=["m-1"], failure_policy="INVALID"
            )
        assert "failure_policy" in str(exc_info.value)

    def test_empty_failure_policy_raises(self):
        with pytest.raises(ValidationError):
            SemanticDependencyGroupRef(
                group_id="g-1", mutation_refs=["m-1"], failure_policy=""
            )

    def test_case_sensitive_failure_policy(self):
        """failure_policy is case-sensitive; lowercase is invalid."""
        with pytest.raises(ValidationError):
            SemanticDependencyGroupRef(
                group_id="g-1", mutation_refs=["m-1"], failure_policy="all_or_none"
            )


# --- ProcessResult Construction ---


class TestProcessResultConstruction:
    """Test ProcessResult construction with various content."""

    def test_empty_result_valid(self):
        result = _make_process_result()
        assert result.lowest_seq == 1
        assert result.highest_seq == 3
        assert result.retention_decisions == []
        assert result.propositions == []
        assert result.packets == []
        assert result.dependency_groups == []

    def test_dependency_groups_default_empty(self):
        result = _make_process_result()
        assert result.dependency_groups == []

    def test_diagnostics_required(self):
        """ProcessResult requires diagnostics field."""
        with pytest.raises(ValidationError):
            ProcessResult(
                api_contract_version="1.0.0",
                pipeline_version="0.1.0",
                model_version="gpt-4-turbo",
                extraction_version="ext-v1",
                request_id="req-1",
                idempotency_key="idem-1",
                conversation_id="conv-1",
                base_graph_version=5,
                lowest_seq=1,
                highest_seq=3,
                retention_decisions=[],
                propositions=[],
                packets=[],
                packet_memberships=[],
                splits=[],
                identity_resolutions=[],
                new_concern_proposals=[],
                proposed_associations=[],
                # diagnostics omitted
            )
