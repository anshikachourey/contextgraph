"""Property-based tests for novelty/lifecycle invariants.

**Validates: Requirements 2.12, 3.6, 4.1, 4.2, 6.6, 10.2, 10.4**

Tests:
1. Novelty precondition exhaustive: all (novelty_eligible, has_ICC, has_complete_retention)
   combinations yield the correct outcome.
2. Deterministic proposal identity: same packet_creation_key → same concern IDs
   across retries. Different keys → different IDs.
3. Request ID excluded from creation key: varying request_id never changes the
   concern_creation_key or proposed_concern_id.
4. Missing retention fail-closed: any proposition with empty retention_levels always
   produces DEFER/NONE regardless of other propositions.
5. Inconclusive retrieval never produces novelty: if sufficiency confidence != HIGH,
   novelty_eligible is always False from DownstreamSeparator.
6. Merge redirect invariants (lifecycle_handler stub): valid chains resolve, cyclic
   chains rejected, max-depth exceeded rejected.

Uses hypothesis with @settings(max_examples=100).
"""

from __future__ import annotations

from dataclasses import dataclass

from hypothesis import given, settings, assume
from hypothesis import strategies as st

from app.sie.enums import (
    BehavioralConfidenceBand,
    CohesionStatus,
    ConcernStatus,
    ParentResolutionState,
    PipelineOutcome,
    PropositionProvenance,
    PropositionType,
    ResolutionAction,
    RetentionLevel,
    SemanticState,
)
from app.sie.id_generation import build_concern_key, resolve_entity_id
from app.sie.identity_models import CandidateRecord, SufficiencyRecord
from app.sie.models import Proposition, SemanticPacket
from app.sie.retrieval.downstream_separator import (
    DownstreamDecision,
    DownstreamSeparator,
)
from app.sie.retrieval.novelty_checker import NoveltyChecker, NoveltyResult


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

_NON_ICC_LEVELS = [
    level for level in RetentionLevel if level != RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE
]

retention_level_st = st.sampled_from(list(RetentionLevel))
non_icc_retention_level_st = st.sampled_from(_NON_ICC_LEVELS)
confidence_band_st = st.sampled_from(list(BehavioralConfidenceBand))
non_high_confidence_st = st.sampled_from(
    [BehavioralConfidenceBand.MEDIUM, BehavioralConfidenceBand.LOW]
)

nonempty_str_st = st.text(
    min_size=1,
    max_size=50,
    alphabet=st.characters(whitelist_categories=("L", "N", "P"), blacklist_characters="\x00"),
)

packet_creation_key_st = st.text(
    min_size=3,
    max_size=80,
    alphabet=st.characters(whitelist_categories=("L", "N", "P"), blacklist_characters="\x00"),
)

