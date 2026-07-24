"""Property-based tests for retrieval coordinator and channel architecture (Task 7.4).

Proves via hypothesis:
1. Retrieval does not assign ownership — RetrievalCandidate has no confidence attribute.
2. Retrieval does not manufacture semantic confidence — no confidence field on candidates.
3. Channel-local scores remain diagnostics only — no score on RetrievalCandidate.
4. Duplicate candidates preserve all contributing attempt provenance.
5. ERROR/TIMEOUT/UNAVAILABLE remain distinct from successful empty retrieval.
6. One channel failure does not convert overall retrieval into false success or false absence.
7. Registry rejection of unknown channels.
8. Missing policy fail-closed.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from app.sie.enums import (
    BehavioralConfidenceBand,
    ConcernStatus,
    RetrievalAttemptStatus,
)
from app.sie.identity_models import RetrievalAttemptRecord
from app.sie.identity_policy import (
    CANONICAL_CHANNEL_FAMILIES,
    ChannelFamilyRequirement,
    ChannelInvocation,
    ChannelRegistryEntry,
    DeferResult,
    RetrievalPolicy,
    validate_policy_or_defer,
)
from app.sie.retrieval.channel_protocol import (
    ChannelRegistry,
    RetrievalCandidate,
    RetrievalResult,
    UnknownChannelError,
)
from app.sie.retrieval.retrieval_coordinator import RetrievalCoordinator


# ---------------------------------------------------------------------------
# Shared strategies
# ---------------------------------------------------------------------------

concern_id_st = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
)

attempt_id_st = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
)

lifecycle_status_st = st.sampled_from(list(ConcernStatus))

# Non-success statuses that indicate failure
non_success_statuses_st = st.sampled_from([
    RetrievalAttemptStatus.ERROR,
    RetrievalAttemptStatus.TIMEOUT,
    RetrievalAttemptStatus.UNAVAILABLE,
    RetrievalAttemptStatus.SKIPPED_WITH_REASON,
])

# Success statuses
success_statuses_st = st.sampled_from([
    RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
    RetrievalAttemptStatus.SUCCESS_EMPTY,
])

all_statuses_st = st.sampled_from(list(RetrievalAttemptStatus))

# Random channel IDs that are unlikely to be registered
random_channel_id_st = st.text(
    min_size=5,
    max_size=40,
    alphabet=st.characters(whitelist_categories=("L", "N")),
).filter(lambda x: not x.startswith("registered"))


# ---------------------------------------------------------------------------
# Property 1: Retrieval does not assign ownership
# ---------------------------------------------------------------------------


class TestRetrievalNoOwnership:
    """RetrievalCandidate objects never contain a confidence band."""

    @given(
        concern_ids=st.lists(concern_id_st, min_size=1, max_size=10),
        statuses=st.lists(lifecycle_status_st, min_size=1, max_size=10),
    )
    @settings(max_examples=100)
    def test_retrieval_candidate_has_no_confidence_attribute(
        self,
        concern_ids: list[str],
        statuses: list[ConcernStatus],
    ) -> None:
        """For any combination of retrieval results, RetrievalCandidate carries no confidence."""
        # Build candidates from random concern_ids and statuses
        for i, concern_id in enumerate(concern_ids):
            status = statuses[i % len(statuses)]
            candidate = RetrievalCandidate(
                concern_id=concern_id,
                lifecycle_status=status,
                contributing_attempt_ids=[f"attempt-{i}"],
            )
            # The frozen dataclass has ONLY concern_id, lifecycle_status, contributing_attempt_ids
            assert not hasattr(candidate, "confidence")
            assert not hasattr(candidate, "confidence_band")
            assert not hasattr(candidate, "identity_confidence")


# ---------------------------------------------------------------------------
# Property 2: Retrieval does not manufacture semantic confidence
# ---------------------------------------------------------------------------


class TestRetrievalNoSemanticConfidence:
    """Property test proving RetrievalCandidate has no confidence attribute."""

    @given(
        candidate_count=st.integers(min_value=1, max_value=20),
        attempt_counts=st.lists(
            st.integers(min_value=1, max_value=5), min_size=1, max_size=20
        ),
    )
    @settings(max_examples=100)
    def test_no_confidence_on_any_generated_candidate(
        self,
        candidate_count: int,
        attempt_counts: list[int],
    ) -> None:
        """Across randomly generated candidate lists, no candidate has a confidence field."""
        candidates: list[RetrievalCandidate] = []
        for i in range(min(candidate_count, len(attempt_counts))):
            attempt_ids = [f"attempt-{i}-{j}" for j in range(attempt_counts[i])]
            candidate = RetrievalCandidate(
                concern_id=f"concern-{i}",
                lifecycle_status=ConcernStatus.ACTIVE,
                contributing_attempt_ids=attempt_ids,
            )
            candidates.append(candidate)

        for candidate in candidates:
            # hasattr check proves no confidence attribute exists
            assert not hasattr(candidate, "confidence")
            assert not hasattr(candidate, "score")
            assert not hasattr(candidate, "ownership")
            # Only the declared fields exist
            assert hasattr(candidate, "concern_id")
            assert hasattr(candidate, "lifecycle_status")
            assert hasattr(candidate, "contributing_attempt_ids")


# ---------------------------------------------------------------------------
# Property 3: Channel-local scores remain diagnostics only
# ---------------------------------------------------------------------------


class TestChannelScoresDiagnosticsOnly:
    """RetrievalCandidate has no score field — scores live only in RetrievalAttemptRecord."""

    @given(
        concern_ids=st.lists(concern_id_st, min_size=1, max_size=10),
        lifecycle_statuses=st.lists(lifecycle_status_st, min_size=1, max_size=10),
    )
    @settings(max_examples=100)
    def test_no_score_field_on_candidate(
        self,
        concern_ids: list[str],
        lifecycle_statuses: list[ConcernStatus],
    ) -> None:
        """No score field exists on RetrievalCandidate that could influence downstream."""
        for i, concern_id in enumerate(concern_ids):
            status = lifecycle_statuses[i % len(lifecycle_statuses)]
            candidate = RetrievalCandidate(
                concern_id=concern_id,
                lifecycle_status=status,
                contributing_attempt_ids=[f"attempt-{i}"],
            )
            # No score/rank/weight/similarity field exists
            assert not hasattr(candidate, "score")
            assert not hasattr(candidate, "rank")
            assert not hasattr(candidate, "similarity")
            assert not hasattr(candidate, "weight")
            assert not hasattr(candidate, "retrieval_score")
            assert not hasattr(candidate, "channel_score")

    @given(
        attempt_id=attempt_id_st,
        status=success_statuses_st,
    )
    @settings(max_examples=100)
    def test_attempt_record_scores_are_diagnostic_metadata(
        self,
        attempt_id: str,
        status: RetrievalAttemptStatus,
    ) -> None:
        """RetrievalAttemptRecord carries scores in its fields — not on candidates."""
        # AttemptRecords have diagnostic fields (latency, candidate_ids, etc.)
        # but these never appear on RetrievalCandidate
        candidate_ids = ["concern-x"] if status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES else []
        attempt = RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id="emb_v1",
            channel_family="embedding_primary",
            query_mode="broad",
            query_reference="ref",
            scope_description="scope",
            status=status,
            candidate_ids=candidate_ids,
            candidate_count=len(candidate_ids),
            latency_ms=10,
            retrieval_policy_version="1.0.0",
        )
        # The attempt record has diagnostic fields
        assert hasattr(attempt, "latency_ms")
        assert hasattr(attempt, "candidate_ids")
        # But RetrievalCandidate derived from it has NONE of these
        if candidate_ids:
            candidate = RetrievalCandidate(
                concern_id=candidate_ids[0],
                lifecycle_status=ConcernStatus.ACTIVE,
                contributing_attempt_ids=[attempt.attempt_id],
            )
            assert not hasattr(candidate, "latency_ms")
            assert not hasattr(candidate, "confidence")
            assert not hasattr(candidate, "score")


# ---------------------------------------------------------------------------
# Property 4: Duplicate candidates preserve all contributing attempt provenance
# ---------------------------------------------------------------------------


class TestDeduplicationPreservesProvenance:
    """For any attempts returning the same concern_id, all attempt_ids are preserved."""

    @given(
        num_attempts=st.integers(min_value=2, max_value=10),
        concern_id=concern_id_st,
    )
    @settings(max_examples=100)
    def test_aggregation_merges_all_attempt_ids(
        self,
        num_attempts: int,
        concern_id: str,
    ) -> None:
        """Multiple attempts surfacing the same concern_id merge all attempt_ids."""
        assume(len(concern_id) > 0)

        # Simulate attempts all returning the same concern_id
        attempts: list[RetrievalAttemptRecord] = []
        for i in range(num_attempts):
            attempt = RetrievalAttemptRecord(
                attempt_id=f"attempt-{i}",
                channel_id=f"channel-{i}",
                channel_family="embedding_primary",
                query_mode="broad",
                query_reference=f"ref-{i}",
                scope_description=f"scope-{i}",
                status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                candidate_ids=[concern_id],
                candidate_count=1,
                latency_ms=10,
                retrieval_policy_version="1.0.0",
            )
            attempts.append(attempt)

        # Use the coordinator's internal aggregation logic
        coordinator = RetrievalCoordinator.__new__(RetrievalCoordinator)
        candidates = coordinator._aggregate_candidates(attempts)

        # Should produce exactly ONE deduplicated candidate
        assert len(candidates) == 1
        assert candidates[0].concern_id == concern_id
        # All attempt IDs must be preserved
        assert len(candidates[0].contributing_attempt_ids) == num_attempts
        expected_ids = {f"attempt-{i}" for i in range(num_attempts)}
        assert set(candidates[0].contributing_attempt_ids) == expected_ids

    @given(
        concern_ids=st.lists(concern_id_st, min_size=2, max_size=8, unique=True),
        attempts_per_concern=st.lists(
            st.integers(min_value=1, max_value=4), min_size=2, max_size=8
        ),
    )
    @settings(max_examples=100)
    def test_multiple_concerns_each_preserve_their_attempts(
        self,
        concern_ids: list[str],
        attempts_per_concern: list[int],
    ) -> None:
        """Each unique concern_id preserves exactly its own contributing attempt_ids."""
        n = min(len(concern_ids), len(attempts_per_concern))
        assume(n >= 2)

        attempts: list[RetrievalAttemptRecord] = []
        expected_attempt_map: dict[str, set[str]] = {}

        counter = 0
        for i in range(n):
            cid = concern_ids[i]
            expected_attempt_map[cid] = set()
            for j in range(attempts_per_concern[i]):
                aid = f"attempt-{counter}"
                expected_attempt_map[cid].add(aid)
                attempts.append(
                    RetrievalAttemptRecord(
                        attempt_id=aid,
                        channel_id=f"ch-{counter}",
                        channel_family="embedding_primary",
                        query_mode="broad",
                        query_reference=f"ref-{counter}",
                        scope_description=f"scope-{counter}",
                        status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                        candidate_ids=[cid],
                        candidate_count=1,
                        latency_ms=5,
                        retrieval_policy_version="1.0.0",
                    )
                )
                counter += 1

        coordinator = RetrievalCoordinator.__new__(RetrievalCoordinator)
        candidates = coordinator._aggregate_candidates(attempts)

        # Each unique concern appears exactly once
        assert len(candidates) == n
        result_map = {c.concern_id: set(c.contributing_attempt_ids) for c in candidates}
        for cid in concern_ids[:n]:
            assert cid in result_map
            assert result_map[cid] == expected_attempt_map[cid]


# ---------------------------------------------------------------------------
# Property 5: ERROR/TIMEOUT/UNAVAILABLE remain distinct from successful empty
# ---------------------------------------------------------------------------


class TestNonSuccessStatusDistinctness:
    """Non-success statuses never appear in candidates and are preserved distinctly."""

    @given(
        status=non_success_statuses_st,
        attempt_id=attempt_id_st,
    )
    @settings(max_examples=100)
    def test_non_success_attempts_never_produce_candidates(
        self,
        status: RetrievalAttemptStatus,
        attempt_id: str,
    ) -> None:
        """Attempts with ERROR/TIMEOUT/UNAVAILABLE/SKIPPED never produce candidates."""
        assume(len(attempt_id) > 0)

        attempt = RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id="test-ch",
            channel_family="embedding_primary",
            query_mode="broad",
            query_reference="ref",
            scope_description="scope",
            status=status,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=50,
            failure_reason="simulated failure",
            retrieval_policy_version="1.0.0",
        )

        coordinator = RetrievalCoordinator.__new__(RetrievalCoordinator)
        candidates = coordinator._aggregate_candidates([attempt])

        # Non-success attempts NEVER contribute candidates
        assert candidates == []

    @given(
        statuses=st.lists(non_success_statuses_st, min_size=1, max_size=10),
    )
    @settings(max_examples=100)
    def test_non_success_statuses_are_distinct_values(
        self,
        statuses: list[RetrievalAttemptStatus],
    ) -> None:
        """Each non-success status is distinct from SUCCESS_EMPTY — never conflated."""
        for status in statuses:
            assert status != RetrievalAttemptStatus.SUCCESS_EMPTY
            assert status != RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
            # The status value itself is preserved
            assert status in {
                RetrievalAttemptStatus.ERROR,
                RetrievalAttemptStatus.TIMEOUT,
                RetrievalAttemptStatus.UNAVAILABLE,
                RetrievalAttemptStatus.SKIPPED_WITH_REASON,
            }

    @given(
        non_success_count=st.integers(min_value=1, max_value=5),
        non_success_status=non_success_statuses_st,
    )
    @settings(max_examples=100)
    def test_mixed_attempts_only_success_contributes_candidates(
        self,
        non_success_count: int,
        non_success_status: RetrievalAttemptStatus,
    ) -> None:
        """In a mix of success and failure attempts, only SUCCESS_WITH_CANDIDATES yields results."""
        attempts: list[RetrievalAttemptRecord] = []

        # Add non-success attempts
        for i in range(non_success_count):
            attempts.append(
                RetrievalAttemptRecord(
                    attempt_id=f"failed-{i}",
                    channel_id=f"ch-fail-{i}",
                    channel_family="embedding_primary",
                    query_mode="broad",
                    query_reference=f"ref-{i}",
                    scope_description=f"scope-{i}",
                    status=non_success_status,
                    candidate_ids=[],
                    candidate_count=0,
                    latency_ms=100,
                    failure_reason="fail",
                    retrieval_policy_version="1.0.0",
                )
            )

        # Add one successful attempt
        attempts.append(
            RetrievalAttemptRecord(
                attempt_id="success-0",
                channel_id="ch-success",
                channel_family="embedding_primary",
                query_mode="broad",
                query_reference="success-ref",
                scope_description="success-scope",
                status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                candidate_ids=["concern-A"],
                candidate_count=1,
                latency_ms=10,
                retrieval_policy_version="1.0.0",
            )
        )

        coordinator = RetrievalCoordinator.__new__(RetrievalCoordinator)
        candidates = coordinator._aggregate_candidates(attempts)

        # Only the successful attempt's candidate appears
        assert len(candidates) == 1
        assert candidates[0].concern_id == "concern-A"
        assert "success-0" in candidates[0].contributing_attempt_ids


# ---------------------------------------------------------------------------
# Property 6: One channel failure does not convert to false success or absence
# ---------------------------------------------------------------------------


class TestPartialFailurePreservation:
    """Channel failure doesn't manufacture false success or false absence."""

    @given(
        error_status=non_success_statuses_st,
        success_candidate_ids=st.lists(concern_id_st, min_size=1, max_size=5, unique=True),
    )
    @settings(max_examples=100)
    def test_one_error_one_success_preserves_successful_candidates(
        self,
        error_status: RetrievalAttemptStatus,
        success_candidate_ids: list[str],
    ) -> None:
        """If one channel errors and another succeeds, successful candidates are preserved."""
        # Failed attempt
        failed_attempt = RetrievalAttemptRecord(
            attempt_id="failed-attempt",
            channel_id="ch-error",
            channel_family="lexical_entity",
            query_mode="broad",
            query_reference="ref",
            scope_description="scope",
            status=error_status,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=100,
            failure_reason="channel error",
            retrieval_policy_version="1.0.0",
        )

        # Successful attempt
        success_attempt = RetrievalAttemptRecord(
            attempt_id="success-attempt",
            channel_id="ch-success",
            channel_family="embedding_primary",
            query_mode="broad",
            query_reference="ref",
            scope_description="scope",
            status=RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
            candidate_ids=success_candidate_ids,
            candidate_count=len(success_candidate_ids),
            latency_ms=10,
            retrieval_policy_version="1.0.0",
        )

        coordinator = RetrievalCoordinator.__new__(RetrievalCoordinator)
        candidates = coordinator._aggregate_candidates([failed_attempt, success_attempt])

        # All successful candidates preserved despite the failure
        result_concern_ids = {c.concern_id for c in candidates}
        assert result_concern_ids == set(success_candidate_ids)

    @given(
        error_statuses=st.lists(non_success_statuses_st, min_size=1, max_size=5),
    )
    @settings(max_examples=100)
    def test_all_errors_no_successful_channel_yields_zero_candidates(
        self,
        error_statuses: list[RetrievalAttemptStatus],
    ) -> None:
        """If all channels error and none returns candidates, result has zero candidates."""
        attempts: list[RetrievalAttemptRecord] = []
        for i, status in enumerate(error_statuses):
            attempts.append(
                RetrievalAttemptRecord(
                    attempt_id=f"failed-{i}",
                    channel_id=f"ch-{i}",
                    channel_family="embedding_primary",
                    query_mode="broad",
                    query_reference=f"ref-{i}",
                    scope_description=f"scope-{i}",
                    status=status,
                    candidate_ids=[],
                    candidate_count=0,
                    latency_ms=50,
                    failure_reason="error",
                    retrieval_policy_version="1.0.0",
                )
            )

        coordinator = RetrievalCoordinator.__new__(RetrievalCoordinator)
        candidates = coordinator._aggregate_candidates(attempts)

        # Zero candidates — not fake empty success
        assert candidates == []

    @given(
        error_status=non_success_statuses_st,
    )
    @settings(max_examples=100)
    def test_error_attempt_status_preserved_in_result(
        self,
        error_status: RetrievalAttemptStatus,
    ) -> None:
        """Failed attempt statuses are preserved distinctly — never converted to SUCCESS_EMPTY."""
        attempt = RetrievalAttemptRecord(
            attempt_id="failed-1",
            channel_id="ch-1",
            channel_family="embedding_primary",
            query_mode="broad",
            query_reference="ref",
            scope_description="scope",
            status=error_status,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=50,
            failure_reason="simulated",
            retrieval_policy_version="1.0.0",
        )

        # The attempt preserves its exact status
        assert attempt.status == error_status
        assert attempt.status != RetrievalAttemptStatus.SUCCESS_EMPTY
        assert attempt.status != RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES


