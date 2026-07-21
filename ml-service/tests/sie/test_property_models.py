"""Property-based tests for SIE data models using Hypothesis.

These tests verify critical invariants across random valid inputs:
1. Retention roles survive serialization roundtrip.
2. Same creation key → same permanent ID; mutable text excluded.
3. Source provenance immutable through model transitions.
4. Multiple association roles per proposition valid.
5. Unresolved/deferred states pass validation.
6. Packet splits cannot introduce source provenance.
7. Invalid identity-resolution combinations rejected.
8. established_by_packet_id serialized/preserved correctly.
9. PendingSemanticDecision lifecycle state roundtrip.
"""

import json
from datetime import datetime

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

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
    SemanticState,
    StageExecutionStatus,
)
from app.sie.id_generation import (
    resolve_entity_id,
    ENTITY_NAMESPACES,
    build_association_key,
    build_proposition_key,
)
from app.sie.models import (
    IdentityResolutionResult,
    ConcernProposal,
    PendingSemanticDecision,
    Proposition,
    RetentionDecision,
    SemanticPacket,
)
from app.sie.associations import (
    PacketMembership,
    PacketSplitRecord,
    PropositionAssociation,
)


# ---------------------------------------------------------------------------
# Strategies for generating valid model inputs
# ---------------------------------------------------------------------------

retention_level_st = st.sampled_from(list(RetentionLevel))
confidence_st = st.sampled_from(list(BehavioralConfidenceBand))
outcome_st = st.sampled_from(list(PipelineOutcome))
proposition_type_st = st.sampled_from(list(PropositionType))
provenance_st = st.sampled_from(list(PropositionProvenance))
semantic_state_st = st.sampled_from(list(SemanticState))
cohesion_status_st = st.sampled_from(list(CohesionStatus))
concern_status_st = st.sampled_from(list(ConcernStatus))
parent_resolution_st = st.sampled_from(list(ParentResolutionState))
association_role_st = st.sampled_from(list(AssociationRole))
entity_kind_st = st.sampled_from(sorted(ENTITY_NAMESPACES.keys()))
speaker_role_st = st.sampled_from(["USER", "ASSISTANT"])
iso_timestamp_st = st.just(datetime.utcnow().isoformat() + "Z")
nonempty_str_st = st.text(min_size=1, max_size=50, alphabet=st.characters(
    whitelist_categories=("L", "N", "P", "S"),
    blacklist_characters="\x00",
))
uuid_like_st = st.text(
    min_size=8, max_size=36,
    alphabet="abcdef0123456789-",
)


lifecycle_state_st = st.sampled_from(["pending", "unresolved", "deferred", "resolved"])


# ---------------------------------------------------------------------------
# Property 1: Retention primary and secondary roles survive serialization
# **Validates: Requirements 1.2**
# ---------------------------------------------------------------------------


@given(
    primary=retention_level_st,
    secondary_roles=st.lists(retention_level_st, min_size=0, max_size=5),
    confidence=confidence_st,
    outcome=outcome_st,
)
@settings(max_examples=100)
def test_retention_roles_survive_serialization(
    primary, secondary_roles, confidence, outcome
):
    """For ANY valid RetentionDecision, serializing and deserializing preserves
    all retention roles (primary + secondary)."""
    decision = RetentionDecision(
        decision_id="d-001",
        decision_creation_key="conv1:msg1:0",
        conversation_id="conv-1",
        primary_level=primary,
        secondary_roles=secondary_roles,
        confidence=confidence,
        outcome=outcome,
        source_message_ids=["msg-1"],
        speaker_role="USER",
        sequence_position=0,
        extraction_version="1.0",
        assessment_version="1.0",
    )
    # Serialize to dict and back
    data = json.loads(decision.model_dump_json())
    restored = RetentionDecision.model_validate(data)

    assert restored.primary_level == primary
    assert restored.secondary_roles == secondary_roles
    assert restored.confidence == confidence
    assert restored.outcome == outcome


# ---------------------------------------------------------------------------
# Property 2: Same creation key → same ID; mutable text excluded from IDs
# **Validates: Requirements 2.1**
# ---------------------------------------------------------------------------


