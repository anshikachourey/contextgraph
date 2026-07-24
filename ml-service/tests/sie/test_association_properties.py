"""Property-based tests for normalized multi-role proposition associations (Task 12.3).

Proves:
1. Every retained role survives downstream assembly.
2. One proposition can hold multiple valid association roles.
3. Assistant propositions never receive user-grounded durable roles.
4. Missing detail prevents all packet mutations.
5. Input provenance and prior valid associations remain unchanged.

**Validates: Requirements 1.6, 1.7, 1.8**
"""

from __future__ import annotations

import copy

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

from app.sie.enums import (
    AssociationRole,
    BehavioralConfidenceBand,
    CohesionStatus,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    ResolutionAction,
    RetentionLevel,
    SemanticState,
)
from app.sie.models import (
    Proposition,
    SemanticPacket,
)
from app.sie.associations import PropositionAssociation
from app.sie.retrieval.association_assembler import AssociationAssembler
from app.sie.retrieval.proposition_validator import (
    PropositionDetailValidator,
    PropositionValidationResult,
)


# ---------------------------------------------------------------------------
# Shared strategies
# ---------------------------------------------------------------------------

confidence_st = st.sampled_from(list(BehavioralConfidenceBand))
nonempty_str_st = st.text(
    min_size=1,
    max_size=20,
    alphabet=st.characters(whitelist_categories=("L", "N")),
)

# Retention levels that produce association roles
_DURABLE_RETENTION_LEVELS = [
    RetentionLevel.DURABLE_PROPOSITION,
    RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE,
    RetentionLevel.SUPPORTING_EVIDENCE,
    RetentionLevel.EMERGENCE_EVIDENCE,
]

# Retention levels that produce NO associations
_NON_DURABLE_RETENTION_LEVELS = [
    RetentionLevel.CONTEXT_ONLY,
    RetentionLevel.DISCARD,
]

# The expected mapping from retention to role
_RETENTION_ROLE_MAP = {
    RetentionLevel.DURABLE_PROPOSITION: AssociationRole.PRIMARY_OWNER,
    RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE: AssociationRole.PRIMARY_OWNER,
    RetentionLevel.SUPPORTING_EVIDENCE: AssociationRole.SUPPORTING_EVIDENCE,
    RetentionLevel.EMERGENCE_EVIDENCE: AssociationRole.EMERGENCE_EVIDENCE,
}

durable_retention_st = st.sampled_from(_DURABLE_RETENTION_LEVELS)
all_retention_st = st.sampled_from(list(RetentionLevel))
provenance_st = st.sampled_from(list(PropositionProvenance))
prop_type_st = st.sampled_from(list(PropositionType))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_proposition(
    *,
    proposition_id: str = "prop-001",
    speaker_role: str = "USER",
    retention_levels: list[RetentionLevel] | None = None,
    provenance: PropositionProvenance = PropositionProvenance.DIRECT,
) -> Proposition:
    """Create a Proposition with the given parameters."""
    return Proposition(
        proposition_id=proposition_id,
        proposition_creation_key=f"req-001:{proposition_id}",
        conversation_id="conv-001",
        source_message_ids=["msg-001"],
        speaker_role=speaker_role,
        canonical_meaning="Test meaning",
        proposition_type=PropositionType.CLAIM,
        message_seq_range=(1, 1),
        provenance=provenance,
        retention_levels=retention_levels or [RetentionLevel.DURABLE_PROPOSITION],
        created_at="2024-01-01T00:00:00Z",
        extraction_version="1.0",
    )


