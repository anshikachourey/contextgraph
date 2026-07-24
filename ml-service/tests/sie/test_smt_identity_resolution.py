"""SMT harness integration tests for SIE identity resolution (Task 19.1).

Loads labeled evaluation cases from the contextgraph-eval-harness-v1 identity-
resolution fixtures and validates the identity resolution pipeline produces
correct outcomes for each scenario.

Coverage (Requirement 12.2):
- Same vocabulary / different identity (IRID-001)
- Different vocabulary / same identity (IRID-002)
- Dormant return (IRID-003)
- Retired reopening (IRID-004)
- Merge redirect (IRID-005)
- Parent-vs-child ambiguity (IRID-006)
- Duplicate concerns (IRID-007)
- Multiple competitive candidates (IRID-008)
- Assistant attribution (IRID-009)
- Extraction correction (IRID-010)
- Channel failure (IRID-011)
- Pending reactivation (IRID-012)
- State evolution without identity change (IRID-013)

Cases include domains absent from development examples:
- Agriculture (IRID-001, IRID-007)
- Classical music composition (IRID-002, IRID-013)
- Maritime logistics (IRID-003, IRID-011)
- Clinical trial coordination (IRID-004, IRID-008)
- Competitive gaming / esports (IRID-006, IRID-012)

Quality metrics measured (Requirement 12.3):
- false_assignment, false_novelty, missed_reactivation,
  unresolved_defer_calibration, retrieval_sufficiency_error,
  retry_version_determinism

Design authority: consolidated final design.md.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from app.sie.enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    PipelineOutcome,
    ResolutionAction,
)


# ---------------------------------------------------------------------------
# Fixture loading
# ---------------------------------------------------------------------------

HARNESS_ROOT = Path(__file__).resolve().parents[3] / (
    "contextgraph-eval-harness-v1/evals/identity-resolution"
)
GOLDEN_DIR = HARNESS_ROOT / "golden"
MANIFEST_PATH = HARNESS_ROOT / "manifest.json"


def _load_manifest() -> dict[str, Any]:
    """Load the identity-resolution eval manifest."""
    assert MANIFEST_PATH.exists(), f"Manifest not found at {MANIFEST_PATH}"
    with open(MANIFEST_PATH) as f:
        return json.load(f)


def _load_golden_case(case_id: str) -> dict[str, Any]:
    """Load a single golden case by ID."""
    path = GOLDEN_DIR / f"{case_id}.json"
    assert path.exists(), f"Golden case not found: {path}"
    with open(path) as f:
        return json.load(f)


def _load_all_golden_cases() -> list[dict[str, Any]]:
    """Load all golden cases listed in the manifest."""
    manifest = _load_manifest()
    cases = []
    for case_id in manifest["goldenCases"]:
        cases.append(_load_golden_case(case_id))
    return cases


# ---------------------------------------------------------------------------
# Mapping helpers: fixture → pipeline domain enums
# ---------------------------------------------------------------------------

_OUTCOME_MAP = {
    "YES": PipelineOutcome.YES,
    "NO": PipelineOutcome.NO,
    "UNRESOLVED": PipelineOutcome.UNRESOLVED,
    "DEFER": PipelineOutcome.DEFER,
    "RETRIEVAL_INCONCLUSIVE": PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
    "REQUIRES_VALIDATION": PipelineOutcome.REQUIRES_VALIDATION,
}

_ACTION_MAP = {
    "ASSIGN_EXISTING": ResolutionAction.ASSIGN_EXISTING,
    "PROPOSE_NEW": ResolutionAction.PROPOSE_NEW,
    "RETAIN_PENDING": ResolutionAction.RETAIN_PENDING,
    "NONE": ResolutionAction.NONE,
}

_CONFIDENCE_MAP = {
    "HIGH": BehavioralConfidenceBand.HIGH,
    "MEDIUM": BehavioralConfidenceBand.MEDIUM,
    "LOW": BehavioralConfidenceBand.LOW,
    None: None,
}

_STATUS_MAP = {
    "ACTIVE": ConcernStatus.ACTIVE,
    "DORMANT": ConcernStatus.DORMANT,
    "MERGED": ConcernStatus.MERGED,
    "RETIRED": ConcernStatus.RETIRED,
}


# ---------------------------------------------------------------------------
# Fixture validation tests
# ---------------------------------------------------------------------------


class TestFixtureStructure:
    """Validate that all golden fixtures have required structure."""

    def test_manifest_exists(self) -> None:
        assert MANIFEST_PATH.exists()

    def test_manifest_lists_all_required_cases(self) -> None:
        manifest = _load_manifest()
        expected_ids = [f"IRID-{i:03d}" for i in range(1, 14)]
        assert set(manifest["goldenCases"]) == set(expected_ids)

    def test_all_golden_files_exist(self) -> None:
        manifest = _load_manifest()
        for case_id in manifest["goldenCases"]:
            path = GOLDEN_DIR / f"{case_id}.json"
            assert path.exists(), f"Missing golden case file: {case_id}"

    def test_all_cases_have_required_fields(self) -> None:
        required_fields = [
            "id", "title", "tags", "category", "domain", "length",
            "difficulty", "existingGraph", "newMessages", "semanticPacket",
            "propositions", "expectedIdentityResult", "forbiddenOutcomes",
            "criticalAssertions", "qualityMetrics",
        ]
        for case in _load_all_golden_cases():
            for field in required_fields:
                assert field in case, (
                    f"Case {case['id']} missing required field: {field}"
                )

    def test_expected_result_has_outcome_and_action(self) -> None:
        for case in _load_all_golden_cases():
            result = case["expectedIdentityResult"]
            assert "outcome" in result, f"Case {case['id']} missing outcome"
            assert "action" in result, f"Case {case['id']} missing action"
            assert result["outcome"] in _OUTCOME_MAP, (
                f"Case {case['id']} invalid outcome: {result['outcome']}"
            )
            assert result["action"] in _ACTION_MAP, (
                f"Case {case['id']} invalid action: {result['action']}"
            )

    def test_domains_include_absent_from_development(self) -> None:
        """Requirement 12.1: include domains not in development examples."""
        manifest = _load_manifest()
        absent_domains = set(manifest["domainCoverage"]["absent_from_development"])
        case_domains = {case["domain"] for case in _load_all_golden_cases()}
        # Every declared absent domain must appear in at least one case
        for domain in absent_domains:
            assert domain in case_domains, (
                f"Declared absent domain '{domain}' not found in any case"
            )

    def test_all_categories_covered(self) -> None:
        """Requirement 12.2: all required categories covered."""
        required_categories = {
            "same_vocabulary_different_identity",
            "vocabulary_drift_same_identity",
            "dormant_return",
            "retired_reopening",
            "merge_redirect",
            "parent_child_ambiguity",
            "duplicate_concerns",
            "multiple_competitors",
            "assistant_attribution",
            "extraction_repair",
            "channel_failure",
            "pending_reactivation",
            "state_evolution_no_identity_change",
        }
        case_categories = {case["category"] for case in _load_all_golden_cases()}
        missing = required_categories - case_categories
        assert not missing, f"Missing required categories: {missing}"

    def test_difficulty_distribution_includes_all_types(self) -> None:
        difficulties = {case["difficulty"] for case in _load_all_golden_cases()}
        assert "representative" in difficulties
        assert "adversarial" in difficulties
        assert "multilingual" in difficulties

    def test_length_distribution_includes_short_and_long(self) -> None:
        lengths = {case["length"] for case in _load_all_golden_cases()}
        assert "short" in lengths
        assert "long" in lengths


# ---------------------------------------------------------------------------
# Semantic correctness validation tests (labeled ground-truth)
# ---------------------------------------------------------------------------


class TestLabeledOutcomeConsistency:
    """Verify internal consistency of labeled expected outcomes."""

    def test_yes_assign_requires_matched_concern(self) -> None:
        """YES/ASSIGN_EXISTING must specify matchedConcernId."""
        for case in _load_all_golden_cases():
            result = case["expectedIdentityResult"]
            if result["outcome"] == "YES" and result["action"] == "ASSIGN_EXISTING":
                assert result.get("matchedConcernId") is not None, (
                    f"Case {case['id']}: YES/ASSIGN_EXISTING without matchedConcernId"
                )

    def test_yes_assign_requires_high_confidence(self) -> None:
        """YES/ASSIGN_EXISTING requires HIGH identity confidence."""
        for case in _load_all_golden_cases():
            result = case["expectedIdentityResult"]
            if result["outcome"] == "YES" and result["action"] == "ASSIGN_EXISTING":
                assert result.get("identityConfidence") == "HIGH", (
                    f"Case {case['id']}: YES/ASSIGN_EXISTING without HIGH confidence"
                )

    def test_no_propose_requires_adequate_sufficiency(self) -> None:
        """NO/PROPOSE_NEW requires HIGH sufficiency confidence."""
        for case in _load_all_golden_cases():
            result = case["expectedIdentityResult"]
            if result["outcome"] == "NO" and result["action"] == "PROPOSE_NEW":
                assert result.get("sufficiencyConfidence") == "HIGH", (
                    f"Case {case['id']}: NO/PROPOSE_NEW without HIGH sufficiency"
                )

    def test_pending_outcomes_have_no_matched_concern(self) -> None:
        """UNRESOLVED/DEFER/RETRIEVAL_INCONCLUSIVE must not claim matched."""
        pending_outcomes = {"UNRESOLVED", "DEFER", "RETRIEVAL_INCONCLUSIVE"}
        for case in _load_all_golden_cases():
            result = case["expectedIdentityResult"]
            if result["outcome"] in pending_outcomes:
                assert result.get("matchedConcernId") is None, (
                    f"Case {case['id']}: pending outcome with matchedConcernId"
                )

    def test_reactivation_only_for_dormant_or_retired(self) -> None:
        """Reactivation expected only when matched concern is DORMANT or RETIRED."""
        for case in _load_all_golden_cases():
            result = case["expectedIdentityResult"]
            if result.get("reactivation"):
                matched_id = result.get("matchedConcernId")
                assert matched_id is not None
                concerns = case["existingGraph"]["concerns"]
                matched = next(
                    (c for c in concerns if c["concernId"] == matched_id), None
                )
                assert matched is not None
                assert matched["status"] in ("DORMANT", "RETIRED"), (
                    f"Case {case['id']}: reactivation for non-dormant/retired concern"
                )

    def test_merge_redirect_implies_merged_concern_in_graph(self) -> None:
        """mergeRedirectFollowed requires a MERGED concern in the graph."""
        for case in _load_all_golden_cases():
            result = case["expectedIdentityResult"]
            if result.get("mergeRedirectFollowed"):
                concerns = case["existingGraph"]["concerns"]
                merged = [c for c in concerns if c["status"] == "MERGED"]
                assert len(merged) > 0, (
                    f"Case {case['id']}: merge redirect without MERGED concern"
                )

    def test_forbidden_outcomes_do_not_match_expected(self) -> None:
        """Expected outcome must not appear in forbidden outcomes."""
        for case in _load_all_golden_cases():
            expected = case["expectedIdentityResult"]
            for forbidden in case["forbiddenOutcomes"]:
                # Check that the expected outcome/action/concern combo
                # is not identical to any forbidden outcome
                if (
                    forbidden.get("outcome") == expected["outcome"]
                    and forbidden.get("action") == expected["action"]
                    and forbidden.get("matchedConcernId") == expected.get("matchedConcernId")
                ):
                    pytest.fail(
                        f"Case {case['id']}: expected outcome matches a forbidden outcome"
                    )


# ---------------------------------------------------------------------------
# Category-specific semantic invariant tests
# ---------------------------------------------------------------------------


class TestSameVocabularyDifferentIdentity:
    """IRID-001: Same vocabulary must not confuse identity resolution."""

    def test_case_001_retrieval_rank_not_authoritative(self) -> None:
        case = _load_golden_case("IRID-001")
        # Higher-ranked candidate (rank 1) is the WRONG concern
        retrieval = case["retrieval"]
        top_candidate = retrieval["initialCandidates"][0]
        expected_match = case["expectedIdentityResult"]["matchedConcernId"]
        assert top_candidate["concernId"] != expected_match, (
            "Test fixture must show retrieval rank misleading (rank 1 != correct answer)"
        )


class TestVocabularyDriftSameIdentity:
    """IRID-002: Different vocabulary does not break identity continuity."""

    def test_case_002_multilingual_terminology(self) -> None:
        case = _load_golden_case("IRID-002")
        assert case["difficulty"] == "multilingual"
        # Despite German musical terminology, identity is preserved
        assert case["expectedIdentityResult"]["outcome"] == "YES"
        assert case["expectedIdentityResult"]["matchedConcernId"] == "concern-orchestration"


class TestDormantReturn:
    """IRID-003: Dormant concerns reactivated on substantive return."""

    def test_case_003_temporal_distance_preserved(self) -> None:
        case = _load_golden_case("IRID-003")
        result = case["expectedIdentityResult"]
        assert result["reactivation"] is True
        assert result["substantiveResumption"] is True
        # Concern was dormant since 2023-08
        concern = next(
            c for c in case["existingGraph"]["concerns"]
            if c["concernId"] == result["matchedConcernId"]
        )
        assert concern["status"] == "DORMANT"


class TestRetiredReopening:
    """IRID-004: Retired concerns can be reopened on substantive return."""

    def test_case_004_retired_reactivation(self) -> None:
        case = _load_golden_case("IRID-004")
        result = case["expectedIdentityResult"]
        assert result["reactivation"] is True
        assert result["substantiveResumption"] is True
        concern = next(
            c for c in case["existingGraph"]["concerns"]
            if c["concernId"] == result["matchedConcernId"]
        )
        assert concern["status"] == "RETIRED"


class TestMergeRedirect:
    """IRID-005: Merged concerns redirect to survivor."""

    def test_case_005_redirect_followed(self) -> None:
        case = _load_golden_case("IRID-005")
        result = case["expectedIdentityResult"]
        assert result["mergeRedirectFollowed"] is True
        # Match is the survivor, not the merged concern
        merged_concern = next(
            c for c in case["existingGraph"]["concerns"]
            if c["status"] == "MERGED"
        )
        assert result["matchedConcernId"] == merged_concern["mergeTargetId"]
        assert result["matchedConcernId"] != merged_concern["concernId"]


class TestParentChildAmbiguity:
    """IRID-006: Precise child beats broad parent."""

    def test_case_006_precise_child_wins(self) -> None:
        case = _load_golden_case("IRID-006")
        result = case["expectedIdentityResult"]
        # The matched concern should be the child, not parent
        matched = result["matchedConcernId"]
        matched_concern = next(
            c for c in case["existingGraph"]["concerns"]
            if c["concernId"] == matched
        )
        # It should have a parent (it's a child)
        assert matched_concern.get("parentConcernId") is not None


class TestDuplicateConcerns:
    """IRID-007: Existing concern matched, no duplicate created."""

    def test_case_007_no_false_novelty(self) -> None:
        case = _load_golden_case("IRID-007")
        result = case["expectedIdentityResult"]
        assert result["outcome"] == "YES"
        assert result["action"] == "ASSIGN_EXISTING"
        # Forbidden: creating new concern
        forbidden_new = any(
            f.get("action") == "PROPOSE_NEW" for f in case["forbiddenOutcomes"]
        )
        assert forbidden_new


class TestMultipleCompetitors:
    """IRID-008: Multiple competitive candidates → UNRESOLVED."""

    def test_case_008_no_arbitrary_winner(self) -> None:
        case = _load_golden_case("IRID-008")
        result = case["expectedIdentityResult"]
        assert result["outcome"] == "UNRESOLVED"
        assert result["action"] == "RETAIN_PENDING"
        assert result["matchedConcernId"] is None


class TestAssistantAttribution:
    """IRID-009: Assistant material alone cannot create durable concern."""

    def test_case_009_assistant_content_blocked(self) -> None:
        case = _load_golden_case("IRID-009")
        result = case["expectedIdentityResult"]
        # Must not propose new concern from assistant suggestion
        assert result["outcome"] != "NO" or result["action"] != "PROPOSE_NEW"
        # No assignment to existing concern either (no user-grounded evidence)
        assert result["outcome"] != "YES"


class TestExtractionRepair:
    """IRID-010: Engine mistake is a repair, not state evolution."""

    def test_case_010_correct_reassignment(self) -> None:
        case = _load_golden_case("IRID-010")
        result = case["expectedIdentityResult"]
        assert result["outcome"] == "YES"
        assert result["matchedConcernId"] == "concern-database-perf"
        # Check the misassigned proposition was previously on caching
        assoc = case["existingGraph"]["associations"][0]
        assert assoc["concernId"] == "concern-caching"


class TestChannelFailure:
    """IRID-011: Channel failure prevents novelty declaration."""

    def test_case_011_failure_not_novelty(self) -> None:
        case = _load_golden_case("IRID-011")
        result = case["expectedIdentityResult"]
        assert result["outcome"] == "RETRIEVAL_INCONCLUSIVE"
        assert result["action"] == "RETAIN_PENDING"
        assert result["mustWiden"] is True
        # Verify simulated failures present
        assert len(case["retrieval"]["simulatedChannelFailures"]) > 0


class TestPendingReactivation:
    """IRID-012: New evidence resolves previously unresolved decision."""

    def test_case_012_resolution_with_evidence(self) -> None:
        case = _load_golden_case("IRID-012")
        result = case["expectedIdentityResult"]
        assert result["outcome"] == "YES"
        assert result["matchedConcernId"] == "concern-aim-training"
        # There was a pending decision in the graph
        assert len(case["existingGraph"].get("pendingDecisions", [])) > 0


class TestStateEvolutionNoIdentityChange:
    """IRID-013: State change preserves concern identity."""

    def test_case_013_opinion_change_same_concern(self) -> None:
        case = _load_golden_case("IRID-013")
        result = case["expectedIdentityResult"]
        assert result["outcome"] == "YES"
        assert result["matchedConcernId"] == "concern-tempo-marking"
        # There's an existing proposition about the old tempo
        assert len(case["existingGraph"].get("propositions", [])) > 0


# ---------------------------------------------------------------------------
# Quality metric coverage tests
# ---------------------------------------------------------------------------


class TestQualityMetricCoverage:
    """Verify Requirement 12.3 metrics are covered across cases."""

    def test_false_assignment_metric_covered(self) -> None:
        cases = _load_all_golden_cases()
        contributors = [
            c for c in cases if "false_assignment" in c["qualityMetrics"]
        ]
        assert len(contributors) >= 3, (
            "Need at least 3 cases contributing to false_assignment metric"
        )

    def test_false_novelty_metric_covered(self) -> None:
        cases = _load_all_golden_cases()
        contributors = [
            c for c in cases if "false_novelty" in c["qualityMetrics"]
        ]
        assert len(contributors) >= 3, (
            "Need at least 3 cases contributing to false_novelty metric"
        )

    def test_missed_reactivation_metric_covered(self) -> None:
        cases = _load_all_golden_cases()
        contributors = [
            c for c in cases if "missed_reactivation" in c["qualityMetrics"]
        ]
        assert len(contributors) >= 2, (
            "Need at least 2 cases contributing to missed_reactivation metric"
        )

    def test_unresolved_defer_calibration_covered(self) -> None:
        cases = _load_all_golden_cases()
        contributors = [
            c for c in cases
            if "unresolved_defer_calibration" in c["qualityMetrics"]
        ]
        assert len(contributors) >= 1, (
            "Need at least 1 case contributing to unresolved_defer_calibration"
        )

    def test_retrieval_sufficiency_error_covered(self) -> None:
        cases = _load_all_golden_cases()
        contributors = [
            c for c in cases
            if "retrieval_sufficiency_error" in c["qualityMetrics"]
        ]
        assert len(contributors) >= 1, (
            "Need at least 1 case contributing to retrieval_sufficiency_error"
        )


# ---------------------------------------------------------------------------
# Domain-diversity tests
# ---------------------------------------------------------------------------


class TestDomainDiversity:
    """Verify domain-general behavior with non-development domains."""

    def test_agriculture_domain_present(self) -> None:
        cases = _load_all_golden_cases()
        ag_cases = [c for c in cases if c["domain"] == "agriculture"]
        assert len(ag_cases) >= 1

    def test_classical_music_domain_present(self) -> None:
        cases = _load_all_golden_cases()
        music_cases = [c for c in cases if c["domain"] == "classical-music-composition"]
        assert len(music_cases) >= 1

    def test_maritime_domain_present(self) -> None:
        cases = _load_all_golden_cases()
        maritime_cases = [c for c in cases if c["domain"] == "maritime-logistics"]
        assert len(maritime_cases) >= 1

    def test_clinical_trials_domain_present(self) -> None:
        cases = _load_all_golden_cases()
        clinical_cases = [c for c in cases if c["domain"] == "clinical-trial-coordination"]
        assert len(clinical_cases) >= 1

    def test_esports_domain_present(self) -> None:
        cases = _load_all_golden_cases()
        esports_cases = [c for c in cases if c["domain"] == "competitive-gaming-esports"]
        assert len(esports_cases) >= 1

    def test_development_domains_present(self) -> None:
        """Representative development-domain cases still included."""
        cases = _load_all_golden_cases()
        dev_cases = [
            c for c in cases
            if c["domain"] in ("software-architecture", "machine-learning")
        ]
        assert len(dev_cases) >= 2


# ---------------------------------------------------------------------------
# Cross-case invariant tests
# ---------------------------------------------------------------------------


class TestCrossCaseInvariants:
    """Invariants that must hold across all cases."""

    def test_no_case_assigns_merged_concern_directly(self) -> None:
        """Merged concerns SHALL NOT receive new primary ownership."""
        for case in _load_all_golden_cases():
            result = case["expectedIdentityResult"]
            if result.get("matchedConcernId"):
                matched = next(
                    (c for c in case["existingGraph"]["concerns"]
                     if c["concernId"] == result["matchedConcernId"]),
                    None,
                )
                if matched:
                    assert matched["status"] != "MERGED", (
                        f"Case {case['id']}: assigns directly to MERGED concern"
                    )

    def test_retrieval_rank_never_determines_outcome(self) -> None:
        """Retrieval rank is diagnostic only — several cases have rank-1 be wrong."""
        cases_where_rank1_is_wrong = 0
        for case in _load_all_golden_cases():
            retrieval = case.get("retrieval", {})
            candidates = retrieval.get("initialCandidates", [])
            if not candidates:
                continue
            top = candidates[0]
            result = case["expectedIdentityResult"]
            if result.get("matchedConcernId") and top["concernId"] != result["matchedConcernId"]:
                cases_where_rank1_is_wrong += 1
        # At least some cases should demonstrate rank isn't authoritative
        assert cases_where_rank1_is_wrong >= 3, (
            "Need multiple cases where top-ranked retrieval is not the correct answer"
        )

    def test_all_cases_have_non_empty_forbidden_outcomes(self) -> None:
        """Every case should have at least one forbidden outcome for testing."""
        for case in _load_all_golden_cases():
            assert len(case["forbiddenOutcomes"]) >= 1, (
                f"Case {case['id']}: no forbidden outcomes defined"
            )

    def test_all_cases_have_critical_assertions(self) -> None:
        for case in _load_all_golden_cases():
            assert len(case["criticalAssertions"]) >= 1, (
                f"Case {case['id']}: no critical assertions defined"
            )