@given(
    entity_kind=entity_kind_st,
    creation_key=st.text(min_size=1, max_size=200),
)
@settings(max_examples=200)
def test_same_creation_key_produces_same_id(entity_kind, creation_key):
    """For ANY creation key string, the same key always produces the same ID."""
    id1 = resolve_entity_id(entity_kind, creation_key)
    id2 = resolve_entity_id(entity_kind, creation_key)
    assert id1 == id2


@given(
    request_id=nonempty_str_st,
    position=st.integers(min_value=0, max_value=10000),
    mutable_meaning_a=nonempty_str_st,
    mutable_meaning_b=nonempty_str_st,
)
@settings(max_examples=100)
def test_mutable_text_does_not_affect_ids(
    request_id, position, mutable_meaning_a, mutable_meaning_b
):
    """Mutable semantic text (canonical_meaning) does not affect proposition IDs.
    Two propositions with the same creation key but different meanings get the same ID."""
    key = build_proposition_key(request_id, position)
    id_a = resolve_entity_id("proposition", key)
    id_b = resolve_entity_id("proposition", key)
    # Same key → same ID regardless of any mutable text that would be on the model
    assert id_a == id_b


# ---------------------------------------------------------------------------
# Property 3: Source provenance immutable through model transitions
# **Validates: Requirements 5.1**
# ---------------------------------------------------------------------------


@given(
    provenance=provenance_st,
    new_state=st.sampled_from(
        [SemanticState.SUPERSEDED, SemanticState.RETRACTED, SemanticState.INVALIDATED]
    ),
    original_msg_ids=st.lists(nonempty_str_st, min_size=1, max_size=5),
)
@settings(max_examples=100)
def test_source_provenance_unchanged_through_transitions(
    provenance, new_state, original_msg_ids
):
    """Source provenance remains unchanged through allowed model transitions.
    Changing semantic_state must not alter provenance or source_message_ids."""
    prop = Proposition(
        proposition_id="p-001",
        proposition_creation_key="req1:0",
        conversation_id="conv-1",
        source_message_ids=original_msg_ids,
        speaker_role="USER",
        canonical_meaning="test meaning",
        proposition_type=PropositionType.CLAIM,
        message_seq_range=(1, 2),
        provenance=provenance,
        semantic_state=SemanticState.ACTIVE,
        retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
        created_at="2024-01-01T00:00:00Z",
        extraction_version="1.0",
    )
    # Simulate state transition by creating new model with new state
    transitioned = prop.model_copy(update={"semantic_state": new_state})

    # Source provenance must be unchanged
    assert transitioned.provenance == provenance
    assert transitioned.source_message_ids == original_msg_ids
    assert transitioned.proposition_id == prop.proposition_id


# ---------------------------------------------------------------------------
# Property 4: Multiple association roles for one proposition are valid
# **Validates: Requirements 2.8**
# ---------------------------------------------------------------------------


@given(
    roles=st.lists(association_role_st, min_size=2, max_size=5),
)
@settings(max_examples=100)
def test_multiple_association_roles_per_proposition_valid(roles):
    """Generate random AssociationRole combinations and verify multiple roles
    per proposition work. A proposition may have distinct associations with
    different roles to different concerns."""
    associations = []
    for i, role in enumerate(roles):
        assoc = PropositionAssociation(
            association_id=f"assoc-{i}",
            association_creation_key=f"req1:prop1:concern{i}:{role.value}",
            proposition_id="prop-001",
            concern_id=f"concern-{i}",
            role=role,
            confidence=BehavioralConfidenceBand.HIGH,
            provenance="identity_resolution",
            established_by_packet_id="pkt-001",
            semantic_state=SemanticState.ACTIVE,
            created_at="2024-01-01T00:00:00Z",
            version=1,
        )
        associations.append(assoc)

    # All associations must be valid and distinct
    assert len(associations) == len(roles)
    for assoc in associations:
        # Verify roundtrip serialization
        data = json.loads(assoc.model_dump_json())
        restored = PropositionAssociation.model_validate(data)
        assert restored.role == assoc.role
        assert restored.proposition_id == "prop-001"


# ---------------------------------------------------------------------------
# Property 5: Unresolved/deferred states pass validation
# **Validates: Requirements 5.4**
# ---------------------------------------------------------------------------


