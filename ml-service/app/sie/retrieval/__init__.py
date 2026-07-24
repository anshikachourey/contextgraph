"""SIE retrieval subsystem — channel protocol, registry, and coordination.

This package implements the retrieval architecture for identity resolution:
- Channel protocol defining the contract all retrieval channels must satisfy.
- Channel registry validating channel IDs and query modes against policy.
- Retrieval result aggregation and deduplication.
- Seven canonical channel family implementations.
- IRS assessor for detecting retrieval gaps using grounded evidence.

Design authority: design-corrections.md §6 (Retrieval Architecture), §7.1 (IRS Assessment).
"""

from .channel_protocol import (
    RetrievalCandidate,
    ChannelRegistry,
    RetrievalChannel,
    RetrievalResult,
)
from .retrieval_coordinator import RetrievalCoordinator
from .channels import (
    AliasNormalizedChannel,
    AlternateFormulationChannel,
    DormantScanChannel,
    EmbeddingPrimaryChannel,
    HistoricalRegionChannel,
    IdentitySummaryChannel,
    LexicalEntityChannel,
    create_all_default_channels,
)
from .downstream_separator import DownstreamDecision, DownstreamSeparator
from .irs_assessor import IRSAssessor
from .novelty_checker import NoveltyChecker, NoveltyResult
from .pending_decision_manager import (
    PendingDecisionBundle,
    PendingDecisionManager,
    PendingIdentityDetail,
    PendingPropositionMembership,
    ReEvaluationEligibility,
    ResolutionResult,
)
from .proposition_validator import PropositionDetailValidator, PropositionValidationResult
from .provisional_overlay import ProvisionalOverlay
from .shared_proposal_coalescer import CoalescedProposalResult, SharedProposalCoalescer

__all__ = [
    "CoalescedProposalResult",
    "DownstreamDecision",
    "DownstreamSeparator",
    "AliasNormalizedChannel",
    "AlternateFormulationChannel",
    "ChannelRegistry",
    "DormantScanChannel",
    "EmbeddingPrimaryChannel",
    "HistoricalRegionChannel",
    "IRSAssessor",
    "IdentitySummaryChannel",
    "LexicalEntityChannel",
    "NoveltyChecker",
    "NoveltyResult",
    "PendingDecisionBundle",
    "PendingDecisionManager",
    "PendingIdentityDetail",
    "PendingPropositionMembership",
    "PropositionDetailValidator",
    "PropositionValidationResult",
    "ProvisionalOverlay",
    "ReEvaluationEligibility",
    "ResolutionResult",
    "RetrievalChannel",
    "RetrievalCoordinator",
    "RetrievalCandidate",
    "RetrievalResult",
    "SharedProposalCoalescer",
    "create_all_default_channels",
]
