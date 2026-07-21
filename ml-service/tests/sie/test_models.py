"""Tests for SIE core Pydantic models.

Validates model creation, serialization, and validation invariants for:
- RetentionDecision
- SIEMessage
- Proposition
- ProvisionalConcernBoundary
- SemanticPacket
- IdentityResolutionResult (discriminated-result invariant)
- ConcernProposal
- PersistentConcern (lifecycle + parent-resolution invariants)
- PendingSemanticDecision (lifecycle_state validation)
"""

import pytest
from pydantic import ValidationError

from app.sie.enums import (
    BehavioralConfidenceBand,
    CohesionStatus,
    ConcernStatus,
    ParentResolutionState,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    ResolutionAction,
    RetentionLevel,
    SemanticState,
    StageExecutionStatus,
)
from app.sie.models import (
    ConcernProposal,
    IdentityResolutionResult,
    PendingSemanticDecision,
    PersistentConcern,
    Proposition,
    ProvisionalConcernBoundary,
    RetentionDecision,
    SemanticPacket,
    SIEMessage,
)


# ---------------------------------------------------------------------------
# RetentionDecision
# ---------------------------------------------------------------------------


class TestRetentionDecision:
    def test_basic_creation(self):
        rd = RetentionDecision(
            decision_id="rd-1",
            decision_creation_key="req-1:msg-1:0",
            conversation_id="conv-1",
            primary_level=RetentionLevel.DURABLE_PROPOSITION,
            secondary_roles=[RetentionLevel.EMERGENCE_EVIDENCE],
            confidence=BehavioralConfidenceBand.HIGH,
            outcome=PipelineOutcome.YES,
            source_message_ids=["msg-1"],
            speaker_role="USER",
            sequence_position=0,
            extraction_version="1.0.0",
            assessment_version="1.0.0",
        )
        assert rd.primary_level == RetentionLevel.DURABLE_PROPOSITION
        assert rd.secondary_roles == [RetentionLevel.EMERGENCE_EVIDENCE]
        assert rd.rationale is None

    def test_serialization_roundtrip(self):
        rd = RetentionDecision(
            decision_id="rd-2",
            decision_creation_key="req-1:msg-2:1",
            conversation_id="conv-1",
            primary_level=RetentionLevel.SUPPORTING_EVIDENCE,
            secondary_roles=[
                RetentionLevel.CONTEXT_ONLY,
                RetentionLevel.EMERGENCE_EVIDENCE,
            ],
            confidence=BehavioralConfidenceBand.MEDIUM,
            outcome=PipelineOutcome.YES,
            source_message_ids=["msg-2", "msg-3"],
            speaker_role="ASSISTANT",
            sequence_position=1,
            extraction_version="1.0.0",
            assessment_version="1.0.0",
            rationale="Contains supporting evidence for concern X",
        )
        data = rd.model_dump()
        restored = RetentionDecision(**data)
        assert restored == rd
        assert restored.secondary_roles == [
            RetentionLevel.CONTEXT_ONLY,
            RetentionLevel.EMERGENCE_EVIDENCE,
        ]

    def test_empty_secondary_roles_default(self):
        rd = RetentionDecision(
            decision_id="rd-3",
            decision_creation_key="req-1:msg-3:0",
            conversation_id="conv-1",
            primary_level=RetentionLevel.DISCARD,
            confidence=BehavioralConfidenceBand.HIGH,
            outcome=PipelineOutcome.NO,
            source_message_ids=["msg-3"],
            speaker_role="USER",
            sequence_position=2,
            extraction_version="1.0.0",
            assessment_version="1.0.0",
        )
        assert rd.secondary_roles == []


# ---------------------------------------------------------------------------
# SIEMessage
# ---------------------------------------------------------------------------


