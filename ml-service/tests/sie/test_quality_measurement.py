"""Tests for SIE identity resolution semantic quality measurement (Task 19.2).

Validates the quality measurement infrastructure:
- Scorer correctly computes each metric from pipeline results and golden labels.
- Evaluation runner records configuration metadata.
- Report format clearly indicates pending approval thresholds.
- Production gate blocks until thresholds are approved.

Requirement 12, AC 3, 8, 9.
Design authority: consolidated final design.md.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest

# Add the eval harness scorers to the path
sys.path.insert(
    0,
    str(
        Path(__file__).resolve().parents[2].parent
        / "contextgraph-eval-harness-v1"
        / "evals"
        / "identity-resolution"
        / "scorers"
    ),
)

from quality_scorer import (
    CaseResult,
    IdentityResolutionQualityScorer,
    MetricResult,
    QualityReport,
)
from evaluation_runner import (
    EvaluationRunResult,
    EvaluationRunner,
    InferenceConfig,
    ModelConfig,
    PolicyConfig,
    PromptConfig,
    RunConfiguration,
)


# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------


def _make_golden_case(
    case_id: str,
    outcome: str = "YES",
    action: str = "ASSIGN_EXISTING",
    matched_concern_id: str | None = "concern-abc",
    identity_confidence: str | None = "HIGH",
    sufficiency_confidence: str | None = None,
    reactivation: bool = False,
    must_widen: bool = False,
    quality_metrics: list[str] | None = None,
    forbidden_outcomes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Create a minimal golden case for testing."""
    return {
        "id": case_id,
        "title": f"Test case {case_id}",
        "tags": ["test"],
        "category": "same_vocabulary_different_identity",
        "domain": "test-domain",
        "length": "short",
        "difficulty": "representative",
        "existingGraph": {"concerns": [], "propositions": [], "associations": []},
        "newMessages": [],
        "semanticPacket": {
            "packetId": "pkt-test",
            "userEvidenceMessageIds": [],
            "conciseMeaning": "test",
            "retentionRoles": ["INDEPENDENT_CONCERN_CANDIDATE"],
        },
        "propositions": [],
        "retrieval": {"initialCandidates": []},
        "expectedIdentityResult": {
            "outcome": outcome,
            "action": action,
            "matchedConcernId": matched_concern_id,
            "identityConfidence": identity_confidence,
            "sufficiencyConfidence": sufficiency_confidence,
            "reactivation": reactivation,
            "mergeRedirectFollowed": False,
            "substantiveResumption": False,
            "mustWiden": must_widen,
        },
        "forbiddenOutcomes": forbidden_outcomes or [
            {"outcome": "NO", "action": "PROPOSE_NEW", "reason": "test"}
        ],
        "criticalAssertions": ["matched_concern=concern-abc"],
        "qualityMetrics": quality_metrics or ["false_assignment"],
    }


def _make_actual_result(
    outcome: str = "YES",
    action: str = "ASSIGN_EXISTING",
    matched_concern_id: str | None = "concern-abc",
    identity_confidence: str | None = "HIGH",
    sufficiency_confidence: str | None = None,
    reactivation: bool = False,
    must_widen: bool = False,
) -> dict[str, Any]:
    """Create a minimal actual result dict."""
    return {
        "outcome": outcome,
        "action": action,
        "matchedConcernId": matched_concern_id,
        "identityConfidence": identity_confidence,
        "sufficiencyConfidence": sufficiency_confidence,
        "reactivation": reactivation,
        "mergeRedirectFollowed": False,
        "mustWiden": must_widen,
    }


def _make_run_config() -> RunConfiguration:
    """Create a test run configuration."""
    return RunConfiguration(
        model=ModelConfig(
            model_id="test-model",
            model_version="1.0",
            provider="test-provider",
            temperature=0.0,
            max_tokens=4096,
            structured_output=True,
        ),
        prompt=PromptConfig(
            prompt_version="v1.0.0",
            schema_version="1.0",
            system_prompt_hash="abc123",
            evaluation_prompt_hash="def456",
        ),
        policy=PolicyConfig(
            retrieval_policy_version="v1.0.0",
            identity_policy_version="v1.0.0",
            widening_budget_version="v1.0.0",
        ),
        inference=InferenceConfig(
            pipeline_version="v1.0.0",
            contract_version="1.0",
            retrieval_timeout_ms=5000,
            max_widening_rounds=3,
            max_retry_attempts=2,
            deterministic_mode=True,
        ),
    )


