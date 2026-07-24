"""Semantic quality scorer for SIE identity resolution evaluation.

Computes quality metrics required by Requirement 12, AC 3:
- False existing-concern assignment rate
- False new-concern creation (false novelty) rate
- Missed reactivation rate
- Unresolved/defer calibration
- Retrieval-sufficiency error rate
- Retry/version determinism

Each metric is computed independently from pipeline results compared against
golden labels. Numeric production-readiness thresholds are NOT hardcoded here;
they are a release-policy decision (Requirement 12, AC 8-9) and reported as
PENDING_APPROVAL until explicitly approved and recorded.

Design authority: consolidated final design.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Metric result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MetricResult:
    """A single quality metric measurement.

    Attributes:
        name: Canonical metric name matching scorer contract.
        value: Computed metric value (typically a rate 0.0–1.0 or count).
        denominator: Number of applicable cases for this metric.
        numerator: Number of cases that contributed to the error/success.
        threshold: Approved threshold or "PENDING_APPROVAL".
        passed: Whether the metric meets threshold. None if threshold pending.
        details: Per-case breakdown for debugging.
    """

    name: str
    value: float
    denominator: int
    numerator: int
    threshold: str
    passed: bool | None
    details: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class QualityReport:
    """Aggregate quality report for an evaluation run.

    Attributes:
        metrics: Individual metric results keyed by canonical name.
        total_cases: Total number of golden cases evaluated.
        total_passed: Cases where all critical assertions passed.
        total_failed: Cases where at least one critical assertion failed.
        all_thresholds_approved: Whether all thresholds have been set.
        production_ready: True only if all thresholds approved and all pass.
    """

    metrics: dict[str, MetricResult] = field(default_factory=dict)
    total_cases: int = 0
    total_passed: int = 0
    total_failed: int = 0
    all_thresholds_approved: bool = False
    production_ready: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Serialize report for structured output."""
        return {
            "total_cases": self.total_cases,
            "total_passed": self.total_passed,
            "total_failed": self.total_failed,
            "all_thresholds_approved": self.all_thresholds_approved,
            "production_ready": self.production_ready,
            "metrics": {
                name: {
                    "value": m.value,
                    "numerator": m.numerator,
                    "denominator": m.denominator,
                    "threshold": m.threshold,
                    "passed": m.passed,
                }
                for name, m in self.metrics.items()
            },
        }


# ---------------------------------------------------------------------------
# Scoring primitives
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CaseResult:
    """Result of scoring one evaluation case.

    Attributes:
        case_id: The golden case identifier (e.g., "IRID-001").
        expected: The expected identity result from the golden case.
        actual: The actual identity result produced by the pipeline.
        outcome_correct: Whether outcome matches expected.
        action_correct: Whether action matches expected.
        matched_concern_correct: Whether matched concern ID matches.
        confidence_correct: Whether identity confidence band matches.
        sufficiency_correct: Whether sufficiency confidence band matches.
        forbidden_violation: True if actual matches any forbidden outcome.
        critical_assertions_passed: True if all critical assertions hold.
        contributing_metrics: Which quality metrics this case contributes to.
    """

    case_id: str
    expected: dict[str, Any]
    actual: dict[str, Any]
    outcome_correct: bool
    action_correct: bool
    matched_concern_correct: bool
    confidence_correct: bool
    sufficiency_correct: bool
    forbidden_violation: bool
    critical_assertions_passed: bool
    contributing_metrics: list[str]


# ---------------------------------------------------------------------------
# Quality Scorer
# ---------------------------------------------------------------------------


