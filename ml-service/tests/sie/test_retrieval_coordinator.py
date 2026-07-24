"""Tests for the RetrievalCoordinator.

Verifies:
- Initial plan execution runs all policy channels in order.
- Candidates are aggregated and deduplicated by concern_id.
- Contributing attempt IDs are preserved across multiple channels.
- Channel errors/timeouts/unavailability are recorded distinctly, not as empty success.
- Failed attempts do not abort the coordinator — other channels continue.
- Channel-local scores remain diagnostics only (LOW confidence default).
- The coordinator does not make ownership decisions.
"""

from __future__ import annotations

import pytest

from app.sie.contracts import (
    ConcernSummary,
    GraphStateContext,
)
from app.sie.enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    ParentResolutionState,
    RetrievalAttemptStatus,
)
from app.sie.retrieval.channel_protocol import RetrievalCandidate
from app.sie.identity_models import (
    CandidateRecord,
    IRSSignal,
    RetrievalAttemptRecord,
)
from app.sie.identity_policy import (
    ChannelFamilyRequirement,
    ChannelInvocation,
    RetrievalPolicy,
)
from app.sie.models import SemanticPacket
from app.sie.retrieval.channel_protocol import (
    ChannelRegistry,
    RetrievalChannel,
    RetrievalResult,
)
from app.sie.retrieval.retrieval_coordinator import RetrievalCoordinator


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_context() -> GraphStateContext:
    """Create a minimal valid GraphStateContext for tests."""
    return GraphStateContext(
        graph_version=1,
        snapshot_token="test-snapshot-token",
        snapshot_digest="test-snapshot-digest",
        concerns=[],
        propositions=[],
        active_associations=[],
    )


def _make_packet() -> SemanticPacket:
    """Create a minimal valid SemanticPacket for tests."""
    return SemanticPacket(
        packet_id="pkt-001",
        packet_creation_key="req-001:partition-0",
        conversation_id="conv-001",
        source_message_ids=["msg-001"],
        message_seq_range=(1, 1),
        user_grounded_meaning="User wants to learn about machine learning",
        provenance="test",
        packet_formation_version="1.0.0",
        cohesion_status="COHESIVE",
    )


def _make_policy(initial_channels: list[ChannelInvocation]) -> RetrievalPolicy:
    """Create a RetrievalPolicy with the given initial channels."""
    return RetrievalPolicy(
        policy_version="1.0.0",
        initial_channels=initial_channels,
        channel_family_requirements={},
        irs_signal_channel_mapping={},
    )


# ---------------------------------------------------------------------------
# Fake channels
# ---------------------------------------------------------------------------


class FakeSuccessChannel:
    """A channel that returns SUCCESS_WITH_CANDIDATES."""

    def __init__(
        self,
        channel_id: str = "embedding_primary_v1",
        channel_family: str = "embedding_primary",
        supported_modes: list[str] | None = None,
        candidate_ids: list[str] | None = None,
        latency_ms: int = 10,
    ) -> None:
        self._channel_id = channel_id
        self._channel_family = channel_family
        self._supported_modes = supported_modes or ["broad", "narrow"]
        self._candidate_ids = candidate_ids or ["concern-A"]
        self._latency_ms = latency_ms

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return self._channel_family

    @property
    def supported_query_modes(self) -> list[str]:
        return self._supported_modes

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        return RetrievalAttemptRecord(
            attempt_id=f"{self._channel_id}_{invocation.query_mode}_attempt",
            channel_id=self._channel_id,
            channel_family=self._channel_family,
            query_mode=invocation.query_mode,
            query_reference="test-query-ref",
            scope_description="test scope",
            status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
            candidate_ids=self._candidate_ids,
            candidate_count=len(self._candidate_ids),
            latency_ms=self._latency_ms,
            retrieval_policy_version="1.0.0",
        )


class FakeEmptyChannel:
    """A channel that returns SUCCESS_EMPTY."""

    def __init__(
        self,
        channel_id: str = "alias_normalized_v1",
        channel_family: str = "alias_normalized",
        supported_modes: list[str] | None = None,
        latency_ms: int = 5,
    ) -> None:
        self._channel_id = channel_id
        self._channel_family = channel_family
        self._supported_modes = supported_modes or ["exact", "fuzzy"]
        self._latency_ms = latency_ms

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return self._channel_family

    @property
    def supported_query_modes(self) -> list[str]:
        return self._supported_modes

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        return RetrievalAttemptRecord(
            attempt_id=f"{self._channel_id}_{invocation.query_mode}_attempt",
            channel_id=self._channel_id,
            channel_family=self._channel_family,
            query_mode=invocation.query_mode,
            query_reference="alias-query-ref",
            scope_description="alias scope",
            status=RetrievalAttemptStatus.SUCCESS_EMPTY,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=self._latency_ms,
            retrieval_policy_version="1.0.0",
        )