# ---------------------------------------------------------------------------
# Scorer unit tests
# ---------------------------------------------------------------------------


class TestQualityScorerBasics:
    """Test scorer produces correct metrics for known inputs."""

    def test_all_correct_produces_zero_errors(self) -> None:
        """When all results match golden labels, all error rates are 0."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T01", quality_metrics=[
            "false_assignment", "false_novelty", "missed_reactivation",
        ])
        actual = _make_actual_result()
        report = scorer.score([(golden, actual)])

        assert report.total_cases == 1
        assert report.total_passed == 1
        assert report.total_failed == 0
        assert report.metrics["false_assignment_rate"].value == 0.0
        assert report.metrics["false_novelty_rate"].value == 0.0

    def test_wrong_assignment_counted_as_false_assignment(self) -> None:
        """Assigning to wrong concern counted in false_assignment."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case(
            "IRID-T02",
            matched_concern_id="concern-correct",
            quality_metrics=["false_assignment"],
        )
        actual = _make_actual_result(matched_concern_id="concern-wrong")
        report = scorer.score([(golden, actual)])

        metric = report.metrics["false_assignment_rate"]
        assert metric.numerator == 1
        assert metric.denominator == 1
        assert metric.value == 1.0

    def test_false_novelty_when_propose_new_instead_of_assign(self) -> None:
        """Proposing new when match exists counted as false_novelty."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case(
            "IRID-T03",
            outcome="YES",
            action="ASSIGN_EXISTING",
            quality_metrics=["false_novelty"],
        )
        actual = _make_actual_result(
            outcome="NO",
            action="PROPOSE_NEW",
            matched_concern_id=None,
            sufficiency_confidence="HIGH",
        )
        report = scorer.score([(golden, actual)])

        metric = report.metrics["false_novelty_rate"]
        assert metric.numerator == 1
        assert metric.denominator == 1
        assert metric.value == 1.0

    def test_missed_reactivation_detected(self) -> None:
        """Expected reactivation that didn't happen is counted."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case(
            "IRID-T04",
            reactivation=True,
            quality_metrics=["missed_reactivation"],
        )
        actual = _make_actual_result(reactivation=False)
        report = scorer.score([(golden, actual)])

        metric = report.metrics["missed_reactivation_rate"]
        assert metric.numerator == 1
        assert metric.denominator == 1
        assert metric.value == 1.0

    def test_unresolved_defer_calibration_error(self) -> None:
        """Expected UNRESOLVED but got YES is a calibration error."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case(
            "IRID-T05",
            outcome="UNRESOLVED",
            action="RETAIN_PENDING",
            matched_concern_id=None,
            identity_confidence="MEDIUM",
            quality_metrics=["unresolved_defer_calibration"],
            forbidden_outcomes=[],
        )
        actual = _make_actual_result(
            outcome="YES",
            action="ASSIGN_EXISTING",
            matched_concern_id="concern-abc",
        )
        report = scorer.score([(golden, actual)])

        metric = report.metrics["unresolved_defer_calibration"]
        assert metric.numerator == 1
        assert metric.denominator == 1

    def test_retrieval_sufficiency_error_detected(self) -> None:
        """Expected RETRIEVAL_INCONCLUSIVE but got resolved."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case(
            "IRID-T06",
            outcome="RETRIEVAL_INCONCLUSIVE",
            action="RETAIN_PENDING",
            matched_concern_id=None,
            identity_confidence=None,
            must_widen=True,
            quality_metrics=["retrieval_sufficiency_error"],
            forbidden_outcomes=[],
        )
        actual = _make_actual_result(
            outcome="NO",
            action="PROPOSE_NEW",
            matched_concern_id=None,
            sufficiency_confidence="HIGH",
        )
        report = scorer.score([(golden, actual)])

        metric = report.metrics["retrieval_sufficiency_error_rate"]
        assert metric.numerator == 1
        assert metric.denominator == 1

    def test_multiple_cases_computes_rate(self) -> None:
        """Rate is correctly computed over multiple cases."""
        scorer = IdentityResolutionQualityScorer()
        cases = [
            (
                _make_golden_case("IRID-T10", quality_metrics=["false_assignment"]),
                _make_actual_result(),  # correct
            ),
            (
                _make_golden_case(
                    "IRID-T11",
                    matched_concern_id="concern-right",
                    quality_metrics=["false_assignment"],
                ),
                _make_actual_result(matched_concern_id="concern-wrong"),  # wrong
            ),
            (
                _make_golden_case("IRID-T12", quality_metrics=["false_assignment"]),
                _make_actual_result(),  # correct
            ),
        ]
        report = scorer.score(cases)

        metric = report.metrics["false_assignment_rate"]
        assert metric.denominator == 3
        assert metric.numerator == 1
        assert abs(metric.value - 1.0 / 3.0) < 0.001

    def test_empty_cases_produces_zero_report(self) -> None:
        """Scoring with no cases produces zero-value report."""
        scorer = IdentityResolutionQualityScorer()
        report = scorer.score([])

        assert report.total_cases == 0
        assert report.total_passed == 0
        for metric in report.metrics.values():
            assert metric.value == 0.0
            assert metric.denominator == 0