request_id_st = st.text(
    min_size=1,
    max_size=60,
    alphabet=st.characters(whitelist_categories=("L", "N"), blacklist_characters="\x00"),
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_packet(
    *,
    packet_creation_key: str = "req-1:partition-a",
    user_grounded_meaning: str = "User wants to learn ML fundamentals",
) -> SemanticPacket:
    return SemanticPacket(
        packet_id="pkt-001",
        packet_creation_key=packet_creation_key,
        conversation_id="conv-001",
        source_message_ids=["msg-1"],
        message_seq_range=(1, 1),
        user_grounded_meaning=user_grounded_meaning,
        provenance="direct",
        packet_formation_version="1.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_proposition(
    *,
    proposition_id: str = "prop-001",
    retention_levels: list[RetentionLevel] | None = None,
) -> Proposition:
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


def _novelty_eligible_decision() -> DownstreamDecision:
    return DownstreamDecision(
        outcome=PipelineOutcome.NO,
        action=ResolutionAction.PROPOSE_NEW,
        matched_concern_id=None,
        requires_widening=False,
        novelty_eligible=True,
        rationale="No plausible candidate; novelty eligible.",
    )


def _non_novelty_decision() -> DownstreamDecision:
    return DownstreamDecision(
        outcome=PipelineOutcome.UNRESOLVED,
        action=ResolutionAction.RETAIN_PENDING,
        matched_concern_id=None,
        requires_widening=False,
        novelty_eligible=False,
        rationale="Not novelty eligible.",
    )


# ---------------------------------------------------------------------------
# Property 1: Novelty precondition exhaustive
#
# For all combinations of (novelty_eligible, has_ICC, has_complete_retention),
# verify the correct outcome.
# ---------------------------------------------------------------------------


@given(
    novelty_eligible=st.booleans(),
    has_icc=st.booleans(),
    has_complete_retention=st.booleans(),
)
@settings(max_examples=100)
def test_novelty_precondition_exhaustive(
    novelty_eligible: bool,
    has_icc: bool,
    has_complete_retention: bool,
) -> None:
    """For every combination of novelty preconditions, verify the correct outcome.

    **Validates: Requirements 3.6, 4.1, 4.2**

    Preconditions for novelty:
    1. novelty_eligible == True (from downstream separator)
    2. has_complete_retention: all propositions have non-empty retention_levels
    3. has_icc: at least one proposition has INDEPENDENT_CONCERN_CANDIDATE

    Expected outcomes:
    - All True → eligible=True, outcome=NO, action=PROPOSE_NEW
    - novelty_eligible=False → eligible=False, pass-through downstream outcome
    - novelty_eligible=True, incomplete retention → DEFER/NONE (fail-closed)
    - novelty_eligible=True, complete retention, no ICC → UNRESOLVED/RETAIN_PENDING
    """
    checker = NoveltyChecker()
    packet = _make_packet()

    # Build retention_levels for proposition based on flags
    if not has_complete_retention:
        retention_levels: list[RetentionLevel] = []
    elif has_icc:
        retention_levels = [RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE]
    else:
        retention_levels = [RetentionLevel.SUPPORTING_EVIDENCE]

    propositions = [_make_proposition(retention_levels=retention_levels)]
    decision = _novelty_eligible_decision() if novelty_eligible else _non_novelty_decision()

    result = checker.check_novelty(packet, propositions, decision, "req-test")

    if not novelty_eligible:
        # Gate 1: not eligible → pass-through
        assert result.eligible is False
        assert result.outcome == decision.outcome
        assert result.action == decision.action
    elif not has_complete_retention:
        # Gate 2: fail-closed on missing retention
        assert result.eligible is False
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert result.blocked_reason == "missing retention detail"
    elif not has_icc:
        # Gate 3: no INDEPENDENT_CONCERN_CANDIDATE
        assert result.eligible is False
        assert result.outcome == PipelineOutcome.UNRESOLVED
        assert result.action == ResolutionAction.RETAIN_PENDING
        assert "INDEPENDENT_CONCERN_CANDIDATE" in (result.blocked_reason or "")
    else:
        # All preconditions pass → novelty confirmed
        assert result.eligible is True
        assert result.outcome == PipelineOutcome.NO
        assert result.action == ResolutionAction.PROPOSE_NEW
        assert result.proposal is not None
        assert result.blocked_reason is None


# ---------------------------------------------------------------------------
# Property 2: Deterministic proposal identity
#
# Given any (packet_creation_key, "novelty"), the resulting concern_creation_key
# and proposed_concern_id are identical across multiple calls (retries).
# Different packet_creation_keys produce different IDs.
# ---------------------------------------------------------------------------


@given(packet_creation_key=packet_creation_key_st)
@settings(max_examples=100)
def test_deterministic_proposal_identity(packet_creation_key: str) -> None:
    """Same packet_creation_key always yields same concern_creation_key and proposed_concern_id.

    **Validates: Requirements 6.6, 10.2**

    Simulates retries by calling check_novelty multiple times with the same
    packet_creation_key but different request_ids.
    """
    checker = NoveltyChecker()
    packet = _make_packet(packet_creation_key=packet_creation_key)
    propositions = [
        _make_proposition(retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE])
    ]
    decision = _novelty_eligible_decision()

    # Simulate 3 retries with different request_ids
    results = [
        checker.check_novelty(packet, propositions, decision, f"req-retry-{i}")
        for i in range(3)
    ]

    # All must produce the same creation key and proposed ID
    assert all(r.eligible for r in results)
    keys = {r.proposal.concern_creation_key for r in results}
    ids = {r.proposal.proposed_concern_id for r in results}
    assert len(keys) == 1, f"Expected 1 unique key, got {len(keys)}: {keys}"
    assert len(ids) == 1, f"Expected 1 unique ID, got {len(ids)}: {ids}"

    # Verify they match the expected derivation
    expected_key = build_concern_key(packet_creation_key, "novelty")
    expected_id = resolve_entity_id("concern", expected_key)
    assert keys.pop() == expected_key
    assert ids.pop() == expected_id