class TestSIEMessage:
    def test_basic_creation(self):
        msg = SIEMessage(
            message_id="msg-1",
            conversation_id="conv-1",
            role="USER",
            content="Hello world",
            sequence_position=0,
            created_at="2024-01-01T00:00:00Z",
        )
        assert msg.attachment_refs == []
        assert msg.structured_content is None

    def test_with_attachments_and_structured_content(self):
        msg = SIEMessage(
            message_id="msg-2",
            conversation_id="conv-1",
            role="ASSISTANT",
            content="Here's the code",
            sequence_position=1,
            created_at="2024-01-01T00:01:00Z",
            attachment_refs=["file-1", "file-2"],
            structured_content={"code_blocks": [{"lang": "python", "content": "x=1"}]},
        )
        assert msg.attachment_refs == ["file-1", "file-2"]
        assert msg.structured_content["code_blocks"][0]["lang"] == "python"

    def test_serialization_roundtrip(self):
        msg = SIEMessage(
            message_id="msg-3",
            conversation_id="conv-1",
            role="USER",
            content="Test",
            sequence_position=2,
            created_at="2024-01-01T00:02:00Z",
            attachment_refs=["a"],
            structured_content={"key": "value"},
        )
        restored = SIEMessage(**msg.model_dump())
        assert restored == msg


# ---------------------------------------------------------------------------
# Proposition
# ---------------------------------------------------------------------------


class TestProposition:
    def test_basic_creation_with_all_retention_levels(self):
        prop = Proposition(
            proposition_id="prop-1",
            proposition_creation_key="req-1:0",
            conversation_id="conv-1",
            source_message_ids=["msg-1"],
            speaker_role="USER",
            canonical_meaning="I want to learn Python",
            proposition_type=PropositionType.GOAL,
            message_seq_range=(0, 0),
            provenance=PropositionProvenance.DIRECT,
            retention_levels=[
                RetentionLevel.DURABLE_PROPOSITION,
                RetentionLevel.EMERGENCE_EVIDENCE,
            ],
            created_at="2024-01-01T00:00:00Z",
            extraction_version="1.0.0",
        )
        assert prop.semantic_state == SemanticState.ACTIVE
        assert len(prop.retention_levels) == 2
        assert RetentionLevel.DURABLE_PROPOSITION in prop.retention_levels
        assert RetentionLevel.EMERGENCE_EVIDENCE in prop.retention_levels

    def test_supersedes_another_proposition(self):
        prop = Proposition(
            proposition_id="prop-2",
            proposition_creation_key="req-1:1",
            conversation_id="conv-1",
            source_message_ids=["msg-2"],
            speaker_role="USER",
            canonical_meaning="Actually I want to learn Rust instead",
            proposition_type=PropositionType.CORRECTION,
            message_seq_range=(1, 1),
            provenance=PropositionProvenance.DIRECT,
            retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            created_at="2024-01-01T00:01:00Z",
            extraction_version="1.0.0",
            supersedes_proposition_id="prop-1",
        )
        assert prop.supersedes_proposition_id == "prop-1"

    def test_serialization_preserves_retention_levels(self):
        levels = [
            RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE,
            RetentionLevel.SUPPORTING_EVIDENCE,
            RetentionLevel.EMERGENCE_EVIDENCE,
        ]
        prop = Proposition(
            proposition_id="prop-3",
            proposition_creation_key="req-1:2",
            conversation_id="conv-1",
            source_message_ids=["msg-1", "msg-2"],
            speaker_role="USER",
            canonical_meaning="Complex meaning",
            proposition_type=PropositionType.CLAIM,
            message_seq_range=(0, 1),
            provenance=PropositionProvenance.INTERPRETATION,
            retention_levels=levels,
            created_at="2024-01-01T00:00:00Z",
            extraction_version="1.0.0",
        )
        data = prop.model_dump()
        restored = Proposition(**data)
        assert restored.retention_levels == levels


# ---------------------------------------------------------------------------
# ProvisionalConcernBoundary
# ---------------------------------------------------------------------------


