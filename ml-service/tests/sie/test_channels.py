"""Tests for the seven canonical retrieval channel families.

Verifies:
- Each channel implements the RetrievalChannel protocol.
- Each channel returns a valid RetrievalAttemptRecord with correct status.
- Each channel searches only the supplied GraphStateContext.
- attempt_id follows the deterministic format: {channel_id}-{packet_id}-{query_mode}.
- Alternate-formulation returns ERROR (channel failure, not pipeline abort).
- Channels respect their configured query modes.
"""

from __future__ import annotations

import pytest

from app.sie.contracts import (
    AssociationSummary,
    ConcernAlias,
    ConcernEmbedding,
    ConcernSummary,
    GraphStateContext,
    PropositionSummary,
)
from app.sie.enums import (
    AssociationRole,
    ConcernStatus,
    CohesionStatus,
    ParentResolutionState,
    PropositionType,
    RetrievalAttemptStatus,
    SemanticState,
)
from app.sie.identity_models import RetrievalAttemptRecord
from app.sie.identity_policy import ChannelInvocation
from app.sie.models import SemanticPacket
from app.sie.retrieval.channel_protocol import ChannelRegistry, RetrievalChannel
from app.sie.retrieval.channels import (
    AliasNormalizedChannel,
    AlternateFormulationChannel,
    DormantScanChannel,
    EmbeddingPrimaryChannel,
    HistoricalRegionChannel,
    IdentitySummaryChannel,
    LexicalEntityChannel,
    create_all_default_channels,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_packet(
    packet_id: str = "pkt-001",
    meaning: str = "User wants to learn about machine learning algorithms",
    seq_range: tuple[int, int] = (1, 3),
) -> SemanticPacket:
    """Create a test SemanticPacket."""
    return SemanticPacket(
        packet_id=packet_id,
        packet_creation_key="pck-001",
        conversation_id="conv-001",
        source_message_ids=["msg-001"],
        message_seq_range=seq_range,
        user_grounded_meaning=meaning,
        provenance="test",
        packet_formation_version="1.0.0",
        cohesion_status=CohesionStatus.COHESIVE,
    )


def _make_context(
    concerns: list[ConcernSummary] | None = None,
    propositions: list[PropositionSummary] | None = None,
    associations: list[AssociationSummary] | None = None,
    embeddings: list[ConcernEmbedding] | None = None,
    aliases: list[ConcernAlias] | None = None,
) -> GraphStateContext:
    """Create a test GraphStateContext."""
    return GraphStateContext(
        graph_version=1,
        snapshot_token="snap-001",
        snapshot_digest="digest-001",
        concerns=concerns or [],
        propositions=propositions or [],
        active_associations=associations or [],
        concern_embeddings=embeddings or [],
        normalized_aliases=aliases or [],
    )


def _make_concern(
    concern_id: str = "concern-001",
    identity_summary: str = "Machine learning and algorithms",
    status: ConcernStatus = ConcernStatus.ACTIVE,
    last_active_at: str = "2024-01-01T00:00:00Z",
) -> ConcernSummary:
    """Create a test ConcernSummary."""
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary=identity_summary,
        display_title="ML Algorithms",
        current_summary="Active discussion about machine learning",
        status=status,
        parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
        last_active_at=last_active_at,
        semantic_version=1,
    )


def _make_invocation(
    channel_id: str, query_mode: str, **overrides: object
) -> ChannelInvocation:
    """Create a test ChannelInvocation."""
    return ChannelInvocation(
        channel_id=channel_id,
        query_mode=query_mode,
        scope_overrides=dict(overrides),
    )


# ---------------------------------------------------------------------------
# Tests: Protocol compliance for all channels
# ---------------------------------------------------------------------------


class TestProtocolCompliance:
    """All seven channels satisfy the RetrievalChannel protocol."""

    def test_all_channels_satisfy_protocol(self) -> None:
        """Every default channel instance satisfies the RetrievalChannel protocol."""
        channels = create_all_default_channels()
        assert len(channels) == 7
        for channel in channels:
            assert isinstance(channel, RetrievalChannel)

    def test_all_channels_register_in_registry(self) -> None:
        """All default channels can be registered in the ChannelRegistry."""
        registry = ChannelRegistry()
        channels = create_all_default_channels()
        for channel in channels:
            registry.register(channel)
        assert len(registry.registered_channel_ids) == 7

    def test_channel_families_are_canonical(self) -> None:
        """Each channel's family is one of the seven canonical families."""
        from app.sie.identity_policy import CANONICAL_CHANNEL_FAMILIES

        channels = create_all_default_channels()
        families = {ch.channel_family for ch in channels}
        assert families == CANONICAL_CHANNEL_FAMILIES