@given(
    key_a=packet_creation_key_st,
    key_b=packet_creation_key_st,
)
@settings(max_examples=100)
def test_different_packet_keys_produce_different_ids(key_a: str, key_b: str) -> None:
    """Different packet_creation_keys must produce different proposed_concern_ids.

    **Validates: Requirements 6.6, 10.2**
    """
    assume(key_a != key_b)

    checker = NoveltyChecker()
    props = [_make_proposition(retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE])]
    decision = _novelty_eligible_decision()

    result_a = checker.check_novelty(
        _make_packet(packet_creation_key=key_a), props, decision, "req-1"
    )
    result_b = checker.check_novelty(
        _make_packet(packet_creation_key=key_b), props, decision, "req-1"
    )

    assert result_a.eligible and result_b.eligible
    assert result_a.proposal.proposed_concern_id != result_b.proposal.proposed_concern_id
    assert result_a.proposal.concern_creation_key != result_b.proposal.concern_creation_key


# ---------------------------------------------------------------------------
# Property 3: Request ID excluded from creation key
#
# Varying request_id does NOT change concern_creation_key or proposed_concern_id.
# ---------------------------------------------------------------------------


@given(
    packet_creation_key=packet_creation_key_st,
    request_id_a=request_id_st,
    request_id_b=request_id_st,
)
@settings(max_examples=100)
def test_request_id_excluded_from_creation_key(
    packet_creation_key: str,
    request_id_a: str,
    request_id_b: str,
) -> None:
    """Raw request_id must never influence concern_creation_key or proposed_concern_id.

    **Validates: Requirements 6.6, 10.4**
    """
    assume(request_id_a != request_id_b)

    checker = NoveltyChecker()
    packet = _make_packet(packet_creation_key=packet_creation_key)
    propositions = [
        _make_proposition(retention_levels=[RetentionLevel.INDEPENDENT_CONCERN_CANDIDATE])
    ]
    decision = _novelty_eligible_decision()

    result_a = checker.check_novelty(packet, propositions, decision, request_id_a)
    result_b = checker.check_novelty(packet, propositions, decision, request_id_b)

    assert result_a.eligible and result_b.eligible
    assert result_a.proposal.concern_creation_key == result_b.proposal.concern_creation_key
    assert result_a.proposal.proposed_concern_id == result_b.proposal.proposed_concern_id


# ---------------------------------------------------------------------------
# Property 4: Missing retention fail-closed
#
# Any proposition with empty retention_levels always produces DEFER/NONE.
# ---------------------------------------------------------------------------


@given(
    num_good_props=st.integers(min_value=0, max_value=5),
    good_levels=st.lists(
        st.lists(retention_level_st, min_size=1, max_size=3),
        min_size=0,
        max_size=5,
    ),
)
@settings(max_examples=100)
def test_missing_retention_fail_closed(
    num_good_props: int,
    good_levels: list[list[RetentionLevel]],
) -> None:
    """Any proposition with empty retention_levels always produces DEFER/NONE.

    **Validates: Requirements 3.6, 4.1**

    Regardless of how many other propositions have valid retention, if any single
    proposition has empty retention_levels, the result must be DEFER/NONE.
    """
    checker = NoveltyChecker()
    packet = _make_packet()
    decision = _novelty_eligible_decision()

    # Build propositions: some with valid retention, plus one with empty
    propositions = []
    for i, levels in enumerate(good_levels[:num_good_props]):
        propositions.append(
            _make_proposition(
                proposition_id=f"prop-good-{i}",
                retention_levels=levels,
            )
        )
    # Always include one with empty retention_levels
    propositions.append(
        _make_proposition(
            proposition_id="prop-empty-retention",
            retention_levels=[],
        )
    )

    result = checker.check_novelty(packet, propositions, decision, "req-test")

    assert result.eligible is False
    assert result.outcome == PipelineOutcome.DEFER
    assert result.action == ResolutionAction.NONE
    assert result.blocked_reason == "missing retention detail"
    assert result.proposal is None


# ---------------------------------------------------------------------------
# Property 5: Inconclusive retrieval never produces novelty
#
# If sufficiency confidence != HIGH, novelty_eligible is always False from
# DownstreamSeparator.
# ---------------------------------------------------------------------------