class IdentityResolutionQualityScorer:
    """Computes Requirement 12.3 quality metrics from pipeline results.

    The scorer takes a list of (golden_case, actual_result) pairs and
    computes each metric separately. It does not invent thresholds.

    Usage:
        scorer = IdentityResolutionQualityScorer()
        report = scorer.score(cases_with_results)
    """

    # Thresholds are PENDING_APPROVAL — they must be explicitly approved
    # before production release per Requirement 12, AC 8-9.
    THRESHOLD_STATUS = "PENDING_APPROVAL"

    def score(
        self,
        cases_with_results: list[tuple[dict[str, Any], dict[str, Any]]],
    ) -> QualityReport:
        """Score all cases and produce a quality report.

        Args:
            cases_with_results: List of (golden_case, actual_result) tuples.
                golden_case: Full golden case dict (from IRID-NNN.json).
                actual_result: Dict with at minimum: outcome, action,
                    matchedConcernId, identityConfidence, sufficiencyConfidence,
                    reactivation, mergeRedirectFollowed.

        Returns:
            QualityReport with all metrics computed.
        """
        case_results = [
            self._score_case(golden, actual)
            for golden, actual in cases_with_results
        ]

        report = QualityReport(
            total_cases=len(case_results),
            total_passed=sum(
                1 for cr in case_results if cr.critical_assertions_passed
            ),
            total_failed=sum(
                1 for cr in case_results if not cr.critical_assertions_passed
            ),
        )

        # Compute each metric independently
        report.metrics["false_assignment_rate"] = self._compute_false_assignment(
            case_results
        )
        report.metrics["false_novelty_rate"] = self._compute_false_novelty(
            case_results
        )
        report.metrics["missed_reactivation_rate"] = (
            self._compute_missed_reactivation(case_results)
        )
        report.metrics["unresolved_defer_calibration"] = (
            self._compute_unresolved_defer_calibration(case_results)
        )
        report.metrics["retrieval_sufficiency_error_rate"] = (
            self._compute_retrieval_sufficiency_error(case_results)
        )
        report.metrics["retry_version_determinism"] = (
            self._compute_retry_determinism(case_results)
        )

        # Check if all thresholds are approved
        report.all_thresholds_approved = all(
            m.threshold != self.THRESHOLD_STATUS
            for m in report.metrics.values()
        )

        # Production readiness requires ALL thresholds approved and ALL pass
        report.production_ready = (
            report.all_thresholds_approved
            and all(m.passed is True for m in report.metrics.values())
            and report.total_failed == 0
        )

        return report

    def _score_case(
        self,
        golden: dict[str, Any],
        actual: dict[str, Any],
    ) -> CaseResult:
        """Score a single case against its golden label."""
        expected = golden["expectedIdentityResult"]

        outcome_correct = actual.get("outcome") == expected["outcome"]
        action_correct = actual.get("action") == expected["action"]
        matched_concern_correct = (
            actual.get("matchedConcernId") == expected.get("matchedConcernId")
        )
        confidence_correct = (
            actual.get("identityConfidence") == expected.get("identityConfidence")
        )
        sufficiency_correct = (
            actual.get("sufficiencyConfidence")
            == expected.get("sufficiencyConfidence")
        )

        # Check forbidden outcomes
        forbidden_violation = self._check_forbidden_outcomes(
            golden["forbiddenOutcomes"], actual
        )

        # Critical assertions are all-or-nothing: outcome + action + concern
        critical_assertions_passed = (
            outcome_correct
            and action_correct
            and matched_concern_correct
            and not forbidden_violation
        )

        return CaseResult(
            case_id=golden["id"],
            expected=expected,
            actual=actual,
            outcome_correct=outcome_correct,
            action_correct=action_correct,
            matched_concern_correct=matched_concern_correct,
            confidence_correct=confidence_correct,
            sufficiency_correct=sufficiency_correct,
            forbidden_violation=forbidden_violation,
            critical_assertions_passed=critical_assertions_passed,
            contributing_metrics=golden.get("qualityMetrics", []),
        )

    def _check_forbidden_outcomes(
        self,
        forbidden: list[dict[str, Any]],
        actual: dict[str, Any],
    ) -> bool:
        """Return True if the actual result matches any forbidden outcome."""
        for f in forbidden:
            matches_outcome = (
                f.get("outcome") is None or f["outcome"] == actual.get("outcome")
            )
            matches_action = (
                f.get("action") is None or f["action"] == actual.get("action")
            )
            matches_concern = (
                f.get("matchedConcernId") is None
                or f["matchedConcernId"] == actual.get("matchedConcernId")
            )
            if matches_outcome and matches_action and matches_concern:
                return True
        return False

    # -------------------------------------------------------------------
    # Individual metric computations
    # -------------------------------------------------------------------

    def _compute_false_assignment(
        self, case_results: list[CaseResult]
    ) -> MetricResult:
        """False assignment: actual assigned to wrong existing concern.

        Denominator: cases tagged with 'false_assignment' metric.
        Numerator: among those, cases where actual outcome is YES/ASSIGN_EXISTING
        but matchedConcernId differs from expected, OR where a forbidden
        assignment outcome was produced.
        """
        applicable = [
            cr for cr in case_results
            if "false_assignment" in cr.contributing_metrics
        ]
        if not applicable:
            return MetricResult(
                name="false_assignment_rate",
                value=0.0,
                denominator=0,
                numerator=0,
                threshold=self.THRESHOLD_STATUS,
                passed=None,
            )

        errors = []
        for cr in applicable:
            is_false_assignment = (
                cr.actual.get("outcome") == "YES"
                and cr.actual.get("action") == "ASSIGN_EXISTING"
                and cr.actual.get("matchedConcernId") != cr.expected.get("matchedConcernId")
            )
            if is_false_assignment or cr.forbidden_violation:
                errors.append({"case_id": cr.case_id, "actual": cr.actual})

        rate = len(errors) / len(applicable) if applicable else 0.0
        return MetricResult(
            name="false_assignment_rate",
            value=rate,
            denominator=len(applicable),
            numerator=len(errors),
            threshold=self.THRESHOLD_STATUS,
            passed=None,  # Cannot determine without approved threshold
            details=errors,
        )

    def _compute_false_novelty(
        self, case_results: list[CaseResult]
    ) -> MetricResult:
        """False novelty: actual proposed new concern when match exists.

        Denominator: cases tagged with 'false_novelty' metric.
        Numerator: among those, cases where actual is NO/PROPOSE_NEW but
        expected was YES/ASSIGN_EXISTING or another non-novelty outcome.
        """
        applicable = [
            cr for cr in case_results
            if "false_novelty" in cr.contributing_metrics
        ]
        if not applicable:
            return MetricResult(
                name="false_novelty_rate",
                value=0.0,
                denominator=0,
                numerator=0,
                threshold=self.THRESHOLD_STATUS,
                passed=None,
            )

        errors = []
        for cr in applicable:
            is_false_novelty = (
                cr.actual.get("outcome") == "NO"
                and cr.actual.get("action") == "PROPOSE_NEW"
                and cr.expected.get("outcome") != "NO"
            )
            if is_false_novelty:
                errors.append({"case_id": cr.case_id, "actual": cr.actual})

        rate = len(errors) / len(applicable) if applicable else 0.0
        return MetricResult(
            name="false_novelty_rate",
            value=rate,
            denominator=len(applicable),
            numerator=len(errors),
            threshold=self.THRESHOLD_STATUS,
            passed=None,
            details=errors,
        )

    def _compute_missed_reactivation(
        self, case_results: list[CaseResult]
    ) -> MetricResult:
        """Missed reactivation: dormant/retired should have been reactivated.

        Denominator: cases tagged with 'missed_reactivation'.
        Numerator: among those, cases where expected reactivation=True but
        actual did not produce reactivation.
        """
        applicable = [
            cr for cr in case_results
            if "missed_reactivation" in cr.contributing_metrics
        ]
        if not applicable:
            return MetricResult(
                name="missed_reactivation_rate",
                value=0.0,
                denominator=0,
                numerator=0,
                threshold=self.THRESHOLD_STATUS,
                passed=None,
            )

        errors = []
        for cr in applicable:
            expected_reactivation = cr.expected.get("reactivation", False)
            actual_reactivation = cr.actual.get("reactivation", False)
            if expected_reactivation and not actual_reactivation:
                errors.append({"case_id": cr.case_id, "actual": cr.actual})

        rate = len(errors) / len(applicable) if applicable else 0.0
        return MetricResult(
            name="missed_reactivation_rate",
            value=rate,
            denominator=len(applicable),
            numerator=len(errors),
            threshold=self.THRESHOLD_STATUS,
            passed=None,
            details=errors,
        )

    def _compute_unresolved_defer_calibration(
        self, case_results: list[CaseResult]
    ) -> MetricResult:
        """Unresolved/defer calibration error.

        Denominator: cases tagged with 'unresolved_defer_calibration'.
        Numerator: cases where either:
          - Expected UNRESOLVED/DEFER but actual resolved prematurely, OR
          - Expected resolved but actual produced UNRESOLVED/DEFER.
        """
        applicable = [
            cr for cr in case_results
            if "unresolved_defer_calibration" in cr.contributing_metrics
        ]
        if not applicable:
            return MetricResult(
                name="unresolved_defer_calibration",
                value=0.0,
                denominator=0,
                numerator=0,
                threshold=self.THRESHOLD_STATUS,
                passed=None,
            )

        pending_outcomes = {"UNRESOLVED", "DEFER", "RETRIEVAL_INCONCLUSIVE"}
        errors = []
        for cr in applicable:
            expected_is_pending = cr.expected.get("outcome") in pending_outcomes
            actual_is_pending = cr.actual.get("outcome") in pending_outcomes

            # Calibration error: mismatch between expected and actual
            # regarding whether the case should be deferred
            if expected_is_pending != actual_is_pending:
                errors.append({
                    "case_id": cr.case_id,
                    "expected_pending": expected_is_pending,
                    "actual_pending": actual_is_pending,
                    "actual": cr.actual,
                })

        rate = len(errors) / len(applicable) if applicable else 0.0
        return MetricResult(
            name="unresolved_defer_calibration",
            value=rate,
            denominator=len(applicable),
            numerator=len(errors),
            threshold=self.THRESHOLD_STATUS,
            passed=None,
            details=errors,
        )

    def _compute_retrieval_sufficiency_error(
        self, case_results: list[CaseResult]
    ) -> MetricResult:
        """Retrieval-sufficiency error: gate produced wrong adequacy judgment.

        Denominator: cases tagged with 'retrieval_sufficiency_error'.
        Numerator: cases where:
          - Expected RETRIEVAL_INCONCLUSIVE but actual claims adequate, OR
          - Expected adequate (YES/NO) but actual returns RETRIEVAL_INCONCLUSIVE.
        """
        applicable = [
            cr for cr in case_results
            if "retrieval_sufficiency_error" in cr.contributing_metrics
        ]
        if not applicable:
            return MetricResult(
                name="retrieval_sufficiency_error_rate",
                value=0.0,
                denominator=0,
                numerator=0,
                threshold=self.THRESHOLD_STATUS,
                passed=None,
            )

        errors = []
        for cr in applicable:
            expected_inconclusive = (
                cr.expected.get("outcome") == "RETRIEVAL_INCONCLUSIVE"
            )
            actual_inconclusive = (
                cr.actual.get("outcome") == "RETRIEVAL_INCONCLUSIVE"
            )

            # Also consider sufficiency confidence mismatch
            expected_must_widen = cr.expected.get("mustWiden", False)
            actual_must_widen = cr.actual.get("mustWiden", False)

            if expected_inconclusive != actual_inconclusive:
                errors.append({
                    "case_id": cr.case_id,
                    "expected_inconclusive": expected_inconclusive,
                    "actual_inconclusive": actual_inconclusive,
                    "actual": cr.actual,
                })
            elif expected_must_widen != actual_must_widen:
                errors.append({
                    "case_id": cr.case_id,
                    "expected_must_widen": expected_must_widen,
                    "actual_must_widen": actual_must_widen,
                    "actual": cr.actual,
                })

        rate = len(errors) / len(applicable) if applicable else 0.0
        return MetricResult(
            name="retrieval_sufficiency_error_rate",
            value=rate,
            denominator=len(applicable),
            numerator=len(errors),
            threshold=self.THRESHOLD_STATUS,
            passed=None,
            details=errors,
        )

    def _compute_retry_determinism(
        self, case_results: list[CaseResult]
    ) -> MetricResult:
        """Retry/version determinism: same input produces same output.

        This metric requires multiple runs of the same case. When evaluated
        from a single run, it reports 0 errors with note that multi-run
        evaluation is needed.

        Denominator: cases tagged with 'retry_version_determinism'.
        Numerator: cases where repeated runs produced different results.
        """
        applicable = [
            cr for cr in case_results
            if "retry_version_determinism" in cr.contributing_metrics
        ]
        # Single-run evaluation cannot measure determinism across retries.
        # The evaluation runner handles multi-run determinism checks separately.
        return MetricResult(
            name="retry_version_determinism",
            value=0.0,
            denominator=len(applicable),
            numerator=0,
            threshold=self.THRESHOLD_STATUS,
            passed=None,
            details=[{
                "note": "Requires multi-run evaluation to measure. "
                "See EvaluationRunner.run_determinism_check()."
            }] if not applicable else [],
        )

    # -------------------------------------------------------------------
    # Multi-run determinism (used by evaluation runner)
    # -------------------------------------------------------------------

    def score_determinism(
        self,
        multi_run_results: list[list[tuple[dict[str, Any], dict[str, Any]]]],
    ) -> MetricResult:
        """Score retry/version determinism across multiple runs.

        Args:
            multi_run_results: List of runs, where each run is a list of
                (golden_case, actual_result) tuples. All runs must contain
                the same cases in the same order.

        Returns:
            MetricResult for retry_version_determinism.
        """
        if len(multi_run_results) < 2:
            return MetricResult(
                name="retry_version_determinism",
                value=1.0,  # Trivially deterministic with one run
                denominator=0,
                numerator=0,
                threshold=self.THRESHOLD_STATUS,
                passed=None,
                details=[{"note": "Need ≥2 runs to measure determinism."}],
            )

        first_run = multi_run_results[0]
        num_cases = len(first_run)
        non_deterministic_cases: list[dict[str, Any]] = []

        for case_idx in range(num_cases):
            case_id = first_run[case_idx][0]["id"]
            reference_result = first_run[case_idx][1]

            for run_idx in range(1, len(multi_run_results)):
                other_result = multi_run_results[run_idx][case_idx][1]
                if not self._results_equivalent(reference_result, other_result):
                    non_deterministic_cases.append({
                        "case_id": case_id,
                        "run_index": run_idx,
                        "reference": reference_result,
                        "divergent": other_result,
                    })
                    break  # One divergence is enough to flag the case

        determinism_rate = (
            1.0 - (len(non_deterministic_cases) / num_cases)
            if num_cases > 0
            else 1.0
        )

        return MetricResult(
            name="retry_version_determinism",
            value=determinism_rate,
            denominator=num_cases,
            numerator=len(non_deterministic_cases),
            threshold=self.THRESHOLD_STATUS,
            passed=None,
            details=non_deterministic_cases,
        )

    def _results_equivalent(
        self, a: dict[str, Any], b: dict[str, Any]
    ) -> bool:
        """Check if two pipeline results are semantically equivalent.

        Compares outcome, action, matchedConcernId, and confidence bands.
        Ignores timing/diagnostic metadata that may vary between runs.
        """
        keys_to_compare = [
            "outcome",
            "action",
            "matchedConcernId",
            "identityConfidence",
            "sufficiencyConfidence",
            "reactivation",
            "mergeRedirectFollowed",
            "mustWiden",
        ]
        return all(a.get(k) == b.get(k) for k in keys_to_compare)
