"""Standalone behavioral confidence evaluator for SIE identity resolution.

This module implements the behavioral confidence rubric as a composable,
independently testable component. It enforces the semantic contract:

- HIGH: actionable identity evidence AND no material competitor (uniquely actionable).
- MEDIUM: plausible but non-actionable (competition or weaker signals).
- LOW: insufficient evidence (does NOT prove novelty, does NOT prove absence).

Key invariants:
- HIGH requires no material competitor. If any competitor exists, HIGH is downgraded.
- Operational/model failure is NEVER converted to semantic confidence.
  A FAILED stage produces null confidence, handled outside this evaluator.
- Each pipeline domain (identity, IRS, sufficiency, retention, association)
  has its own independent confidence evaluation. Bands from different stages
  are not numerically interchangeable.

Design authority: design.md §3 (Behavioral Confidence and Decision Semantics).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from ..enums import BehavioralConfidenceBand


# ---------------------------------------------------------------------------
# Confidence domain classification
# ---------------------------------------------------------------------------


class ConfidenceDomain(str, Enum):
    """Pipeline domains that produce independent confidence evaluations.

    Each domain has its own rubric interpretation. Confidence values from
    different domains are not comparable or interchangeable.
    """

    IDENTITY = "identity"
    IRS = "irs"
    SUFFICIENCY = "sufficiency"
    RETENTION = "retention"
    ASSOCIATION = "association"


# ---------------------------------------------------------------------------
# Input models for confidence evaluation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IdentitySignals:
    """Signals extracted from identity evaluation for confidence assignment.

    Attributes:
        exact_continuity: Exact concern continuity established.
        historical_trajectory: Historical trajectory continuity holds.
        return_path_continuity: Return-path continuity holds.
        scope_compatible: Semantic scope is compatible.
        is_best_match: This candidate is the evaluator's best match.
        has_material_competitor: At least one material competitor exists.
    """

    exact_continuity: bool
    historical_trajectory: bool
    return_path_continuity: bool
    scope_compatible: bool
    is_best_match: bool
    has_material_competitor: bool


@dataclass(frozen=True)
class SufficiencySignals:
    """Signals for sufficiency confidence evaluation.

    Attributes:
        all_required_channels_succeeded: All policy-required channel families
            completed with at least their minimum successful attempts.
        unresolved_high_irs_signals: Count of unresolved HIGH IRS signals.
        unresolved_medium_irs_signals: Count of unresolved MEDIUM IRS signals.
        material_failed_coverage: Whether a material coverage gap exists
            due to failed/timed-out/unavailable attempts.
        required_lifecycle_scope_covered: Whether required lifecycle states
            and historical scope are covered.
    """

    all_required_channels_succeeded: bool
    unresolved_high_irs_signals: int
    unresolved_medium_irs_signals: int
    material_failed_coverage: bool
    required_lifecycle_scope_covered: bool


@dataclass(frozen=True)
class IRSConfidenceSignals:
    """Signals for IRS (Intelligent Retrieval Signal) confidence evaluation.

    Attributes:
        grounded_in_source_evidence: Whether the signal has concrete
            source evidence references.
        evidence_reference_count: Number of evidence references supporting
            the signal.
        signal_specificity: Whether the signal is specific (e.g., a named
            historical referent) vs. vague/generic.
    """

    grounded_in_source_evidence: bool
    evidence_reference_count: int
    signal_specificity: bool


@dataclass(frozen=True)
class RetentionConfidenceSignals:
    """Signals for retention-level confidence evaluation.

    Attributes:
        has_durable_proposition_evidence: Whether the material contains
            at least one durable proposition.
        has_independent_concern_candidate: Whether the material qualifies
            as an independent concern candidate.
        speaker_is_user: Whether the speaker is the user (not assistant).
    """

    has_durable_proposition_evidence: bool
    has_independent_concern_candidate: bool
    speaker_is_user: bool


@dataclass(frozen=True)
class AssociationConfidenceSignals:
    """Signals for association confidence evaluation.

    Attributes:
        identity_match_confidence: The identity confidence for the owning
            concern (None if no match).
        role_grounded_in_retention: Whether the association role is derived
            from validated retention analysis.
        evidence_supports_role: Whether supporting evidence directly
            corresponds to this association role.
    """

    identity_match_confidence: BehavioralConfidenceBand | None
    role_grounded_in_retention: bool
    evidence_supports_role: bool


# ---------------------------------------------------------------------------
# Confidence evaluation result
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConfidenceEvaluation:
    """Result of a confidence evaluation in a specific domain.

    Attributes:
        domain: Which pipeline domain this confidence applies to.
        band: The assigned confidence band.
        rationale: Concise explanation of why this band was assigned.
    """

    domain: ConfidenceDomain
    band: BehavioralConfidenceBand
    rationale: str


# ---------------------------------------------------------------------------
# BehavioralConfidenceEvaluator
# ---------------------------------------------------------------------------


class BehavioralConfidenceEvaluator:
    """Standalone behavioral confidence evaluator.

    Applies the semantic confidence rubric independently for each pipeline
    domain. This class is stateless and can be composed into any pipeline
    stage that needs to assign confidence.

    Core invariants enforced:
    - HIGH requires actionable evidence AND no material competitor.
    - MEDIUM is plausible but non-actionable.
    - LOW is insufficient evidence (not proof of novelty or absence).
    - This evaluator NEVER produces confidence for failed/incomplete stages.
      Callers must not invoke confidence evaluation when stage_status is FAILED.
    """

    def evaluate_identity(
        self, signals: IdentitySignals
    ) -> ConfidenceEvaluation:
        """Evaluate identity confidence using the priority rubric.

        Priority order determines base confidence:
        1. Exact continuity → HIGH candidate
        2. Historical trajectory → HIGH candidate
        3. Return-path continuity → HIGH candidate
        4. Only scope compatibility → LOW

        Material competition enforcement:
        - If has_material_competitor is True, confidence is capped at MEDIUM.
        - HIGH is only possible when is_best_match AND no material competitor.

        No continuity signals at all → LOW.

        Args:
            signals: Extracted identity evaluation signals.

        Returns:
            ConfidenceEvaluation with the assigned identity band.
        """
        # Determine base signal strength from priority order
        has_strong_continuity = (
            signals.exact_continuity
            or signals.historical_trajectory
            or signals.return_path_continuity
        )

        # Case 1: Strong continuity signal present
        if has_strong_continuity:
            if signals.is_best_match and not signals.has_material_competitor:
                # Uniquely actionable: HIGH
                signal_name = self._strongest_signal_name(signals)
                return ConfidenceEvaluation(
                    domain=ConfidenceDomain.IDENTITY,
                    band=BehavioralConfidenceBand.HIGH,
                    rationale=(
                        f"{signal_name} established with no material competitor. "
                        f"Evidence is uniquely actionable."
                    ),
                )
            else:
                # Strong signal but competition or not best match → MEDIUM
                if signals.has_material_competitor:
                    reason = (
                        f"{self._strongest_signal_name(signals)} present but "
                        f"material competitor exists. Plausible but non-actionable."
                    )
                else:
                    reason = (
                        f"{self._strongest_signal_name(signals)} present but "
                        f"not identified as best match. Plausible but non-actionable."
                    )
                return ConfidenceEvaluation(
                    domain=ConfidenceDomain.IDENTITY,
                    band=BehavioralConfidenceBand.MEDIUM,
                    rationale=reason,
                )

        # Case 2: Only scope compatibility
        if signals.scope_compatible:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.IDENTITY,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    "Only scope compatibility established. Insufficient evidence "
                    "for identity continuity. Does not prove novelty."
                ),
            )

        # Case 3: No continuity signals at all
        return ConfidenceEvaluation(
            domain=ConfidenceDomain.IDENTITY,
            band=BehavioralConfidenceBand.LOW,
            rationale=(
                "No identity continuity signals present. Insufficient evidence. "
                "Does not prove novelty or absence of match."
            ),
        )

    def evaluate_sufficiency(
        self, signals: SufficiencySignals
    ) -> ConfidenceEvaluation:
        """Evaluate retrieval-sufficiency confidence.

        HIGH: All required channels succeeded, no unresolved HIGH/MEDIUM IRS
              signals, no material failed coverage, required scope covered.
        MEDIUM: Minor gaps (e.g., some MEDIUM IRS unresolved but required
                channels succeeded and scope covered).
        LOW: Material coverage gaps, unresolved HIGH signals, or required
             channels failed.

        Args:
            signals: Sufficiency evaluation signals.

        Returns:
            ConfidenceEvaluation with the assigned sufficiency band.
        """
        # Any unresolved HIGH IRS signal blocks HIGH sufficiency
        if signals.unresolved_high_irs_signals > 0:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.SUFFICIENCY,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    f"{signals.unresolved_high_irs_signals} unresolved HIGH IRS "
                    f"signal(s) block retrieval adequacy."
                ),
            )

        # Material failed coverage blocks HIGH sufficiency
        if signals.material_failed_coverage:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.SUFFICIENCY,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    "Material coverage gap from failed/timed-out/unavailable "
                    "attempts. Retrieval adequacy cannot be established."
                ),
            )

        # Required channels not all succeeded
        if not signals.all_required_channels_succeeded:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.SUFFICIENCY,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    "Not all policy-required channel families completed "
                    "successfully. Retrieval adequacy not established."
                ),
            )

        # Required lifecycle scope not covered
        if not signals.required_lifecycle_scope_covered:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.SUFFICIENCY,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    "Required lifecycle/historical scope not covered. "
                    "Retrieval may have missed eligible concerns."
                ),
            )

        # Unresolved MEDIUM IRS signals reduce to MEDIUM sufficiency
        if signals.unresolved_medium_irs_signals > 0:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.SUFFICIENCY,
                band=BehavioralConfidenceBand.MEDIUM,
                rationale=(
                    f"{signals.unresolved_medium_irs_signals} unresolved MEDIUM "
                    f"IRS signal(s). Retrieval mostly adequate but gaps remain."
                ),
            )

        # All criteria met
        return ConfidenceEvaluation(
            domain=ConfidenceDomain.SUFFICIENCY,
            band=BehavioralConfidenceBand.HIGH,
            rationale=(
                "All required channels succeeded, no unresolved IRS signals, "
                "no material coverage gaps, required scope covered. "
                "Retrieval is positively adequate."
            ),
        )

    def evaluate_irs(
        self, signals: IRSConfidenceSignals
    ) -> ConfidenceEvaluation:
        """Evaluate confidence in an IRS signal itself.

        HIGH: Grounded in specific source evidence with multiple references.
        MEDIUM: Grounded but limited evidence or low specificity.
        LOW: Not adequately grounded in source evidence.

        Args:
            signals: IRS signal confidence signals.

        Returns:
            ConfidenceEvaluation with the assigned IRS signal band.
        """
        if not signals.grounded_in_source_evidence:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.IRS,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    "IRS signal not grounded in source evidence. "
                    "Insufficient basis to direct widening."
                ),
            )

        if signals.signal_specificity and signals.evidence_reference_count >= 2:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.IRS,
                band=BehavioralConfidenceBand.HIGH,
                rationale=(
                    "IRS signal grounded in specific source evidence with "
                    f"{signals.evidence_reference_count} references. "
                    "Strong basis for directed retrieval."
                ),
            )

        return ConfidenceEvaluation(
            domain=ConfidenceDomain.IRS,
            band=BehavioralConfidenceBand.MEDIUM,
            rationale=(
                "IRS signal has some grounding but limited specificity or "
                "evidence. Plausible retrieval gap indicator."
            ),
        )

    def evaluate_retention(
        self, signals: RetentionConfidenceSignals
    ) -> ConfidenceEvaluation:
        """Evaluate retention-level confidence.

        HIGH: User-authored durable proposition with independent concern eligibility.
        MEDIUM: Has durable evidence but may not qualify as independent concern.
        LOW: Insufficient for durable retention.

        Args:
            signals: Retention confidence signals.

        Returns:
            ConfidenceEvaluation with the assigned retention band.
        """
        if not signals.speaker_is_user:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.RETENTION,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    "Non-user-authored content cannot independently establish "
                    "durable retention. Requires user-grounded evidence."
                ),
            )

        if (
            signals.has_durable_proposition_evidence
            and signals.has_independent_concern_candidate
        ):
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.RETENTION,
                band=BehavioralConfidenceBand.HIGH,
                rationale=(
                    "User-authored material with durable proposition evidence "
                    "and independent concern eligibility. Fully actionable."
                ),
            )

        if signals.has_durable_proposition_evidence:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.RETENTION,
                band=BehavioralConfidenceBand.MEDIUM,
                rationale=(
                    "User-authored durable proposition evidence present but "
                    "does not independently qualify as concern candidate."
                ),
            )

        return ConfidenceEvaluation(
            domain=ConfidenceDomain.RETENTION,
            band=BehavioralConfidenceBand.LOW,
            rationale=(
                "Insufficient durable proposition evidence. Does not meet "
                "retention threshold for concern creation."
            ),
        )

    def evaluate_association(
        self, signals: AssociationConfidenceSignals
    ) -> ConfidenceEvaluation:
        """Evaluate association confidence for a proposition-to-concern link.

        HIGH: Identity match is HIGH and association role is grounded in
              retention analysis with supporting evidence.
        MEDIUM: Identity match is present and role is retention-grounded,
                but identity confidence is not HIGH.
        LOW: Identity match absent or role not adequately grounded.

        Args:
            signals: Association confidence signals.

        Returns:
            ConfidenceEvaluation with the assigned association band.
        """
        if signals.identity_match_confidence is None:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.ASSOCIATION,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    "No identity match established. Association cannot be "
                    "confidently assigned without owning concern."
                ),
            )

        if not signals.role_grounded_in_retention:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.ASSOCIATION,
                band=BehavioralConfidenceBand.LOW,
                rationale=(
                    "Association role not grounded in validated retention "
                    "analysis. Insufficient basis for durable association."
                ),
            )

        if (
            signals.identity_match_confidence == BehavioralConfidenceBand.HIGH
            and signals.evidence_supports_role
        ):
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.ASSOCIATION,
                band=BehavioralConfidenceBand.HIGH,
                rationale=(
                    "HIGH identity match with retention-grounded role and "
                    "supporting evidence. Association is actionable."
                ),
            )

        if signals.identity_match_confidence == BehavioralConfidenceBand.HIGH:
            return ConfidenceEvaluation(
                domain=ConfidenceDomain.ASSOCIATION,
                band=BehavioralConfidenceBand.MEDIUM,
                rationale=(
                    "HIGH identity match and retention-grounded role, but "
                    "evidence does not directly support this specific role."
                ),
            )

        # MEDIUM or LOW identity match with grounded role
        return ConfidenceEvaluation(
            domain=ConfidenceDomain.ASSOCIATION,
            band=BehavioralConfidenceBand.MEDIUM,
            rationale=(
                f"Identity match is {signals.identity_match_confidence.value} "
                f"with retention-grounded role. Plausible but not uniquely actionable."
            ),
        )

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _strongest_signal_name(signals: IdentitySignals) -> str:
        """Return a human-readable name of the strongest continuity signal."""
        if signals.exact_continuity:
            return "Exact continuity"
        if signals.historical_trajectory:
            return "Historical trajectory"
        if signals.return_path_continuity:
            return "Return-path continuity"
        return "Scope compatibility"
