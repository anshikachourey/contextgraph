"""Tests for PendingDecisionManager — pending identity decision lifecycle.

Covers:
- Creation with deterministic keys from canonical semantic request identity.
- Duplicate detection (same creation key → same decision ID).
- Re-evaluation gating (max attempts, cooldown).
- Resolution preserves original history.
- All PipelineOutcome values that produce pending decisions.
- Normalized membership referential integrity.
- Property-based tests for retry deduplication and bounded re-evaluation.

Design authority: consolidated final design.md §13.
"""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.sie.enums import (
    CohesionStatus,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    RetentionLevel,
    SemanticState,
)
from app.sie.id_generation import (
    build_pending_semantic_decision_key,
    resolve_entity_id,
)
from app.sie.identity_policy import ReEvaluationPolicy
from app.sie.models import Proposition, SemanticPacket
from app.sie.retrieval.pending_decision_manager import (
    PENDING_OUTCOMES,
    PendingDecisionBundle,
    PendingDecisionManager,
    PendingIdentityDetail,
    PendingPropositionMembership,
    ReEvaluationEligibility,
    ResolutionResult,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_packet(
    *,
    packet_id: str = "pkt-001",
    packet_creation_key: str = "req-1:partition-a",
    conversation_id: str = "conv-001",
) -> SemanticPacket:
    """Create a minimal SemanticPacket for testing."""
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=packet_creation_key,
        conversation_id=conversation_id,
        source_message_ids=["msg-1"],
        message_seq_range=(1, 1),
        user_grounded_meaning="User wants to learn ML fundamentals",
        provenance="direct",
        packet_formation_version="1.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_proposition(
    *,
    proposition_id: str = "prop-001",
    retention_levels: list[RetentionLevel] | None = None,
) -> Proposition:
    """Create a Proposition with configurable retention_levels."""
    if retention_levels is None:
        retention_levels = [RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE]
    return Proposition(
        proposition_id=proposition_id,
        proposition_creation_key=f"req-1:{proposition_id}",
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        speaker_role="USER",
        canonical_meaning="I want to learn about ML",
        proposition_type=PropositionType.GOAL,
        message_seq_range=(1, 1),
        provenance=PropositionProvenance.DIRECT,
        semantic_state=SemanticState.ACTIVE,
        retention_levels=retention_levels,
        created_at="2024-01-01T00:00:00Z",
        extraction_version="1.0",
    )


def _make_policy(
    *,
    max_attempts: int = 3,
    cooldown_ms: int = 5000,
    triggers: list[str] | None = None,
) -> ReEvaluationPolicy:
    """Create a ReEvaluationPolicy for testing."""
    if triggers is None:
        triggers = [
            "new_evidence",
            "alias_change",
            "graph_repair",
            "merge_event",
            "retrieval_improvement",
            "policy_change",
            "manual_validation",
        ]
    return ReEvaluationPolicy(
        policy_version="1.0.0",
        triggers=triggers,
        max_re_evaluation_attempts=max_attempts,
        cooldown_between_attempts_ms=cooldown_ms,
    )


# ---------------------------------------------------------------------------
# Task 13.1: Creation and persistence tests
# ---------------------------------------------------------------------------


