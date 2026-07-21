"""Tests for the grounded IRS assessor.

Verifies:
- IRS-3 IMPLIED_PRIOR_STATE: continuation_origin → DORMANT/RETIRED concern.
- IRS-4 BROAD_CANDIDATE_MISMATCH: all candidates non-ACTIVE with active concerns existing.
- IRS-6 CONTINUATION_HISTORY_MISMATCH: continuation_origin not in candidates.
- IRS-2 HISTORICAL_REFERENT: early propositions not covered by candidates.
- IRS-5 ALIAS_OR_VOCABULARY_DRIFT: aliases exist for non-candidate concerns.
- IRS-1 REVISIT_LANGUAGE: placeholder returns None (requires LLM).
- Every emitted signal is grounded in source_evidence.
- Signals start with resolved=False, resolved_by_attempt_ids=[].
- No domain-specific keyword lists used as truth rules.
"""

from __future__ import annotations

import pytest

from app.sie.contracts import (
    AssociationSummary,
    ConcernAlias,
    ConcernSummary,
    GraphStateContext,
    PropositionSummary,
)
from app.sie.enums import (
    AssociationRole,
    BehavioralConfidenceBand,
    ConcernStatus,
    IRSSignalType,
    ParentResolutionState,
    PropositionType,
    RetrievalAttemptStatus,
    SemanticState,
)
from app.sie.identity_models import (
    CandidateRecord,
    ChannelDiagnostic,
    EvidenceReference,
    IRSSignal,
    RetrievalAttemptRecord,
)
from app.sie.models import SemanticPacket
from app.sie.retrieval.channel_protocol import RetrievalResult
from app.sie.retrieval.irs_assessor import IRSAssessor


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_packet(
    *,
    packet_id: str = "pkt-1",
    continuation_origin: str | None = None,
    message_seq_range: tuple[int, int] = (10, 12),
) -> SemanticPacket:
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key=f"key-{packet_id}",
        conversation_id="conv-1",
        source_message_ids=["msg-1"],
        message_seq_range=message_seq_range,
        user_grounded_meaning="Test packet content",
        continuation_origin=continuation_origin,
        provenance="test",
        packet_formation_version="1.0",
        cohesion_status="COHESIVE",
    )


def _make_candidate(
    *,
    concern_id: str = "concern-1",
    lifecycle_status: ConcernStatus = ConcernStatus.ACTIVE,
    resolved_merge_target: str | None = None,
) -> CandidateRecord:
    return CandidateRecord(
        concern_id=concern_id,
        lifecycle_status=lifecycle_status,
        resolved_merge_target=resolved_merge_target,
        contributing_attempt_ids=["attempt-1"],
        channel_local_diagnostics=[],
        identity_evidence=[],
        contrary_evidence=[],
        confidence=BehavioralConfidenceBand.MEDIUM,
        explanation="Test candidate",
    )


def _make_concern_summary(
    *,
    concern_id: str = "concern-1",
    status: ConcernStatus = ConcernStatus.ACTIVE,
) -> ConcernSummary:
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary="Test concern",
        display_title="Test",
        current_summary="A test concern",
        status=status,
        aliases=[],
        canonical_parent_id=None,
        parent_resolution_state=ParentResolutionState.ROOT_CONFIRMED,
        last_active_at="2024-01-01T00:00:00Z",
        semantic_version=1,
    )


def _make_context(
    *,
    concerns: list[ConcernSummary] | None = None,
    propositions: list[PropositionSummary] | None = None,
    active_associations: list[AssociationSummary] | None = None,
    normalized_aliases: list[ConcernAlias] | None = None,
) -> GraphStateContext:
    return GraphStateContext(
        graph_version=1,
        snapshot_token="snap-1",
        snapshot_digest="digest-1",
        concerns=concerns or [],
        propositions=propositions or [],
        active_associations=active_associations or [],
        pending_decisions=[],
        normalized_aliases=normalized_aliases or [],
    )


def _empty_retrieval_result() -> RetrievalResult:
    return RetrievalResult(attempts=[], candidates=[], total_latency_ms=0)


# ---------------------------------------------------------------------------
# IRS-3: IMPLIED_PRIOR_STATE
# ---------------------------------------------------------------------------


