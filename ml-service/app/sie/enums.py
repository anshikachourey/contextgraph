"""SIE semantic enum definitions.

All enums are string-based for JSON serialization compatibility.
Values are defined by the SIE data-model design specification.
"""

from enum import Enum


class RetentionLevel(str, Enum):
    """Classification of how conversational material should be retained."""

    DISCARD = "DISCARD"
    CONTEXT_ONLY = "CONTEXT_ONLY"
    SUPPORTING_EVIDENCE = "SUPPORTING_EVIDENCE"
    DURABLE_PROPOSITION = "DURABLE_PROPOSITION"
    EMERGENCE_EVIDENCE = "EMERGENCE_EVIDENCE"
    INDEPENDENT_CONCERN_CANDIDATE = "INDEPENDENT_CONCERN_CANDIDATE"


class BehavioralConfidenceBand(str, Enum):
    """Stage-specific confidence band determining pipeline behavior."""

    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class PipelineOutcome(str, Enum):
    """Graduated pipeline decision outcome."""

    YES = "YES"
    NO = "NO"
    UNRESOLVED = "UNRESOLVED"
    DEFER = "DEFER"
    RETRIEVAL_INCONCLUSIVE = "RETRIEVAL_INCONCLUSIVE"
    REQUIRES_VALIDATION = "REQUIRES_VALIDATION"


class PropositionType(str, Enum):
    """Type classification for extracted propositions."""

    QUESTION = "QUESTION"
    CLAIM = "CLAIM"
    PREFERENCE = "PREFERENCE"
    GOAL = "GOAL"
    INTENT = "INTENT"
    DECISION = "DECISION"
    CONSTRAINT = "CONSTRAINT"
    PLAN = "PLAN"
    CORRECTION = "CORRECTION"
    REJECTION = "REJECTION"
    UPDATE = "UPDATE"
    REQUEST = "REQUEST"
    EMOTIONAL_STATE = "EMOTIONAL_STATE"
    EXAMPLE = "EXAMPLE"


class PropositionProvenance(str, Enum):
    """How the proposition was derived from source material."""

    DIRECT = "DIRECT"
    PARAPHRASE = "PARAPHRASE"
    INTERPRETATION = "INTERPRETATION"
    INFERENCE = "INFERENCE"


class SemanticState(str, Enum):
    """Lifecycle state of a semantic entity (proposition or association)."""

    ACTIVE = "ACTIVE"
    SUPERSEDED = "SUPERSEDED"
    RETRACTED = "RETRACTED"
    INVALIDATED = "INVALIDATED"


class CohesionStatus(str, Enum):
    """Result of concern-cohesion analysis for a Semantic Packet."""

    COHESIVE = "COHESIVE"
    MIXED = "MIXED"
    UNRESOLVED_COHESION = "UNRESOLVED_COHESION"


class ConcernStatus(str, Enum):
    """Lifecycle status of a Persistent Concern."""

    ACTIVE = "ACTIVE"
    DORMANT = "DORMANT"
    RETIRED = "RETIRED"
    MERGED = "MERGED"


class ParentResolutionState(str, Enum):
    """Resolution state of a concern's parent relationship."""

    ROOT_CONFIRMED = "ROOT_CONFIRMED"
    PARENT_DEFERRED = "PARENT_DEFERRED"
    PARENT_ASSIGNED = "PARENT_ASSIGNED"


class AssociationRole(str, Enum):
    """Role of a proposition-to-concern association."""

    PRIMARY_OWNER = "PRIMARY_OWNER"
    SUPPORTING_EVIDENCE = "SUPPORTING_EVIDENCE"
    EMERGENCE_EVIDENCE = "EMERGENCE_EVIDENCE"
    CONTEXT = "CONTEXT"
    CROSS_OBJECT_IMPACT = "CROSS_OBJECT_IMPACT"


class ResolutionAction(str, Enum):
    """Identity resolution action taken for a semantic packet."""

    ASSIGN_EXISTING = "ASSIGN_EXISTING"
    PROPOSE_NEW = "PROPOSE_NEW"
    RETAIN_PENDING = "RETAIN_PENDING"
    NONE = "NONE"


class IRSSignalType(str, Enum):
    """Intelligent Retrieval Signal types that indicate retrieval gaps."""

    REVISIT_LANGUAGE = "REVISIT_LANGUAGE"
    HISTORICAL_REFERENT = "HISTORICAL_REFERENT"
    IMPLIED_PRIOR_STATE = "IMPLIED_PRIOR_STATE"
    BROAD_CANDIDATE_MISMATCH = "BROAD_CANDIDATE_MISMATCH"
    ALIAS_OR_VOCABULARY_DRIFT = "ALIAS_OR_VOCABULARY_DRIFT"
    CONTINUATION_HISTORY_MISMATCH = "CONTINUATION_HISTORY_MISMATCH"


class RetrievalAttemptStatus(str, Enum):
    """Outcome status of a single retrieval attempt."""

    SUCCESS_WITH_CANDIDATES = "SUCCESS_WITH_CANDIDATES"
    SUCCESS_EMPTY = "SUCCESS_EMPTY"
    ERROR = "ERROR"
    TIMEOUT = "TIMEOUT"
    UNAVAILABLE = "UNAVAILABLE"
    SKIPPED_WITH_REASON = "SKIPPED_WITH_REASON"


class StageExecutionStatus(str, Enum):
    """Execution status of a pipeline stage (identity or sufficiency)."""

    COMPLETED = "COMPLETED"
    NOT_RUN = "NOT_RUN"
    FAILED = "FAILED"


class ProcessingMode(str, Enum):
    """Processing mode determining which pipeline stages to execute.

    - FULL_PIPELINE: Execute all upstream stages (extraction, retention,
      packet formation, cohesion) followed by identity resolution.
    - IDENTITY_RESOLUTION_ONLY: Skip upstream stages; requires complete
      proposition detail and all primary/secondary retention roles pre-supplied.
    - PENDING_RE_EVALUATION: Re-evaluate previously pending identity decisions
      with new evidence or policy changes.
    """

    FULL_PIPELINE = "FULL_PIPELINE"
    IDENTITY_RESOLUTION_ONLY = "IDENTITY_RESOLUTION_ONLY"
    PENDING_RE_EVALUATION = "PENDING_RE_EVALUATION"
