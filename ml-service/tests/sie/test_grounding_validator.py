"""Tests for the GroundingValidator.

Verifies rejection of:
- Fabricated concern IDs not in context.
- Fabricated proposition IDs not in context.
- Missing evidence spans (no entity_id or entity_type).
- Unsupported assistant-to-user attribution.
- Unlisted competitors not in the candidate set.
- Malformed output (wrong types, missing fields).

Also verifies:
- Valid output passes all checks.
- Multiple violations are all reported.
"""

from __future__ import annotations

import pytest

from app.sie.evaluator.grounding_validator import (
    GroundingContext,
    GroundingRejectionReason,
    GroundingResult,
    GroundingValidator,
    GroundingViolation,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_context(
    valid_concern_ids: frozenset[str] | None = None,
    valid_proposition_ids: frozenset[str] | None = None,
    valid_message_ids: frozenset[str] | None = None,
    candidate_concern_ids: frozenset[str] | None = None,
    assistant_proposition_ids: frozenset[str] | None = None,
) -> GroundingContext:
    """Create a GroundingContext with sensible defaults."""
    return GroundingContext(
        valid_concern_ids=valid_concern_ids or frozenset({"concern-1", "concern-2"}),
        valid_proposition_ids=valid_proposition_ids
        or frozenset({"prop-1", "prop-2", "prop-3"}),
        valid_message_ids=valid_message_ids or frozenset({"msg-1", "msg-2"}),
        candidate_concern_ids=candidate_concern_ids
        or frozenset({"concern-1", "concern-2"}),
        assistant_proposition_ids=assistant_proposition_ids
        or frozenset({"prop-3"}),
    )


def _make_valid_output(
    concern_id: str = "concern-1",
    best_match: str | None = "concern-1",
    competitors: list[str] | None = None,
) -> dict:
    """Create a well-formed output that passes grounding."""
    return {
        "candidate_assessments": [
            {
                "concern_id": concern_id,
                "supporting_evidence": [
                    {
                        "entity_id": "prop-1",
                        "entity_type": "proposition",
                        "description": "User stated this concern.",
                    }
                ],
                "contrary_evidence": [],
                "exact_continuity": True,
                "historical_trajectory": False,
                "return_path_continuity": False,
                "scope_compatible": True,
                "explanation": "Clear identity match.",
            }
        ],
        "best_match_concern_id": best_match,
        "competing_candidate_ids": competitors or [],
        "explanation": "Evaluation explanation.",
    }


@pytest.fixture
def validator() -> GroundingValidator:
    """Create a GroundingValidator instance."""
    return GroundingValidator()


@pytest.fixture
def context() -> GroundingContext:
    """Create a default GroundingContext."""
    return _make_context()


# ---------------------------------------------------------------------------
# Tests: Valid output
# ---------------------------------------------------------------------------


class TestValidOutput:
    """Tests for output that passes all grounding checks."""

    def test_valid_output_passes(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Well-formed output with valid IDs passes grounding."""
        output = _make_valid_output()
        result = validator.validate(output, context)

        assert result.valid is True
        assert result.violations == []
        assert result.output == output

    def test_valid_output_with_null_best_match(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Output with null best_match_concern_id passes grounding."""
        output = _make_valid_output(best_match=None)
        result = validator.validate(output, context)

        assert result.valid is True

    def test_valid_output_with_multiple_candidates(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Output with multiple valid candidate assessments passes."""
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "concern-1",
                    "supporting_evidence": [
                        {"entity_id": "prop-1", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Match 1.",
                },
                {
                    "concern_id": "concern-2",
                    "supporting_evidence": [
                        {"entity_id": "prop-2", "entity_type": "proposition"}
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": False,
                    "historical_trajectory": True,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Match 2.",
                },
            ],
            "best_match_concern_id": "concern-1",
            "competing_candidate_ids": ["concern-2"],
            "explanation": "Two candidates evaluated.",
        }
        result = validator.validate(output, context)

        assert result.valid is True


# ---------------------------------------------------------------------------
# Tests: Fabricated concern IDs
# ---------------------------------------------------------------------------


class TestFabricatedConcernIDs:
    """Tests for rejection of fabricated concern IDs."""

    def test_rejects_fabricated_concern_id_in_assessment(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Fabricated concern_id in candidate assessment is rejected."""
        output = _make_valid_output(concern_id="fabricated-concern")
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.FABRICATED_CONCERN_ID
            for v in result.violations
        )

    def test_rejects_fabricated_best_match(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Fabricated best_match_concern_id is rejected."""
        output = _make_valid_output(best_match="nonexistent-concern")
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.FABRICATED_CONCERN_ID
            for v in result.violations
        )

    def test_rejects_fabricated_concern_in_evidence(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Fabricated concern ID in evidence reference is rejected."""
        output = _make_valid_output()
        output["candidate_assessments"][0]["supporting_evidence"] = [
            {
                "entity_id": "nonexistent-concern",
                "entity_type": "concern",
                "description": "Fabricated.",
            }
        ]
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.FABRICATED_CONCERN_ID
            for v in result.violations
        )


# ---------------------------------------------------------------------------
# Tests: Fabricated proposition IDs
# ---------------------------------------------------------------------------


class TestFabricatedPropositionIDs:
    """Tests for rejection of fabricated proposition IDs."""

    def test_rejects_fabricated_proposition_in_evidence(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Fabricated proposition ID in evidence is rejected."""
        output = _make_valid_output()
        output["candidate_assessments"][0]["supporting_evidence"] = [
            {
                "entity_id": "nonexistent-prop",
                "entity_type": "proposition",
                "description": "Fabricated.",
            }
        ]
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.FABRICATED_PROPOSITION_ID
            for v in result.violations
        )


# ---------------------------------------------------------------------------
# Tests: Missing evidence spans
# ---------------------------------------------------------------------------


class TestMissingEvidenceSpans:
    """Tests for rejection of evidence with missing required fields."""

    def test_rejects_evidence_missing_entity_id(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Evidence without entity_id is rejected."""
        output = _make_valid_output()
        output["candidate_assessments"][0]["supporting_evidence"] = [
            {"entity_type": "proposition", "description": "No ID."}
        ]
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MISSING_EVIDENCE_SPAN
            for v in result.violations
        )

    def test_rejects_evidence_missing_entity_type(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Evidence without entity_type is rejected."""
        output = _make_valid_output()
        output["candidate_assessments"][0]["supporting_evidence"] = [
            {"entity_id": "prop-1", "description": "No type."}
        ]
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MISSING_EVIDENCE_SPAN
            for v in result.violations
        )

    def test_rejects_invalid_message_id_in_evidence(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Evidence referencing a non-existent message ID is rejected."""
        output = _make_valid_output()
        output["candidate_assessments"][0]["supporting_evidence"] = [
            {
                "entity_id": "nonexistent-msg",
                "entity_type": "message",
                "description": "Fabricated message.",
            }
        ]
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MISSING_EVIDENCE_SPAN
            for v in result.violations
        )


# ---------------------------------------------------------------------------
# Tests: Unsupported assistant attribution
# ---------------------------------------------------------------------------


class TestUnsupportedAssistantAttribution:
    """Tests for rejection of assistant propositions used as ownership evidence."""

    def test_rejects_assistant_proposition_as_supporting_evidence(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Assistant proposition used as supporting evidence is rejected."""
        output = _make_valid_output()
        # prop-3 is an assistant proposition in our context
        output["candidate_assessments"][0]["supporting_evidence"] = [
            {
                "entity_id": "prop-3",
                "entity_type": "proposition",
                "description": "Assistant said this.",
            }
        ]
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.UNSUPPORTED_ASSISTANT_ATTRIBUTION
            for v in result.violations
        )

    def test_allows_assistant_proposition_in_contrary_evidence(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Assistant proposition in contrary_evidence is allowed."""
        output = _make_valid_output()
        output["candidate_assessments"][0]["contrary_evidence"] = [
            {
                "entity_id": "prop-3",
                "entity_type": "proposition",
                "description": "Assistant contradicts this.",
            }
        ]
        result = validator.validate(output, context)

        # Contrary evidence from assistant is fine — it doesn't establish ownership
        assert result.valid is True

    def test_allows_user_proposition_as_supporting_evidence(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """User proposition as supporting evidence is allowed."""
        output = _make_valid_output()
        # prop-1 and prop-2 are user propositions
        output["candidate_assessments"][0]["supporting_evidence"] = [
            {
                "entity_id": "prop-1",
                "entity_type": "proposition",
                "description": "User stated this.",
            }
        ]
        result = validator.validate(output, context)

        assert result.valid is True


# ---------------------------------------------------------------------------
# Tests: Unlisted competitors
# ---------------------------------------------------------------------------


class TestUnlistedCompetitors:
    """Tests for rejection of competitors not in the candidate set."""

    def test_rejects_unlisted_competitor(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Competitor concern ID not in candidate set is rejected."""
        output = _make_valid_output(competitors=["nonexistent-concern"])
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.UNLISTED_COMPETITOR
            for v in result.violations
        )

    def test_allows_listed_competitor(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Competitor in the candidate set is allowed."""
        output = _make_valid_output(competitors=["concern-2"])
        result = validator.validate(output, context)

        assert result.valid is True


# ---------------------------------------------------------------------------
# Tests: Malformed output
# ---------------------------------------------------------------------------


class TestMalformedOutput:
    """Tests for rejection of malformed output."""

    def test_rejects_missing_required_fields(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Output missing required top-level fields is rejected."""
        output = {"only_one_field": True}
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MISSING_REQUIRED_FIELD
            for v in result.violations
        )

    def test_rejects_non_list_candidate_assessments(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """candidate_assessments that isn't a list is rejected."""
        output = {
            "candidate_assessments": "not a list",
            "best_match_concern_id": None,
            "competing_candidate_ids": [],
            "explanation": "test",
        }
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MALFORMED_OUTPUT
            for v in result.violations
        )

    def test_rejects_non_list_competing_ids(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """competing_candidate_ids that isn't a list is rejected."""
        output = {
            "candidate_assessments": [],
            "best_match_concern_id": None,
            "competing_candidate_ids": "not a list",
            "explanation": "test",
        }
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MALFORMED_OUTPUT
            for v in result.violations
        )

    def test_rejects_non_string_explanation(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """explanation that isn't a string is rejected."""
        output = {
            "candidate_assessments": [],
            "best_match_concern_id": None,
            "competing_candidate_ids": [],
            "explanation": 12345,
        }
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MALFORMED_OUTPUT
            for v in result.violations
        )

    def test_rejects_non_dict_assessment(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Assessment that isn't a dict is rejected."""
        output = {
            "candidate_assessments": ["not a dict"],
            "best_match_concern_id": None,
            "competing_candidate_ids": [],
            "explanation": "test",
        }
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MALFORMED_OUTPUT
            for v in result.violations
        )

    def test_rejects_assessment_missing_required_fields(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Assessment missing required fields is rejected."""
        output = {
            "candidate_assessments": [
                {"concern_id": "concern-1"}  # missing most fields
            ],
            "best_match_concern_id": None,
            "competing_candidate_ids": [],
            "explanation": "test",
        }
        result = validator.validate(output, context)

        assert result.valid is False
        assert any(
            v.reason == GroundingRejectionReason.MISSING_REQUIRED_FIELD
            for v in result.violations
        )


# ---------------------------------------------------------------------------
# Tests: Multiple violations reported
# ---------------------------------------------------------------------------


class TestMultipleViolations:
    """Tests verifying all violations are reported together."""

    def test_reports_multiple_violations(
        self, validator: GroundingValidator, context: GroundingContext
    ) -> None:
        """Multiple violations in one output are all reported."""
        output = {
            "candidate_assessments": [
                {
                    "concern_id": "fabricated-concern",
                    "supporting_evidence": [
                        {
                            "entity_id": "prop-3",  # assistant attribution
                            "entity_type": "proposition",
                        }
                    ],
                    "contrary_evidence": [],
                    "exact_continuity": True,
                    "historical_trajectory": False,
                    "return_path_continuity": False,
                    "scope_compatible": True,
                    "explanation": "Bad output.",
                }
            ],
            "best_match_concern_id": "fabricated-concern",
            "competing_candidate_ids": ["another-fabricated"],
            "explanation": "Everything is wrong.",
        }
        result = validator.validate(output, context)

        assert result.valid is False
        # Should have at least: fabricated concern in assessment, fabricated
        # best_match, unlisted competitor, and assistant attribution
        reasons = {v.reason for v in result.violations}
        assert GroundingRejectionReason.FABRICATED_CONCERN_ID in reasons
        assert GroundingRejectionReason.UNLISTED_COMPETITOR in reasons
        assert GroundingRejectionReason.UNSUPPORTED_ASSISTANT_ATTRIBUTION in reasons
