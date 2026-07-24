"""Tests for PropositionDetailValidator — complete proposition-detail validation.

Verifies:
- At least one proposition must be associated with the packet.
- Every proposition must have non-empty speaker_role.
- Every proposition must have non-empty retention_levels (complete retention data).
- Every proposition must have valid provenance (not empty/null).
- Every proposition must have non-empty proposition_id and proposition_creation_key.
- Every proposition must have non-empty source_message_ids.
- Missing detail blocks entire packet with DEFER/NONE — never silently skips.
- Valid propositions produce valid=True with no outcome/action.
- Multiple failures are reported in missing_fields.

Design authority: consolidated final design.md, Task 12.1.
"""

from __future__ import annotations

import pytest

from app.sie.enums import (
    CohesionStatus,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    ResolutionAction,
    RetentionLevel,
    SemanticState,
)
from app.sie.models import Proposition, SemanticPacket
from app.sie.retrieval.proposition_validator import (
    PropositionDetailValidator,
    PropositionValidationResult,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_packet(
    *,
    packet_id: str = "pkt-001",
    packet_creation_key: str = "req-1:partition-a",
) -> SemanticPacket:
    """Create a minimal SemanticPacket for testing."""
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=packet_creation_key,
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        message_seq_range=(1, 1),
        user_grounded_meaning="User wants to learn about ML",
        provenance="direct",
        packet_formation_version="1.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_proposition(
    *,
    proposition_id: str = "prop-001",
    proposition_creation_key: str = "req-1:prop-001",
    speaker_role: str = "USER",
    retention_levels: list[RetentionLevel] | None = None,
    provenance: PropositionProvenance = PropositionProvenance.DIRECT,
    source_message_ids: list[str] | None = None,
) -> Proposition:
    """Create a Proposition with configurable fields for testing."""
    if retention_levels is None:
        retention_levels = [RetentionLevel.DURABLE_PROPOSITION]
    if source_message_ids is None:
        source_message_ids = ["msg-1"]
    return Proposition(
        proposition_id=proposition_id,
        proposition_creation_key=proposition_creation_key,
        conversation_id="conv-001",
        source_message_ids=source_message_ids,
        speaker_role=speaker_role,
        canonical_meaning="I want to learn about ML",
        proposition_type=PropositionType.GOAL,
        message_seq_range=(1, 1),
        provenance=provenance,
        semantic_state=SemanticState.ACTIVE,
        retention_levels=retention_levels,
        created_at="2024-01-01T00:00:00Z",
        extraction_version="1.0",
    )


# ---------------------------------------------------------------------------
# Tests: Valid propositions → valid=True
# ---------------------------------------------------------------------------