class TestProvisionalConcernBoundary:
    def test_basic_creation(self):
        boundary = ProvisionalConcernBoundary(
            boundary_id="b-1",
            proposition_ids=["prop-1", "prop-2"],
            provisional_concern_label="User's career goals",
            confidence=BehavioralConfidenceBand.HIGH,
        )
        assert boundary.rationale is None
        assert boundary.provisional_concern_label == "User's career goals"

    def test_label_is_descriptive_not_concern_id(self):
        """Provisional label is descriptive text, not a concern ID."""
        boundary = ProvisionalConcernBoundary(
            boundary_id="b-2",
            proposition_ids=["prop-3"],
            provisional_concern_label="Discussion about laptop requirements",
            confidence=BehavioralConfidenceBand.MEDIUM,
            rationale="Props seem related to device needs",
        )
        # Label should be descriptive, not look like an ID
        assert not boundary.provisional_concern_label.startswith("concern-")


# ---------------------------------------------------------------------------
# SemanticPacket
# ---------------------------------------------------------------------------


class TestSemanticPacket:
    def test_cohesive_packet(self):
        packet = SemanticPacket(
            packet_id="pkt-1",
            packet_creation_key="req-1:partition-0",
            conversation_id="conv-1",
            source_message_ids=["msg-1", "msg-2"],
            message_seq_range=(0, 1),
            user_grounded_meaning="User wants to learn Python",
            provenance="extraction",
            packet_formation_version="1.0.0",
            cohesion_status=CohesionStatus.COHESIVE,
        )
        assert packet.assistant_context is None
        assert packet.continuation_origin is None
        assert packet.provisional_boundaries == []

    def test_mixed_packet_with_boundaries(self):
        boundaries = [
            ProvisionalConcernBoundary(
                boundary_id="b-1",
                proposition_ids=["prop-1"],
                provisional_concern_label="Career goals",
                confidence=BehavioralConfidenceBand.HIGH,
            ),
            ProvisionalConcernBoundary(
                boundary_id="b-2",
                proposition_ids=["prop-2"],
                provisional_concern_label="Device requirements",
                confidence=BehavioralConfidenceBand.MEDIUM,
            ),
        ]
        packet = SemanticPacket(
            packet_id="pkt-2",
            packet_creation_key="req-1:partition-1",
            conversation_id="conv-1",
            source_message_ids=["msg-3"],
            message_seq_range=(2, 2),
            user_grounded_meaning="Multiple topics",
            assistant_context="Previous context about jobs",
            provenance="extraction",
            packet_formation_version="1.0.0",
            cohesion_status=CohesionStatus.MIXED,
            provisional_boundaries=boundaries,
        )
        assert len(packet.provisional_boundaries) == 2

    def test_unresolved_cohesion(self):
        packet = SemanticPacket(
            packet_id="pkt-3",
            packet_creation_key="req-1:partition-2",
            conversation_id="conv-1",
            source_message_ids=["msg-4"],
            message_seq_range=(3, 3),
            user_grounded_meaning="Ambiguous grouping",
            provenance="extraction",
            packet_formation_version="1.0.0",
            cohesion_status=CohesionStatus.UNRESOLVED_COHESION,
        )
        assert packet.cohesion_status == CohesionStatus.UNRESOLVED_COHESION


# ---------------------------------------------------------------------------
# IdentityResolutionResult — discriminated-result invariant
# ---------------------------------------------------------------------------