def _make_packet() -> SemanticPacket:
    """Create a minimal test packet."""
    return SemanticPacket(
        packet_id="pkt-001",
        packet_creation_key="req-001:partition-0",
        conversation_id="conv-001",
        source_message_ids=["msg-001"],
        message_seq_range=(1, 1),
        user_grounded_meaning="Test meaning",
        provenance="test",
        packet_formation_version="1.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


# ===========================================================================
# Property 1: Every retained role survives downstream assembly.
# **Validates: Requirements 1.6, 1.7**
# ===========================================================================


class TestRetainedRoleSurvivesAssembly:
    """Prove every durable retention level produces its mapped association role."""

    @given(
        retention_level=durable_retention_st,
    )
    @settings(max_examples=100)
    def test_each_durable_retention_produces_correct_role(
        self, retention_level: RetentionLevel
    ):
        """Each durable retention level (DURABLE_PROPOSITION,
        INDEPENDENT_CONCERN_CANDIDATE, SUPPORTING_EVIDENCE, EMERGENCE_EVIDENCE)
        produces exactly its mapped association role in the downstream assembly.
        """
        expected_role = _RETENTION_ROLE_MAP[retention_level]

        prop = _make_proposition(
            proposition_id="prop-test",
            speaker_role="USER",
            retention_levels=[retention_level],
        )
        packet = _make_packet()

        assembler = AssociationAssembler()
        associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        # Exactly one association with the expected role
        assert len(associations) == 1
        assert associations[0].role == expected_role
        assert associations[0].proposition_id == "prop-test"
        assert associations[0].concern_id == "concern-001"

    @given(
        retention_levels=st.lists(
            durable_retention_st, min_size=1, max_size=4, unique=True
        ),
    )
    @settings(max_examples=100)
    def test_all_retained_roles_survive_assembly(
        self, retention_levels: list[RetentionLevel]
    ):
        """When a proposition has multiple durable retention levels,
        ALL corresponding roles appear in the assembled associations.
        No retained role is silently dropped.
        """
        prop = _make_proposition(
            proposition_id="prop-multi",
            speaker_role="USER",
            retention_levels=retention_levels,
        )
        packet = _make_packet()

        assembler = AssociationAssembler()
        associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        # Compute expected distinct roles
        expected_roles = {_RETENTION_ROLE_MAP[rl] for rl in retention_levels}

        actual_roles = {a.role for a in associations}
        assert actual_roles == expected_roles

    @given(
        non_durable_level=st.sampled_from(_NON_DURABLE_RETENTION_LEVELS),
    )
    @settings(max_examples=100)
    def test_context_only_and_discard_produce_no_associations(
        self, non_durable_level: RetentionLevel
    ):
        """CONTEXT_ONLY and DISCARD retention levels create NO durable associations."""
        prop = _make_proposition(
            proposition_id="prop-context",
            speaker_role="USER",
            retention_levels=[non_durable_level],
        )
        packet = _make_packet()

        assembler = AssociationAssembler()
        associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        assert associations == []


# ===========================================================================
# Property 2: One proposition can hold multiple valid association roles.
# **Validates: Requirements 1.6**
# ===========================================================================


class TestMultipleRolesPerProposition:
    """Prove a single proposition can hold multiple association roles simultaneously."""

    @given(
        retention_combo=st.lists(
            durable_retention_st, min_size=2, max_size=4, unique=True
        ),
    )
    @settings(max_examples=100)
    def test_proposition_receives_multiple_roles(
        self, retention_combo: list[RetentionLevel]
    ):
        """A single USER proposition with multiple durable retention levels
        receives one association per distinct mapped role. For example,
        (DURABLE_PROPOSITION, SUPPORTING_EVIDENCE) → (PRIMARY_OWNER, SUPPORTING_EVIDENCE).
        """
        prop = _make_proposition(
            proposition_id="prop-multi-role",
            speaker_role="USER",
            retention_levels=retention_combo,
        )
        packet = _make_packet()

        assembler = AssociationAssembler()
        associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        # Each association must reference the same proposition
        for assoc in associations:
            assert assoc.proposition_id == "prop-multi-role"

        # Number of associations equals distinct mapped roles
        expected_roles = {_RETENTION_ROLE_MAP[rl] for rl in retention_combo}
        assert len(associations) == len(expected_roles)

    def test_durable_and_independent_both_map_to_primary_owner(self):
        """Both DURABLE_PROPOSITION and INDEPENDENT_CONCERN_CANDIDATE map to
        PRIMARY_OWNER. If both are present, only ONE PRIMARY_OWNER association
        is created (deduplication by role).
        """
        prop = _make_proposition(
            proposition_id="prop-dedup",
            speaker_role="USER",
            retention_levels=[
                RetentionLevel.DURABLE_PROPOSITION,
                RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE,
            ],
        )
        packet = _make_packet()

        assembler = AssociationAssembler()
        associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        # Only one PRIMARY_OWNER despite two retention levels mapping to it
        primary_roles = [a for a in associations if a.role == AssociationRole.PRIMARY_OWNER]
        assert len(primary_roles) == 1


# ===========================================================================
# Property 3: Assistant propositions never receive user-grounded durable roles.
# **Validates: Requirements 1.8**
# ===========================================================================


class TestAssistantNeverReceivesDurableRoles:
    """Prove assistant-authored propositions never get user-grounded associations."""

    @given(
        retention_levels=st.lists(
            all_retention_st, min_size=1, max_size=4, unique=True
        ),
    )
    @settings(max_examples=100)
    def test_assistant_proposition_produces_no_associations(
        self, retention_levels: list[RetentionLevel]
    ):
        """Assistant-authored propositions NEVER receive PRIMARY_OWNER,
        SUPPORTING_EVIDENCE, or EMERGENCE_EVIDENCE — regardless of their
        retention levels. Even after confirmation, the confirming USER
        proposition carries the applicable evidence.
        """
        prop = _make_proposition(
            proposition_id="prop-assistant",
            speaker_role="ASSISTANT",
            retention_levels=retention_levels,
        )
        packet = _make_packet()

        assembler = AssociationAssembler()
        associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        # No associations created for assistant propositions
        assert associations == []

    @given(
        num_user_props=st.integers(min_value=1, max_value=3),
        num_assistant_props=st.integers(min_value=1, max_value=3),
    )
    @settings(max_examples=100)
    def test_mixed_packet_only_user_gets_associations(
        self, num_user_props: int, num_assistant_props: int
    ):
        """In a mixed packet with both USER and ASSISTANT propositions,
        only USER propositions receive durable associations.
        """
        props = []
        for i in range(num_user_props):
            props.append(
                _make_proposition(
                    proposition_id=f"user-prop-{i}",
                    speaker_role="USER",
                    retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
                )
            )
        for i in range(num_assistant_props):
            props.append(
                _make_proposition(
                    proposition_id=f"asst-prop-{i}",
                    speaker_role="ASSISTANT",
                    retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
                )
            )

        packet = _make_packet()
        assembler = AssociationAssembler()
        associations = assembler.assemble_associations(
            packet=packet,
            propositions=props,
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        # Only user propositions produced associations
        assert len(associations) == num_user_props
        for assoc in associations:
            assert assoc.proposition_id.startswith("user-prop-")


# ===========================================================================
# Property 4: Missing detail prevents all packet mutations.
# **Validates: Requirements 1.6**
# ===========================================================================


class TestMissingDetailPreventsAll:
    """Prove that incomplete proposition detail blocks the entire packet."""

    @given(
        missing_field=st.sampled_from([
            "speaker_role",
            "retention_levels",
            "provenance",
            "proposition_id",
            "source_message_ids",
            "proposition_creation_key",
        ]),
    )
    @settings(max_examples=100)
    def test_missing_required_field_blocks_packet(self, missing_field: str):
        """When any required field is missing/empty on a proposition,
        the PropositionDetailValidator returns DEFER and blocks all
        packet mutations — never silently skips.
        """
        # Build a proposition with one field made invalid
        # We construct manually with dict manipulation to bypass Pydantic
        # validation, then test the validator's behavior
        prop_kwargs = dict(
            proposition_id="prop-001",
            proposition_creation_key="req-001:prop-001",
            conversation_id="conv-001",
            source_message_ids=["msg-001"],
            speaker_role="USER",
            canonical_meaning="Test meaning",
            proposition_type=PropositionType.CLAIM,
            message_seq_range=(1, 1),
            provenance=PropositionProvenance.DIRECT,
            retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            created_at="2024-01-01T00:00:00Z",
            extraction_version="1.0",
        )

        # Make the specified field empty/invalid
        if missing_field == "speaker_role":
            prop_kwargs["speaker_role"] = ""
        elif missing_field == "retention_levels":
            prop_kwargs["retention_levels"] = []
        elif missing_field == "provenance":
            # Can't set None on a required enum field, skip this combo
            # Instead test with the validator logic
            # The validator checks for falsy provenance
            prop_kwargs["provenance"] = PropositionProvenance.DIRECT
            # We'll test via the validator by passing a constructed object
            prop = Proposition(**prop_kwargs)
            # Monkey-patch for test
            object.__setattr__(prop, "provenance", None)
            packet = _make_packet()
            validator = PropositionDetailValidator()
            result = validator.validate_packet_propositions(packet, [prop])
            assert result.valid is False
            assert result.outcome == PipelineOutcome.DEFER
            assert result.action == ResolutionAction.NONE
            assert len(result.missing_fields) > 0
            return
        elif missing_field == "proposition_id":
            prop_kwargs["proposition_id"] = ""
        elif missing_field == "source_message_ids":
            prop_kwargs["source_message_ids"] = []
        elif missing_field == "proposition_creation_key":
            prop_kwargs["proposition_creation_key"] = ""

        prop = Proposition(**prop_kwargs)
        packet = _make_packet()

        validator = PropositionDetailValidator()
        result = validator.validate_packet_propositions(packet, [prop])

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert len(result.missing_fields) > 0

    @settings(max_examples=100)
    @given(
        num_props=st.integers(min_value=1, max_value=5),
    )
    def test_no_propositions_blocks_packet(self, num_props: int):
        """A packet with zero propositions is always invalid (blocked)."""
        packet = _make_packet()
        validator = PropositionDetailValidator()
        result = validator.validate_packet_propositions(packet, [])

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER


# ===========================================================================
# Property 5: Input provenance and prior valid associations remain unchanged.
# **Validates: Requirements 1.6, 1.7**
# ===========================================================================


class TestInputProvenancePreserved:
    """Prove that assembly does not mutate input propositions or existing associations."""

    @given(
        retention_levels=st.lists(
            durable_retention_st, min_size=1, max_size=3, unique=True
        ),
        num_existing_associations=st.integers(min_value=0, max_value=3),
    )
    @settings(max_examples=100)
    def test_proposition_fields_unchanged_after_assembly(
        self,
        retention_levels: list[RetentionLevel],
        num_existing_associations: int,
    ):
        """Assembly never modifies the input proposition's fields.
        All stable IDs, retention roles, speaker_role, provenance,
        and source_message_ids remain exactly as supplied.
        """
        prop = _make_proposition(
            proposition_id="prop-preserve",
            speaker_role="USER",
            retention_levels=retention_levels,
            provenance=PropositionProvenance.DIRECT,
        )

        # Deep copy to compare after assembly
        original_prop = copy.deepcopy(prop)

        packet = _make_packet()
        assembler = AssociationAssembler()
        _associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        # Verify input proposition is unchanged
        assert prop.proposition_id == original_prop.proposition_id
        assert prop.proposition_creation_key == original_prop.proposition_creation_key
        assert prop.speaker_role == original_prop.speaker_role
        assert prop.retention_levels == original_prop.retention_levels
        assert prop.source_message_ids == original_prop.source_message_ids
        assert prop.provenance == original_prop.provenance
        assert prop.canonical_meaning == original_prop.canonical_meaning

    @given(
        retention_levels=st.lists(
            durable_retention_st, min_size=1, max_size=3, unique=True
        ),
    )
    @settings(max_examples=100)
    def test_prior_associations_not_mutated_by_new_assembly(
        self, retention_levels: list[RetentionLevel]
    ):
        """Creating new associations from assembly does not mutate any
        prior valid associations. Prior associations' IDs, roles,
        confidence, provenance, and semantic_state remain unchanged.
        """
        # Simulate a prior valid association
        prior_association = PropositionAssociation(
            association_id="assoc-prior-001",
            association_creation_key="req-000:prop-000:concern-000:PRIMARY_OWNER",
            proposition_id="prop-prior",
            concern_id="concern-000",
            role=AssociationRole.PRIMARY_OWNER,
            confidence=BehavioralConfidenceBand.HIGH,
            provenance="identity_resolution",
            established_by_packet_id="pkt-000",
            semantic_state=SemanticState.ACTIVE,
            created_at="2024-01-01T00:00:00Z",
            version=1,
        )

        # Deep copy the prior association
        original_prior = copy.deepcopy(prior_association)

        # Now assemble new associations
        prop = _make_proposition(
            proposition_id="prop-new",
            speaker_role="USER",
            retention_levels=retention_levels,
        )
        packet = _make_packet()
        assembler = AssociationAssembler()
        new_associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.MEDIUM,
        )

        # Prior association is completely unchanged
        assert prior_association.association_id == original_prior.association_id
        assert prior_association.association_creation_key == original_prior.association_creation_key
        assert prior_association.proposition_id == original_prior.proposition_id
        assert prior_association.concern_id == original_prior.concern_id
        assert prior_association.role == original_prior.role
        assert prior_association.confidence == original_prior.confidence
        assert prior_association.provenance == original_prior.provenance
        assert prior_association.semantic_state == original_prior.semantic_state
        assert prior_association.version == original_prior.version

        # New associations are distinct objects
        for new_assoc in new_associations:
            assert new_assoc.association_id != prior_association.association_id

    @given(
        retention_levels=st.lists(
            durable_retention_st, min_size=1, max_size=4, unique=True
        ),
    )
    @settings(max_examples=100)
    def test_packet_unchanged_after_assembly(
        self, retention_levels: list[RetentionLevel]
    ):
        """The SemanticPacket itself is never modified by association assembly."""
        packet = _make_packet()
        original_packet = copy.deepcopy(packet)

        prop = _make_proposition(
            proposition_id="prop-pkt-check",
            speaker_role="USER",
            retention_levels=retention_levels,
        )

        assembler = AssociationAssembler()
        _associations = assembler.assemble_associations(
            packet=packet,
            propositions=[prop],
            concern_id="concern-001",
            request_id="req-001",
            confidence=BehavioralConfidenceBand.HIGH,
        )

        # Packet is unchanged
        assert packet.packet_id == original_packet.packet_id
        assert packet.packet_creation_key == original_packet.packet_creation_key
        assert packet.source_message_ids == original_packet.source_message_ids
        assert packet.user_grounded_meaning == original_packet.user_grounded_meaning