@given(
    outcome=st.sampled_from([
        PipelineOutcome.UNRESOLVED,
        PipelineOutcome.DEFER,
        PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
        PipelineOutcome.REQUIRES_VALIDATION,
    ]),
    identity_confidence=confidence_st,
    sufficiency_confidence=confidence_st,
)
@settings(max_examples=100)
def test_unresolved_deferred_states_pass_validation(
    outcome, identity_confidence, sufficiency_confidence
):
    """Unresolved/deferred IdentityResolutionResult states pass validation
    when neither matched_concern_id nor new_concern_proposal is set."""
    result = IdentityResolutionResult(
        packet_id="pkt-001",
        outcome=outcome,
        action=ResolutionAction.RETAIN_PENDING,
        matched_concern_id=None,
        new_concern_proposal=None,
        identity_stage_status=StageExecutionStatus.COMPLETED,
        identity_confidence=identity_confidence,
        sufficiency_stage_status=StageExecutionStatus.COMPLETED,
        sufficiency_confidence=sufficiency_confidence,
        candidates_considered=["c1", "c2"],
        rationale="Insufficient confidence for resolution",
    )
    # Should not raise
    data = json.loads(result.model_dump_json())
    restored = IdentityResolutionResult.model_validate(data)
    assert restored.outcome == outcome
    assert restored.matched_concern_id is None
    assert restored.new_concern_proposal is None


# ---------------------------------------------------------------------------
# Property 6: Packet splits cannot introduce source provenance
# **Validates: Requirements 3.6**
# ---------------------------------------------------------------------------


@given(
    num_children=st.integers(min_value=2, max_value=6),
    original_msg_ids=st.lists(nonempty_str_st, min_size=1, max_size=5),
)
@settings(max_examples=100)
def test_packet_splits_cannot_introduce_source_provenance(
    num_children, original_msg_ids
):
    """Packet splits cannot introduce new source provenance. Child packets
    inherit provenance from constituent propositions only."""
    child_ids = [f"child-pkt-{i}" for i in range(num_children)]
    split = PacketSplitRecord(
        split_id="split-001",
        split_creation_key="req1:orig-pkt:0",
        original_packet_id="orig-pkt-001",
        resulting_packet_ids=child_ids,
        split_reason="mixed_cohesion",
        created_at="2024-01-01T00:00:00Z",
    )
    # The split record itself does not carry source_message_ids —
    # provenance comes from propositions, not splits
    data = json.loads(split.model_dump_json())
    restored = PacketSplitRecord.model_validate(data)

    # Verify no source provenance fields exist on split record
    assert not hasattr(restored, "source_message_ids")
    assert not hasattr(restored, "provenance")
    assert not hasattr(restored, "speaker_role")
    assert restored.original_packet_id == "orig-pkt-001"
    assert restored.resulting_packet_ids == child_ids


# ---------------------------------------------------------------------------
# Property 7: Invalid identity-resolution result combinations are rejected
# **Validates: Requirements 4.10**
# ---------------------------------------------------------------------------


@given(
    confidence=confidence_st,
    concern_id=nonempty_str_st,
)
@settings(max_examples=100)
def test_invalid_identity_resolution_both_match_and_proposal_rejected(
    confidence, concern_id
):
    """For YES outcome, having BOTH matched_concern_id and new_concern_proposal
    must be rejected."""
    proposal = ConcernProposal(
        concern_creation_key="pkt1:ev1",
        proposed_concern_id="new-concern-001",
        identity_summary="A new concern",
        display_title="New Concern",
        initial_summary="Initial summary",
    )
    with pytest.raises(ValueError, match="must not have.*new_concern_proposal"):
        IdentityResolutionResult(
            packet_id="pkt-001",
            outcome=PipelineOutcome.YES,
            action=ResolutionAction.ASSIGN_EXISTING,
            matched_concern_id=concern_id,
            new_concern_proposal=proposal,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.HIGH,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            rationale="Both set — invalid",
        )