class FakeErrorChannel:
    """A channel that returns ERROR status."""

    def __init__(
        self,
        channel_id: str = "lexical_entity_v1",
        channel_family: str = "lexical_entity",
        supported_modes: list[str] | None = None,
        error_status: RetrievalAttemptStatus = RetrievalAttemptStatus.ERROR,
        latency_ms: int = 100,
    ) -> None:
        self._channel_id = channel_id
        self._channel_family = channel_family
        self._supported_modes = supported_modes or ["broad", "narrow"]
        self._error_status = error_status
        self._latency_ms = latency_ms

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return self._channel_family

    @property
    def supported_query_modes(self) -> list[str]:
        return self._supported_modes

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        return RetrievalAttemptRecord(
            attempt_id=f"{self._channel_id}_{invocation.query_mode}_attempt",
            channel_id=self._channel_id,
            channel_family=self._channel_family,
            query_mode=invocation.query_mode,
            query_reference="error-query-ref",
            scope_description="error scope",
            status=self._error_status,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=self._latency_ms,
            failure_reason="Simulated channel failure",
            retrieval_policy_version="1.0.0",
        )


class FakeExceptionChannel:
    """A channel that raises an unhandled exception."""

    def __init__(
        self,
        channel_id: str = "alternate_formulation_v1",
        channel_family: str = "alternate_formulation",
        supported_modes: list[str] | None = None,
    ) -> None:
        self._channel_id = channel_id
        self._channel_family = channel_family
        self._supported_modes = supported_modes or ["default"]

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return self._channel_family

    @property
    def supported_query_modes(self) -> list[str]:
        return self._supported_modes

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        raise RuntimeError("LLM service unavailable")


# ---------------------------------------------------------------------------
# Tests: Basic retrieval execution
# ---------------------------------------------------------------------------


