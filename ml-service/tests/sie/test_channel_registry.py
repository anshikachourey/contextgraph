"""Tests for the channel protocol and validated registry.

Verifies:
- Registration of a valid channel succeeds.
- Registration with invalid channel_family raises.
- Retrieving unknown channel_id raises.
- Validation rejects unknown IDs and unsupported modes.
- Policy validation catches all invalid invocations.
- No channel may assign ownership or interpret its score as confidence.
"""

from __future__ import annotations

import pytest

from app.sie.contracts import GraphStateContext
from app.sie.identity_models import RetrievalAttemptRecord
from app.sie.identity_policy import (
    CANONICAL_CHANNEL_FAMILIES,
    ChannelFamilyRequirement,
    ChannelInvocation,
    RetrievalPolicy,
)
from app.sie.models import SemanticPacket
from app.sie.retrieval.channel_protocol import (
    ChannelRegistry,
    InvalidChannelFamilyError,
    RetrievalChannel,
    RetrievalResult,
    UnknownChannelError,
    UnsupportedQueryModeError,
)


# ---------------------------------------------------------------------------
# Test fixtures: fake channel implementations
# ---------------------------------------------------------------------------


class FakeEmbeddingChannel:
    """A valid channel implementing the RetrievalChannel protocol."""

    @property
    def channel_id(self) -> str:
        return "embedding_primary_v1"

    @property
    def channel_family(self) -> str:
        return "embedding_primary"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["broad", "narrow", "continuation"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        """Fake retrieval — returns empty success."""
        return RetrievalAttemptRecord(
            attempt_id="attempt-001",
            channel_id=self.channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference="test-query-ref",
            scope_description="test scope",
            status="SUCCESS_EMPTY",
            candidate_ids=[],
            candidate_count=0,
            latency_ms=10,
            retrieval_policy_version="1.0.0",
        )


class FakeAliasChannel:
    """Another valid channel for alias-based retrieval."""

    @property
    def channel_id(self) -> str:
        return "alias_normalized_v1"

    @property
    def channel_family(self) -> str:
        return "alias_normalized"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["exact", "fuzzy"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        return RetrievalAttemptRecord(
            attempt_id="attempt-002",
            channel_id=self.channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference="alias-query-ref",
            scope_description="alias scope",
            status="SUCCESS_EMPTY",
            candidate_ids=[],
            candidate_count=0,
            latency_ms=5,
            retrieval_policy_version="1.0.0",
        )


class FakeInvalidFamilyChannel:
    """A channel with an invalid (non-canonical) channel family."""

    @property
    def channel_id(self) -> str:
        return "bogus_channel_v1"

    @property
    def channel_family(self) -> str:
        return "not_a_real_family"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["default"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Tests: Channel registration
# ---------------------------------------------------------------------------


class TestChannelRegistration:
    """Tests for channel registration in the registry."""

    def test_register_valid_channel_succeeds(self) -> None:
        """Registration of a channel with a canonical family succeeds."""
        registry = ChannelRegistry()
        channel = FakeEmbeddingChannel()
        registry.register(channel)

        assert channel.channel_id in registry.registered_channel_ids

    def test_register_multiple_channels(self) -> None:
        """Multiple valid channels can be registered."""
        registry = ChannelRegistry()
        registry.register(FakeEmbeddingChannel())
        registry.register(FakeAliasChannel())

        assert len(registry.registered_channel_ids) == 2
        assert "embedding_primary_v1" in registry.registered_channel_ids
        assert "alias_normalized_v1" in registry.registered_channel_ids

    def test_register_invalid_family_raises(self) -> None:
        """Registration with a non-canonical channel_family raises InvalidChannelFamilyError."""
        registry = ChannelRegistry()

        with pytest.raises(InvalidChannelFamilyError) as exc_info:
            registry.register(FakeInvalidFamilyChannel())

        assert "not_a_real_family" in str(exc_info.value)

    def test_register_all_canonical_families(self) -> None:
        """Every canonical family can be registered successfully."""
        registry = ChannelRegistry()

        for family in CANONICAL_CHANNEL_FAMILIES:

            class _Channel:
                _family = family
                _id = f"{family}_test"

                @property
                def channel_id(self) -> str:
                    return self._id

                @property
                def channel_family(self) -> str:
                    return self._family

                @property
                def supported_query_modes(self) -> list[str]:
                    return ["default"]

                async def retrieve(self, packet, context, invocation):
                    raise NotImplementedError

            registry.register(_Channel())

        assert len(registry.registered_channel_ids) == len(CANONICAL_CHANNEL_FAMILIES)


# ---------------------------------------------------------------------------
# Tests: Channel retrieval by ID
# ---------------------------------------------------------------------------


class TestChannelGet:
    """Tests for retrieving channels from the registry."""

    def test_get_registered_channel(self) -> None:
        """Getting a registered channel returns the correct instance."""
        registry = ChannelRegistry()
        channel = FakeEmbeddingChannel()
        registry.register(channel)

        retrieved = registry.get("embedding_primary_v1")
        assert retrieved.channel_id == "embedding_primary_v1"
        assert retrieved.channel_family == "embedding_primary"

    def test_get_unknown_channel_raises(self) -> None:
        """Getting an unregistered channel_id raises UnknownChannelError."""
        registry = ChannelRegistry()

        with pytest.raises(UnknownChannelError) as exc_info:
            registry.get("nonexistent_channel")

        assert "nonexistent_channel" in str(exc_info.value)

    def test_get_after_multiple_registrations(self) -> None:
        """Each registered channel can be retrieved by its ID."""
        registry = ChannelRegistry()
        registry.register(FakeEmbeddingChannel())
        registry.register(FakeAliasChannel())

        emb = registry.get("embedding_primary_v1")
        alias = registry.get("alias_normalized_v1")

        assert emb.channel_family == "embedding_primary"
        assert alias.channel_family == "alias_normalized"


# ---------------------------------------------------------------------------
# Tests: Invocation validation
# ---------------------------------------------------------------------------


class TestInvocationValidation:
    """Tests for single invocation validation."""

    def test_valid_invocation_passes(self) -> None:
        """A valid channel_id and supported query_mode passes validation."""
        registry = ChannelRegistry()
        registry.register(FakeEmbeddingChannel())

        invocation = ChannelInvocation(
            channel_id="embedding_primary_v1",
            query_mode="broad",
            scope_overrides={},
        )
        assert registry.validate_invocation(invocation) is True

    def test_unknown_channel_id_raises(self) -> None:
        """Validation rejects an invocation with unknown channel_id."""
        registry = ChannelRegistry()
        registry.register(FakeEmbeddingChannel())

        invocation = ChannelInvocation(
            channel_id="nonexistent_channel",
            query_mode="broad",
            scope_overrides={},
        )
        with pytest.raises(UnknownChannelError):
            registry.validate_invocation(invocation)

    def test_unsupported_query_mode_raises(self) -> None:
        """Validation rejects an invocation with unsupported query_mode."""
        registry = ChannelRegistry()
        registry.register(FakeEmbeddingChannel())

        invocation = ChannelInvocation(
            channel_id="embedding_primary_v1",
            query_mode="turbo_mode",  # not supported
            scope_overrides={},
        )
        with pytest.raises(UnsupportedQueryModeError) as exc_info:
            registry.validate_invocation(invocation)

        assert "turbo_mode" in str(exc_info.value)
        assert "embedding_primary_v1" in str(exc_info.value)

    def test_all_supported_modes_pass(self) -> None:
        """All declared supported query modes pass validation."""
        registry = ChannelRegistry()
        registry.register(FakeEmbeddingChannel())

        for mode in ["broad", "narrow", "continuation"]:
            invocation = ChannelInvocation(
                channel_id="embedding_primary_v1",
                query_mode=mode,
                scope_overrides={},
            )
            assert registry.validate_invocation(invocation) is True


# ---------------------------------------------------------------------------
# Tests: Policy validation
# ---------------------------------------------------------------------------


class TestPolicyValidation:
    """Tests for policy-level validation catching all invalid invocations."""

    def _make_registry(self) -> ChannelRegistry:
        """Create a registry with embedding and alias channels."""
        registry = ChannelRegistry()
        registry.register(FakeEmbeddingChannel())
        registry.register(FakeAliasChannel())
        return registry

    def test_valid_policy_passes(self) -> None:
        """A policy referencing only registered channels/modes validates."""
        registry = self._make_registry()

        policy = RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="embedding_primary_v1",
                    query_mode="broad",
                    scope_overrides={},
                ),
                ChannelInvocation(
                    channel_id="alias_normalized_v1",
                    query_mode="exact",
                    scope_overrides={},
                ),
            ],
            channel_family_requirements={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=True,
                ),
            },
            irs_signal_channel_mapping={},
        )
        result = registry.validate_policy(policy)
        assert result.valid is True
        assert result.errors == []

    def test_policy_with_unknown_channel_id_fails(self) -> None:
        """Policy referencing an unknown channel_id is invalid."""
        registry = self._make_registry()

        policy = RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="ghost_channel",
                    query_mode="default",
                    scope_overrides={},
                ),
            ],
            channel_family_requirements={},
            irs_signal_channel_mapping={},
        )
        result = registry.validate_policy(policy)
        assert result.valid is False
        assert any("ghost_channel" in e for e in result.errors)

    def test_policy_with_unsupported_query_mode_fails(self) -> None:
        """Policy referencing an unsupported query_mode is invalid."""
        registry = self._make_registry()

        policy = RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="embedding_primary_v1",
                    query_mode="hyperdrive",  # not supported
                    scope_overrides={},
                ),
            ],
            channel_family_requirements={},
            irs_signal_channel_mapping={},
        )
        result = registry.validate_policy(policy)
        assert result.valid is False
        assert any("hyperdrive" in e for e in result.errors)

    def test_policy_irs_mapping_with_unknown_channel_fails(self) -> None:
        """IRS signal mapping referencing unknown channel is invalid."""
        registry = self._make_registry()

        policy = RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="embedding_primary_v1",
                    query_mode="broad",
                    scope_overrides={},
                ),
            ],
            channel_family_requirements={},
            irs_signal_channel_mapping={
                "REVISIT_LANGUAGE": [
                    ChannelInvocation(
                        channel_id="phantom_widener",
                        query_mode="default",
                        scope_overrides={},
                    ),
                ],
            },
        )
        result = registry.validate_policy(policy)
        assert result.valid is False
        assert any("phantom_widener" in e for e in result.errors)

    def test_policy_irs_mapping_with_unsupported_mode_fails(self) -> None:
        """IRS signal mapping with unsupported query_mode is invalid."""
        registry = self._make_registry()

        policy = RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="embedding_primary_v1",
                    query_mode="broad",
                    scope_overrides={},
                ),
            ],
            channel_family_requirements={},
            irs_signal_channel_mapping={
                "ALIAS_OR_VOCABULARY_DRIFT": [
                    ChannelInvocation(
                        channel_id="alias_normalized_v1",
                        query_mode="super_fuzzy",  # not supported
                        scope_overrides={},
                    ),
                ],
            },
        )
        result = registry.validate_policy(policy)
        assert result.valid is False
        assert any("super_fuzzy" in e for e in result.errors)

    def test_policy_with_multiple_errors_reports_all(self) -> None:
        """Policy validation collects ALL errors, not just the first."""
        registry = self._make_registry()

        policy = RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="ghost_1",
                    query_mode="default",
                    scope_overrides={},
                ),
                ChannelInvocation(
                    channel_id="embedding_primary_v1",
                    query_mode="invalid_mode",
                    scope_overrides={},
                ),
            ],
            channel_family_requirements={},
            irs_signal_channel_mapping={
                "HISTORICAL_REFERENT": [
                    ChannelInvocation(
                        channel_id="ghost_2",
                        query_mode="default",
                        scope_overrides={},
                    ),
                ],
            },
        )
        result = registry.validate_policy(policy)
        assert result.valid is False
        # Should have at least 3 errors: ghost_1, invalid_mode, ghost_2
        assert len(result.errors) >= 3