class TestImpliedPriorState:
    """IRS-3: continuation_origin references a DORMANT or RETIRED concern."""

    @pytest.mark.asyncio
    async def test_dormant_concern_emits_high_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin="concern-dormant")
        context = _make_context(
            concerns=[
                _make_concern_summary(
                    concern_id="concern-dormant", status=ConcernStatus.DORMANT
                ),
            ]
        )

        signals = await assessor.assess(
            packet, [], _empty_retrieval_result(), context
        )

        irs3 = [s for s in signals if s.signal_type == IRSSignalType.IMPLIED_PRIOR_STATE]
        assert len(irs3) == 1
        assert irs3[0].confidence == BehavioralConfidenceBand.HIGH
        assert irs3[0].resolved is False
        assert irs3[0].resolved_by_attempt_ids == []
        assert len(irs3[0].source_evidence) >= 1

    @pytest.mark.asyncio
    async def test_retired_concern_emits_high_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin="concern-retired")
        context = _make_context(
            concerns=[
                _make_concern_summary(
                    concern_id="concern-retired", status=ConcernStatus.RETIRED
                ),
            ]
        )

        signals = await assessor.assess(
            packet, [], _empty_retrieval_result(), context
        )

        irs3 = [s for s in signals if s.signal_type == IRSSignalType.IMPLIED_PRIOR_STATE]
        assert len(irs3) == 1
        assert irs3[0].confidence == BehavioralConfidenceBand.HIGH

    @pytest.mark.asyncio
    async def test_active_concern_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin="concern-active")
        context = _make_context(
            concerns=[
                _make_concern_summary(
                    concern_id="concern-active", status=ConcernStatus.ACTIVE
                ),
            ]
        )

        signals = await assessor.assess(
            packet, [], _empty_retrieval_result(), context
        )

        irs3 = [s for s in signals if s.signal_type == IRSSignalType.IMPLIED_PRIOR_STATE]
        assert len(irs3) == 0

    @pytest.mark.asyncio
    async def test_no_continuation_origin_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin=None)
        context = _make_context(
            concerns=[
                _make_concern_summary(
                    concern_id="concern-dormant", status=ConcernStatus.DORMANT
                ),
            ]
        )

        signals = await assessor.assess(
            packet, [], _empty_retrieval_result(), context
        )

        irs3 = [s for s in signals if s.signal_type == IRSSignalType.IMPLIED_PRIOR_STATE]
        assert len(irs3) == 0


# ---------------------------------------------------------------------------
# IRS-4: BROAD_CANDIDATE_MISMATCH
# ---------------------------------------------------------------------------


class TestBroadCandidateMismatch:
    """IRS-4: All candidates non-ACTIVE but active concerns exist in context."""

    @pytest.mark.asyncio
    async def test_all_dormant_candidates_with_active_in_context(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet()
        candidates = [
            _make_candidate(concern_id="c1", lifecycle_status=ConcernStatus.DORMANT),
            _make_candidate(concern_id="c2", lifecycle_status=ConcernStatus.RETIRED),
        ]
        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c1", status=ConcernStatus.DORMANT),
                _make_concern_summary(concern_id="c3", status=ConcernStatus.ACTIVE),
            ]
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs4 = [
            s for s in signals
            if s.signal_type == IRSSignalType.BROAD_CANDIDATE_MISMATCH
        ]
        assert len(irs4) == 1
        assert irs4[0].confidence == BehavioralConfidenceBand.MEDIUM
        assert irs4[0].resolved is False
        assert len(irs4[0].source_evidence) >= 1

    @pytest.mark.asyncio
    async def test_mixed_candidates_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet()
        candidates = [
            _make_candidate(concern_id="c1", lifecycle_status=ConcernStatus.ACTIVE),
            _make_candidate(concern_id="c2", lifecycle_status=ConcernStatus.DORMANT),
        ]
        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c1", status=ConcernStatus.ACTIVE),
            ]
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs4 = [
            s for s in signals
            if s.signal_type == IRSSignalType.BROAD_CANDIDATE_MISMATCH
        ]
        assert len(irs4) == 0

    @pytest.mark.asyncio
    async def test_no_candidates_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet()
        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c1", status=ConcernStatus.ACTIVE),
            ]
        )

        signals = await assessor.assess(
            packet, [], _empty_retrieval_result(), context
        )

        irs4 = [
            s for s in signals
            if s.signal_type == IRSSignalType.BROAD_CANDIDATE_MISMATCH
        ]
        assert len(irs4) == 0

    @pytest.mark.asyncio
    async def test_no_active_concerns_in_context_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet()
        candidates = [
            _make_candidate(concern_id="c1", lifecycle_status=ConcernStatus.DORMANT),
        ]
        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c1", status=ConcernStatus.DORMANT),
            ]
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs4 = [
            s for s in signals
            if s.signal_type == IRSSignalType.BROAD_CANDIDATE_MISMATCH
        ]
        assert len(irs4) == 0


