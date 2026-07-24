"""Evaluation runner for SIE identity resolution quality measurement.

Orchestrates evaluation runs with full configuration metadata recording.
Per Requirement 12, AC 3 and AC 8-9:
- Records model, prompt, policy, and inference configuration for every run.
- Reports quality metrics separately for each dimension.
- Does NOT approve production behavior until numeric quality thresholds
  are explicitly approved.

Design authority: consolidated final design.md.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

try:
    from .quality_scorer import (
        IdentityResolutionQualityScorer,
        MetricResult,
        QualityReport,
    )
except ImportError:
    from quality_scorer import (  # type: ignore[no-redef]
        IdentityResolutionQualityScorer,
        MetricResult,
        QualityReport,
    )


# ---------------------------------------------------------------------------
# Configuration metadata types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelConfig:
    """Model configuration used for an evaluation run.

    Attributes:
        model_id: Identifier of the LLM model (e.g., "gpt-4o", "claude-3").
        model_version: Specific version/checkpoint of the model.
        provider: Model provider (e.g., "openai", "anthropic").
        temperature: Sampling temperature used.
        max_tokens: Maximum tokens per invocation.
        structured_output: Whether structured output mode was used.
    """

    model_id: str
    model_version: str
    provider: str
    temperature: float
    max_tokens: int
    structured_output: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_id": self.model_id,
            "model_version": self.model_version,
            "provider": self.provider,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "structured_output": self.structured_output,
        }


@dataclass(frozen=True)
class PromptConfig:
    """Prompt/schema configuration for an evaluation run.

    Attributes:
        prompt_version: Versioned identifier of the prompt template.
        schema_version: Version of the structured output schema.
        system_prompt_hash: Content hash of the system prompt for traceability.
        evaluation_prompt_hash: Content hash of the evaluation prompt.
    """

    prompt_version: str
    schema_version: str
    system_prompt_hash: str | None = None
    evaluation_prompt_hash: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "prompt_version": self.prompt_version,
            "schema_version": self.schema_version,
            "system_prompt_hash": self.system_prompt_hash,
            "evaluation_prompt_hash": self.evaluation_prompt_hash,
        }


@dataclass(frozen=True)
class PolicyConfig:
    """Policy configuration for an evaluation run.

    Attributes:
        retrieval_policy_version: Version of the retrieval policy.
        identity_policy_version: Version of the identity resolution policy.
        widening_budget_version: Version of the widening budget configuration.
        re_evaluation_policy_version: Version of re-evaluation policy.
        confidence_rubric_version: Version of the confidence rubric.
    """

    retrieval_policy_version: str
    identity_policy_version: str
    widening_budget_version: str
    re_evaluation_policy_version: str | None = None
    confidence_rubric_version: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "retrieval_policy_version": self.retrieval_policy_version,
            "identity_policy_version": self.identity_policy_version,
            "widening_budget_version": self.widening_budget_version,
            "re_evaluation_policy_version": self.re_evaluation_policy_version,
            "confidence_rubric_version": self.confidence_rubric_version,
        }


@dataclass(frozen=True)
class InferenceConfig:
    """Inference/runtime configuration for an evaluation run.

    Attributes:
        pipeline_version: Version of the identity resolution pipeline code.
        contract_version: API contract version.
        retrieval_timeout_ms: Retrieval channel timeout.
        max_widening_rounds: Maximum adaptive widening rounds.
        max_retry_attempts: Maximum model retry attempts.
        deterministic_mode: Whether deterministic (seeded) inference was used.
    """

    pipeline_version: str
    contract_version: str
    retrieval_timeout_ms: int | None = None
    max_widening_rounds: int | None = None
    max_retry_attempts: int | None = None
    deterministic_mode: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "pipeline_version": self.pipeline_version,
            "contract_version": self.contract_version,
            "retrieval_timeout_ms": self.retrieval_timeout_ms,
            "max_widening_rounds": self.max_widening_rounds,
            "max_retry_attempts": self.max_retry_attempts,
            "deterministic_mode": self.deterministic_mode,
        }


@dataclass
class RunConfiguration:
    """Complete configuration metadata for an evaluation run.

    Records ALL configuration used per Requirement 12, AC 3:
    model, prompt, policy, and inference configuration.
    """

    model: ModelConfig
    prompt: PromptConfig
    policy: PolicyConfig
    inference: InferenceConfig

    def to_dict(self) -> dict[str, Any]:
        return {
            "model": self.model.to_dict(),
            "prompt": self.prompt.to_dict(),
            "policy": self.policy.to_dict(),
            "inference": self.inference.to_dict(),
        }


# ---------------------------------------------------------------------------
# Evaluation run result
# ---------------------------------------------------------------------------


@dataclass
class EvaluationRunResult:
    """Complete result of a single evaluation run.

    Attributes:
        run_id: Unique identifier for this run.
        timestamp: ISO 8601 timestamp when the run started.
        configuration: Full configuration metadata.
        quality_report: Computed quality metrics.
        case_results: Per-case detailed results.
        duration_ms: Total evaluation duration in milliseconds.
        notes: Optional human-readable notes.
    """

    run_id: str
    timestamp: str
    configuration: RunConfiguration
    quality_report: QualityReport
    case_results: list[dict[str, Any]] = field(default_factory=list)
    duration_ms: float = 0.0
    notes: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict for JSON output."""
        return {
            "run_id": self.run_id,
            "timestamp": self.timestamp,
            "configuration": self.configuration.to_dict(),
            "quality_report": self.quality_report.to_dict(),
            "case_results": self.case_results,
            "duration_ms": self.duration_ms,
            "notes": self.notes,
            "production_gate": {
                "all_thresholds_approved": self.quality_report.all_thresholds_approved,
                "production_ready": self.quality_report.production_ready,
                "status": (
                    "APPROVED"
                    if self.quality_report.production_ready
                    else "PENDING_APPROVAL"
                ),
                "blocking_reason": self._blocking_reason(),
            },
        }

    def _blocking_reason(self) -> str | None:
        """Human-readable reason why production gate is blocked."""
        if self.quality_report.production_ready:
            return None
        if not self.quality_report.all_thresholds_approved:
            return (
                "Numeric quality thresholds have not been approved. "
                "Per Requirement 12 AC 9, thresholds must be explicitly "
                "approved and recorded before production rollout."
            )
        failing = [
            name
            for name, m in self.quality_report.metrics.items()
            if m.passed is False
        ]
        if failing:
            return f"Metrics failing threshold: {', '.join(failing)}"
        if self.quality_report.total_failed > 0:
            return (
                f"{self.quality_report.total_failed} cases failed "
                "critical assertions."
            )
        return "Unknown blocking condition."