class TestIdentityResolutionResult:
    def _make_proposal(self) -> ConcernProposal:
        return ConcernProposal(
            concern_creation_key="pkt-1:ir-event-1",
            proposed_concern_id="concern-new-1",
            identity_summary="User's Python learning journey",
            display_title="Python Learning",
            initial_summary="User wants to learn Python",
        )

    def test_yes_assign_existing_with_matched_concern(self):
        """YES/ASSIGN_EXISTING requires matched_concern_id, completed identity,
        HIGH identity confidence."""
        result = IdentityResolutionResult(
            packet_id="pkt-1",
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            matched_concern_id="concern-existing-1",
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.HIGH,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            rationale="High confidence match",
        )
        assert result.matched_concern_id == "concern-existing-1"
        assert result.new_concern_proposal is None

    def test_no_propose_new_with_proposal(self):
        """NO/PROPOSE_NEW requires new_concern_proposal, completed sufficiency,
        HIGH sufficiency confidence."""
        proposal = self._make_proposal()
        result = IdentityResolutionResult(
            packet_id="pkt-1",
            outcome=PipelineOutcome.NO,
            action=ResolutionAction.PROPOSE_NEW,
            new_concern_proposal=proposal,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.LOW,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            rationale="No existing match; proposing new concern",
        )
        assert result.new_concern_proposal is not None
        assert result.matched_concern_id is None

    def test_yes_with_proposal_raises_error(self):
        """YES/ASSIGN_EXISTING cannot have new_concern_proposal."""
        proposal = self._make_proposal()
        with pytest.raises(ValidationError, match="must not have.*new_concern_proposal"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.YES,
                action=ResolutionAction.ASSIGN_EXISTING,
                matched_concern_id="concern-1",
                new_concern_proposal=proposal,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.HIGH,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Invalid combination",
            )

    def test_yes_without_match_raises_error(self):
        """YES/ASSIGN_EXISTING must have matched_concern_id."""
        with pytest.raises(ValidationError, match="requires matched_concern_id"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.YES,
                action=ResolutionAction.ASSIGN_EXISTING,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.HIGH,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Missing result",
            )

    def test_no_without_proposal_raises_error(self):
        """NO/PROPOSE_NEW must have new_concern_proposal."""
        with pytest.raises(ValidationError, match="requires new_concern_proposal"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.LOW,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Missing proposal",
            )

    def test_unresolved_with_no_results(self):
        """UNRESOLVED/RETAIN_PENDING: both fields must be None."""
        result = IdentityResolutionResult(
            packet_id="pkt-1",
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            candidates_considered=["concern-a", "concern-b"],
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.MEDIUM,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            rationale="Could not determine a match",
        )
        assert result.matched_concern_id is None
        assert result.new_concern_proposal is None

    def test_defer_with_no_results(self):
        """DEFER: both fields must be None."""
        result = IdentityResolutionResult(
            packet_id="pkt-1",
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.NONE,
            identity_stage_status=StageExecutionStatus.NOT_RUN,
            identity_confidence=None,
            sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
            sufficiency_confidence=None,
            rationale="Need more context",
        )
        assert result.matched_concern_id is None
        assert result.new_concern_proposal is None

    def test_unresolved_with_matched_concern_raises_error(self):
        with pytest.raises(ValidationError, match="must not have.*matched_concern_id"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id="concern-1",
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.MEDIUM,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Invalid",
            )

    def test_defer_with_proposal_raises_error(self):
        proposal = self._make_proposal()
        with pytest.raises(ValidationError, match="must not have.*new_concern_proposal"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.DEFER,
                action=ResolutionAction.NONE,
                new_concern_proposal=proposal,
                identity_stage_status=StageExecutionStatus.NOT_RUN,
                identity_confidence=None,
                sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
                sufficiency_confidence=None,
                rationale="Invalid",
            )

    def test_retrieval_inconclusive_with_candidates(self):
        """RETRIEVAL_INCONCLUSIVE: valid with candidates list but no match/proposal."""
        result = IdentityResolutionResult(
            packet_id="pkt-1",
            outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            action=ResolutionAction.RETAIN_PENDING,
            candidates_considered=["concern-x", "concern-y", "concern-z"],
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.LOW,
            sufficiency_stage_status=StageExecutionStatus.FAILED,
            sufficiency_confidence=None,
            rationale="Retrieval channels timed out",
        )
        assert len(result.candidates_considered) == 3
        assert result.matched_concern_id is None
        assert result.new_concern_proposal is None

    def test_requires_validation_with_match_raises_error(self):
        with pytest.raises(ValidationError, match="must not have.*matched_concern_id"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.REQUIRES_VALIDATION,
                action=ResolutionAction.RETAIN_PENDING,
                matched_concern_id="concern-1",
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.MEDIUM,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Invalid",
            )

    def test_yes_requires_completed_identity_stage(self):
        """YES outcome requires identity_stage_status=COMPLETED."""
        with pytest.raises(ValidationError, match="identity_stage_status=COMPLETED"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.YES,
                action=ResolutionAction.ASSIGN_EXISTING,
                matched_concern_id="concern-1",
                identity_stage_status=StageExecutionStatus.NOT_RUN,
                identity_confidence=None,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Stage not run",
            )

    def test_yes_requires_high_identity_confidence(self):
        """YES outcome requires identity_confidence=HIGH."""
        with pytest.raises(ValidationError, match="identity_confidence=HIGH"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.YES,
                action=ResolutionAction.ASSIGN_EXISTING,
                matched_concern_id="concern-1",
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.MEDIUM,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Not high enough",
            )

    def test_no_requires_completed_sufficiency_stage(self):
        """NO outcome requires sufficiency_stage_status=COMPLETED."""
        with pytest.raises(ValidationError, match="sufficiency_stage_status=COMPLETED"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                new_concern_proposal=self._make_proposal(),
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.LOW,
                sufficiency_stage_status=StageExecutionStatus.FAILED,
                sufficiency_confidence=None,
                rationale="Sufficiency failed",
            )

    def test_no_requires_high_sufficiency_confidence(self):
        """NO outcome requires sufficiency_confidence=HIGH."""
        with pytest.raises(ValidationError, match="sufficiency_confidence=HIGH"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.NO,
                action=ResolutionAction.PROPOSE_NEW,
                new_concern_proposal=self._make_proposal(),
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.LOW,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.MEDIUM,
                rationale="Not high enough",
            )

    def test_completed_stage_without_confidence_raises_error(self):
        """COMPLETED stage requires non-null confidence."""
        with pytest.raises(ValidationError, match="COMPLETED but confidence is null"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=None,
                sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
                sufficiency_confidence=None,
                rationale="Missing confidence",
            )

    def test_not_run_stage_with_confidence_raises_error(self):
        """NOT_RUN stage must not have confidence (fabrication prevention)."""
        with pytest.raises(
            ValidationError, match="did not complete.*must not have a fabricated"
        ):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                identity_stage_status=StageExecutionStatus.NOT_RUN,
                identity_confidence=BehavioralConfidenceBand.LOW,
                sufficiency_stage_status=StageExecutionStatus.NOT_RUN,
                sufficiency_confidence=None,
                rationale="Fabricated confidence",
            )

    def test_failed_stage_with_confidence_raises_error(self):
        """FAILED stage must not have confidence."""
        with pytest.raises(
            ValidationError, match="did not complete.*must not have a fabricated"
        ):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.UNRESOLVED,
                action=ResolutionAction.RETAIN_PENDING,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.LOW,
                sufficiency_stage_status=StageExecutionStatus.FAILED,
                sufficiency_confidence=BehavioralConfidenceBand.MEDIUM,
                rationale="Fabricated confidence on failed stage",
            )