# ---------------------------------------------------------------------------
# IRS-6: CONTINUATION_HISTORY_MISMATCH
# ---------------------------------------------------------------------------


class TestContinuationHistoryMismatch:
    """IRS-6: continuation_origin but no candidate matches that origin."""

    @pytest.mark.asyncio
    async def test_origin_not_in_candidates_emits_high_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin="origin-concern")
        candidates = [
            _make_candidate(concern_id="other-concern"),
        ]
        context = _make_context(
            concerns=[
                _make_concern_summary(
                    concern_id="origin-concern", status=ConcernStatus.ACTIVE
                ),
            ]
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs6 = [
            s for s in signals
            if s.signal_type == IRSSignalType.CONTINUATION_HISTORY_MISMATCH
        ]
        assert len(irs6) == 1
        assert irs6[0].confidence == BehavioralConfidenceBand.HIGH
        assert irs6[0].resolved is False
        assert len(irs6[0].source_evidence) >= 1

    @pytest.mark.asyncio
    async def test_origin_matches_candidate_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin="matching-concern")
        candidates = [
            _make_candidate(concern_id="matching-concern"),
        ]
        context = _make_context()

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs6 = [
            s for s in signals
            if s.signal_type == IRSSignalType.CONTINUATION_HISTORY_MISMATCH
        ]
        assert len(irs6) == 0

    @pytest.mark.asyncio
    async def test_origin_matches_merge_target_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin="merged-target")
        candidates = [
            _make_candidate(
                concern_id="other",
                resolved_merge_target="merged-target",
            ),
        ]
        context = _make_context()

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs6 = [
            s for s in signals
            if s.signal_type == IRSSignalType.CONTINUATION_HISTORY_MISMATCH
        ]
        assert len(irs6) == 0

    @pytest.mark.asyncio
    async def test_no_continuation_origin_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin=None)
        candidates = [_make_candidate(concern_id="c1")]
        context = _make_context()

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs6 = [
            s for s in signals
            if s.signal_type == IRSSignalType.CONTINUATION_HISTORY_MISMATCH
        ]
        assert len(irs6) == 0


# ---------------------------------------------------------------------------
# IRS-2: HISTORICAL_REFERENT
# ---------------------------------------------------------------------------