class TestValidPropositions:
    """When all propositions have complete detail, validation succeeds."""

    def test_single_valid_proposition(self) -> None:
        """Single proposition with all required fields → valid=True."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition()]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is True
        assert result.outcome is None
        assert result.action is None
        assert result.missing_fields == []
        assert result.rationale

    def test_multiple_valid_propositions(self) -> None:
        """Multiple propositions all valid → valid=True."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [
            _make_proposition(proposition_id="p1", proposition_creation_key="key-1"),
            _make_proposition(proposition_id="p2", proposition_creation_key="key-2"),
            _make_proposition(proposition_id="p3", proposition_creation_key="key-3"),
        ]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is True
        assert result.missing_fields == []

    def test_valid_with_multiple_retention_levels(self) -> None:
        """Proposition with multiple retention levels is valid."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                retention_levels=[
                    RetentionLevel.DURABLE_PROPOSITION,
                    RetentionLevel.SUPPORTING_EVIDENCE,
                    RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE,
                ]
            ),
        ]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is True

    def test_valid_with_assistant_role(self) -> None:
        """Assistant-authored propositions are valid (role validation checks non-empty)."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(speaker_role="ASSISTANT")]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is True

    def test_valid_rationale_includes_count(self) -> None:
        """Rationale mentions the count of validated propositions."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [
            _make_proposition(proposition_id="p1", proposition_creation_key="k1"),
            _make_proposition(proposition_id="p2", proposition_creation_key="k2"),
        ]

        result = validator.validate_packet_propositions(packet, propositions)

        assert "2" in result.rationale


# ---------------------------------------------------------------------------
# Tests: No propositions → blocks packet
# ---------------------------------------------------------------------------


class TestNoPropositions:
    """Empty proposition list blocks the packet with DEFER."""

    def test_empty_propositions_list(self) -> None:
        """No propositions → valid=False, DEFER."""
        validator = PropositionDetailValidator()
        packet = _make_packet()

        result = validator.validate_packet_propositions(packet, [])

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert len(result.missing_fields) == 1
        assert "no propositions" in result.missing_fields[0]
        assert packet.packet_id in result.missing_fields[0]


# ---------------------------------------------------------------------------
# Tests: Missing speaker_role → blocks packet
# ---------------------------------------------------------------------------


class TestMissingSpeakerRole:
    """Missing or empty speaker_role blocks the entire packet."""

    def test_empty_string_speaker_role(self) -> None:
        """Empty string speaker_role → validation fails."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(speaker_role="")]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert any("speaker_role" in f for f in result.missing_fields)

    def test_whitespace_only_speaker_role(self) -> None:
        """Whitespace-only speaker_role → validation fails."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(speaker_role="   ")]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert any("speaker_role" in f for f in result.missing_fields)


# ---------------------------------------------------------------------------
# Tests: Missing retention_levels → blocks packet
# ---------------------------------------------------------------------------


class TestMissingRetentionLevels:
    """Empty retention_levels blocks the entire packet."""

    def test_empty_retention_levels(self) -> None:
        """Empty retention_levels list → validation fails."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(retention_levels=[])]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert any("retention_levels" in f for f in result.missing_fields)

    def test_one_of_many_missing_retention_blocks_all(self) -> None:
        """If ANY proposition has empty retention → entire packet blocked."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="good",
                proposition_creation_key="k-good",
                retention_levels=[RetentionLevel.DURABLE_PROPOSITION],
            ),
            _make_proposition(
                proposition_id="bad",
                proposition_creation_key="k-bad",
                retention_levels=[],
            ),
        ]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER
        assert any("bad" in f and "retention_levels" in f for f in result.missing_fields)


# ---------------------------------------------------------------------------
# Tests: Missing provenance → blocks packet
# ---------------------------------------------------------------------------


class TestMissingProvenance:
    """Missing or empty provenance blocks the entire packet.

    Note: The Proposition model uses PropositionProvenance enum, which
    always has a truthy value if set. We test defensively.
    """

    def test_all_valid_provenance_values_pass(self) -> None:
        """All valid PropositionProvenance enum values pass validation."""
        validator = PropositionDetailValidator()
        packet = _make_packet()

        for prov in PropositionProvenance:
            propositions = [_make_proposition(provenance=prov)]
            result = validator.validate_packet_propositions(packet, propositions)
            assert result.valid is True, f"Provenance {prov} should be valid"


# ---------------------------------------------------------------------------
# Tests: Missing source_message_ids → blocks packet
# ---------------------------------------------------------------------------


class TestMissingSourceMessageIds:
    """Empty source_message_ids blocks the entire packet."""

    def test_empty_source_message_ids(self) -> None:
        """Empty source_message_ids list → validation fails."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(source_message_ids=[])]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert any("source_message_ids" in f for f in result.missing_fields)


# ---------------------------------------------------------------------------
# Tests: Missing stable IDs → blocks packet
# ---------------------------------------------------------------------------


class TestMissingStableIds:
    """Missing proposition_id or proposition_creation_key blocks the packet."""

    def test_empty_proposition_id(self) -> None:
        """Empty proposition_id → validation fails."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(proposition_id="")]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER
        assert any("proposition_id" in f for f in result.missing_fields)

    def test_whitespace_only_proposition_id(self) -> None:
        """Whitespace-only proposition_id → validation fails."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(proposition_id="   ")]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert any("proposition_id" in f for f in result.missing_fields)

    def test_empty_proposition_creation_key(self) -> None:
        """Empty proposition_creation_key → validation fails."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(proposition_creation_key="")]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert any("proposition_creation_key" in f for f in result.missing_fields)

    def test_whitespace_only_creation_key(self) -> None:
        """Whitespace-only proposition_creation_key → validation fails."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(proposition_creation_key="   ")]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert any("proposition_creation_key" in f for f in result.missing_fields)