# ---------------------------------------------------------------------------
# Threshold and production gate tests
# ---------------------------------------------------------------------------


class TestProductionGate:
    """Verify thresholds are PENDING_APPROVAL and block production."""

    def test_thresholds_are_pending_approval(self) -> None:
        """All thresholds report PENDING_APPROVAL by default."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T20")
        actual = _make_actual_result()
        report = scorer.score([(golden, actual)])

        for metric in report.metrics.values():
            assert metric.threshold == "PENDING_APPROVAL"
            assert metric.passed is None

    def test_production_ready_false_when_thresholds_pending(self) -> None:
        """Production readiness blocked when thresholds not approved."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T21")
        actual = _make_actual_result()
        report = scorer.score([(golden, actual)])

        assert report.all_thresholds_approved is False
        assert report.production_ready is False


# ---------------------------------------------------------------------------
# Forbidden outcome tests
# ---------------------------------------------------------------------------


class TestForbiddenOutcomes:
    """Test detection of forbidden outcome violations."""

    def test_forbidden_outcome_detected(self) -> None:
        """Producing a forbidden outcome is flagged."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case(
            "IRID-T30",
            forbidden_outcomes=[
                {
                    "outcome": "YES",
                    "action": "ASSIGN_EXISTING",
                    "matchedConcernId": "concern-wrong",
                    "reason": "wrong concern",
                }
            ],
            quality_metrics=["false_assignment"],
        )
        actual = _make_actual_result(matched_concern_id="concern-wrong")
        report = scorer.score([(golden, actual)])

        # The case should be counted as failed
        assert report.total_failed == 1

    def test_correct_outcome_not_flagged_as_forbidden(self) -> None:
        """Correct result matching expected is not a forbidden violation."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case(
            "IRID-T31",
            forbidden_outcomes=[
                {
                    "outcome": "NO",
                    "action": "PROPOSE_NEW",
                    "reason": "should not propose new",
                }
            ],
        )
        actual = _make_actual_result()  # YES/ASSIGN_EXISTING - not forbidden
        report = scorer.score([(golden, actual)])

        assert report.total_passed == 1
        assert report.total_failed == 0


# ---------------------------------------------------------------------------
# Determinism scoring tests
# ---------------------------------------------------------------------------