class TestHistoricalReferent:
    """IRS-2: Early propositions not covered by candidate set."""

    @pytest.mark.asyncio
    async def test_early_propositions_uncovered_emits_medium_signal(self) -> None:
        assessor = IRSAssessor()
        # Packet is at seq 10-12, referencing early content
        packet = _make_packet(message_seq_range=(10, 12))
        candidates = [_make_candidate(concern_id="c-recent")]

        # Propositions from early conversation (seq 1-2)
        propositions = [
            PropositionSummary(
                proposition_id="prop-early",
                canonical_meaning="Early discussion topic",
                proposition_type=PropositionType.CLAIM,
                speaker_role="user",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(1, 2),
            ),
            PropositionSummary(
                proposition_id="prop-late",
                canonical_meaning="Recent discussion topic",
                proposition_type=PropositionType.CLAIM,
                speaker_role="user",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(8, 9),
            ),
        ]
        associations = [
            AssociationSummary(
                association_id="assoc-1",
                proposition_id="prop-early",
                concern_id="c-early",
                role=AssociationRole.PRIMARY_OWNER,
                semantic_state=SemanticState.ACTIVE,
            ),
        ]
        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c-early", status=ConcernStatus.ACTIVE),
                _make_concern_summary(concern_id="c-recent", status=ConcernStatus.ACTIVE),
            ],
            propositions=propositions,
            active_associations=associations,
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs2 = [
            s for s in signals
            if s.signal_type == IRSSignalType.HISTORICAL_REFERENT
        ]
        assert len(irs2) == 1
        assert irs2[0].confidence == BehavioralConfidenceBand.MEDIUM
        assert irs2[0].resolved is False
        assert len(irs2[0].source_evidence) >= 1

    @pytest.mark.asyncio
    async def test_early_propositions_covered_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet(message_seq_range=(10, 12))
        candidates = [_make_candidate(concern_id="c-early")]

        propositions = [
            PropositionSummary(
                proposition_id="prop-early",
                canonical_meaning="Early discussion topic",
                proposition_type=PropositionType.CLAIM,
                speaker_role="user",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(1, 2),
            ),
        ]
        associations = [
            AssociationSummary(
                association_id="assoc-1",
                proposition_id="prop-early",
                concern_id="c-early",
                role=AssociationRole.PRIMARY_OWNER,
                semantic_state=SemanticState.ACTIVE,
            ),
        ]
        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c-early", status=ConcernStatus.ACTIVE),
            ],
            propositions=propositions,
            active_associations=associations,
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs2 = [
            s for s in signals
            if s.signal_type == IRSSignalType.HISTORICAL_REFERENT
        ]
        assert len(irs2) == 0

    @pytest.mark.asyncio
    async def test_packet_itself_is_early_no_signal(self) -> None:
        """If packet is from the early part of conversation, no IRS-2 signal."""
        assessor = IRSAssessor()
        packet = _make_packet(message_seq_range=(1, 2))
        candidates = [_make_candidate(concern_id="c-other")]

        propositions = [
            PropositionSummary(
                proposition_id="prop-early",
                canonical_meaning="Early discussion topic",
                proposition_type=PropositionType.CLAIM,
                speaker_role="user",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(1, 2),
            ),
            PropositionSummary(
                proposition_id="prop-mid",
                canonical_meaning="Mid discussion",
                proposition_type=PropositionType.CLAIM,
                speaker_role="user",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(5, 6),
            ),
        ]
        associations = [
            AssociationSummary(
                association_id="assoc-1",
                proposition_id="prop-early",
                concern_id="c-early",
                role=AssociationRole.PRIMARY_OWNER,
                semantic_state=SemanticState.ACTIVE,
            ),
        ]
        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c-early", status=ConcernStatus.ACTIVE),
            ],
            propositions=propositions,
            active_associations=associations,
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs2 = [
            s for s in signals
            if s.signal_type == IRSSignalType.HISTORICAL_REFERENT
        ]
        assert len(irs2) == 0


# ---------------------------------------------------------------------------
# IRS-5: ALIAS_OR_VOCABULARY_DRIFT
# ---------------------------------------------------------------------------