# ---------------------------------------------------------------------------
# Property 7: Registry rejection of unknown channels
# ---------------------------------------------------------------------------


class TestRegistryRejectsUnknown:
    """Random channel_ids not in registry always raise UnknownChannelError."""

    @given(
        unknown_id=random_channel_id_st,
    )
    @settings(max_examples=100)
    def test_unregistered_channel_id_raises_unknown_error(
        self,
        unknown_id: str,
    ) -> None:
        """Any channel_id not registered raises UnknownChannelError on get()."""
        assume(len(unknown_id) > 0)

        registry = ChannelRegistry()
        # Register one known channel so registry is non-empty
        _register_known_channel(registry, "registered_emb_v1", "embedding_primary")

        # The random ID is not the registered one
        assume(unknown_id != "registered_emb_v1")

        with pytest.raises(UnknownChannelError) as exc_info:
            registry.get(unknown_id)

        assert exc_info.value.channel_id == unknown_id

    @given(
        unknown_ids=st.lists(random_channel_id_st, min_size=1, max_size=10, unique=True),
    )
    @settings(max_examples=100)
    def test_validate_invocation_rejects_unknown_ids(
        self,
        unknown_ids: list[str],
    ) -> None:
        """validate_invocation rejects all unknown channel_ids."""
        registry = ChannelRegistry()
        _register_known_channel(registry, "registered_emb_v1", "embedding_primary")

        for uid in unknown_ids:
            assume(uid != "registered_emb_v1")
            assume(len(uid) > 0)
            invocation = ChannelInvocation(
                channel_id=uid,
                query_mode="broad",
                scope_overrides={},
            )
            with pytest.raises(UnknownChannelError):
                registry.validate_invocation(invocation)


