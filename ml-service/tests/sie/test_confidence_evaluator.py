"""Tests for the standalone BehavioralConfidenceEvaluator.

Verifies the confidence rubric for each pipeline domain:
- Identity: priority rubric with competitor enforcement.
- Sufficiency: channel coverage and IRS signal blocking.
- IRS: grounding and specificity.
- Retention: user-authored, durable, and independent.
- Association: identity-grounded, retention-validated roles.

Key invariants tested:
- HIGH requires no material competitor (identity domain).
- LOW does not prove novelty (it's insufficient evidence).
- Domains are independent (different signals produce different outcomes).
- Operational failure never becomes semantic confidence (handled by caller).
"""

from __future__ import annotations

import pytest

from app.sie.enums import BehavioralConfidenceBand
from app.sie.evaluator.confidence_evaluator import (
    AssociationConfidenceSignals,
    BehavioralConfidenceEvaluator,
    ConfidenceDomain,
    ConfidenceEvaluation,
    IdentitySignals,
    IRSConfidenceSignals,
    RetentionConfidenceSignals,
    SufficiencySignals,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def evaluator() -> BehavioralConfidenceEvaluator:
    """Create a fresh evaluator instance."""
    return BehavioralConfidenceEvaluator()


# ---------------------------------------------------------------------------
# Tests: Identity domain
# ---------------------------------------------------------------------------


class TestIdentityConfidence:
    """Tests for identity confidence evaluation."""

    def test_exact_continuity_no_competitor_is_high(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Exact continuity + best match + no competitor → HIGH."""
        signals = IdentitySignals(
            exact_continuity=True,
            historical_trajectory=False,
            return_path_continuity=False,
            scope_compatible=True,
            is_best_match=True,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.domain == ConfidenceDomain.IDENTITY
        assert result.band == BehavioralConfidenceBand.HIGH
        assert "Exact continuity" in result.rationale

    def test_exact_continuity_with_competitor_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Exact continuity + competitor → MEDIUM (competitor caps HIGH)."""
        signals = IdentitySignals(
            exact_continuity=True,
            historical_trajectory=False,
            return_path_continuity=False,
            scope_compatible=True,
            is_best_match=True,
            has_material_competitor=True,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM
        assert "competitor" in result.rationale.lower()

    def test_historical_trajectory_no_competitor_is_high(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Historical trajectory + best match + no competitor → HIGH."""
        signals = IdentitySignals(
            exact_continuity=False,
            historical_trajectory=True,
            return_path_continuity=False,
            scope_compatible=True,
            is_best_match=True,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.HIGH
        assert "Historical trajectory" in result.rationale

    def test_historical_trajectory_with_competitor_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Historical trajectory + competitor → MEDIUM."""
        signals = IdentitySignals(
            exact_continuity=False,
            historical_trajectory=True,
            return_path_continuity=False,
            scope_compatible=True,
            is_best_match=True,
            has_material_competitor=True,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM

    def test_return_path_no_competitor_is_high(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Return-path continuity + best match + no competitor → HIGH."""
        signals = IdentitySignals(
            exact_continuity=False,
            historical_trajectory=False,
            return_path_continuity=True,
            scope_compatible=True,
            is_best_match=True,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.HIGH
        assert "Return-path" in result.rationale

    def test_return_path_with_competitor_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Return-path continuity + competitor → MEDIUM."""
        signals = IdentitySignals(
            exact_continuity=False,
            historical_trajectory=False,
            return_path_continuity=True,
            scope_compatible=True,
            is_best_match=True,
            has_material_competitor=True,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM

    def test_scope_compatible_only_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Only scope compatibility (no continuity) → LOW."""
        signals = IdentitySignals(
            exact_continuity=False,
            historical_trajectory=False,
            return_path_continuity=False,
            scope_compatible=True,
            is_best_match=True,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.LOW
        assert "insufficient" in result.rationale.lower()

    def test_no_signals_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """No continuity signals at all → LOW."""
        signals = IdentitySignals(
            exact_continuity=False,
            historical_trajectory=False,
            return_path_continuity=False,
            scope_compatible=False,
            is_best_match=True,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.LOW
        assert "novelty" in result.rationale.lower()

    def test_not_best_match_with_strong_signal_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Strong signal but not best match → MEDIUM."""
        signals = IdentitySignals(
            exact_continuity=True,
            historical_trajectory=True,
            return_path_continuity=True,
            scope_compatible=True,
            is_best_match=False,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM

    def test_high_requires_no_material_competitor_invariant(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """HIGH is impossible when has_material_competitor=True (invariant)."""
        # Try every strong signal combination with competitor
        for exact, hist, rpath in [
            (True, False, False),
            (False, True, False),
            (False, False, True),
            (True, True, True),
        ]:
            signals = IdentitySignals(
                exact_continuity=exact,
                historical_trajectory=hist,
                return_path_continuity=rpath,
                scope_compatible=True,
                is_best_match=True,
                has_material_competitor=True,
            )
            result = evaluator.evaluate_identity(signals)
            assert result.band != BehavioralConfidenceBand.HIGH, (
                f"HIGH should be impossible with competitor: "
                f"exact={exact}, hist={hist}, rpath={rpath}"
            )

    def test_low_does_not_prove_novelty(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """LOW confidence rationale explicitly states it does not prove novelty."""
        signals = IdentitySignals(
            exact_continuity=False,
            historical_trajectory=False,
            return_path_continuity=False,
            scope_compatible=False,
            is_best_match=True,
            has_material_competitor=False,
        )
        result = evaluator.evaluate_identity(signals)

        assert result.band == BehavioralConfidenceBand.LOW
        assert "not prove novelty" in result.rationale.lower() or (
            "does not prove" in result.rationale.lower()
        )


# ---------------------------------------------------------------------------
# Tests: Sufficiency domain
# ---------------------------------------------------------------------------


class TestSufficiencyConfidence:
    """Tests for retrieval-sufficiency confidence evaluation."""

    def test_all_criteria_met_is_high(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """All required channels succeeded, no gaps, no signals → HIGH."""
        signals = SufficiencySignals(
            all_required_channels_succeeded=True,
            unresolved_high_irs_signals=0,
            unresolved_medium_irs_signals=0,
            material_failed_coverage=False,
            required_lifecycle_scope_covered=True,
        )
        result = evaluator.evaluate_sufficiency(signals)

        assert result.domain == ConfidenceDomain.SUFFICIENCY
        assert result.band == BehavioralConfidenceBand.HIGH

    def test_unresolved_high_irs_blocks_adequacy(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Unresolved HIGH IRS signal → LOW sufficiency."""
        signals = SufficiencySignals(
            all_required_channels_succeeded=True,
            unresolved_high_irs_signals=1,
            unresolved_medium_irs_signals=0,
            material_failed_coverage=False,
            required_lifecycle_scope_covered=True,
        )
        result = evaluator.evaluate_sufficiency(signals)

        assert result.band == BehavioralConfidenceBand.LOW

    def test_material_failed_coverage_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Material failed coverage → LOW sufficiency."""
        signals = SufficiencySignals(
            all_required_channels_succeeded=True,
            unresolved_high_irs_signals=0,
            unresolved_medium_irs_signals=0,
            material_failed_coverage=True,
            required_lifecycle_scope_covered=True,
        )
        result = evaluator.evaluate_sufficiency(signals)

        assert result.band == BehavioralConfidenceBand.LOW

    def test_required_channels_failed_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Required channels not all succeeded → LOW."""
        signals = SufficiencySignals(
            all_required_channels_succeeded=False,
            unresolved_high_irs_signals=0,
            unresolved_medium_irs_signals=0,
            material_failed_coverage=False,
            required_lifecycle_scope_covered=True,
        )
        result = evaluator.evaluate_sufficiency(signals)

        assert result.band == BehavioralConfidenceBand.LOW

    def test_lifecycle_scope_not_covered_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Required lifecycle scope not covered → LOW."""
        signals = SufficiencySignals(
            all_required_channels_succeeded=True,
            unresolved_high_irs_signals=0,
            unresolved_medium_irs_signals=0,
            material_failed_coverage=False,
            required_lifecycle_scope_covered=False,
        )
        result = evaluator.evaluate_sufficiency(signals)

        assert result.band == BehavioralConfidenceBand.LOW

    def test_unresolved_medium_irs_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Only MEDIUM IRS unresolved (no HIGH, no failures) → MEDIUM."""
        signals = SufficiencySignals(
            all_required_channels_succeeded=True,
            unresolved_high_irs_signals=0,
            unresolved_medium_irs_signals=2,
            material_failed_coverage=False,
            required_lifecycle_scope_covered=True,
        )
        result = evaluator.evaluate_sufficiency(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM


# ---------------------------------------------------------------------------
# Tests: IRS domain
# ---------------------------------------------------------------------------


class TestIRSConfidence:
    """Tests for IRS signal confidence evaluation."""

    def test_grounded_specific_multiple_refs_is_high(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Grounded, specific, multiple evidence references → HIGH."""
        signals = IRSConfidenceSignals(
            grounded_in_source_evidence=True,
            evidence_reference_count=3,
            signal_specificity=True,
        )
        result = evaluator.evaluate_irs(signals)

        assert result.domain == ConfidenceDomain.IRS
        assert result.band == BehavioralConfidenceBand.HIGH

    def test_grounded_but_not_specific_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Grounded but not specific or few references → MEDIUM."""
        signals = IRSConfidenceSignals(
            grounded_in_source_evidence=True,
            evidence_reference_count=1,
            signal_specificity=False,
        )
        result = evaluator.evaluate_irs(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM

    def test_not_grounded_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Not grounded in source evidence → LOW."""
        signals = IRSConfidenceSignals(
            grounded_in_source_evidence=False,
            evidence_reference_count=5,
            signal_specificity=True,
        )
        result = evaluator.evaluate_irs(signals)

        assert result.band == BehavioralConfidenceBand.LOW


# ---------------------------------------------------------------------------
# Tests: Retention domain
# ---------------------------------------------------------------------------


class TestRetentionConfidence:
    """Tests for retention confidence evaluation."""

    def test_user_durable_independent_is_high(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """User-authored + durable + independent candidate → HIGH."""
        signals = RetentionConfidenceSignals(
            has_durable_proposition_evidence=True,
            has_independent_concern_candidate=True,
            speaker_is_user=True,
        )
        result = evaluator.evaluate_retention(signals)

        assert result.domain == ConfidenceDomain.RETENTION
        assert result.band == BehavioralConfidenceBand.HIGH

    def test_user_durable_not_independent_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """User-authored + durable but not independent → MEDIUM."""
        signals = RetentionConfidenceSignals(
            has_durable_proposition_evidence=True,
            has_independent_concern_candidate=False,
            speaker_is_user=True,
        )
        result = evaluator.evaluate_retention(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM

    def test_user_not_durable_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """User-authored but not durable → LOW."""
        signals = RetentionConfidenceSignals(
            has_durable_proposition_evidence=False,
            has_independent_concern_candidate=False,
            speaker_is_user=True,
        )
        result = evaluator.evaluate_retention(signals)

        assert result.band == BehavioralConfidenceBand.LOW

    def test_assistant_authored_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Assistant-authored content → LOW (cannot establish user concern)."""
        signals = RetentionConfidenceSignals(
            has_durable_proposition_evidence=True,
            has_independent_concern_candidate=True,
            speaker_is_user=False,
        )
        result = evaluator.evaluate_retention(signals)

        assert result.band == BehavioralConfidenceBand.LOW
        assert "non-user" in result.rationale.lower() or (
            "cannot independently" in result.rationale.lower()
        )


# ---------------------------------------------------------------------------
# Tests: Association domain
# ---------------------------------------------------------------------------


class TestAssociationConfidence:
    """Tests for association confidence evaluation."""

    def test_high_identity_grounded_with_evidence_is_high(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """HIGH identity + grounded role + evidence supports role → HIGH."""
        signals = AssociationConfidenceSignals(
            identity_match_confidence=BehavioralConfidenceBand.HIGH,
            role_grounded_in_retention=True,
            evidence_supports_role=True,
        )
        result = evaluator.evaluate_association(signals)

        assert result.domain == ConfidenceDomain.ASSOCIATION
        assert result.band == BehavioralConfidenceBand.HIGH

    def test_high_identity_grounded_no_evidence_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """HIGH identity + grounded role but evidence doesn't support → MEDIUM."""
        signals = AssociationConfidenceSignals(
            identity_match_confidence=BehavioralConfidenceBand.HIGH,
            role_grounded_in_retention=True,
            evidence_supports_role=False,
        )
        result = evaluator.evaluate_association(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM

    def test_medium_identity_grounded_is_medium(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """MEDIUM identity + grounded role → MEDIUM."""
        signals = AssociationConfidenceSignals(
            identity_match_confidence=BehavioralConfidenceBand.MEDIUM,
            role_grounded_in_retention=True,
            evidence_supports_role=True,
        )
        result = evaluator.evaluate_association(signals)

        assert result.band == BehavioralConfidenceBand.MEDIUM

    def test_no_identity_match_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """No identity match → LOW association confidence."""
        signals = AssociationConfidenceSignals(
            identity_match_confidence=None,
            role_grounded_in_retention=True,
            evidence_supports_role=True,
        )
        result = evaluator.evaluate_association(signals)

        assert result.band == BehavioralConfidenceBand.LOW

    def test_role_not_retention_grounded_is_low(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Role not grounded in retention → LOW regardless of identity."""
        signals = AssociationConfidenceSignals(
            identity_match_confidence=BehavioralConfidenceBand.HIGH,
            role_grounded_in_retention=False,
            evidence_supports_role=True,
        )
        result = evaluator.evaluate_association(signals)

        assert result.band == BehavioralConfidenceBand.LOW


# ---------------------------------------------------------------------------
# Tests: Domain independence
# ---------------------------------------------------------------------------


class TestDomainIndependence:
    """Tests verifying that confidence domains are truly independent."""

    def test_each_domain_produces_correct_domain_field(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """Each evaluate_* method tags the result with its domain."""
        identity_result = evaluator.evaluate_identity(
            IdentitySignals(
                exact_continuity=True,
                historical_trajectory=False,
                return_path_continuity=False,
                scope_compatible=True,
                is_best_match=True,
                has_material_competitor=False,
            )
        )
        sufficiency_result = evaluator.evaluate_sufficiency(
            SufficiencySignals(
                all_required_channels_succeeded=True,
                unresolved_high_irs_signals=0,
                unresolved_medium_irs_signals=0,
                material_failed_coverage=False,
                required_lifecycle_scope_covered=True,
            )
        )
        irs_result = evaluator.evaluate_irs(
            IRSConfidenceSignals(
                grounded_in_source_evidence=True,
                evidence_reference_count=3,
                signal_specificity=True,
            )
        )
        retention_result = evaluator.evaluate_retention(
            RetentionConfidenceSignals(
                has_durable_proposition_evidence=True,
                has_independent_concern_candidate=True,
                speaker_is_user=True,
            )
        )
        association_result = evaluator.evaluate_association(
            AssociationConfidenceSignals(
                identity_match_confidence=BehavioralConfidenceBand.HIGH,
                role_grounded_in_retention=True,
                evidence_supports_role=True,
            )
        )

        assert identity_result.domain == ConfidenceDomain.IDENTITY
        assert sufficiency_result.domain == ConfidenceDomain.SUFFICIENCY
        assert irs_result.domain == ConfidenceDomain.IRS
        assert retention_result.domain == ConfidenceDomain.RETENTION
        assert association_result.domain == ConfidenceDomain.ASSOCIATION

    def test_same_band_different_domains_are_independent(
        self, evaluator: BehavioralConfidenceEvaluator
    ) -> None:
        """HIGH identity does not imply HIGH sufficiency — they're independent."""
        identity_high = evaluator.evaluate_identity(
            IdentitySignals(
                exact_continuity=True,
                historical_trajectory=False,
                return_path_continuity=False,
                scope_compatible=True,
                is_best_match=True,
                has_material_competitor=False,
            )
        )
        sufficiency_low = evaluator.evaluate_sufficiency(
            SufficiencySignals(
                all_required_channels_succeeded=False,
                unresolved_high_irs_signals=1,
                unresolved_medium_irs_signals=0,
                material_failed_coverage=True,
                required_lifecycle_scope_covered=False,
            )
        )

        assert identity_high.band == BehavioralConfidenceBand.HIGH
        assert sufficiency_low.band == BehavioralConfidenceBand.LOW
        # Domains are truly independent
        assert identity_high.domain != sufficiency_low.domain