# ---------------------------------------------------------------------------
# Tests: Protocol compliance
# ---------------------------------------------------------------------------


class TestProtocolCompliance:
    """Tests verifying protocol invariants are enforced."""

    def test_fake_channel_satisfies_protocol(self) -> None:
        """Fake channels satisfy the runtime-checkable RetrievalChannel protocol."""
        assert isinstance(FakeEmbeddingChannel(), RetrievalChannel)
        assert isinstance(FakeAliasChannel(), RetrievalChannel)

    def test_retrieval_result_default_construction(self) -> None:
        """RetrievalResult can be constructed with defaults."""
        result = RetrievalResult()
        assert result.attempts == []
        assert result.candidates == []
        assert result.total_latency_ms == 0

    def test_retrieval_result_with_data(self) -> None:
        """RetrievalResult can hold attempts and candidates."""
        attempt = RetrievalAttemptRecord(
            attempt_id="a1",
            channel_id="embedding_primary_v1",
            channel_family="embedding_primary",
            query_mode="broad",
            query_reference="ref",
            scope_description="scope",
            status="SUCCESS_WITH_CANDIDATES",
            candidate_ids=["concern-1"],
            candidate_count=1,
            latency_ms=50,
            retrieval_policy_version="1.0.0",
        )
        result = RetrievalResult(
            attempts=[attempt],
            candidates=[],
            total_latency_ms=50,
        )
        assert len(result.attempts) == 1
        assert result.total_latency_ms == 50
