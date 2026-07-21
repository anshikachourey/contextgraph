"""Retrieval-sufficiency gate for SIE identity resolution.

This module implements `SufficiencyGate`, which evaluates whether retrieval
coverage is ADEQUATE or INCONCLUSIVE for identity resolution to proceed.

Design authority: design-corrections.md §7.2.

Retrieval is ADEQUATE only when:
1. Every policy-required channel family completed successfully.
2. Every material HIGH or MEDIUM IRS signal was addressed (resolved=True).
3. No failed or unavailable attempt could plausibly conceal a match.
4. Required lifecycle and historical scopes were covered.

A successful empty result (SUCCESS_EMPTY) MAY contribute to adequacy.
ERROR, TIMEOUT, UNAVAILABLE, SKIPPED_WITH_REASON SHALL NOT be represented
as successful empty retrieval.

Identity ambiguity does NOT make retrieval inconclusive and does NOT
trigger widening.
"""

from __future__ import annotations

from ..enums import (
    BehavioralConfidenceBand,
    RetrievalAttemptStatus,
    StageExecutionStatus,
)
from ..identity_models import IRSSignal, SufficiencyRecord
from ..identity_policy import RetrievalPolicy
from .channel_protocol import RetrievalResult

# Statuses considered successful for coverage purposes
_SUCCESSFUL_STATUSES: frozenset[RetrievalAttemptStatus] = frozenset(
    {
        RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
        RetrievalAttemptStatus.SUCCESS_EMPTY,
    }
)

# Statuses that represent material failures (cannot contribute to adequacy)
_FAILURE_STATUSES: frozenset[RetrievalAttemptStatus] = frozenset(
    {
        RetrievalAttemptStatus.ERROR,
        RetrievalAttemptStatus.TIMEOUT,
        RetrievalAttemptStatus.UNAVAILABLE,
        RetrievalAttemptStatus.SKIPPED_WITH_REASON,
    }
)