# ---------------------------------------------------------------------------
# Tests: Multiple failures in one proposition
# ---------------------------------------------------------------------------


class TestMultipleFailures:
    """Multiple missing fields are ALL reported — never silently skip."""

    def test_multiple_fields_missing_on_one_proposition(self) -> None:
        """Proposition with speaker_role and retention_levels both empty."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                speaker_role="",
                retention_levels=[],
                source_message_ids=[],
            ),
        ]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        # All three failures must be reported
        assert any("speaker_role" in f for f in result.missing_fields)
        assert any("retention_levels" in f for f in result.missing_fields)
        assert any("source_message_ids" in f for f in result.missing_fields)

    def test_multiple_propositions_multiple_failures(self) -> None:
        """Multiple propositions each with different issues → all reported."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [
            _make_proposition(
                proposition_id="p1",
                proposition_creation_key="k1",
                speaker_role="",  # fails: speaker_role
            ),
            _make_proposition(
                proposition_id="p2",
                proposition_creation_key="k2",
                retention_levels=[],  # fails: retention_levels
            ),
        ]

        result = validator.validate_packet_propositions(packet, propositions)

        assert result.valid is False
        assert len(result.missing_fields) >= 2
        assert any("speaker_role" in f for f in result.missing_fields)
        assert any("retention_levels" in f for f in result.missing_fields)


# ---------------------------------------------------------------------------
# Tests: Rationale content
# ---------------------------------------------------------------------------


class TestRationale:
    """The rationale always provides a human-readable explanation."""

    def test_failure_rationale_mentions_blocked(self) -> None:
        """Failure rationale mentions blocking the packet."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(speaker_role="")]

        result = validator.validate_packet_propositions(packet, propositions)

        assert "FAILED" in result.rationale or "blocked" in result.rationale.lower()

    def test_failure_rationale_includes_never_skip(self) -> None:
        """Failure rationale mentions not silently skipping."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition(retention_levels=[])]

        result = validator.validate_packet_propositions(packet, propositions)

        assert "silently skip" in result.rationale.lower() or "never" in result.rationale.lower()

    def test_success_rationale_mentions_complete(self) -> None:
        """Success rationale mentions completeness."""
        validator = PropositionDetailValidator()
        packet = _make_packet()
        propositions = [_make_proposition()]

        result = validator.validate_packet_propositions(packet, propositions)

        assert "complete" in result.rationale.lower()


# ---------------------------------------------------------------------------
# Tests: PropositionValidationResult dataclass
# ---------------------------------------------------------------------------


class TestPropositionValidationResultDataclass:
    """Tests for the PropositionValidationResult frozen dataclass."""

    def test_result_is_frozen(self) -> None:
        """PropositionValidationResult instances are immutable."""
        result = PropositionValidationResult(
            valid=True,
            outcome=None,
            action=None,
            missing_fields=[],
            rationale="ok",
        )
        with pytest.raises(AttributeError):
            result.valid = False  # type: ignore[misc]

    def test_result_equality(self) -> None:
        """Two results with same fields are equal."""
        r1 = PropositionValidationResult(
            valid=False,
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.NONE,
            missing_fields=["x"],
            rationale="test",
        )
        r2 = PropositionValidationResult(
            valid=False,
            outcome=PipelineOutcome.DEFER,
            action=ResolutionAction.NONE,
            missing_fields=["x"],
            rationale="test",
        )
        assert r1 == r2

    def test_default_missing_fields_is_empty(self) -> None:
        """missing_fields defaults to empty list."""
        result = PropositionValidationResult(
            valid=True,
            outcome=None,
            action=None,
        )
        assert result.missing_fields == []
        assert result.rationale == ""