class TestPendingDecisionCreation:
    """Tests for pending decision creation with deterministic keys."""

    def test_create_pending_decision_unresolved(self):
        """UNRESOLVED outcome creates a pending decision with 'unresolved' state."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        assert not bundle.is_duplicate
        assert bundle.decision.outcome == PipelineOutcome.UNRESOLVED
        assert bundle.decision.lifecycle_state == "unresolved"
        assert bundle.decision.stage == "identity_resolution"
        assert bundle.decision.conversation_id == "conv-001"

    def test_create_pending_decision_defer(self):
        """DEFER outcome creates a pending decision with 'deferred' state."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.DEFER,
            request_id="req-001",
            graph_version=5,
        )

        assert not bundle.is_duplicate
        assert bundle.decision.outcome == PipelineOutcome.DEFER
        assert bundle.decision.lifecycle_state == "deferred"

    def test_create_pending_decision_retrieval_inconclusive(self):
        """RETRIEVAL_INCONCLUSIVE creates decision with 'unresolved' state."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            request_id="req-001",
            graph_version=5,
        )

        assert not bundle.is_duplicate
        assert bundle.decision.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert bundle.decision.lifecycle_state == "unresolved"

    def test_create_pending_decision_requires_validation(self):
        """REQUIRES_VALIDATION creates decision with 'pending' state."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.REQUIRES_VALIDATION,
            request_id="req-001",
            graph_version=5,
        )

        assert not bundle.is_duplicate
        assert bundle.decision.outcome == PipelineOutcome.REQUIRES_VALIDATION
        assert bundle.decision.lifecycle_state == "pending"

    def test_invalid_outcome_raises(self):
        """YES and NO are not valid pending outcomes."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        with pytest.raises(ValueError, match="Cannot create pending decision"):
            manager.create_pending_decision(
                packet=packet,
                propositions=props,
                outcome=PipelineOutcome.YES,
                request_id="req-001",
                graph_version=5,
            )

        with pytest.raises(ValueError, match="Cannot create pending decision"):
            manager.create_pending_decision(
                packet=packet,
                propositions=props,
                outcome=PipelineOutcome.NO,
                request_id="req-001",
                graph_version=5,
            )

    def test_deterministic_creation_key(self):
        """Creation key is deterministic from packet_creation_key, not random."""
        manager = PendingDecisionManager()
        packet = _make_packet(packet_creation_key="req-1:partition-a")
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        # The creation key should use build_pending_semantic_decision_key
        expected_key = build_pending_semantic_decision_key(
            "req-001", "identity_resolution", "req-1:partition-a"
        )
        assert bundle.decision.decision_creation_key == expected_key

        # The decision_id should be resolved from the creation key
        expected_id = resolve_entity_id("pending_semantic_decision", expected_key)
        assert bundle.decision.decision_id == expected_id

    def test_entity_creation_key_from_packet_creation_key(self):
        """entity_creation_key derives from packet_creation_key, not request_id."""
        manager = PendingDecisionManager()
        packet = _make_packet(packet_creation_key="stable-semantic-key")
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="transport-request-id-xyz",
            graph_version=5,
        )

        # entity_creation_key is the packet's creation key (semantic identity)
        assert bundle.decision.entity_creation_key == "stable-semantic-key"

    def test_identity_detail_created(self):
        """Identity detail is created with packet and graph version info."""
        manager = PendingDecisionManager()
        packet = _make_packet(packet_id="pkt-test")
        props = [
            _make_proposition(proposition_id="p1"),
            _make_proposition(proposition_id="p2"),
        ]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=7,
        )

        assert bundle.identity_detail.decision_id == bundle.decision.decision_id
        assert bundle.identity_detail.packet_id == "pkt-test"
        assert bundle.identity_detail.proposition_ids == ["p1", "p2"]
        assert bundle.identity_detail.graph_version_analyzed == 7

    def test_proposition_memberships_ordered(self):
        """Proposition memberships preserve order with correct ordinals."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [
            _make_proposition(proposition_id="p-alpha"),
            _make_proposition(proposition_id="p-beta"),
            _make_proposition(proposition_id="p-gamma"),
        ]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.DEFER,
            request_id="req-001",
            graph_version=3,
        )

        assert len(bundle.proposition_memberships) == 3
        for i, m in enumerate(bundle.proposition_memberships):
            assert m.decision_id == bundle.decision.decision_id
            assert m.proposition_id == props[i].proposition_id
            assert m.ordinal == i