# ---------------------------------------------------------------------------
# Pipeline adapter protocol
# ---------------------------------------------------------------------------


class PipelineAdapter(Protocol):
    """Protocol for adapters that run the identity resolution pipeline.

    Implementations invoke the actual pipeline (or a mock) and return
    the identity result dict for a given golden case.
    """

    def run_case(self, golden_case: dict[str, Any]) -> dict[str, Any]:
        """Run the pipeline for a single golden case.

        Args:
            golden_case: Full golden case dict from IRID-NNN.json.

        Returns:
            Dict with identity result fields: outcome, action,
            matchedConcernId, identityConfidence, sufficiencyConfidence,
            reactivation, mergeRedirectFollowed, mustWiden.
        """
        ...


# ---------------------------------------------------------------------------
# Evaluation Runner
# ---------------------------------------------------------------------------


class EvaluationRunner:
    """Orchestrates evaluation runs with configuration metadata recording.

    Loads golden cases, runs each through the pipeline adapter, scores
    results, and produces a full evaluation report with configuration
    metadata and quality gate status.

    Usage:
        runner = EvaluationRunner(
            golden_dir=Path("golden/"),
            manifest_path=Path("manifest.json"),
        )
        result = runner.run(
            adapter=my_pipeline_adapter,
            configuration=my_run_config,
        )
        runner.save_result(result, output_path)
    """

    def __init__(
        self,
        golden_dir: Path | None = None,
        manifest_path: Path | None = None,
    ) -> None:
        harness_root = Path(__file__).resolve().parents[1]
        self._golden_dir = golden_dir or (harness_root / "golden")
        self._manifest_path = manifest_path or (harness_root / "manifest.json")
        self._scorer = IdentityResolutionQualityScorer()

    def load_golden_cases(self) -> list[dict[str, Any]]:
        """Load all golden cases from manifest."""
        with open(self._manifest_path) as f:
            manifest = json.load(f)

        cases = []
        for case_id in manifest["goldenCases"]:
            path = self._golden_dir / f"{case_id}.json"
            with open(path) as f:
                cases.append(json.load(f))
        return cases

    def run(
        self,
        adapter: PipelineAdapter,
        configuration: RunConfiguration,
        notes: str | None = None,
    ) -> EvaluationRunResult:
        """Execute a full evaluation run.

        Args:
            adapter: Pipeline adapter that runs cases.
            configuration: Full configuration metadata to record.
            notes: Optional human-readable notes for this run.

        Returns:
            EvaluationRunResult with quality report and metadata.
        """
        run_id = f"eval-{uuid.uuid4().hex[:12]}"
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        start_ms = time.time() * 1000

        golden_cases = self.load_golden_cases()
        cases_with_results: list[tuple[dict[str, Any], dict[str, Any]]] = []
        case_details: list[dict[str, Any]] = []

        for golden in golden_cases:
            actual = adapter.run_case(golden)
            cases_with_results.append((golden, actual))
            case_details.append({
                "case_id": golden["id"],
                "category": golden["category"],
                "domain": golden["domain"],
                "expected_outcome": golden["expectedIdentityResult"]["outcome"],
                "actual_outcome": actual.get("outcome"),
                "correct": (
                    actual.get("outcome")
                    == golden["expectedIdentityResult"]["outcome"]
                    and actual.get("action")
                    == golden["expectedIdentityResult"]["action"]
                    and actual.get("matchedConcernId")
                    == golden["expectedIdentityResult"].get("matchedConcernId")
                ),
            })

        quality_report = self._scorer.score(cases_with_results)
        duration_ms = (time.time() * 1000) - start_ms

        return EvaluationRunResult(
            run_id=run_id,
            timestamp=timestamp,
            configuration=configuration,
            quality_report=quality_report,
            case_results=case_details,
            duration_ms=duration_ms,
            notes=notes,
        )

    def run_determinism_check(
        self,
        adapter: PipelineAdapter,
        configuration: RunConfiguration,
        num_runs: int = 3,
    ) -> MetricResult:
        """Run the same cases multiple times to measure determinism.

        Args:
            adapter: Pipeline adapter that runs cases.
            configuration: Configuration metadata.
            num_runs: Number of repeated runs (default 3).

        Returns:
            MetricResult for retry_version_determinism.
        """
        golden_cases = self.load_golden_cases()
        multi_run_results: list[list[tuple[dict[str, Any], dict[str, Any]]]] = []

        for _ in range(num_runs):
            run_results: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for golden in golden_cases:
                actual = adapter.run_case(golden)
                run_results.append((golden, actual))
            multi_run_results.append(run_results)

        return self._scorer.score_determinism(multi_run_results)

    def save_result(
        self,
        result: EvaluationRunResult,
        output_path: Path,
    ) -> None:
        """Save evaluation result as JSON.

        Args:
            result: The evaluation run result.
            output_path: Path to write the JSON report.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(result.to_dict(), f, indent=2, default=str)

    def format_report(self, result: EvaluationRunResult) -> str:
        """Format a human-readable quality report.

        Args:
            result: The evaluation run result.

        Returns:
            Formatted report string.
        """
        lines = [
            "=" * 72,
            "SIE Identity Resolution — Quality Evaluation Report",
            "=" * 72,
            f"Run ID:     {result.run_id}",
            f"Timestamp:  {result.timestamp}",
            f"Duration:   {result.duration_ms:.0f}ms",
            "",
            "— Configuration —",
            f"  Model:      {result.configuration.model.model_id} "
            f"v{result.configuration.model.model_version}",
            f"  Provider:   {result.configuration.model.provider}",
            f"  Prompt:     {result.configuration.prompt.prompt_version}",
            f"  Schema:     {result.configuration.prompt.schema_version}",
            f"  Retrieval:  {result.configuration.policy.retrieval_policy_version}",
            f"  Identity:   {result.configuration.policy.identity_policy_version}",
            f"  Pipeline:   {result.configuration.inference.pipeline_version}",
            f"  Contract:   {result.configuration.inference.contract_version}",
            "",
            "— Results Summary —",
            f"  Total cases:  {result.quality_report.total_cases}",
            f"  Passed:       {result.quality_report.total_passed}",
            f"  Failed:       {result.quality_report.total_failed}",
            "",
            "— Quality Metrics (Requirement 12, AC 3) —",
        ]

        for name, metric in result.quality_report.metrics.items():
            status = (
                "✓ PASS" if metric.passed is True
                else "✗ FAIL" if metric.passed is False
                else "? PENDING"
            )
            lines.append(
                f"  {name:<40} "
                f"{metric.value:.4f} "
                f"({metric.numerator}/{metric.denominator}) "
                f"[threshold: {metric.threshold}] {status}"
            )

        lines.extend([
            "",
            "— Production Gate —",
            f"  Thresholds approved: {result.quality_report.all_thresholds_approved}",
            f"  Production ready:    {result.quality_report.production_ready}",
        ])

        blocking = result._blocking_reason()
        if blocking:
            lines.append(f"  Blocking reason:     {blocking}")

        lines.append("=" * 72)

        if result.notes:
            lines.extend(["", f"Notes: {result.notes}"])

        return "\n".join(lines)