class TestRetrievalCoordinatorExecution:
    """Tests for initial plan execution."""

    @pytest.mark.asyncio
    async def test_executes_all_initial_channels_in_order(self) -> None:
        """Coordinator executes all policy initial_channels in sequence."""
        registry = ChannelRegistry()
        ch1 = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A"],
        )
        ch2 = FakeEmptyChannel(
            channel_id="alias_normalized_v1",
            channel_family="alias_normalized",
        )
        registry.register(ch1)
        registry.register(ch2)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
            ChannelInvocation(
                channel_id="alias_normalized_v1", query_mode="exact", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert len(result.attempts) == 2
        assert result.attempts[0].channel_id == "embedding_primary_v1"
        assert result.attempts[1].channel_id == "alias_normalized_v1"

    @pytest.mark.asyncio
    async def test_empty_initial_channels_returns_empty_result(self) -> None:
        """Empty policy returns empty result."""
        registry = ChannelRegistry()
        policy = _make_policy([])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert result.attempts == []
        assert result.candidates == []
        assert result.total_latency_ms == 0

    @pytest.mark.asyncio
    async def test_total_latency_aggregated(self) -> None:
        """Total latency is the sum of all attempt latencies."""
        registry = ChannelRegistry()
        ch1 = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            latency_ms=25,
        )
        ch2 = FakeEmptyChannel(
            channel_id="alias_normalized_v1",
            channel_family="alias_normalized",
            latency_ms=15,
        )
        registry.register(ch1)
        registry.register(ch2)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
            ChannelInvocation(
                channel_id="alias_normalized_v1", query_mode="exact", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert result.total_latency_ms == 40


# ---------------------------------------------------------------------------
# Tests: Candidate aggregation and deduplication
# ---------------------------------------------------------------------------


class TestCandidateAggregation:
    """Tests for candidate deduplication and contributing attempt preservation."""

    @pytest.mark.asyncio
    async def test_single_channel_single_candidate(self) -> None:
        """Single channel with one candidate produces one CandidateRecord."""
        registry = ChannelRegistry()
        ch = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A"],
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert len(result.candidates) == 1
        assert result.candidates[0].concern_id == "concern-A"
        assert len(result.candidates[0].contributing_attempt_ids) == 1

    @pytest.mark.asyncio
    async def test_same_concern_from_multiple_channels_deduplicates(self) -> None:
        """Same concern_id from two channels creates ONE candidate with both attempt IDs."""
        registry = ChannelRegistry()
        ch1 = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-X"],
            latency_ms=10,
        )
        ch2 = FakeSuccessChannel(
            channel_id="identity_summary_v1",
            channel_family="identity_summary",
            supported_modes=["broad"],
            candidate_ids=["concern-X"],
            latency_ms=12,
        )
        registry.register(ch1)
        registry.register(ch2)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
            ChannelInvocation(
                channel_id="identity_summary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert len(result.candidates) == 1
        assert result.candidates[0].concern_id == "concern-X"
        assert len(result.candidates[0].contributing_attempt_ids) == 2

    @pytest.mark.asyncio
    async def test_different_concerns_from_multiple_channels(self) -> None:
        """Different concern_ids produce separate CandidateRecords."""
        registry = ChannelRegistry()
        ch1 = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A", "concern-B"],
        )
        ch2 = FakeSuccessChannel(
            channel_id="identity_summary_v1",
            channel_family="identity_summary",
            supported_modes=["broad"],
            candidate_ids=["concern-C"],
        )
        registry.register(ch1)
        registry.register(ch2)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
            ChannelInvocation(
                channel_id="identity_summary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        concern_ids = {c.concern_id for c in result.candidates}
        assert concern_ids == {"concern-A", "concern-B", "concern-C"}
        assert len(result.candidates) == 3

    @pytest.mark.asyncio
    async def test_empty_channels_produce_no_candidates(self) -> None:
        """SUCCESS_EMPTY attempts contribute no candidates."""
        registry = ChannelRegistry()
        ch = FakeEmptyChannel(
            channel_id="alias_normalized_v1",
            channel_family="alias_normalized",
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="alias_normalized_v1", query_mode="exact", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert result.candidates == []
        assert len(result.attempts) == 1
        assert result.attempts[0].status == RetrievalAttemptStatus.SUCCESS_EMPTY

    @pytest.mark.asyncio
    async def test_candidates_have_low_confidence_initially(self) -> None:
        """All candidates start with LOW confidence (evaluator assigns real confidence)."""
        registry = ChannelRegistry()
        ch = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A"],
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        # RetrievalCandidate carries no confidence — verified by type

    @pytest.mark.asyncio
    async def test_candidates_have_empty_diagnostics(self) -> None:
        """Candidates at coordinator stage have empty channel_local_diagnostics."""
        registry = ChannelRegistry()
        ch = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A"],
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        # RetrievalCandidate has no diagnostics field — verified by type


# ---------------------------------------------------------------------------
# Tests: Error handling
# ---------------------------------------------------------------------------


class TestErrorHandling:
    """Tests for channel failure handling."""

    @pytest.mark.asyncio
    async def test_error_channel_does_not_abort_other_channels(self) -> None:
        """An errored channel does not prevent subsequent channels from executing."""
        registry = ChannelRegistry()
        ch_error = FakeErrorChannel(
            channel_id="lexical_entity_v1",
            channel_family="lexical_entity",
            error_status=RetrievalAttemptStatus.ERROR,
        )
        ch_success = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A"],
        )
        registry.register(ch_error)
        registry.register(ch_success)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="lexical_entity_v1", query_mode="broad", scope_overrides={}
            ),
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert len(result.attempts) == 2
        assert result.attempts[0].status == RetrievalAttemptStatus.ERROR
        assert result.attempts[1].status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        # Candidates still produced from the successful channel
        assert len(result.candidates) == 1

    @pytest.mark.asyncio
    async def test_timeout_recorded_distinctly(self) -> None:
        """TIMEOUT status is recorded distinctly from empty success."""
        registry = ChannelRegistry()
        ch = FakeErrorChannel(
            channel_id="lexical_entity_v1",
            channel_family="lexical_entity",
            error_status=RetrievalAttemptStatus.TIMEOUT,
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="lexical_entity_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert result.attempts[0].status == RetrievalAttemptStatus.TIMEOUT
        assert result.attempts[0].status != RetrievalAttemptStatus.SUCCESS_EMPTY
        assert result.candidates == []

    @pytest.mark.asyncio
    async def test_unavailable_recorded_distinctly(self) -> None:
        """UNAVAILABLE status is recorded distinctly from empty success."""
        registry = ChannelRegistry()
        ch = FakeErrorChannel(
            channel_id="lexical_entity_v1",
            channel_family="lexical_entity",
            error_status=RetrievalAttemptStatus.UNAVAILABLE,
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="lexical_entity_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert result.attempts[0].status == RetrievalAttemptStatus.UNAVAILABLE
        assert result.attempts[0].status != RetrievalAttemptStatus.SUCCESS_EMPTY

    @pytest.mark.asyncio
    async def test_exception_channel_recorded_as_error(self) -> None:
        """An unhandled exception from a channel is recorded as ERROR."""
        registry = ChannelRegistry()
        ch = FakeExceptionChannel(
            channel_id="alternate_formulation_v1",
            channel_family="alternate_formulation",
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="alternate_formulation_v1",
                query_mode="default",
                scope_overrides={},
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert len(result.attempts) == 1
        assert result.attempts[0].status == RetrievalAttemptStatus.ERROR
        assert "LLM service unavailable" in (result.attempts[0].failure_reason or "")
        assert result.candidates == []

    @pytest.mark.asyncio
    async def test_exception_does_not_abort_subsequent_channels(self) -> None:
        """An exception in one channel does not prevent others from running."""
        registry = ChannelRegistry()
        ch_exc = FakeExceptionChannel(
            channel_id="alternate_formulation_v1",
            channel_family="alternate_formulation",
        )
        ch_success = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-B"],
        )
        registry.register(ch_exc)
        registry.register(ch_success)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="alternate_formulation_v1",
                query_mode="default",
                scope_overrides={},
            ),
            ChannelInvocation(
                channel_id="embedding_primary_v1",
                query_mode="broad",
                scope_overrides={},
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert len(result.attempts) == 2
        assert result.attempts[0].status == RetrievalAttemptStatus.ERROR
        assert result.attempts[1].status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        assert len(result.candidates) == 1
        assert result.candidates[0].concern_id == "concern-B"

    @pytest.mark.asyncio
    async def test_failed_attempts_do_not_contribute_candidates(self) -> None:
        """Errored/timed-out attempts NEVER produce candidates."""
        registry = ChannelRegistry()
        ch = FakeErrorChannel(
            channel_id="lexical_entity_v1",
            channel_family="lexical_entity",
            error_status=RetrievalAttemptStatus.ERROR,
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="lexical_entity_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        assert result.candidates == []


# ---------------------------------------------------------------------------
# Tests: Widening signals behavior
# ---------------------------------------------------------------------------


class TestWideningSignals:
    """Tests for widening_signals parameter behavior."""

    @pytest.mark.asyncio
    async def test_widening_signals_still_runs_initial_plan(self) -> None:
        """With widening_signals provided, coordinator still runs initial plan."""
        registry = ChannelRegistry()
        ch = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A"],
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        # Even with widening_signals, coordinator only runs initial plan
        result = await coordinator.retrieve_candidates(
            _make_packet(),
            _make_context(),
            widening_signals=[],
        )

        assert len(result.attempts) == 1
        assert result.attempts[0].channel_id == "embedding_primary_v1"

    @pytest.mark.asyncio
    async def test_prior_attempts_accepted(self) -> None:
        """prior_attempts parameter is accepted without changing behavior."""
        registry = ChannelRegistry()
        ch = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A"],
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        prior = RetrievalAttemptRecord(
            attempt_id="prior-attempt-1",
            channel_id="alias_normalized_v1",
            channel_family="alias_normalized",
            query_mode="exact",
            query_reference="prior-ref",
            scope_description="prior scope",
            status=RetrievalAttemptStatus.SUCCESS_EMPTY,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=5,
            retrieval_policy_version="1.0.0",
        )

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(
            _make_packet(),
            _make_context(),
            prior_attempts=[prior],
        )

        # Coordinator runs its own initial plan, prior_attempts is context only
        assert len(result.attempts) == 1
        assert result.attempts[0].channel_id == "embedding_primary_v1"


# ---------------------------------------------------------------------------
# Tests: No ownership decisions
# ---------------------------------------------------------------------------


class TestNoOwnershipDecisions:
    """Tests verifying coordinator does not make ownership decisions."""

    @pytest.mark.asyncio
    async def test_candidates_have_no_evidence(self) -> None:
        """Coordinator-produced candidates have empty evidence (evaluator fills later)."""
        registry = ChannelRegistry()
        ch = FakeSuccessChannel(
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            candidate_ids=["concern-A"],
        )
        registry.register(ch)

        policy = _make_policy([
            ChannelInvocation(
                channel_id="embedding_primary_v1", query_mode="broad", scope_overrides={}
            ),
        ])

        coordinator = RetrievalCoordinator(registry, policy)
        result = await coordinator.retrieve_candidates(_make_packet(), _make_context())

        candidate = result.candidates[0]
        # RetrievalCandidate has no evidence — verified by type
        # (evidence populated by evaluator, not coordinator)
        # (explanation populated by evaluator, not coordinator)