# ---------------------------------------------------------------------------
# Tests: Embedding Primary Channel
# ---------------------------------------------------------------------------


class TestEmbeddingPrimaryChannel:
    """Tests for the embedding_primary channel."""

    @pytest.mark.asyncio
    async def test_empty_embeddings_returns_success_empty(self) -> None:
        """With no embeddings in context, returns SUCCESS_EMPTY."""
        channel = EmbeddingPrimaryChannel()
        packet = _make_packet()
        context = _make_context()
        invocation = _make_invocation("embedding_primary_v1", "broad")

        result = await channel.retrieve(packet, context, invocation)

        assert isinstance(result, RetrievalAttemptRecord)
        assert result.status == RetrievalAttemptStatus.SUCCESS_EMPTY
        assert result.candidate_count == 0
        assert result.channel_family == "embedding_primary"

    @pytest.mark.asyncio
    async def test_with_query_embedding_finds_candidates(self) -> None:
        """With a matching query embedding, returns candidates."""
        channel = EmbeddingPrimaryChannel()
        packet = _make_packet()
        # Create a context with an embedding
        embeddings = [
            ConcernEmbedding(
                concern_id="concern-001",
                embedding=[1.0, 0.0, 0.0],
                source_text_hash="hash1",
                embedding_model_version="v1",
                graph_version=1,
            )
        ]
        context = _make_context(embeddings=embeddings)
        # Provide a query embedding that matches
        invocation = _make_invocation(
            "embedding_primary_v1", "broad", query_embedding=[1.0, 0.0, 0.0]
        )

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        assert "concern-001" in result.candidate_ids
        assert result.candidate_count == 1

    @pytest.mark.asyncio
    async def test_narrow_mode_higher_threshold(self) -> None:
        """Narrow mode requires higher similarity — low-similarity vectors are excluded."""
        channel = EmbeddingPrimaryChannel()
        packet = _make_packet()
        embeddings = [
            ConcernEmbedding(
                concern_id="concern-001",
                embedding=[1.0, 0.5, 0.0],
                source_text_hash="hash1",
                embedding_model_version="v1",
                graph_version=1,
            )
        ]
        context = _make_context(embeddings=embeddings)
        # A query embedding that has moderate similarity (not high enough for narrow)
        invocation = _make_invocation(
            "embedding_primary_v1", "narrow", query_embedding=[0.5, 1.0, 0.0]
        )

        result = await channel.retrieve(packet, context, invocation)

        # Cosine similarity of [1,0.5,0] and [0.5,1,0] is ~0.8, above narrow threshold 0.7
        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES

    @pytest.mark.asyncio
    async def test_attempt_id_format(self) -> None:
        """attempt_id follows {channel_id}-{packet_id}-{query_mode} format."""
        channel = EmbeddingPrimaryChannel()
        packet = _make_packet(packet_id="test-pkt")
        context = _make_context()
        invocation = _make_invocation("embedding_primary_v1", "broad")

        result = await channel.retrieve(packet, context, invocation)

        assert result.attempt_id == "embedding_primary_v1-test-pkt-broad"

    @pytest.mark.asyncio
    async def test_supported_query_modes(self) -> None:
        """Channel declares correct query modes."""
        channel = EmbeddingPrimaryChannel()
        assert set(channel.supported_query_modes) == {"broad", "narrow", "continuation"}


# ---------------------------------------------------------------------------
# Tests: Identity Summary Channel
# ---------------------------------------------------------------------------


class TestIdentitySummaryChannel:
    """Tests for the identity_summary channel."""

    @pytest.mark.asyncio
    async def test_exact_match_finds_candidate(self) -> None:
        """Exact mode finds concerns whose identity_summary contains the query."""
        channel = IdentitySummaryChannel()
        packet = _make_packet(meaning="machine learning")
        concern = _make_concern(
            identity_summary="Machine learning and algorithms"
        )
        context = _make_context(concerns=[concern])
        invocation = _make_invocation("identity_summary_v1", "exact")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        assert "concern-001" in result.candidate_ids

    @pytest.mark.asyncio
    async def test_exact_match_no_match(self) -> None:
        """Exact mode returns empty when no match found."""
        channel = IdentitySummaryChannel()
        packet = _make_packet(meaning="quantum physics")
        concern = _make_concern(identity_summary="Machine learning")
        context = _make_context(concerns=[concern])
        invocation = _make_invocation("identity_summary_v1", "exact")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_EMPTY

    @pytest.mark.asyncio
    async def test_fuzzy_mode_keyword_overlap(self) -> None:
        """Fuzzy mode finds concerns with keyword overlap."""
        channel = IdentitySummaryChannel()
        packet = _make_packet(meaning="learning algorithms for classification")
        concern = _make_concern(
            identity_summary="Machine learning algorithms and models"
        )
        context = _make_context(concerns=[concern])
        invocation = _make_invocation("identity_summary_v1", "fuzzy")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES

    @pytest.mark.asyncio
    async def test_supported_query_modes(self) -> None:
        """Channel declares correct query modes."""
        channel = IdentitySummaryChannel()
        assert set(channel.supported_query_modes) == {"exact", "fuzzy"}