# ---------------------------------------------------------------------------
# ConcernProposal
# ---------------------------------------------------------------------------


class TestConcernProposal:
    def test_basic_creation(self):
        proposal = ConcernProposal(
            concern_creation_key="pkt-1:ir-event-1",
            proposed_concern_id="concern-new-1",
            identity_summary="Python learning journey",
            display_title="Python Learning",
            initial_summary="User wants to learn Python",
        )
        assert proposal.proposed_parent_id is None
        assert (
            proposal.parent_resolution_state
            == ParentResolutionState.PARENT_DEFERRED
        )

    def test_with_proposed_parent(self):
        proposal = ConcernProposal(
            concern_creation_key="pkt-2:ir-event-2",
            proposed_concern_id="concern-new-2",
            identity_summary="Flask web framework learning",
            display_title="Flask Framework",
            initial_summary="User wants to learn Flask",
            proposed_parent_id="concern-python-1",
            parent_resolution_state=ParentResolutionState.PARENT_ASSIGNED,
        )
        assert proposal.proposed_parent_id == "concern-python-1"


# ---------------------------------------------------------------------------
# PersistentConcern — lifecycle and parent-resolution invariants
# ---------------------------------------------------------------------------


class TestPersistentConcern:
    def _base_concern(self, **overrides) -> dict:
        defaults = {
            "concern_id": "concern-1",
            "conversation_id": "conv-1",
            "identity_summary": "User's Python learning journey",
            "display_title": "Python Learning",
            "current_summary": "User is learning Python basics",
            "status": ConcernStatus.ACTIVE,
            "created_at": "2024-01-01T00:00:00Z",
            "last_active_at": "2024-01-15T00:00:00Z",
            "parent_resolution_state": ParentResolutionState.ROOT_CONFIRMED,
            "semantic_version": 1,
        }
        defaults.update(overrides)
        return defaults

    def test_active_root_concern(self):
        concern = PersistentConcern(**self._base_concern())
        assert concern.status == ConcernStatus.ACTIVE
        assert concern.canonical_parent_id is None
        assert concern.merged_into_concern_id is None
        assert concern.aliases == []
        assert concern.metadata == {}

    def test_dormant_concern(self):
        concern = PersistentConcern(
            **self._base_concern(status=ConcernStatus.DORMANT)
        )
        assert concern.status == ConcernStatus.DORMANT

    def test_retired_concern(self):
        concern = PersistentConcern(
            **self._base_concern(status=ConcernStatus.RETIRED)
        )
        assert concern.status == ConcernStatus.RETIRED

    def test_merged_concern(self):
        concern = PersistentConcern(
            **self._base_concern(
                status=ConcernStatus.MERGED,
                merged_into_concern_id="concern-2",
            )
        )
        assert concern.merged_into_concern_id == "concern-2"

    def test_merged_without_target_raises_error(self):
        with pytest.raises(ValidationError, match="merged_into_concern_id"):
            PersistentConcern(
                **self._base_concern(status=ConcernStatus.MERGED)
            )

    def test_non_merged_with_target_raises_error(self):
        with pytest.raises(ValidationError, match="must not have merged_into_concern_id"):
            PersistentConcern(
                **self._base_concern(
                    status=ConcernStatus.ACTIVE,
                    merged_into_concern_id="concern-2",
                )
            )

    def test_parent_assigned_with_parent(self):
        concern = PersistentConcern(
            **self._base_concern(
                parent_resolution_state=ParentResolutionState.PARENT_ASSIGNED,
                canonical_parent_id="concern-parent-1",
            )
        )
        assert concern.canonical_parent_id == "concern-parent-1"

    def test_parent_assigned_without_parent_raises_error(self):
        with pytest.raises(ValidationError, match="canonical_parent_id"):
            PersistentConcern(
                **self._base_concern(
                    parent_resolution_state=ParentResolutionState.PARENT_ASSIGNED,
                )
            )

    def test_root_confirmed_with_parent_raises_error(self):
        with pytest.raises(ValidationError, match="canonical_parent_id=None"):
            PersistentConcern(
                **self._base_concern(
                    parent_resolution_state=ParentResolutionState.ROOT_CONFIRMED,
                    canonical_parent_id="concern-parent-1",
                )
            )

    def test_parent_deferred_with_parent_raises_error(self):
        with pytest.raises(ValidationError, match="canonical_parent_id=None"):
            PersistentConcern(
                **self._base_concern(
                    parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
                    canonical_parent_id="concern-parent-1",
                )
            )

    def test_parent_deferred_without_parent(self):
        concern = PersistentConcern(
            **self._base_concern(
                parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
            )
        )
        assert concern.canonical_parent_id is None
        assert (
            concern.parent_resolution_state
            == ParentResolutionState.PARENT_DEFERRED
        )

    def test_with_aliases_and_metadata(self):
        concern = PersistentConcern(
            **self._base_concern(
                aliases=["Python", "learning Python", "py"],
                metadata={"source": "conversation", "priority": "high"},
            )
        )
        assert len(concern.aliases) == 3
        assert concern.metadata["priority"] == "high"

    def test_serialization_roundtrip(self):
        concern = PersistentConcern(
            **self._base_concern(
                aliases=["Python"],
                metadata={"key": "value"},
                semantic_version=5,
            )
        )
        data = concern.model_dump()
        restored = PersistentConcern(**data)
        assert restored == concern