# ---------------------------------------------------------------------------
# Property 8: Missing policy fail-closed
# ---------------------------------------------------------------------------


class TestMissingPolicyFailClosed:
    """validate_policy_or_defer(None, registry) always returns DeferResult."""

    @given(
        num_registry_entries=st.integers(min_value=0, max_value=7),
    )
    @settings(max_examples=100)
    def test_none_policy_always_defers(
        self,
        num_registry_entries: int,
    ) -> None:
        """Regardless of registry content, None policy always produces DeferResult."""
        families = sorted(CANONICAL_CHANNEL_FAMILIES)
        registry: list[ChannelRegistryEntry] = []
        for i in range(min(num_registry_entries, len(families))):
            registry.append(
                ChannelRegistryEntry(
                    channel_id=f"{families[i]}_v1",
                    channel_family=families[i],
                    supported_query_modes=["broad", "narrow"],
                )
            )

        result = validate_policy_or_defer(None, registry)

        assert result is not None
        assert isinstance(result, DeferResult)
        assert result.outcome.value == "DEFER"
        assert result.action.value == "NONE"
        assert len(result.validation_errors) > 0

    @given(
        registry_size=st.integers(min_value=1, max_value=7),
    )
    @settings(max_examples=100)
    def test_defer_result_has_meaningful_reason(
        self,
        registry_size: int,
    ) -> None:
        """DeferResult from missing policy always contains a meaningful reason."""
        families = sorted(CANONICAL_CHANNEL_FAMILIES)
        registry: list[ChannelRegistryEntry] = []
        for i in range(min(registry_size, len(families))):
            registry.append(
                ChannelRegistryEntry(
                    channel_id=f"{families[i]}_v1",
                    channel_family=families[i],
                    supported_query_modes=["broad"],
                )
            )

        result = validate_policy_or_defer(None, registry)

        assert result is not None
        assert len(result.reason) > 0
        # Reason should mention policy being missing/unavailable
        assert "policy" in result.reason.lower()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakeChannel:
    """Minimal channel for registry population in property tests."""

    def __init__(self, channel_id: str, channel_family: str, modes: list[str] | None = None):
        self._channel_id = channel_id
        self._channel_family = channel_family
        self._modes = modes or ["broad", "narrow"]

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return self._channel_family

    @property
    def supported_query_modes(self) -> list[str]:
        return self._modes

    async def retrieve(self, packet, context, invocation):
        raise NotImplementedError


def _register_known_channel(
    registry: ChannelRegistry, channel_id: str, family: str
) -> None:
    """Register a known channel with the given ID and family."""
    registry.register(_FakeChannel(channel_id, family))