class SufficiencyGate:
    """Evaluates retrieval-sufficiency for identity resolution.

    Produces only ADEQUATE or INCONCLUSIVE outcomes. The gate always
    completes with stage_status=COMPLETED — it always renders a judgment.

    Identity ambiguity (multiple candidates with competing identity claims)
    does NOT affect retrieval sufficiency and does NOT trigger widening.
    """

    def evaluate(
        self,
        retrieval_result: RetrievalResult,
        irs_signals: list[IRSSignal],
        policy: RetrievalPolicy,
    ) -> SufficiencyRecord:
        """Evaluate retrieval sufficiency against the given policy.

        Args:
            retrieval_result: Aggregated retrieval results with all attempts.
            irs_signals: IRS signals detected during retrieval.
            policy: The versioned retrieval policy defining adequacy criteria.

        Returns:
            A SufficiencyRecord with stage_status=COMPLETED and either
            HIGH confidence (ADEQUATE) or MEDIUM/LOW confidence (INCONCLUSIVE).
        """
        coverage_gaps: list[str] = []
        unresolved: list[IRSSignal] = []
        reasons: list[str] = []

        # --- Check 1: Channel-family coverage ---
        family_coverage_gaps = self._check_channel_family_coverage(
            retrieval_result, policy
        )
        coverage_gaps.extend(family_coverage_gaps)
        if family_coverage_gaps:
            reasons.append(
                f"Missing required channel family coverage: "
                f"{', '.join(family_coverage_gaps)}"
            )

        # --- Check 2: IRS signal resolution ---
        unresolved_signals = self._check_irs_signal_resolution(irs_signals)
        unresolved.extend(unresolved_signals)
        if unresolved_signals:
            signal_types = [s.signal_type.value for s in unresolved_signals]
            reasons.append(
                f"Unresolved material IRS signals: {', '.join(signal_types)}"
            )

        # --- Check 3: Failed coverage blocking ---
        material_failure_gaps = self._check_failed_coverage_blocking(
            retrieval_result, policy
        )
        for gap in material_failure_gaps:
            if gap not in coverage_gaps:
                coverage_gaps.append(gap)
        if material_failure_gaps:
            reasons.append(
                f"Material failed coverage (failure_blocks_no_match): "
                f"{', '.join(material_failure_gaps)}"
            )

        # --- Determine outcome ---
        is_adequate = (
            len(coverage_gaps) == 0
            and len(unresolved) == 0
            and len(material_failure_gaps) == 0
        )

        if is_adequate:
            confidence = BehavioralConfidenceBand.HIGH
            rationale = "Retrieval is ADEQUATE: all required channel families covered, all material IRS signals resolved, no material failed coverage gaps."
            coverage_summary = self._build_coverage_summary(
                retrieval_result, policy, adequate=True
            )
        else:
            # Determine severity: MEDIUM if close to adequate, LOW if severely incomplete
            confidence = self._determine_inconclusive_confidence(
                coverage_gaps, unresolved, material_failure_gaps, policy
            )
            rationale = (
                f"Retrieval is INCONCLUSIVE: {'; '.join(reasons)}."
            )
            coverage_summary = self._build_coverage_summary(
                retrieval_result, policy, adequate=False
            )

        return SufficiencyRecord(
            stage_status=StageExecutionStatus.COMPLETED,
            confidence=confidence,
            coverage_summary=coverage_summary,
            unresolved_signals=unresolved,
            failed_coverage_gaps=coverage_gaps,
            rationale=rationale,
        )

    def _check_channel_family_coverage(
        self,
        retrieval_result: RetrievalResult,
        policy: RetrievalPolicy,
    ) -> list[str]:
        """Check that every required channel family has sufficient successful attempts.

        Returns a list of family names that are coverage gaps.
        """
        gaps: list[str] = []

        for family, requirement in policy.channel_family_requirements.items():
            if not requirement.required_for_adequacy:
                continue

            # Count successful attempts for this family
            successful_count = sum(
                1
                for attempt in retrieval_result.attempts
                if (
                    attempt.channel_family == family
                    and RetrievalAttemptStatus(attempt.status) in _SUCCESSFUL_STATUSES
                )
            )

            if successful_count < requirement.min_successful_attempts:
                gaps.append(family)

        return gaps

    def _check_irs_signal_resolution(
        self,
        irs_signals: list[IRSSignal],
    ) -> list[IRSSignal]:
        """Check that all material HIGH/MEDIUM IRS signals are resolved.

        Returns a list of unresolved material signals that block adequacy.
        """
        unresolved: list[IRSSignal] = []

        for signal in irs_signals:
            if signal.confidence in (
                BehavioralConfidenceBand.HIGH,
                BehavioralConfidenceBand.MEDIUM,
            ) and not signal.resolved:
                unresolved.append(signal)

        return unresolved

    def _check_failed_coverage_blocking(
        self,
        retrieval_result: RetrievalResult,
        policy: RetrievalPolicy,
    ) -> list[str]:
        """Check for material failed coverage that blocks NO_MATCH.

        A family has a material failure gap if:
        - failure_blocks_no_match=True in the policy, AND
        - It has at least one ERROR/TIMEOUT/UNAVAILABLE attempt, AND
        - It has NO successful attempt.

        Returns a list of family names with material failure gaps.
        """
        gaps: list[str] = []

        for family, requirement in policy.channel_family_requirements.items():
            if not requirement.failure_blocks_no_match:
                continue

            has_failure = False
            has_success = False

            for attempt in retrieval_result.attempts:
                if attempt.channel_family != family:
                    continue
                status = RetrievalAttemptStatus(attempt.status)
                if status in _FAILURE_STATUSES:
                    has_failure = True
                if status in _SUCCESSFUL_STATUSES:
                    has_success = True

            if has_failure and not has_success:
                gaps.append(family)

        return gaps

    def _determine_inconclusive_confidence(
        self,
        coverage_gaps: list[str],
        unresolved_signals: list[IRSSignal],
        material_failure_gaps: list[str],
        policy: RetrievalPolicy,
    ) -> BehavioralConfidenceBand:
        """Determine confidence level for INCONCLUSIVE outcome.

        MEDIUM: Close to adequate (only 1 minor gap or low-confidence signal).
        LOW: Severely incomplete (multiple gaps or high-confidence unresolved signals).
        """
        total_required_families = sum(
            1
            for req in policy.channel_family_requirements.values()
            if req.required_for_adequacy
        )

        # Severity indicators
        high_severity_signals = sum(
            1
            for s in unresolved_signals
            if s.confidence == BehavioralConfidenceBand.HIGH
        )
        total_issues = (
            len(coverage_gaps) + len(unresolved_signals) + len(material_failure_gaps)
        )

        # LOW if: multiple coverage gaps, any HIGH unresolved signal, or
        # coverage gap ratio is severe
        if high_severity_signals > 0:
            return BehavioralConfidenceBand.LOW
        if total_issues > 2:
            return BehavioralConfidenceBand.LOW
        if total_required_families > 0 and len(coverage_gaps) > total_required_families // 2:
            return BehavioralConfidenceBand.LOW

        return BehavioralConfidenceBand.MEDIUM

    def _build_coverage_summary(
        self,
        retrieval_result: RetrievalResult,
        policy: RetrievalPolicy,
        *,
        adequate: bool,
    ) -> str:
        """Build a human-readable coverage summary."""
        total_attempts = len(retrieval_result.attempts)
        successful = sum(
            1
            for a in retrieval_result.attempts
            if RetrievalAttemptStatus(a.status) in _SUCCESSFUL_STATUSES
        )
        failed = total_attempts - successful

        families_covered: set[str] = set()
        for attempt in retrieval_result.attempts:
            if RetrievalAttemptStatus(attempt.status) in _SUCCESSFUL_STATUSES:
                families_covered.add(attempt.channel_family)

        status = "ADEQUATE" if adequate else "INCONCLUSIVE"
        return (
            f"Retrieval {status}: {successful}/{total_attempts} attempts successful, "
            f"{failed} failed/skipped. "
            f"Families covered: {sorted(families_covered) if families_covered else 'none'}."
        )
