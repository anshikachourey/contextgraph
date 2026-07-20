"""Serialization tests for all SIE enum definitions.

Validates:
- Every enum value serializes to its expected string
- Every enum can be constructed from its string value
- str(enum_value) produces the expected string representation
- All expected values are present in each enum class
"""

import pytest

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


# Expected values for each enum, matching the design document exactly.
RETENTION_LEVEL_VALUES = [
    "DISCARD",
    "CONTEXT_ONLY",
    "SUPPORTING_EVIDENCE",
    "DURABLE_PROPOSITION",
    "EMERGENCE_EVIDENCE",
    "INDEPENDENT_CONCERN_CANDIDATE",
]

BEHAVIORAL_CONFIDENCE_BAND_VALUES = [
    "HIGH",
    "MEDIUM",
    "LOW",
]

PIPELINE_OUTCOME_VALUES = [
    "YES",
    "NO",
    "UNRESOLVED",
    "DEFER",
    "RETRIEVAL_INCONCLUSIVE",
    "REQUIRES_VALIDATION",
]

PROPOSITION_TYPE_VALUES = [
    "QUESTION",
    "CLAIM",
    "PREFERENCE",
    "GOAL",
    "INTENT",
    "DECISION",
    "CONSTRAINT",
    "PLAN",
    "CORRECTION",
    "REJECTION",
    "UPDATE",
    "REQUEST",
    "EMOTIONAL_STATE",
    "EXAMPLE",
]

PROPOSITION_PROVENANCE_VALUES = [
    "DIRECT",
    "PARAPHRASE",
    "INTERPRETATION",
    "INFERENCE",
]

SEMANTIC_STATE_VALUES = [
    "ACTIVE",
    "SUPERSEDED",
    "RETRACTED",
    "INVALIDATED",
]

COHESION_STATUS_VALUES = [
    "COHESIVE",
    "MIXED",
    "UNRESOLVED_COHESION",
]

CONCERN_STATUS_VALUES = [
    "ACTIVE",
    "DORMANT",
    "RETIRED",
    "MERGED",
]

PARENT_RESOLUTION_STATE_VALUES = [
    "ROOT_CONFIRMED",
    "PARENT_DEFERRED",
    "PARENT_ASSIGNED",
]

ASSOCIATION_ROLE_VALUES = [
    "PRIMARY_OWNER",
    "SUPPORTING_EVIDENCE",
    "EMERGENCE_EVIDENCE",
    "CONTEXT",
    "CROSS_OBJECT_IMPACT",
]