class TestDeterminismScoring:
    """Test retry/version determinism measurement."""

    def test_identical_runs_are_deterministic(self) -> None:
        """Same results across runs → determinism = 1.0."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T40")
        actual = _make_actual_result()
        runs = [
            [(golden, actual)],
            [(golden, actual)],
            [(golden, actual)],
        ]
        result = scorer.score_determinism(runs)
        assert result.value == 1.0
        assert result.numerator == 0

    def test_divergent_runs_detected(self) -> None:
        """Different results across runs → determinism < 1.0."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T41")
        actual_a = _make_actual_result(matched_concern_id="concern-a")
        actual_b = _make_actual_result(matched_concern_id="concern-b")
        runs = [
            [(golden, actual_a)],
            [(golden, actual_b)],
        ]
        result = scorer.score_determinism(runs)
        assert result.value == 0.0
        assert result.numerator == 1

    def test_single_run_trivially_deterministic(self) -> None:
        """A single run cannot measure determinism."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T42")
        actual = _make_actual_result()
        result = scorer.score_determinism([[(golden, actual)]])
        assert result.value == 1.0


# ---------------------------------------------------------------------------
# Configuration metadata recording tests
# ---------------------------------------------------------------------------


class TestConfigurationMetadata:
    """Verify that evaluation runs record full configuration."""

    def test_run_config_serializes_all_fields(self) -> None:
        """RunConfiguration.to_dict() includes all required fields."""
        config = _make_run_config()
        d = config.to_dict()

        assert "model" in d
        assert d["model"]["model_id"] == "test-model"
        assert d["model"]["model_version"] == "1.0"
        assert d["model"]["provider"] == "test-provider"
        assert d["model"]["temperature"] == 0.0
        assert d["model"]["max_tokens"] == 4096
        assert d["model"]["structured_output"] is True

        assert "prompt" in d
        assert d["prompt"]["prompt_version"] == "v1.0.0"
        assert d["prompt"]["schema_version"] == "1.0"

        assert "policy" in d
        assert d["policy"]["retrieval_policy_version"] == "v1.0.0"
        assert d["policy"]["identity_policy_version"] == "v1.0.0"
        assert d["policy"]["widening_budget_version"] == "v1.0.0"

        assert "inference" in d
        assert d["inference"]["pipeline_version"] == "v1.0.0"
        assert d["inference"]["contract_version"] == "1.0"
        assert d["inference"]["deterministic_mode"] is True

    def test_model_config_records_model_and_version(self) -> None:
        """ModelConfig captures the exact model identifier and version."""
        config = ModelConfig(
            model_id="gpt-4o-2024-08-06",
            model_version="2024-08-06",
            provider="openai",
            temperature=0.0,
            max_tokens=8192,
            structured_output=True,
        )
        d = config.to_dict()
        assert d["model_id"] == "gpt-4o-2024-08-06"
        assert d["model_version"] == "2024-08-06"

    def test_policy_config_records_all_policy_versions(self) -> None:
        """PolicyConfig captures retrieval, identity, and widening versions."""
        config = PolicyConfig(
            retrieval_policy_version="v2.1.0",
            identity_policy_version="v3.0.0",
            widening_budget_version="v1.2.0",
            re_evaluation_policy_version="v1.0.0",
            confidence_rubric_version="v2.0.0",
        )
        d = config.to_dict()
        assert d["retrieval_policy_version"] == "v2.1.0"
        assert d["identity_policy_version"] == "v3.0.0"
        assert d["widening_budget_version"] == "v1.2.0"
        assert d["re_evaluation_policy_version"] == "v1.0.0"
        assert d["confidence_rubric_version"] == "v2.0.0"


# ---------------------------------------------------------------------------
# Evaluation runner integration tests
# ---------------------------------------------------------------------------


class _MockPipelineAdapter:
    """Mock adapter that returns expected results (perfect pipeline)."""

    def __init__(self, golden_cases: list[dict[str, Any]]) -> None:
        self._results = {
            case["id"]: case["expectedIdentityResult"]
            for case in golden_cases
        }

    def run_case(self, golden_case: dict[str, Any]) -> dict[str, Any]:
        return self._results[golden_case["id"]]


class _FailingPipelineAdapter:
    """Mock adapter that always returns wrong results."""

    def run_case(self, golden_case: dict[str, Any]) -> dict[str, Any]:
        return {
            "outcome": "NO",
            "action": "PROPOSE_NEW",
            "matchedConcernId": None,
            "identityConfidence": None,
            "sufficiencyConfidence": "HIGH",
            "reactivation": False,
            "mergeRedirectFollowed": False,
            "mustWiden": False,
        }


class TestEvaluationRunner:
    """Test the evaluation runner with mock adapters."""

    def test_runner_loads_golden_cases(self) -> None:
        """Runner can load golden cases from harness directory."""
        runner = EvaluationRunner()
        cases = runner.load_golden_cases()
        assert len(cases) == 13
        assert all("id" in c for c in cases)

    def test_runner_produces_evaluation_result(self) -> None:
        """Runner produces a complete evaluation result."""
        runner = EvaluationRunner()
        cases = runner.load_golden_cases()
        adapter = _MockPipelineAdapter(cases)
        config = _make_run_config()

        result = runner.run(adapter=adapter, configuration=config)

        assert result.run_id.startswith("eval-")
        assert result.timestamp is not None
        assert result.configuration == config
        assert result.quality_report.total_cases == 13
        assert result.duration_ms > 0

    def test_perfect_adapter_produces_zero_errors(self) -> None:
        """Perfect pipeline (returns expected) has zero error rates."""
        runner = EvaluationRunner()
        cases = runner.load_golden_cases()
        adapter = _MockPipelineAdapter(cases)
        config = _make_run_config()

        result = runner.run(adapter=adapter, configuration=config)

        for name, metric in result.quality_report.metrics.items():
            assert metric.value == 0.0, (
                f"Metric {name} should be 0.0 for perfect adapter, "
                f"got {metric.value}"
            )
        assert result.quality_report.total_passed == 13
        assert result.quality_report.total_failed == 0

    def test_failing_adapter_produces_errors(self) -> None:
        """Failing pipeline produces non-zero error rates."""
        runner = EvaluationRunner()
        adapter = _FailingPipelineAdapter()
        config = _make_run_config()

        result = runner.run(adapter=adapter, configuration=config)

        # At least some metrics should have errors
        has_errors = any(
            m.numerator > 0
            for m in result.quality_report.metrics.values()
        )
        assert has_errors
        assert result.quality_report.total_failed > 0

    def test_result_serialization_includes_production_gate(self) -> None:
        """Serialized result includes production gate status."""
        runner = EvaluationRunner()
        cases = runner.load_golden_cases()
        adapter = _MockPipelineAdapter(cases)
        config = _make_run_config()

        result = runner.run(adapter=adapter, configuration=config)
        d = result.to_dict()

        assert "production_gate" in d
        assert d["production_gate"]["status"] == "PENDING_APPROVAL"
        assert d["production_gate"]["all_thresholds_approved"] is False
        assert d["production_gate"]["production_ready"] is False
        assert "blocking_reason" in d["production_gate"]
        assert "PENDING_APPROVAL" in d["production_gate"]["blocking_reason"] or \
               "thresholds" in d["production_gate"]["blocking_reason"]

    def test_result_saves_to_json(self) -> None:
        """Runner can save results to a JSON file."""
        runner = EvaluationRunner()
        cases = runner.load_golden_cases()
        adapter = _MockPipelineAdapter(cases)
        config = _make_run_config()

        result = runner.run(adapter=adapter, configuration=config)

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            output_path = Path(f.name)

        try:
            runner.save_result(result, output_path)
            assert output_path.exists()

            with open(output_path) as f:
                data = json.load(f)

            assert data["run_id"] == result.run_id
            assert "configuration" in data
            assert "quality_report" in data
            assert "production_gate" in data
        finally:
            output_path.unlink(missing_ok=True)

    def test_format_report_readable(self) -> None:
        """Runner produces a human-readable text report."""
        runner = EvaluationRunner()
        cases = runner.load_golden_cases()
        adapter = _MockPipelineAdapter(cases)
        config = _make_run_config()

        result = runner.run(adapter=adapter, configuration=config)
        report_text = runner.format_report(result)

        assert "Quality Evaluation Report" in report_text
        assert "test-model" in report_text
        assert "PENDING_APPROVAL" in report_text
        assert "false_assignment_rate" in report_text
        assert "false_novelty_rate" in report_text
        assert "missed_reactivation_rate" in report_text
        assert "unresolved_defer_calibration" in report_text
        assert "retrieval_sufficiency_error_rate" in report_text
        assert "retry_version_determinism" in report_text
        assert "Production ready:" in report_text


# ---------------------------------------------------------------------------
# Report format tests
# ---------------------------------------------------------------------------


class TestReportFormat:
    """Verify report format meets requirements."""

    def test_report_contains_all_six_metrics(self) -> None:
        """Report includes all six required quality metrics."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T50", quality_metrics=[
            "false_assignment", "false_novelty", "missed_reactivation",
            "unresolved_defer_calibration", "retrieval_sufficiency_error",
            "retry_version_determinism",
        ])
        actual = _make_actual_result()
        report = scorer.score([(golden, actual)])

        required_metrics = {
            "false_assignment_rate",
            "false_novelty_rate",
            "missed_reactivation_rate",
            "unresolved_defer_calibration",
            "retrieval_sufficiency_error_rate",
            "retry_version_determinism",
        }
        assert set(report.metrics.keys()) == required_metrics

    def test_each_metric_has_structured_fields(self) -> None:
        """Each metric result has value, numerator, denominator, threshold."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T51")
        actual = _make_actual_result()
        report = scorer.score([(golden, actual)])

        for metric in report.metrics.values():
            assert isinstance(metric.value, float)
            assert isinstance(metric.numerator, int)
            assert isinstance(metric.denominator, int)
            assert isinstance(metric.threshold, str)
            assert metric.threshold == "PENDING_APPROVAL"

    def test_quality_report_serializable(self) -> None:
        """QualityReport.to_dict() produces JSON-serializable output."""
        scorer = IdentityResolutionQualityScorer()
        golden = _make_golden_case("IRID-T52")
        actual = _make_actual_result()
        report = scorer.score([(golden, actual)])

        d = report.to_dict()
        # Ensure it's JSON-serializable
        serialized = json.dumps(d)
        assert serialized is not None
        parsed = json.loads(serialized)
        assert parsed["total_cases"] == 1