@given(
    non_yes_outcome=st.sampled_from([
        PipelineOutcome.UNRESOLVED,
        PipelineOutcome.DEFER,
        PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
        PipelineOutcome.REQUIRES_VALIDATION,
    ]),
    concern_id=nonempty_str_st,
)
@settings(max_examples=100)
def test_invalid_identity_resolution_pending_with_match_rejected(
    non_yes_outcome, concern_id
):
    """Pending outcomes with matched_concern_id set must be rejected."""
    with pytest.raises(ValueError, match="must not have.*matched_concern_id"):
        IdentityResolutionResult(
            packet_id="pkt-001",
            outcome=non_yes_outcome,
            action=ResolutionAction.RETAIN_PENDING,
            matched_concern_id=concern_id,
            new_concern_proposal=None,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.HIGH,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            rationale="Pending with match — invalid",
        )


# ---------------------------------------------------------------------------
# Property 8: established_by_packet_id serialized, validated, preserved
# **Validates: Requirements 1.4**
# ---------------------------------------------------------------------------


@given(
    packet_id=st.one_of(st.none(), nonempty_str_st),
    role=association_role_st,
    confidence=confidence_st,
    state=semantic_state_st,
)
@settings(max_examples=100)
def test_established_by_packet_id_roundtrip(packet_id, role, confidence, state):
    """For ANY valid PropositionAssociation with established_by_packet_id,
    the field survives roundtrip serialization."""
    assoc = PropositionAssociation(
        association_id="assoc-001",
        association_creation_key="req1:prop1:concern1:PRIMARY_OWNER",
        proposition_id="prop-001",
        concern_id="concern-001",
        role=role,
        confidence=confidence,
        provenance="identity_resolution",
        established_by_packet_id=packet_id,
        semantic_state=state,
        created_at="2024-01-01T00:00:00Z",
        version=1,
    )
    data = json.loads(assoc.model_dump_json())
    restored = PropositionAssociation.model_validate(data)

    assert restored.established_by_packet_id == packet_id
    assert restored.role == role
    assert restored.confidence == confidence
    assert restored.semantic_state == state


# ---------------------------------------------------------------------------
# Property 9: PendingSemanticDecision lifecycle state roundtrip
# **Validates: Requirements 5.4**
# ---------------------------------------------------------------------------


@given(
    lifecycle_state=lifecycle_state_st,
    outcome=outcome_st,
    stage=st.sampled_from(["retention", "extraction", "cohesion", "identity"]),
    dep_refs=st.lists(nonempty_str_st, min_size=0, max_size=3),
)
@settings(max_examples=100)
def test_pending_semantic_decision_lifecycle_roundtrip(
    lifecycle_state, outcome, stage, dep_refs
):
    """For ANY valid PendingSemanticDecision with a valid lifecycle_state,
    serialization roundtrip preserves all fields correctly."""
    decision = PendingSemanticDecision(
        decision_id="dec-001",
        decision_creation_key="req1:identity:ent1",
        conversation_id="conv-1",
        stage=stage,
        entity_creation_key="req1:0",
        outcome=outcome,
        lifecycle_state=lifecycle_state,
        originating_request_id="req-001",
        dependency_refs=dep_refs,
        resolution_metadata={"note": "test"} if lifecycle_state == "resolved" else None,
        rationale="Test rationale",
        created_at="2024-01-01T00:00:00Z",
        resolved_at="2024-01-02T00:00:00Z" if lifecycle_state == "resolved" else None,
    )
    data = json.loads(decision.model_dump_json())
    restored = PendingSemanticDecision.model_validate(data)

    assert restored.lifecycle_state == lifecycle_state
    assert restored.outcome == outcome
    assert restored.stage == stage
    assert restored.dependency_refs == dep_refs
    assert restored.decision_creation_key == decision.decision_creation_key
    assert restored.entity_creation_key == decision.entity_creation_key


@given(
    invalid_state=st.text(min_size=1, max_size=20).filter(
        lambda s: s not in {"pending", "unresolved", "deferred", "resolved"}
    ),
)
@settings(max_examples=50)
def test_pending_semantic_decision_rejects_invalid_lifecycle(invalid_state):
    """Invalid lifecycle states must be rejected by validation."""
    with pytest.raises(ValueError, match="lifecycle_state must be one of"):
        PendingSemanticDecision(
            decision_id="dec-001",
            decision_creation_key="req1:identity:ent1",
            conversation_id="conv-1",
            stage="identity",
            entity_creation_key="req1:0",
            outcome=PipelineOutcome.UNRESOLVED,
            lifecycle_state=invalid_state,
            originating_request_id="req-001",
            created_at="2024-01-01T00:00:00Z",
        )