class TestRetentionLevel:
    """Tests for RetentionLevel enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in RetentionLevel]
        assert actual == RETENTION_LEVEL_VALUES

    @pytest.mark.parametrize("value", RETENTION_LEVEL_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = RetentionLevel(value)
        assert member.value == value

    @pytest.mark.parametrize("value", RETENTION_LEVEL_VALUES)
    def test_constructs_from_string(self, value: str):
        member = RetentionLevel(value)
        assert isinstance(member, RetentionLevel)

    @pytest.mark.parametrize("value", RETENTION_LEVEL_VALUES)
    def test_str_representation(self, value: str):
        member = RetentionLevel(value)
        assert str(member) == value


class TestBehavioralConfidenceBand:
    """Tests for BehavioralConfidenceBand enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in BehavioralConfidenceBand]
        assert actual == BEHAVIORAL_CONFIDENCE_BAND_VALUES

    @pytest.mark.parametrize("value", BEHAVIORAL_CONFIDENCE_BAND_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = BehavioralConfidenceBand(value)
        assert member.value == value

    @pytest.mark.parametrize("value", BEHAVIORAL_CONFIDENCE_BAND_VALUES)
    def test_constructs_from_string(self, value: str):
        member = BehavioralConfidenceBand(value)
        assert isinstance(member, BehavioralConfidenceBand)

    @pytest.mark.parametrize("value", BEHAVIORAL_CONFIDENCE_BAND_VALUES)
    def test_str_representation(self, value: str):
        member = BehavioralConfidenceBand(value)
        assert str(member) == value


class TestPipelineOutcome:
    """Tests for PipelineOutcome enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in PipelineOutcome]
        assert actual == PIPELINE_OUTCOME_VALUES

    @pytest.mark.parametrize("value", PIPELINE_OUTCOME_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = PipelineOutcome(value)
        assert member.value == value

    @pytest.mark.parametrize("value", PIPELINE_OUTCOME_VALUES)
    def test_constructs_from_string(self, value: str):
        member = PipelineOutcome(value)
        assert isinstance(member, PipelineOutcome)

    @pytest.mark.parametrize("value", PIPELINE_OUTCOME_VALUES)
    def test_str_representation(self, value: str):
        member = PipelineOutcome(value)
        assert str(member) == value


class TestPropositionType:
    """Tests for PropositionType enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in PropositionType]
        assert actual == PROPOSITION_TYPE_VALUES

    @pytest.mark.parametrize("value", PROPOSITION_TYPE_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = PropositionType(value)
        assert member.value == value

    @pytest.mark.parametrize("value", PROPOSITION_TYPE_VALUES)
    def test_constructs_from_string(self, value: str):
        member = PropositionType(value)
        assert isinstance(member, PropositionType)

    @pytest.mark.parametrize("value", PROPOSITION_TYPE_VALUES)
    def test_str_representation(self, value: str):
        member = PropositionType(value)
        assert str(member) == value


class TestPropositionProvenance:
    """Tests for PropositionProvenance enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in PropositionProvenance]
        assert actual == PROPOSITION_PROVENANCE_VALUES

    @pytest.mark.parametrize("value", PROPOSITION_PROVENANCE_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = PropositionProvenance(value)
        assert member.value == value

    @pytest.mark.parametrize("value", PROPOSITION_PROVENANCE_VALUES)
    def test_constructs_from_string(self, value: str):
        member = PropositionProvenance(value)
        assert isinstance(member, PropositionProvenance)

    @pytest.mark.parametrize("value", PROPOSITION_PROVENANCE_VALUES)
    def test_str_representation(self, value: str):
        member = PropositionProvenance(value)
        assert str(member) == value


class TestSemanticState:
    """Tests for SemanticState enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in SemanticState]
        assert actual == SEMANTIC_STATE_VALUES

    @pytest.mark.parametrize("value", SEMANTIC_STATE_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = SemanticState(value)
        assert member.value == value

    @pytest.mark.parametrize("value", SEMANTIC_STATE_VALUES)
    def test_constructs_from_string(self, value: str):
        member = SemanticState(value)
        assert isinstance(member, SemanticState)

    @pytest.mark.parametrize("value", SEMANTIC_STATE_VALUES)
    def test_str_representation(self, value: str):
        member = SemanticState(value)
        assert str(member) == value


class TestCohesionStatus:
    """Tests for CohesionStatus enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in CohesionStatus]
        assert actual == COHESION_STATUS_VALUES

    @pytest.mark.parametrize("value", COHESION_STATUS_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = CohesionStatus(value)
        assert member.value == value

    @pytest.mark.parametrize("value", COHESION_STATUS_VALUES)
    def test_constructs_from_string(self, value: str):
        member = CohesionStatus(value)
        assert isinstance(member, CohesionStatus)

    @pytest.mark.parametrize("value", COHESION_STATUS_VALUES)
    def test_str_representation(self, value: str):
        member = CohesionStatus(value)
        assert str(member) == value


class TestConcernStatus:
    """Tests for ConcernStatus enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in ConcernStatus]
        assert actual == CONCERN_STATUS_VALUES

    @pytest.mark.parametrize("value", CONCERN_STATUS_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = ConcernStatus(value)
        assert member.value == value

    @pytest.mark.parametrize("value", CONCERN_STATUS_VALUES)
    def test_constructs_from_string(self, value: str):
        member = ConcernStatus(value)
        assert isinstance(member, ConcernStatus)

    @pytest.mark.parametrize("value", CONCERN_STATUS_VALUES)
    def test_str_representation(self, value: str):
        member = ConcernStatus(value)
        assert str(member) == value


class TestParentResolutionState:
    """Tests for ParentResolutionState enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in ParentResolutionState]
        assert actual == PARENT_RESOLUTION_STATE_VALUES

    @pytest.mark.parametrize("value", PARENT_RESOLUTION_STATE_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = ParentResolutionState(value)
        assert member.value == value

    @pytest.mark.parametrize("value", PARENT_RESOLUTION_STATE_VALUES)
    def test_constructs_from_string(self, value: str):
        member = ParentResolutionState(value)
        assert isinstance(member, ParentResolutionState)

    @pytest.mark.parametrize("value", PARENT_RESOLUTION_STATE_VALUES)
    def test_str_representation(self, value: str):
        member = ParentResolutionState(value)
        assert str(member) == value


class TestAssociationRole:
    """Tests for AssociationRole enum."""

    def test_all_expected_values_present(self):
        actual = [member.value for member in AssociationRole]
        assert actual == ASSOCIATION_ROLE_VALUES

    @pytest.mark.parametrize("value", ASSOCIATION_ROLE_VALUES)
    def test_serializes_to_expected_string(self, value: str):
        member = AssociationRole(value)
        assert member.value == value

    @pytest.mark.parametrize("value", ASSOCIATION_ROLE_VALUES)
    def test_constructs_from_string(self, value: str):
        member = AssociationRole(value)
        assert isinstance(member, AssociationRole)

    @pytest.mark.parametrize("value", ASSOCIATION_ROLE_VALUES)
    def test_str_representation(self, value: str):
        member = AssociationRole(value)
        assert str(member) == value


class TestEnumCount:
    """Verify that no enum has unexpected extra members."""

    def test_retention_level_count(self):
        assert len(RetentionLevel) == 6

    def test_behavioral_confidence_band_count(self):
        assert len(BehavioralConfidenceBand) == 3

    def test_pipeline_outcome_count(self):
        assert len(PipelineOutcome) == 6

    def test_proposition_type_count(self):
        assert len(PropositionType) == 14

    def test_proposition_provenance_count(self):
        assert len(PropositionProvenance) == 4

    def test_semantic_state_count(self):
        assert len(SemanticState) == 4

    def test_cohesion_status_count(self):
        assert len(CohesionStatus) == 3

    def test_concern_status_count(self):
        assert len(ConcernStatus) == 4

    def test_parent_resolution_state_count(self):
        assert len(ParentResolutionState) == 3

    def test_association_role_count(self):
        assert len(AssociationRole) == 5