@given(
    sufficiency_confidence=non_high_confidence_st,
    num_candidates=st.integers(min_value=0, max_value=5),
    candidate_confidences=st.lists(confidence_band_st, min_size=0, max_size=5),
)
@settings(max_examples=100)
def test_inconclusive_retrieval_never_produces_novelty(
    sufficiency_confidence: BehavioralConfidenceBand,
    num_candidates: int,
    candidate_confidences: list[BehavioralConfidenceBand],
) -> None:
    """If sufficiency confidence != HIGH, novelty_eligible is always False.

    **Validates: Requirements 4.2, 4.3**

    The DownstreamSeparator's critical invariant: inconclusive retrieval
    (confidence != HIGH) NEVER produces novelty_eligible=True.
    """
    separator = DownstreamSeparator()

    # Build a sufficiency record with non-HIGH confidence
    from app.sie.enums import StageExecutionStatus

    sufficiency = SufficiencyRecord(
        stage_status=StageExecutionStatus.COMPLETED,
        confidence=sufficiency_confidence,
        coverage_summary="test coverage",
        unresolved_signals=[],
        failed_coverage_gaps=[],
        rationale="inconclusive test",
    )

    # Build candidates with random confidence bands
    candidates = []
    for i, conf in enumerate(candidate_confidences[:num_candidates]):
        candidates.append(
            CandidateRecord(
                concern_id=f"concern-{i}",
                lifecycle_status=ConcernStatus.ACTIVE,
                contributing_attempt_ids=[f"attempt-{i}"],
                channel_local_diagnostics=[],
                identity_evidence=[],
                contrary_evidence=[],
                confidence=conf,
                explanation=f"candidate {i}",
            )
        )

    # DownstreamSeparator uses sufficiency.confidence to decide path
    result = separator.determine_outcome(sufficiency, candidates)

    # Critical invariant: non-HIGH sufficiency → never novelty_eligible
    assert result.novelty_eligible is False
    assert result.outcome != PipelineOutcome.NO or result.action != ResolutionAction.PROPOSE_NEW


# ---------------------------------------------------------------------------
# Property 6: Merge redirect invariants
#
# Since lifecycle_handler doesn't exist yet, we implement the merge-redirect
# logic as a pure function and test its properties.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MergeRedirectTarget:
    """Stub representing a concern's merge redirect."""
    concern_id: str
    status: ConcernStatus
    merged_into: str | None = None


class MergeRedirectError(Exception):
    """Errors during merge redirect resolution."""
    pass


def follow_merge_redirect_chain(
    start_concern_id: str,
    concern_lookup: dict[str, MergeRedirectTarget],
    max_depth: int = 5,
) -> MergeRedirectTarget:
    """Follow merge redirects to find the terminal concern.

    Rules:
    - Valid chain resolves to a terminal ACTIVE/DORMANT/RETIRED concern.
    - Cyclic chain (A→B→A) detected and rejected.
    - Chain exceeding max_depth rejected.
    - Missing targets rejected.

    Args:
        start_concern_id: The starting concern's ID.
        concern_lookup: Map of concern_id → MergeRedirectTarget.
        max_depth: Maximum chain hops allowed.

    Returns:
        The terminal MergeRedirectTarget.

    Raises:
        MergeRedirectError: If the chain is invalid.
    """
    visited: set[str] = set()
    current_id = start_concern_id
    depth = 0

    while depth <= max_depth:
        if current_id in visited:
            raise MergeRedirectError(
                f"Cyclic merge redirect detected: {current_id} already visited. "
                f"Chain: {visited}"
            )
        visited.add(current_id)

        target = concern_lookup.get(current_id)
        if target is None:
            raise MergeRedirectError(
                f"Missing merge redirect target: {current_id} not found in lookup."
            )

        # Terminal: not MERGED → return it
        if target.status != ConcernStatus.MERGED:
            return target

        # Follow the redirect
        if target.merged_into is None:
            raise MergeRedirectError(
                f"Concern {current_id} has status=MERGED but no merged_into target."
            )
        current_id = target.merged_into
        depth += 1

    raise MergeRedirectError(
        f"Merge redirect chain exceeded max_depth={max_depth} "
        f"starting from {start_concern_id}."
    )


# Strategies for merge redirect testing

terminal_status_st = st.sampled_from(
    [ConcernStatus.ACTIVE, ConcernStatus.DORMANT, ConcernStatus.RETIRED]
)