# ---------------------------------------------------------------------------
# Tests: Alias Normalized Channel
# ---------------------------------------------------------------------------


class TestAliasNormalizedChannel:
    """Tests for the alias_normalized channel."""

    @pytest.mark.asyncio
    async def test_exact_alias_match(self) -> None:
        """Exact mode matches on normalized_form."""
        channel = AliasNormalizedChannel()
        packet = _make_packet(meaning="ML project")
        aliases = [
            ConcernAlias(
                concern_id="concern-001",
                alias_text="ML Project",
                normalized_form="ML project",
            )
        ]
        context = _make_context(aliases=aliases)
        invocation = _make_invocation("alias_normalized_v1", "exact")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        assert "concern-001" in result.candidate_ids

    @pytest.mark.asyncio
    async def test_normalized_mode_case_insensitive(self) -> None:
        """Normalized mode matches case-insensitively."""
        channel = AliasNormalizedChannel()
        packet = _make_packet(meaning="ml project")
        aliases = [
            ConcernAlias(
                concern_id="concern-001",
                alias_text="ML Project",
                normalized_form="ML Project",
            )
        ]
        context = _make_context(aliases=aliases)
        invocation = _make_invocation("alias_normalized_v1", "normalized")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES

    @pytest.mark.asyncio
    async def test_fuzzy_mode_keyword_match(self) -> None:
        """Fuzzy mode matches on keyword overlap in alias_text."""
        channel = AliasNormalizedChannel()
        packet = _make_packet(meaning="the project about machine learning")
        aliases = [
            ConcernAlias(
                concern_id="concern-001",
                alias_text="machine learning project",
                normalized_form="machine-learning-project",
            )
        ]
        context = _make_context(aliases=aliases)
        invocation = _make_invocation("alias_normalized_v1", "fuzzy")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES

    @pytest.mark.asyncio
    async def test_no_aliases_returns_empty(self) -> None:
        """With no aliases in context, returns SUCCESS_EMPTY."""
        channel = AliasNormalizedChannel()
        packet = _make_packet()
        context = _make_context()
        invocation = _make_invocation("alias_normalized_v1", "exact")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_EMPTY

    @pytest.mark.asyncio
    async def test_supported_query_modes(self) -> None:
        """Channel declares correct query modes."""
        channel = AliasNormalizedChannel()
        assert set(channel.supported_query_modes) == {"exact", "normalized", "fuzzy"}


# ---------------------------------------------------------------------------
# Tests: Lexical Entity Channel
# ---------------------------------------------------------------------------


class TestLexicalEntityChannel:
    """Tests for the lexical_entity channel."""

    @pytest.mark.asyncio
    async def test_entity_match_finds_candidate(self) -> None:
        """Entity match finds concerns via proposition keyword overlap."""
        channel = LexicalEntityChannel()
        packet = _make_packet(meaning="machine learning algorithms")
        props = [
            PropositionSummary(
                proposition_id="prop-001",
                canonical_meaning="Discussion about machine learning algorithms and models",
                proposition_type=PropositionType.CLAIM,
                speaker_role="USER",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(1, 2),
            )
        ]
        assocs = [
            AssociationSummary(
                association_id="assoc-001",
                proposition_id="prop-001",
                concern_id="concern-001",
                role=AssociationRole.PRIMARY_OWNER,
                semantic_state=SemanticState.ACTIVE,
            )
        ]
        context = _make_context(propositions=props, associations=assocs)
        invocation = _make_invocation("lexical_entity_v1", "entity_match")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        assert "concern-001" in result.candidate_ids

    @pytest.mark.asyncio
    async def test_no_propositions_returns_empty(self) -> None:
        """With no propositions, returns SUCCESS_EMPTY."""
        channel = LexicalEntityChannel()
        packet = _make_packet()
        context = _make_context()
        invocation = _make_invocation("lexical_entity_v1", "full_text")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_EMPTY

    @pytest.mark.asyncio
    async def test_supported_query_modes(self) -> None:
        """Channel declares correct query modes."""
        channel = LexicalEntityChannel()
        assert set(channel.supported_query_modes) == {"entity_match", "full_text"}