class TestAliasOrVocabularyDrift:
    """IRS-5: Aliases exist for concerns not in the candidate set."""

    @pytest.mark.asyncio
    async def test_uncovered_alias_active_concern_emits_medium_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet()
        candidates = [_make_candidate(concern_id="c-candidate")]

        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c-candidate", status=ConcernStatus.ACTIVE),
                _make_concern_summary(concern_id="c-aliased", status=ConcernStatus.ACTIVE),
            ],
            normalized_aliases=[
                ConcernAlias(
                    concern_id="c-aliased",
                    alias_text="alternative name",
                    normalized_form="alternative_name",
                ),
            ],
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs5 = [
            s for s in signals
            if s.signal_type == IRSSignalType.ALIAS_OR_VOCABULARY_DRIFT
        ]
        assert len(irs5) == 1
        assert irs5[0].confidence == BehavioralConfidenceBand.MEDIUM
        assert irs5[0].resolved is False
        assert len(irs5[0].source_evidence) >= 1

    @pytest.mark.asyncio
    async def test_alias_concern_already_in_candidates_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet()
        candidates = [_make_candidate(concern_id="c-aliased")]

        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c-aliased", status=ConcernStatus.ACTIVE),
            ],
            normalized_aliases=[
                ConcernAlias(
                    concern_id="c-aliased",
                    alias_text="alternative name",
                    normalized_form="alternative_name",
                ),
            ],
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs5 = [
            s for s in signals
            if s.signal_type == IRSSignalType.ALIAS_OR_VOCABULARY_DRIFT
        ]
        assert len(irs5) == 0

    @pytest.mark.asyncio
    async def test_alias_for_merged_concern_no_signal(self) -> None:
        """Aliases for MERGED concerns should not emit IRS-5."""
        assessor = IRSAssessor()
        packet = _make_packet()
        candidates = [_make_candidate(concern_id="c1")]

        context = _make_context(
            concerns=[
                _make_concern_summary(concern_id="c1", status=ConcernStatus.ACTIVE),
                _make_concern_summary(concern_id="c-merged", status=ConcernStatus.MERGED),
            ],
            normalized_aliases=[
                ConcernAlias(
                    concern_id="c-merged",
                    alias_text="old name",
                    normalized_form="old_name",
                ),
            ],
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs5 = [
            s for s in signals
            if s.signal_type == IRSSignalType.ALIAS_OR_VOCABULARY_DRIFT
        ]
        assert len(irs5) == 0

    @pytest.mark.asyncio
    async def test_no_aliases_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet()
        candidates = [_make_candidate(concern_id="c1")]
        context = _make_context(
            concerns=[_make_concern_summary(concern_id="c1")],
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs5 = [
            s for s in signals
            if s.signal_type == IRSSignalType.ALIAS_OR_VOCABULARY_DRIFT
        ]
        assert len(irs5) == 0


# ---------------------------------------------------------------------------
# IRS-1: REVISIT_LANGUAGE (placeholder)
# ---------------------------------------------------------------------------


class TestRevisitLanguage:
    """IRS-1: Placeholder that currently returns no signal."""

    @pytest.mark.asyncio
    async def test_placeholder_returns_no_signal(self) -> None:
        assessor = IRSAssessor()
        packet = _make_packet()
        candidates = [_make_candidate()]
        context = _make_context(
            concerns=[_make_concern_summary()],
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        irs1 = [
            s for s in signals
            if s.signal_type == IRSSignalType.REVISIT_LANGUAGE
        ]
        assert len(irs1) == 0


# ---------------------------------------------------------------------------
# Cross-cutting invariants
# ---------------------------------------------------------------------------


class TestSignalInvariants:
    """Every emitted signal must be grounded and start unresolved."""

    @pytest.mark.asyncio
    async def test_all_signals_grounded(self) -> None:
        """All emitted signals must have non-empty source_evidence."""
        assessor = IRSAssessor()
        # Set up a scenario that triggers multiple signals
        packet = _make_packet(
            continuation_origin="origin-concern",
            message_seq_range=(10, 12),
        )
        candidates = [
            _make_candidate(concern_id="c-dormant", lifecycle_status=ConcernStatus.DORMANT),
        ]
        context = _make_context(
            concerns=[
                _make_concern_summary(
                    concern_id="origin-concern", status=ConcernStatus.DORMANT
                ),
                _make_concern_summary(concern_id="c-dormant", status=ConcernStatus.DORMANT),
                _make_concern_summary(concern_id="c-active", status=ConcernStatus.ACTIVE),
            ],
            normalized_aliases=[
                ConcernAlias(
                    concern_id="c-active",
                    alias_text="drifted name",
                    normalized_form="drifted_name",
                ),
            ],
        )

        signals = await assessor.assess(
            packet, candidates, _empty_retrieval_result(), context
        )

        assert len(signals) > 0, "Expected at least one signal in multi-trigger scenario"
        for signal in signals:
            assert len(signal.source_evidence) > 0, (
                f"Signal {signal.signal_type.value} has no source_evidence"
            )
            for evidence in signal.source_evidence:
                assert evidence.entity_id, "Evidence must have entity_id"
                assert evidence.entity_type, "Evidence must have entity_type"

    @pytest.mark.asyncio
    async def test_all_signals_start_unresolved(self) -> None:
        """All emitted signals must have resolved=False and empty resolved_by_attempt_ids."""
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin="concern-dormant")
        context = _make_context(
            concerns=[
                _make_concern_summary(
                    concern_id="concern-dormant", status=ConcernStatus.DORMANT
                ),
            ]
        )

        signals = await assessor.assess(
            packet, [], _empty_retrieval_result(), context
        )

        for signal in signals:
            assert signal.resolved is False, (
                f"Signal {signal.signal_type.value} should start unresolved"
            )
            assert signal.resolved_by_attempt_ids == [], (
                f"Signal {signal.signal_type.value} should have empty resolved_by_attempt_ids"
            )

    @pytest.mark.asyncio
    async def test_no_signals_when_nothing_triggers(self) -> None:
        """Empty context and no continuation_origin should produce no signals."""
        assessor = IRSAssessor()
        packet = _make_packet(continuation_origin=None)
        context = _make_context()

        signals = await assessor.assess(
            packet, [], _empty_retrieval_result(), context
        )

        assert signals == []
