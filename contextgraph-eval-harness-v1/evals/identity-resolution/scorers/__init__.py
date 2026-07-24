"""Identity resolution evaluation scorers.

Provides quality measurement infrastructure for SIE identity resolution:
- IdentityResolutionQualityScorer: Computes Requirement 12.3 quality metrics.
- EvaluationRunner: Orchestrates evaluation runs with config metadata recording.
"""

try:
    from .quality_scorer import (
        CaseResult,
        IdentityResolutionQualityScorer,
        MetricResult,
        QualityReport,
    )
    from .evaluation_runner import (
        EvaluationRunResult,
        EvaluationRunner,
        InferenceConfig,
        ModelConfig,
        PolicyConfig,
        PromptConfig,
        RunConfiguration,
    )
except ImportError:
    pass  # Allow standalone module usage without package context