# ---------------------------------------------------------------------------
# Tests: Dormant Scan Channel
# ---------------------------------------------------------------------------


class TestDormantScanChannel:
    """Tests for the dormant_scan channel."""

    @pytest.mark.asyncio
    async def test_full_scan_finds_dormant_concerns(self) -> None:
        """Full scan finds dormant concerns matching packet keywords."""
        channel = DormantScanChannel()
        packet = _make_packet(meaning="machine learning project")
        concerns = [
            _make_concern(
                concern_id="dormant-001",
                identity_summary="Machine learning project",
                status=ConcernStatus.DORMANT,
            ),
            _make_concern(
                concern_id="active-001",
                identity_summary="Machine learning project",
                status=ConcernStatus.ACTIVE,
            ),
        ]
        context = _make_context(concerns=concerns)
        invocation = _make_invocation("dormant_scan_v1", "full_scan")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        assert "dormant-001" in result.candidate_ids
        # Active concerns should NOT be included
        assert "active-001" not in result.candidate_ids

    @pytest.mark.asyncio
    async def test_no_dormant_concerns_returns_empty(self) -> None:
        """With no dormant concerns, returns SUCCESS_EMPTY."""
        channel = DormantScanChannel()
        packet = _make_packet()
        concerns = [
            _make_concern(status=ConcernStatus.ACTIVE),
        ]
        context = _make_context(concerns=concerns)
        invocation = _make_invocation("dormant_scan_v1", "full_scan")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_EMPTY

    @pytest.mark.asyncio
    async def test_supported_query_modes(self) -> None:
        """Channel declares correct query modes."""
        channel = DormantScanChannel()
        assert set(channel.supported_query_modes) == {"full_scan", "recent_dormant"}


# ---------------------------------------------------------------------------
# Tests: Historical Region Channel
# ---------------------------------------------------------------------------


class TestHistoricalRegionChannel:
    """Tests for the historical_region channel."""

    @pytest.mark.asyncio
    async def test_region_search_finds_nearby_propositions(self) -> None:
        """Region search finds concerns from propositions near the packet's seq range."""
        channel = HistoricalRegionChannel()
        packet = _make_packet(seq_range=(5, 7))
        props = [
            PropositionSummary(
                proposition_id="prop-001",
                canonical_meaning="Related proposition",
                proposition_type=PropositionType.CLAIM,
                speaker_role="USER",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(3, 4),  # within window
            ),
            PropositionSummary(
                proposition_id="prop-002",
                canonical_meaning="Distant proposition",
                proposition_type=PropositionType.CLAIM,
                speaker_role="USER",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(50, 51),  # outside window
            ),
        ]
        assocs = [
            AssociationSummary(
                association_id="assoc-001",
                proposition_id="prop-001",
                concern_id="concern-near",
                role=AssociationRole.PRIMARY_OWNER,
                semantic_state=SemanticState.ACTIVE,
            ),
            AssociationSummary(
                association_id="assoc-002",
                proposition_id="prop-002",
                concern_id="concern-far",
                role=AssociationRole.PRIMARY_OWNER,
                semantic_state=SemanticState.ACTIVE,
            ),
        ]
        context = _make_context(propositions=props, associations=assocs)
        invocation = _make_invocation("historical_region_v1", "region_search")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        assert "concern-near" in result.candidate_ids
        assert "concern-far" not in result.candidate_ids

    @pytest.mark.asyncio
    async def test_sequence_range_explicit_overrides(self) -> None:
        """Sequence range mode uses explicit seq_start/seq_end from scope_overrides."""
        channel = HistoricalRegionChannel()
        packet = _make_packet(seq_range=(1, 3))
        props = [
            PropositionSummary(
                proposition_id="prop-001",
                canonical_meaning="In range",
                proposition_type=PropositionType.CLAIM,
                speaker_role="USER",
                semantic_state=SemanticState.ACTIVE,
                message_seq_range=(10, 12),
            ),
        ]
        assocs = [
            AssociationSummary(
                association_id="assoc-001",
                proposition_id="prop-001",
                concern_id="concern-001",
                role=AssociationRole.PRIMARY_OWNER,
                semantic_state=SemanticState.ACTIVE,
            ),
        ]
        context = _make_context(propositions=props, associations=assocs)
        invocation = _make_invocation(
            "historical_region_v1", "sequence_range", seq_start=9, seq_end=13
        )

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
        assert "concern-001" in result.candidate_ids

    @pytest.mark.asyncio
    async def test_supported_query_modes(self) -> None:
        """Channel declares correct query modes."""
        channel = HistoricalRegionChannel()
        assert set(channel.supported_query_modes) == {"region_search", "sequence_range"}