# ---------------------------------------------------------------------------
# PendingSemanticDecision — lifecycle state validation
# ---------------------------------------------------------------------------


class TestPendingSemanticDecision:
    def _base_decision(self, **overrides) -> dict:
        defaults = {
            "decision_id": "dec-1",
            "decision_creation_key": "req-1:identity_resolution:pkt-1:partition-0",
            "conversation_id": "conv-1",
            "stage": "identity_resolution",
            "entity_creation_key": "req-1:partition-0",
            "outcome": PipelineOutcome.UNRESOLVED,
            "lifecycle_state": "pending",
            "originating_request_id": "req-1",
            "created_at": "2024-01-01T00:00:00Z",
        }
        defaults.update(overrides)
        return defaults

    def test_pending_state(self):
        decision = PendingSemanticDecision(**self._base_decision())
        assert decision.lifecycle_state == "pending"
        assert decision.resolved_at is None
        assert decision.resolution_metadata is None
        assert decision.dependency_refs == []

    def test_unresolved_state(self):
        decision = PendingSemanticDecision(
            **self._base_decision(lifecycle_state="unresolved")
        )
        assert decision.lifecycle_state == "unresolved"

    def test_deferred_state(self):
        decision = PendingSemanticDecision(
            **self._base_decision(
                lifecycle_state="deferred",
                rationale="Need more context from user",
            )
        )
        assert decision.lifecycle_state == "deferred"
        assert decision.rationale == "Need more context from user"

    def test_resolved_state(self):
        decision = PendingSemanticDecision(
            **self._base_decision(
                lifecycle_state="resolved",
                resolved_at="2024-01-02T00:00:00Z",
                resolution_metadata={"resolved_by": "req-2", "matched": "concern-1"},
            )
        )
        assert decision.lifecycle_state == "resolved"
        assert decision.resolved_at is not None
        assert decision.resolution_metadata["matched"] == "concern-1"

    def test_invalid_lifecycle_state_raises_error(self):
        with pytest.raises(ValidationError, match="lifecycle_state must be one of"):
            PendingSemanticDecision(
                **self._base_decision(lifecycle_state="completed")
            )

    def test_invalid_lifecycle_state_empty_raises_error(self):
        with pytest.raises(ValidationError, match="lifecycle_state must be one of"):
            PendingSemanticDecision(
                **self._base_decision(lifecycle_state="")
            )

    def test_with_dependency_refs(self):
        decision = PendingSemanticDecision(
            **self._base_decision(
                dependency_refs=["pkt-1", "prop-1", "prop-2"],
            )
        )
        assert len(decision.dependency_refs) == 3

    def test_serialization_roundtrip(self):
        decision = PendingSemanticDecision(
            **self._base_decision(
                lifecycle_state="deferred",
                dependency_refs=["ref-1"],
                rationale="Awaiting context",
            )
        )
        data = decision.model_dump()
        restored = PendingSemanticDecision(**data)
        assert restored == decision
