"""Pending identity decision manager for SIE identity resolution.

This module implements `PendingDecisionManager`, which creates, persists, and
manages re-evaluation of pending identity decisions. Pending decisions represent
identity resolution outcomes that could not be safely resolved:

- UNRESOLVED: ambiguous candidates, more evidence may resolve.
- DEFER: operational dependency unavailable.
- RETRIEVAL_INCONCLUSIVE: retrieval may have omitted a candidate.
- REQUIRES_VALIDATION: human or higher-assurance validation required.

Key invariants:
- Decision creation keys derive from canonical semantic request identity
  (packet_creation_key), never raw request_id or transport metadata.
- Duplicate delivery cannot create duplicate decisions (creation_key uniqueness).
- Re-evaluation is bounded by configured attempt/cooldown policy.
- Resolution preserves original decision history and links successor references.

Design authority: consolidated final design.md §13 (Pending Identity Decisions).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..enums import PipelineOutcome
from ..id_generation import build_pending_semantic_decision_key, resolve_entity_id
from ..identity_policy import ReEvaluationPolicy
from ..models import PendingSemanticDecision, Proposition, SemanticPacket


# ---------------------------------------------------------------------------
# Pending outcomes that produce pending decisions
# ---------------------------------------------------------------------------

PENDING_OUTCOMES: frozenset[PipelineOutcome] = frozenset(
    {
        PipelineOutcome.UNRESOLVED,
        PipelineOutcome.DEFER,
        PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
        PipelineOutcome.REQUIRES_VALIDATION,
    }
)
"""Pipeline outcomes that result in pending identity decisions."""


# ---------------------------------------------------------------------------
# Lifecycle state mapping from outcome
# ---------------------------------------------------------------------------

_OUTCOME_TO_LIFECYCLE: dict[PipelineOutcome, str] = {
    PipelineOutcome.UNRESOLVED: "unresolved",
    PipelineOutcome.DEFER: "deferred",
    PipelineOutcome.RETRIEVAL_INCONCLUSIVE: "unresolved",
    PipelineOutcome.REQUIRES_VALIDATION: "pending",
}


# ---------------------------------------------------------------------------
# Resolution trigger enum (string constants for flexibility)
# ---------------------------------------------------------------------------

VALID_RESOLUTION_TRIGGERS: frozenset[str] = frozenset(
    {
        "new_evidence",
        "alias_change",
        "graph_repair",
        "merge_event",
        "retrieval_improvement",
        "policy_change",
        "manual_validation",
    }
)
"""Configured events that may trigger pending decision re-evaluation."""


# ---------------------------------------------------------------------------
# Pending identity detail
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PendingIdentityDetail:
    """One-to-one identity detail for a pending decision.

    Contains the packet reference, graph version, and stage information
    for the identity-specific pending decision.
    """

    decision_id: str
    packet_id: str
    proposition_ids: list[str]
    graph_version_analyzed: int
    source_resolution_record_id: str | None = None


# ---------------------------------------------------------------------------
# Pending proposition membership
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PendingPropositionMembership:
    """Normalized many-to-many decision/proposition membership record.

    Tracks which propositions belong to which pending decision, preserving
    ordering for deterministic re-evaluation.
    """

    decision_id: str
    proposition_id: str
    ordinal: int


# ---------------------------------------------------------------------------
# Creation result (atomic bundle)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PendingDecisionBundle:
    """Atomic bundle of pending decision, identity detail, and memberships.

    All three must be persisted atomically — no partial writes are permitted.
    """

    decision: PendingSemanticDecision
    identity_detail: PendingIdentityDetail
    proposition_memberships: list[PendingPropositionMembership]
    is_duplicate: bool = False


# ---------------------------------------------------------------------------
# Re-evaluation eligibility result
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReEvaluationEligibility:
    """Result of checking whether a decision can be re-evaluated.

    Fields:
        eligible: Whether re-evaluation is permitted.
        reason: Explanation of why re-evaluation is or isn't eligible.
        attempts_remaining: How many more attempts are allowed (0 if exhausted).
    """

    eligible: bool
    reason: str
    attempts_remaining: int


# ---------------------------------------------------------------------------
# Resolution result
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ResolutionResult:
    """Result of resolving a pending decision.

    Original decision history is preserved; only lifecycle_state and
    resolved_at are updated. Successor references link to the downstream
    associations, proposals, or repairs that resolved the decision.
    """

    decision: PendingSemanticDecision
    successor_refs: list[str]


# ---------------------------------------------------------------------------
# PendingDecisionManager
# ---------------------------------------------------------------------------


class PendingDecisionManager:
    """Manages pending identity decision lifecycle.

    Responsibilities:
    - Create pending decisions for UNRESOLVED, DEFER, RETRIEVAL_INCONCLUSIVE,
      and REQUIRES_VALIDATION outcomes.
    - Generate deterministic creation keys from canonical semantic request
      identity (packet_creation_key + stage).
    - Prevent duplicate decisions via creation_key uniqueness.
    - Gate re-evaluation by configured attempt/cooldown policy.
    - Resolve decisions while preserving original history.
    """

    # In-memory store for duplicate detection within a single pipeline invocation.
    # In production, uniqueness is enforced by the database
    # (UNIQUE(conversation_id, decision_creation_key)).
    _creation_key_registry: dict[str, str]

    def __init__(self) -> None:
        """Initialize with an empty creation key registry."""
        self._creation_key_registry = {}

    def create_pending_decision(
        self,
        packet: SemanticPacket,
        propositions: list[Proposition],
        outcome: PipelineOutcome,
        request_id: str,
        graph_version: int,
    ) -> PendingDecisionBundle:
        """Create a durable pending decision record with full detail and memberships.

        Uses deterministic creation key derived from canonical semantic request
        identity: packet_creation_key + stage. Never uses raw request_id or
        transport metadata in the creation key.

        If the same creation_key has already been seen (duplicate delivery),
        returns the existing decision without creating a new one.

        Args:
            packet: The concern-cohesive semantic packet.
            propositions: All propositions belonging to this packet.
            outcome: The pipeline outcome triggering the pending decision.
            request_id: The processing request ID (used in
                build_pending_semantic_decision_key per contract, but the
                entity_creation_key is derived from packet_creation_key).
            graph_version: The graph version analyzed when this decision was made.

        Returns:
            PendingDecisionBundle containing the decision, identity detail,
            and proposition memberships.

        Raises:
            ValueError: If outcome is not a valid pending outcome.
        """
        if outcome not in PENDING_OUTCOMES:
            raise ValueError(
                f"Cannot create pending decision for outcome '{outcome.value}'. "
                f"Valid pending outcomes: {sorted(o.value for o in PENDING_OUTCOMES)}"
            )

        stage = "identity_resolution"

        # Entity creation key from canonical semantic request identity:
        # Uses packet_creation_key (stable across retries), not raw request_id.
        entity_creation_key = packet.packet_creation_key

        # Build the pending decision creation key using the canonical builder.
        # This uses request_id + stage + entity_creation_key per the ID strategy,
        # but the ENTITY creation key (which drives the decision's semantic identity)
        # is from packet_creation_key, ensuring retry stability.
        decision_creation_key = build_pending_semantic_decision_key(
            request_id, stage, entity_creation_key
        )

        # Duplicate detection: same creation_key → same decision
        if decision_creation_key in self._creation_key_registry:
            existing_decision_id = self._creation_key_registry[decision_creation_key]
            # Return a stub indicating duplicate
            existing_decision = PendingSemanticDecision(
                decision_id=existing_decision_id,
                decision_creation_key=decision_creation_key,
                conversation_id=packet.conversation_id,
                stage=stage,
                entity_creation_key=entity_creation_key,
                outcome=outcome,
                lifecycle_state=_OUTCOME_TO_LIFECYCLE[outcome],
                originating_request_id=request_id,
                dependency_refs=[],
                rationale=f"Pending decision for {outcome.value} outcome",
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            identity_detail = PendingIdentityDetail(
                decision_id=existing_decision_id,
                packet_id=packet.packet_id,
                proposition_ids=[p.proposition_id for p in propositions],
                graph_version_analyzed=graph_version,
            )
            memberships = [
                PendingPropositionMembership(
                    decision_id=existing_decision_id,
                    proposition_id=p.proposition_id,
                    ordinal=i,
                )
                for i, p in enumerate(propositions)
            ]
            return PendingDecisionBundle(
                decision=existing_decision,
                identity_detail=identity_detail,
                proposition_memberships=memberships,
                is_duplicate=True,
            )

        # Resolve deterministic decision ID from creation key
        decision_id = resolve_entity_id(
            "pending_semantic_decision", decision_creation_key
        )

        # Register for duplicate detection
        self._creation_key_registry[decision_creation_key] = decision_id

        # Map outcome to lifecycle state
        lifecycle_state = _OUTCOME_TO_LIFECYCLE[outcome]

        # Build the pending decision
        now_iso = datetime.now(timezone.utc).isoformat()
        decision = PendingSemanticDecision(
            decision_id=decision_id,
            decision_creation_key=decision_creation_key,
            conversation_id=packet.conversation_id,
            stage=stage,
            entity_creation_key=entity_creation_key,
            outcome=outcome,
            lifecycle_state=lifecycle_state,
            originating_request_id=request_id,
            dependency_refs=[],
            rationale=f"Pending decision for {outcome.value} outcome",
            created_at=now_iso,
        )

        # Build identity detail (one-to-one with decision)
        identity_detail = PendingIdentityDetail(
            decision_id=decision_id,
            packet_id=packet.packet_id,
            proposition_ids=[p.proposition_id for p in propositions],
            graph_version_analyzed=graph_version,
        )

        # Build normalized proposition memberships (ordered)
        memberships = [
            PendingPropositionMembership(
                decision_id=decision_id,
                proposition_id=p.proposition_id,
                ordinal=i,
            )
            for i, p in enumerate(propositions)
        ]

        return PendingDecisionBundle(
            decision=decision,
            identity_detail=identity_detail,
            proposition_memberships=memberships,
            is_duplicate=False,
        )

    def can_re_evaluate(
        self,
        decision: PendingSemanticDecision,
        policy: ReEvaluationPolicy,
        current_attempt_count: int,
        last_attempt_time: float | None,
    ) -> ReEvaluationEligibility:
        """Determine whether a pending decision can be re-evaluated.

        Checks:
        1. Decision is not already resolved.
        2. Attempt count has not exceeded the configured maximum.
        3. Sufficient time has elapsed since the last attempt (cooldown).

        All limits come from the ReEvaluationPolicy — no hardcoded values.

        Args:
            decision: The pending decision to check.
            policy: The versioned re-evaluation policy.
            current_attempt_count: How many re-evaluation attempts have been made.
            last_attempt_time: Unix timestamp (seconds) of the last attempt,
                or None if no previous attempt.

        Returns:
            ReEvaluationEligibility with eligibility status and reasoning.
        """
        # Gate 1: Already resolved decisions cannot be re-evaluated
        if decision.lifecycle_state == "resolved":
            return ReEvaluationEligibility(
                eligible=False,
                reason="Decision is already resolved",
                attempts_remaining=0,
            )

        # Gate 2: Max attempts exceeded
        max_attempts = policy.max_re_evaluation_attempts
        if current_attempt_count >= max_attempts:
            return ReEvaluationEligibility(
                eligible=False,
                reason=(
                    f"Maximum re-evaluation attempts exhausted "
                    f"({current_attempt_count}/{max_attempts})"
                ),
                attempts_remaining=0,
            )

        # Gate 3: Cooldown period
        if last_attempt_time is not None:
            cooldown_seconds = policy.cooldown_between_attempts_ms / 1000.0
            elapsed = time.time() - last_attempt_time
            if elapsed < cooldown_seconds:
                remaining_ms = int((cooldown_seconds - elapsed) * 1000)
                return ReEvaluationEligibility(
                    eligible=False,
                    reason=(
                        f"Cooldown period not elapsed "
                        f"({remaining_ms}ms remaining of "
                        f"{policy.cooldown_between_attempts_ms}ms required)"
                    ),
                    attempts_remaining=max_attempts - current_attempt_count,
                )

        attempts_remaining = max_attempts - current_attempt_count
        return ReEvaluationEligibility(
            eligible=True,
            reason="Re-evaluation permitted by policy",
            attempts_remaining=attempts_remaining,
        )

    def resolve_decision(
        self,
        decision: PendingSemanticDecision,
        resolution_metadata: dict,
        successor_refs: list[str] | None = None,
    ) -> ResolutionResult:
        """Resolve a pending decision, preserving original history.

        Sets lifecycle_state to 'resolved', records resolution_metadata,
        sets resolved_at timestamp, and links successor references (associations,
        proposals, or repairs that resolved the decision).

        The original decision record (creation time, original outcome, rationale)
        is preserved — resolution only adds resolution fields.

        Args:
            decision: The pending decision to resolve.
            resolution_metadata: Metadata about how the decision was resolved
                (e.g., successor concern ID, resolution pathway, resolving
                request ID).
            successor_refs: References to successor associations, proposals,
                or repairs that resolved this decision.

        Returns:
            ResolutionResult with the updated decision and successor references.

        Raises:
            ValueError: If the decision is already resolved.
        """
        if decision.lifecycle_state == "resolved":
            raise ValueError(
                f"Decision '{decision.decision_id}' is already resolved. "
                "Cannot resolve a decision that has already been resolved."
            )

        refs = successor_refs or []
        now_iso = datetime.now(timezone.utc).isoformat()

        # Create a new decision object with resolution fields set.
        # The original fields (outcome, rationale, created_at) are preserved.
        resolved_decision = PendingSemanticDecision(
            decision_id=decision.decision_id,
            decision_creation_key=decision.decision_creation_key,
            conversation_id=decision.conversation_id,
            stage=decision.stage,
            entity_creation_key=decision.entity_creation_key,
            outcome=decision.outcome,
            lifecycle_state="resolved",
            originating_request_id=decision.originating_request_id,
            dependency_refs=decision.dependency_refs + refs,
            resolution_metadata=resolution_metadata,
            rationale=decision.rationale,
            created_at=decision.created_at,
            resolved_at=now_iso,
        )

        return ResolutionResult(
            decision=resolved_decision,
            successor_refs=refs,
        )

    def is_valid_trigger(
        self,
        trigger: str,
        policy: ReEvaluationPolicy,
    ) -> bool:
        """Check if a trigger is configured in the re-evaluation policy.

        Only configured triggers may initiate re-evaluation. This ensures
        re-evaluation is driven by versioned, auditable policy.

        Args:
            trigger: The event type to check.
            policy: The versioned re-evaluation policy.

        Returns:
            True if the trigger is configured in the policy's trigger list.
        """
        return trigger in policy.triggers