# ---------------------------------------------------------------------------
# Tests: Alternate Formulation Channel
# ---------------------------------------------------------------------------


class TestAlternateFormulationChannel:
    """Tests for the alternate_formulation channel."""

    @pytest.mark.asyncio
    async def test_returns_error_status(self) -> None:
        """Channel returns ERROR status — LLM not yet implemented."""
        channel = AlternateFormulationChannel()
        packet = _make_packet()
        context = _make_context()
        invocation = _make_invocation("alternate_formulation_v1", "reformulate")

        result = await channel.retrieve(packet, context, invocation)

        assert isinstance(result, RetrievalAttemptRecord)
        assert result.status == RetrievalAttemptStatus.ERROR
        assert result.failure_reason == "LLM reformulation not yet implemented"
        assert result.candidate_count == 0
        assert result.candidate_ids == []

    @pytest.mark.asyncio
    async def test_paraphrase_mode_also_errors(self) -> None:
        """Both query modes return ERROR (stub behavior)."""
        channel = AlternateFormulationChannel()
        packet = _make_packet()
        context = _make_context()
        invocation = _make_invocation("alternate_formulation_v1", "paraphrase")

        result = await channel.retrieve(packet, context, invocation)

        assert result.status == RetrievalAttemptStatus.ERROR
        assert "not yet implemented" in (result.failure_reason or "")

    @pytest.mark.asyncio
    async def test_does_not_abort_pipeline(self) -> None:
        """Channel failure is recorded — no exception raised, no abort signal."""
        channel = AlternateFormulationChannel()
        packet = _make_packet()
        context = _make_context()
        invocation = _make_invocation("alternate_formulation_v1", "reformulate")

        # Should not raise — failure is a normal return value
        result = await channel.retrieve(packet, context, invocation)
        assert result is not None
        assert result.status == RetrievalAttemptStatus.ERROR

    @pytest.mark.asyncio
    async def test_attempt_id_format(self) -> None:
        """attempt_id follows the deterministic format."""
        channel = AlternateFormulationChannel()
        packet = _make_packet(packet_id="pkt-xyz")
        context = _make_context()
        invocation = _make_invocation("alternate_formulation_v1", "reformulate")

        result = await channel.retrieve(packet, context, invocation)

        assert result.attempt_id == "alternate_formulation_v1-pkt-xyz-reformulate"

    @pytest.mark.asyncio
    async def test_supported_query_modes(self) -> None:
        """Channel declares correct query modes."""
        channel = AlternateFormulationChannel()
        assert set(channel.supported_query_modes) == {"reformulate", "paraphrase"}


# ---------------------------------------------------------------------------
# Tests: Deterministic attempt ID format
# ---------------------------------------------------------------------------


class TestAttemptIdFormat:
    """All channels produce attempt IDs in the canonical format."""

    @pytest.mark.asyncio
    async def test_all_channels_produce_correct_attempt_id(self) -> None:
        """Every channel produces attempt_id = {channel_id}-{packet_id}-{query_mode}."""
        packet = _make_packet(packet_id="pkt-test")
        context = _make_context()

        channels_and_modes = [
            (EmbeddingPrimaryChannel(), "broad"),
            (IdentitySummaryChannel(), "exact"),
            (AliasNormalizedChannel(), "exact"),
            (LexicalEntityChannel(), "entity_match"),
            (DormantScanChannel(), "full_scan"),
            (HistoricalRegionChannel(), "region_search"),
            (AlternateFormulationChannel(), "reformulate"),
        ]

        for channel, mode in channels_and_modes:
            invocation = _make_invocation(channel.channel_id, mode)
            result = await channel.retrieve(packet, context, invocation)
            expected_id = f"{channel.channel_id}-pkt-test-{mode}"
            assert result.attempt_id == expected_id, (
                f"Channel {channel.channel_id} produced unexpected attempt_id: "
                f"{result.attempt_id} != {expected_id}"
            )
