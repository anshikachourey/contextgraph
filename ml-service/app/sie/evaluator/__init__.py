"""SIE identity evaluator package.

This package contains the semantic identity evaluator components including
the provider-neutral structured LLM adapter, grounding validation, confidence
evaluation, and the core identity evaluation logic.
"""

from .confidence_evaluator import (
    AssociationConfidenceSignals,
    BehavioralConfidenceEvaluator,
    ConfidenceDomain,
    ConfidenceEvaluation,
    IdentitySignals,
    IRSConfidenceSignals,
    RetentionConfidenceSignals,
    SufficiencySignals,
)
from .grounding_validator import (
    GroundingContext,
    GroundingRejectionReason,
    GroundingResult,
    GroundingValidator,
    GroundingViolation,
)
from .identity_evaluator import (
    CandidateAssessment,
    EvaluationOutput,
    IdentityEvaluationResult,
    IdentityEvaluator,
)
from .llm_adapter import (
    BoundedInvocationResult,
    BoundedLLMInvoker,
    DeterministicFakeAdapter,
    LLMAdapterResult,
    LLMInvocationRecord,
    StructuredLLMAdapter,
)

__all__ = [
    "AssociationConfidenceSignals",
    "BehavioralConfidenceEvaluator",
    "BoundedInvocationResult",
    "BoundedLLMInvoker",
    "CandidateAssessment",
    "ConfidenceDomain",
    "ConfidenceEvaluation",
    "DeterministicFakeAdapter",
    "EvaluationOutput",
    "GroundingContext",
    "GroundingRejectionReason",
    "GroundingResult",
    "GroundingValidator",
    "GroundingViolation",
    "IRSConfidenceSignals",
    "IdentityEvaluationResult",
    "IdentityEvaluator",
    "IdentitySignals",
    "LLMAdapterResult",
    "LLMInvocationRecord",
    "RetentionConfidenceSignals",
    "StructuredLLMAdapter",
    "SufficiencySignals",
]