class TestDuplicateDetection:
    """Tests for duplicate delivery detection via creation_key uniqueness."""

    def test_same_packet_same_request_is_duplicate(self):
        """Same packet + request produces same decision ID (duplicate)."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle1 = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )
        bundle2 = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        assert bundle1.decision.decision_id == bundle2.decision.decision_id
        assert not bundle1.is_duplicate
        assert bundle2.is_duplicate

    def test_different_packet_is_not_duplicate(self):
        """Different packet creation keys produce different decisions."""
        manager = PendingDecisionManager()
        packet1 = _make_packet(packet_creation_key="req-1:part-a")
        packet2 = _make_packet(packet_creation_key="req-1:part-b")
        props = [_make_proposition()]

        bundle1 = manager.create_pending_decision(
            packet=packet1,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )
        bundle2 = manager.create_pending_decision(
            packet=packet2,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        assert bundle1.decision.decision_id != bundle2.decision.decision_id
        assert not bundle1.is_duplicate
        assert not bundle2.is_duplicate

    def test_retry_stability_same_creation_key(self):
        """Retries with the same inputs produce deterministic IDs."""
        manager1 = PendingDecisionManager()
        manager2 = PendingDecisionManager()
        packet = _make_packet(packet_creation_key="stable-key")
        props = [_make_proposition()]

        bundle1 = manager1.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.DEFER,
            request_id="req-001",
            graph_version=5,
        )
        bundle2 = manager2.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.DEFER,
            request_id="req-001",
            graph_version=5,
        )

        # Same inputs → same deterministic decision ID
        assert bundle1.decision.decision_id == bundle2.decision.decision_id
        assert bundle1.decision.decision_creation_key == bundle2.decision.decision_creation_key


# ---------------------------------------------------------------------------
# Task 13.2: Re-evaluation and resolution tests
# ---------------------------------------------------------------------------


class TestReEvaluation:
    """Tests for re-evaluation gating with policy-driven limits."""

    def test_eligible_when_under_max_attempts(self):
        """Re-evaluation is permitted when under max attempts."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]
        policy = _make_policy(max_attempts=5, cooldown_ms=0)

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        result = manager.can_re_evaluate(
            decision=bundle.decision,
            policy=policy,
            current_attempt_count=2,
            last_attempt_time=None,
        )

        assert result.eligible
        assert result.attempts_remaining == 3

    def test_blocked_when_max_attempts_reached(self):
        """Re-evaluation is blocked when max attempts are exhausted."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]
        policy = _make_policy(max_attempts=3)

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        result = manager.can_re_evaluate(
            decision=bundle.decision,
            policy=policy,
            current_attempt_count=3,
            last_attempt_time=None,
        )

        assert not result.eligible
        assert result.attempts_remaining == 0
        assert "exhausted" in result.reason.lower()

    def test_blocked_during_cooldown(self):
        """Re-evaluation is blocked during cooldown period."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]
        policy = _make_policy(max_attempts=5, cooldown_ms=10000)

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        # Last attempt was just now
        result = manager.can_re_evaluate(
            decision=bundle.decision,
            policy=policy,
            current_attempt_count=1,
            last_attempt_time=time.time(),
        )

        assert not result.eligible
        assert "cooldown" in result.reason.lower()

    def test_eligible_after_cooldown_expires(self):
        """Re-evaluation is permitted after cooldown expires."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]
        policy = _make_policy(max_attempts=5, cooldown_ms=1000)

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        # Last attempt was 2 seconds ago (cooldown is 1 second)
        result = manager.can_re_evaluate(
            decision=bundle.decision,
            policy=policy,
            current_attempt_count=1,
            last_attempt_time=time.time() - 2.0,
        )

        assert result.eligible
        assert result.attempts_remaining == 4

    def test_resolved_decision_cannot_be_re_evaluated(self):
        """Already-resolved decisions cannot be re-evaluated."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]
        policy = _make_policy(max_attempts=5)

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        # Resolve the decision first
        resolution = manager.resolve_decision(
            decision=bundle.decision,
            resolution_metadata={"resolver": "test"},
        )

        result = manager.can_re_evaluate(
            decision=resolution.decision,
            policy=policy,
            current_attempt_count=0,
            last_attempt_time=None,
        )

        assert not result.eligible
        assert "already resolved" in result.reason.lower()

    def test_valid_trigger_check(self):
        """is_valid_trigger only accepts configured triggers."""
        manager = PendingDecisionManager()
        policy = _make_policy(triggers=["new_evidence", "alias_change"])

        assert manager.is_valid_trigger("new_evidence", policy)
        assert manager.is_valid_trigger("alias_change", policy)
        assert not manager.is_valid_trigger("unknown_trigger", policy)
        assert not manager.is_valid_trigger("policy_change", policy)

    def test_no_hardcoded_limits(self):
        """Limits come entirely from policy, not hardcoded values."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        # Policy with very high limits
        high_policy = _make_policy(max_attempts=1000, cooldown_ms=0)
        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        result = manager.can_re_evaluate(
            decision=bundle.decision,
            policy=high_policy,
            current_attempt_count=999,
            last_attempt_time=None,
        )
        assert result.eligible
        assert result.attempts_remaining == 1

        # Same attempt count with low-limit policy
        low_policy = _make_policy(max_attempts=5, cooldown_ms=0)
        result = manager.can_re_evaluate(
            decision=bundle.decision,
            policy=low_policy,
            current_attempt_count=999,
            last_attempt_time=None,
        )
        assert not result.eligible


class TestResolution:
    """Tests for decision resolution preserving original history."""

    def test_resolution_sets_resolved_state(self):
        """Resolving a decision sets lifecycle_state to 'resolved'."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        result = manager.resolve_decision(
            decision=bundle.decision,
            resolution_metadata={"matched_concern_id": "concern-123"},
        )

        assert result.decision.lifecycle_state == "resolved"
        assert result.decision.resolved_at is not None

    def test_resolution_preserves_original_fields(self):
        """Resolution preserves original outcome, rationale, and created_at."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.RETRIEVAL_INCONCLUSIVE,
            request_id="req-001",
            graph_version=5,
        )
        original = bundle.decision

        result = manager.resolve_decision(
            decision=original,
            resolution_metadata={"new_concern_id": "concern-xyz"},
            successor_refs=["assoc-1", "assoc-2"],
        )

        # Original fields preserved
        assert result.decision.outcome == PipelineOutcome.RETRIEVAL_INCONCLUSIVE
        assert result.decision.created_at == original.created_at
        assert result.decision.decision_id == original.decision_id
        assert result.decision.decision_creation_key == original.decision_creation_key
        assert result.decision.originating_request_id == original.originating_request_id

    def test_resolution_links_successor_refs(self):
        """Resolution links successor associations/proposals/repairs."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        result = manager.resolve_decision(
            decision=bundle.decision,
            resolution_metadata={"pathway": "assign_existing"},
            successor_refs=["assoc-new-1", "proposal-abc"],
        )

        assert result.successor_refs == ["assoc-new-1", "proposal-abc"]
        assert "assoc-new-1" in result.decision.dependency_refs
        assert "proposal-abc" in result.decision.dependency_refs

    def test_resolution_stores_metadata(self):
        """Resolution metadata is stored on the decision."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.DEFER,
            request_id="req-001",
            graph_version=5,
        )

        metadata = {
            "resolution_type": "concern_merge",
            "resolved_by_request": "req-002",
            "successor_concern_id": "concern-456",
        }
        result = manager.resolve_decision(
            decision=bundle.decision,
            resolution_metadata=metadata,
        )

        assert result.decision.resolution_metadata == metadata

    def test_double_resolution_raises(self):
        """Cannot resolve an already-resolved decision."""
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-001",
            graph_version=5,
        )

        result = manager.resolve_decision(
            decision=bundle.decision,
            resolution_metadata={"resolved": True},
        )

        with pytest.raises(ValueError, match="already resolved"):
            manager.resolve_decision(
                decision=result.decision,
                resolution_metadata={"resolved": True},
            )


# ---------------------------------------------------------------------------
# Task 13.3: Property-based tests
# ---------------------------------------------------------------------------


# Strategies for hypothesis
pending_outcomes_st = st.sampled_from(list(PENDING_OUTCOMES))
attempt_count_st = st.integers(min_value=0, max_value=100)
max_attempts_st = st.integers(min_value=1, max_value=50)
cooldown_ms_st = st.integers(min_value=0, max_value=60000)


class TestPendingDecisionProperties:
    """Property-based tests for pending decisions.

    **Validates: Requirements 8.1, 8.2, 8.5, 8.8**
    """

    @given(outcome=pending_outcomes_st)
    @settings(max_examples=20)
    def test_all_pending_outcomes_produce_valid_decisions(self, outcome):
        """Every valid pending outcome produces a well-formed decision bundle.

        **Validates: Requirements 8.1**
        """
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=outcome,
            request_id="req-prop",
            graph_version=1,
        )

        assert bundle.decision.outcome == outcome
        assert bundle.decision.lifecycle_state in {
            "pending", "unresolved", "deferred"
        }
        assert bundle.identity_detail.decision_id == bundle.decision.decision_id
        assert len(bundle.proposition_memberships) == len(props)

    @given(
        outcome=pending_outcomes_st,
        request_suffix=st.text(
            alphabet=st.characters(whitelist_categories=("L", "N")),
            min_size=1,
            max_size=10,
        ),
    )
    @settings(max_examples=30)
    def test_duplicate_detection_across_retries(self, outcome, request_suffix):
        """Same creation key always produces same decision ID (dedup).

        **Validates: Requirements 8.8**
        """
        manager = PendingDecisionManager()
        packet = _make_packet(packet_creation_key=f"key-{request_suffix}")
        props = [_make_proposition()]
        request_id = f"req-{request_suffix}"

        bundle1 = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=outcome,
            request_id=request_id,
            graph_version=1,
        )
        bundle2 = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=outcome,
            request_id=request_id,
            graph_version=1,
        )

        assert bundle1.decision.decision_id == bundle2.decision.decision_id
        assert bundle2.is_duplicate

    @given(
        current_attempts=attempt_count_st,
        max_attempts=max_attempts_st,
    )
    @settings(max_examples=50)
    def test_bounded_re_evaluation(self, current_attempts, max_attempts):
        """Re-evaluation is always bounded by the configured maximum.

        **Validates: Requirements 8.5**
        """
        manager = PendingDecisionManager()
        packet = _make_packet()
        props = [_make_proposition()]
        policy = _make_policy(max_attempts=max_attempts, cooldown_ms=0)

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=PipelineOutcome.UNRESOLVED,
            request_id="req-prop",
            graph_version=1,
        )

        result = manager.can_re_evaluate(
            decision=bundle.decision,
            policy=policy,
            current_attempt_count=current_attempts,
            last_attempt_time=None,
        )

        if current_attempts >= max_attempts:
            assert not result.eligible
            assert result.attempts_remaining == 0
        else:
            assert result.eligible
            assert result.attempts_remaining == max_attempts - current_attempts

    @given(outcome=pending_outcomes_st)
    @settings(max_examples=20)
    def test_resolution_preserves_original_history(self, outcome):
        """Resolution always preserves original outcome, created_at, and ID.

        **Validates: Requirements 8.2, 8.6**
        """
        manager = PendingDecisionManager()
        packet = _make_packet(
            packet_creation_key=f"res-key-{outcome.value}"
        )
        props = [_make_proposition()]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=outcome,
            request_id=f"req-{outcome.value}",
            graph_version=1,
        )
        original = bundle.decision

        result = manager.resolve_decision(
            decision=original,
            resolution_metadata={"pathway": "test"},
            successor_refs=["ref-1"],
        )

        # Original fields MUST be preserved
        assert result.decision.decision_id == original.decision_id
        assert result.decision.outcome == original.outcome
        assert result.decision.created_at == original.created_at
        assert result.decision.originating_request_id == original.originating_request_id
        assert result.decision.entity_creation_key == original.entity_creation_key
        # Resolution fields MUST be set
        assert result.decision.lifecycle_state == "resolved"
        assert result.decision.resolved_at is not None

    @given(
        n_propositions=st.integers(min_value=1, max_value=10),
        outcome=pending_outcomes_st,
    )
    @settings(max_examples=20)
    def test_membership_referential_integrity(self, n_propositions, outcome):
        """All memberships reference the decision and maintain correct ordinals.

        **Validates: Requirements 8.2**
        """
        manager = PendingDecisionManager()
        packet = _make_packet(
            packet_creation_key=f"mem-key-{n_propositions}-{outcome.value}"
        )
        props = [
            _make_proposition(proposition_id=f"prop-{i}")
            for i in range(n_propositions)
        ]

        bundle = manager.create_pending_decision(
            packet=packet,
            propositions=props,
            outcome=outcome,
            request_id=f"req-mem-{n_propositions}",
            graph_version=1,
        )

        # All memberships reference the same decision
        for m in bundle.proposition_memberships:
            assert m.decision_id == bundle.decision.decision_id

        # Ordinals are contiguous and zero-based
        ordinals = [m.ordinal for m in bundle.proposition_memberships]
        assert ordinals == list(range(n_propositions))

        # Proposition IDs match input order
        member_prop_ids = [m.proposition_id for m in bundle.proposition_memberships]
        expected_prop_ids = [p.proposition_id for p in props]
        assert member_prop_ids == expected_prop_ids