@given(
    chain_length=st.integers(min_value=1, max_value=5),
    terminal_status=terminal_status_st,
)
@settings(max_examples=100)
def test_valid_merge_chain_resolves_to_terminal(
    chain_length: int,
    terminal_status: ConcernStatus,
) -> None:
    """Valid merge chain of length 1-5 resolves to terminal ACTIVE/DORMANT/RETIRED.

    **Validates: Requirements 2.12, 10.2**

    Build a chain: concern-0 → concern-1 → ... → concern-N (terminal).
    The terminal concern has a non-MERGED status.
    """
    # Build the chain
    lookup: dict[str, MergeRedirectTarget] = {}
    for i in range(chain_length - 1):
        lookup[f"concern-{i}"] = MergeRedirectTarget(
            concern_id=f"concern-{i}",
            status=ConcernStatus.MERGED,
            merged_into=f"concern-{i + 1}",
        )
    # Terminal concern
    terminal_id = f"concern-{chain_length - 1}"
    lookup[terminal_id] = MergeRedirectTarget(
        concern_id=terminal_id,
        status=terminal_status,
        merged_into=None,
    )

    result = follow_merge_redirect_chain("concern-0", lookup, max_depth=5)

    assert result.concern_id == terminal_id
    assert result.status == terminal_status
    assert result.status != ConcernStatus.MERGED


@given(
    cycle_size=st.integers(min_value=2, max_value=5),
)
@settings(max_examples=100)
def test_cyclic_merge_chain_rejected(cycle_size: int) -> None:
    """Cyclic merge chains (A→B→...→A) are detected and rejected.

    **Validates: Requirements 2.12, 10.2**
    """
    # Build a cycle: 0→1→2→...→0
    lookup: dict[str, MergeRedirectTarget] = {}
    for i in range(cycle_size):
        next_id = f"concern-{(i + 1) % cycle_size}"
        lookup[f"concern-{i}"] = MergeRedirectTarget(
            concern_id=f"concern-{i}",
            status=ConcernStatus.MERGED,
            merged_into=next_id,
        )

    import pytest

    with pytest.raises(MergeRedirectError, match="[Cc]yclic"):
        follow_merge_redirect_chain("concern-0", lookup, max_depth=10)


@given(
    chain_length=st.integers(min_value=7, max_value=12),
    terminal_status=terminal_status_st,
)
@settings(max_examples=100)
def test_merge_chain_exceeding_max_depth_rejected(
    chain_length: int,
    terminal_status: ConcernStatus,
) -> None:
    """Chains exceeding max_depth are rejected even if ultimately valid.

    **Validates: Requirements 2.12, 10.2**

    A chain of length N requires N-1 hops. With max_depth=5, any chain
    needing more than 5 hops (i.e., chain_length > 6) must be rejected.
    """
    # Build a valid (non-cyclic) chain that requires more hops than max_depth=5
    lookup: dict[str, MergeRedirectTarget] = {}
    for i in range(chain_length - 1):
        lookup[f"concern-{i}"] = MergeRedirectTarget(
            concern_id=f"concern-{i}",
            status=ConcernStatus.MERGED,
            merged_into=f"concern-{i + 1}",
        )
    terminal_id = f"concern-{chain_length - 1}"
    lookup[terminal_id] = MergeRedirectTarget(
        concern_id=terminal_id,
        status=terminal_status,
        merged_into=None,
    )

    import pytest

    with pytest.raises(MergeRedirectError, match="max_depth"):
        follow_merge_redirect_chain("concern-0", lookup, max_depth=5)


@given(
    chain_length=st.integers(min_value=1, max_value=4),
)
@settings(max_examples=100)
def test_merge_chain_missing_target_rejected(chain_length: int) -> None:
    """If a merge target doesn't exist in the lookup, it's rejected.

    **Validates: Requirements 2.12, 10.2**
    """
    # Build a chain that points to a non-existent target
    lookup: dict[str, MergeRedirectTarget] = {}
    for i in range(chain_length):
        lookup[f"concern-{i}"] = MergeRedirectTarget(
            concern_id=f"concern-{i}",
            status=ConcernStatus.MERGED,
            merged_into=f"concern-{i + 1}",
        )
    # Note: concern-{chain_length} is NOT in lookup → missing target

    import pytest

    with pytest.raises(MergeRedirectError, match="[Mm]issing"):
        follow_merge_redirect_chain("concern-0", lookup, max_depth=10)
