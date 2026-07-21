"""Concrete implementations of the seven canonical retrieval channel families.

Each channel:
- Implements the `RetrievalChannel` protocol.
- Searches ONLY the supplied immutable `GraphStateContext`.
- NEVER assigns ownership or interprets its score as confidence.
- Returns a `RetrievalAttemptRecord` documenting the attempt outcome.
- Parameterizes broad/narrow/continuation behavior through configured query modes.

Channel families:
1. embedding_primary — cosine similarity against concern embeddings.
2. identity_summary — text matching against concern identity_summary fields.
3. alias_normalized — lookup against normalized aliases.
4. lexical_entity — keyword/entity extraction and matching against propositions.
5. dormant_scan — filter concerns by DORMANT status from context.
6. historical_region — filter by sequence range from context.
7. alternate_formulation — LLM reformulation stub (returns channel failure).

Design authority: design-corrections.md §6.
"""

from __future__ import annotations

import math
import re
from typing import Any

from ..contracts import ConcernAlias, ConcernEmbedding, GraphStateContext
from ..enums import ConcernStatus, RetrievalAttemptStatus
from ..identity_models import RetrievalAttemptRecord
from ..identity_policy import ChannelInvocation
from ..models import SemanticPacket


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors without numpy."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _make_attempt_id(channel_id: str, packet_id: str, query_mode: str) -> str:
    """Generate a deterministic attempt ID: {channel_id}-{packet_id}-{query_mode}."""
    return f"{channel_id}-{packet_id}-{query_mode}"


def _extract_keywords(text: str) -> set[str]:
    """Extract simple keywords from text by splitting on non-alphanumeric chars."""
    words = re.findall(r"\b\w{3,}\b", text.lower())
    return set(words)


# ---------------------------------------------------------------------------
# 1. Embedding Primary Channel
# ---------------------------------------------------------------------------


class EmbeddingPrimaryChannel:
    """Cosine similarity retrieval against version-matched concern embeddings.

    Supported query modes:
    - broad: lower similarity threshold (0.3)
    - narrow: higher similarity threshold (0.7)
    - continuation: uses continuation_origin as query signal with medium threshold (0.5)
    """

    _THRESHOLDS: dict[str, float] = {
        "broad": 0.3,
        "narrow": 0.7,
        "continuation": 0.5,
    }

    def __init__(self, channel_id: str = "embedding_primary_v1") -> None:
        self._channel_id = channel_id

    @property
    def channel_id(self) -> str:
        return self._channel_id

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
        """Compare packet meaning against context.concern_embeddings using cosine similarity."""
        attempt_id = _make_attempt_id(
            self._channel_id, packet.packet_id, invocation.query_mode
        )
        threshold = self._THRESHOLDS.get(invocation.query_mode, 0.5)

        if not context.concern_embeddings:
            return RetrievalAttemptRecord(
                attempt_id=attempt_id,
                channel_id=self._channel_id,
                channel_family=self.channel_family,
                query_mode=invocation.query_mode,
                query_reference=packet.user_grounded_meaning[:100],
                scope_description=f"Embedding search ({invocation.query_mode}) across {len(context.concern_embeddings)} embeddings",
                status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                candidate_ids=[],
                candidate_count=0,
                latency_ms=0,
                retrieval_policy_version=invocation.scope_overrides.get(
                    "policy_version", "unknown"
                ),
            )

        # Build a pseudo-embedding from packet text for comparison.
        # In production, the packet embedding would be pre-computed.
        # For now, we use a simple bag-of-words approach that compares
        # meaning keywords overlap against each embedding's source_text_hash.
        # However, since we have actual embeddings in context, we need
        # a query embedding. We'll look for one matching the packet.
        query_embedding: list[float] | None = None
        # Check scope_overrides for a pre-computed query embedding
        if "query_embedding" in invocation.scope_overrides:
            query_embedding = invocation.scope_overrides["query_embedding"]

        candidate_ids: list[str] = []

        if query_embedding is not None:
            for ce in context.concern_embeddings:
                sim = _cosine_similarity(query_embedding, ce.embedding)
                if sim >= threshold:
                    candidate_ids.append(ce.concern_id)
        else:
            # Without a query embedding, we cannot perform similarity search.
            # Return empty success — embedding is available but no query vector.
            return RetrievalAttemptRecord(
                attempt_id=attempt_id,
                channel_id=self._channel_id,
                channel_family=self.channel_family,
                query_mode=invocation.query_mode,
                query_reference=packet.user_grounded_meaning[:100],
                scope_description=f"Embedding search ({invocation.query_mode}) — no query embedding provided",
                status=RetrievalAttemptStatus.SUCCESS_EMPTY,
                candidate_ids=[],
                candidate_count=0,
                latency_ms=0,
                retrieval_policy_version=invocation.scope_overrides.get(
                    "policy_version", "unknown"
                ),
            )

        # Deduplicate
        candidate_ids = list(dict.fromkeys(candidate_ids))

        status = (
            RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
            if candidate_ids
            else RetrievalAttemptStatus.SUCCESS_EMPTY
        )

        return RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id=self._channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference=packet.user_grounded_meaning[:100],
            scope_description=f"Embedding search ({invocation.query_mode}), threshold={threshold}, embeddings={len(context.concern_embeddings)}",
            status=status,
            candidate_ids=candidate_ids,
            candidate_count=len(candidate_ids),
            latency_ms=0,
            retrieval_policy_version=invocation.scope_overrides.get(
                "policy_version", "unknown"
            ),
        )


# ---------------------------------------------------------------------------
# 2. Identity Summary Channel
# ---------------------------------------------------------------------------


class IdentitySummaryChannel:
    """Text matching against concern.identity_summary fields.

    Supported query modes:
    - exact: case-insensitive exact substring match
    - fuzzy: keyword overlap scoring
    """

    def __init__(self, channel_id: str = "identity_summary_v1") -> None:
        self._channel_id = channel_id

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return "identity_summary"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["exact", "fuzzy"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        """Match packet meaning against concern identity_summary fields."""
        attempt_id = _make_attempt_id(
            self._channel_id, packet.packet_id, invocation.query_mode
        )
        query_text = packet.user_grounded_meaning.lower()
        candidate_ids: list[str] = []

        if invocation.query_mode == "exact":
            for concern in context.concerns:
                if query_text in concern.identity_summary.lower():
                    candidate_ids.append(concern.concern_id)
        elif invocation.query_mode == "fuzzy":
            query_keywords = _extract_keywords(query_text)
            for concern in context.concerns:
                summary_keywords = _extract_keywords(
                    concern.identity_summary.lower()
                )
                if query_keywords and summary_keywords:
                    overlap = len(query_keywords & summary_keywords)
                    # Require at least 30% keyword overlap
                    ratio = overlap / min(len(query_keywords), len(summary_keywords))
                    if ratio >= 0.3:
                        candidate_ids.append(concern.concern_id)

        candidate_ids = list(dict.fromkeys(candidate_ids))
        status = (
            RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
            if candidate_ids
            else RetrievalAttemptStatus.SUCCESS_EMPTY
        )

        return RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id=self._channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference=packet.user_grounded_meaning[:100],
            scope_description=f"Identity summary search ({invocation.query_mode}) across {len(context.concerns)} concerns",
            status=status,
            candidate_ids=candidate_ids,
            candidate_count=len(candidate_ids),
            latency_ms=0,
            retrieval_policy_version=invocation.scope_overrides.get(
                "policy_version", "unknown"
            ),
        )


# ---------------------------------------------------------------------------
# 3. Alias Normalized Channel
# ---------------------------------------------------------------------------


class AliasNormalizedChannel:
    """Lookup against context.normalized_aliases.

    Supported query modes:
    - exact: exact match on normalized_form
    - normalized: case-insensitive normalized comparison
    - fuzzy: substring/overlap matching on alias_text
    """

    def __init__(self, channel_id: str = "alias_normalized_v1") -> None:
        self._channel_id = channel_id

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return "alias_normalized"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["exact", "normalized", "fuzzy"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        """Lookup packet meaning against normalized aliases."""
        attempt_id = _make_attempt_id(
            self._channel_id, packet.packet_id, invocation.query_mode
        )
        query_text = packet.user_grounded_meaning
        candidate_ids: list[str] = []

        if invocation.query_mode == "exact":
            # Exact match on normalized_form
            for alias in context.normalized_aliases:
                if alias.normalized_form == query_text:
                    candidate_ids.append(alias.concern_id)
        elif invocation.query_mode == "normalized":
            # Case-insensitive normalized match
            query_lower = query_text.lower().strip()
            for alias in context.normalized_aliases:
                if alias.normalized_form.lower().strip() == query_lower:
                    candidate_ids.append(alias.concern_id)
        elif invocation.query_mode == "fuzzy":
            # Substring or keyword overlap on alias_text
            query_keywords = _extract_keywords(query_text.lower())
            for alias in context.normalized_aliases:
                alias_keywords = _extract_keywords(alias.alias_text.lower())
                if query_keywords and alias_keywords:
                    overlap = len(query_keywords & alias_keywords)
                    if overlap >= 1:
                        candidate_ids.append(alias.concern_id)

        candidate_ids = list(dict.fromkeys(candidate_ids))
        status = (
            RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
            if candidate_ids
            else RetrievalAttemptStatus.SUCCESS_EMPTY
        )

        return RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id=self._channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference=query_text[:100],
            scope_description=f"Alias lookup ({invocation.query_mode}) across {len(context.normalized_aliases)} aliases",
            status=status,
            candidate_ids=candidate_ids,
            candidate_count=len(candidate_ids),
            latency_ms=0,
            retrieval_policy_version=invocation.scope_overrides.get(
                "policy_version", "unknown"
            ),
        )


# ---------------------------------------------------------------------------
# 4. Lexical Entity Channel
# ---------------------------------------------------------------------------


class LexicalEntityChannel:
    """Keyword/entity extraction and matching against propositions.

    Supported query modes:
    - entity_match: extract key entities from packet and match against propositions
    - full_text: full-text keyword search across proposition meanings
    """

    def __init__(self, channel_id: str = "lexical_entity_v1") -> None:
        self._channel_id = channel_id

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return "lexical_entity"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["entity_match", "full_text"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        """Match packet keywords/entities against propositions and their concerns."""
        attempt_id = _make_attempt_id(
            self._channel_id, packet.packet_id, invocation.query_mode
        )
        query_keywords = _extract_keywords(packet.user_grounded_meaning.lower())
        candidate_ids: list[str] = []

        # Build a mapping from proposition_id to concern_id via associations
        prop_to_concern: dict[str, str] = {}
        for assoc in context.active_associations:
            prop_to_concern[assoc.proposition_id] = assoc.concern_id

        if invocation.query_mode == "entity_match":
            # Match extracted entities (longer keywords as proxy for entities)
            entity_keywords = {kw for kw in query_keywords if len(kw) >= 5}
            if not entity_keywords:
                entity_keywords = query_keywords

            for prop in context.propositions:
                prop_keywords = _extract_keywords(prop.canonical_meaning.lower())
                overlap = len(entity_keywords & prop_keywords)
                if overlap >= 2 or (
                    len(entity_keywords) <= 2 and overlap >= 1
                ):
                    concern_id = prop_to_concern.get(prop.proposition_id)
                    if concern_id:
                        candidate_ids.append(concern_id)

        elif invocation.query_mode == "full_text":
            # Full-text keyword overlap
            for prop in context.propositions:
                prop_keywords = _extract_keywords(prop.canonical_meaning.lower())
                if query_keywords and prop_keywords:
                    overlap = len(query_keywords & prop_keywords)
                    ratio = overlap / min(len(query_keywords), len(prop_keywords))
                    if ratio >= 0.25:
                        concern_id = prop_to_concern.get(prop.proposition_id)
                        if concern_id:
                            candidate_ids.append(concern_id)

        candidate_ids = list(dict.fromkeys(candidate_ids))
        status = (
            RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
            if candidate_ids
            else RetrievalAttemptStatus.SUCCESS_EMPTY
        )

        return RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id=self._channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference=packet.user_grounded_meaning[:100],
            scope_description=f"Lexical entity search ({invocation.query_mode}) across {len(context.propositions)} propositions",
            status=status,
            candidate_ids=candidate_ids,
            candidate_count=len(candidate_ids),
            latency_ms=0,
            retrieval_policy_version=invocation.scope_overrides.get(
                "policy_version", "unknown"
            ),
        )


# ---------------------------------------------------------------------------
# 5. Dormant Scan Channel
# ---------------------------------------------------------------------------


class DormantScanChannel:
    """Filter concerns by DORMANT status from context.

    Supported query modes:
    - full_scan: returns all dormant concerns that have keyword overlap with packet
    - recent_dormant: returns dormant concerns sorted by recency with keyword overlap
    """

    def __init__(self, channel_id: str = "dormant_scan_v1") -> None:
        self._channel_id = channel_id

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return "dormant_scan"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["full_scan", "recent_dormant"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        """Filter concerns with DORMANT status and match against packet."""
        attempt_id = _make_attempt_id(
            self._channel_id, packet.packet_id, invocation.query_mode
        )
        query_keywords = _extract_keywords(packet.user_grounded_meaning.lower())
        candidate_ids: list[str] = []

        dormant_concerns = [
            c for c in context.concerns if c.status == ConcernStatus.DORMANT
        ]

        if invocation.query_mode == "recent_dormant":
            # Sort by last_active_at descending (most recent first)
            dormant_concerns = sorted(
                dormant_concerns, key=lambda c: c.last_active_at, reverse=True
            )

        for concern in dormant_concerns:
            concern_keywords = _extract_keywords(
                f"{concern.identity_summary} {concern.display_title} {concern.current_summary}".lower()
            )
            if query_keywords and concern_keywords:
                overlap = len(query_keywords & concern_keywords)
                if overlap >= 1:
                    candidate_ids.append(concern.concern_id)

        candidate_ids = list(dict.fromkeys(candidate_ids))
        status = (
            RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
            if candidate_ids
            else RetrievalAttemptStatus.SUCCESS_EMPTY
        )

        return RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id=self._channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference=packet.user_grounded_meaning[:100],
            scope_description=f"Dormant scan ({invocation.query_mode}) across {len(dormant_concerns)} dormant concerns",
            status=status,
            candidate_ids=candidate_ids,
            candidate_count=len(candidate_ids),
            latency_ms=0,
            retrieval_policy_version=invocation.scope_overrides.get(
                "policy_version", "unknown"
            ),
        )


# ---------------------------------------------------------------------------
# 6. Historical Region Channel
# ---------------------------------------------------------------------------


class HistoricalRegionChannel:
    """Filter by sequence range from context.

    Supported query modes:
    - region_search: find concerns associated with propositions in the packet's
      message sequence neighborhood
    - sequence_range: use explicit sequence range from scope_overrides
    """

    def __init__(self, channel_id: str = "historical_region_v1") -> None:
        self._channel_id = channel_id

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return "historical_region"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["region_search", "sequence_range"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        """Find concerns associated with propositions in a sequence range."""
        attempt_id = _make_attempt_id(
            self._channel_id, packet.packet_id, invocation.query_mode
        )

        # Determine the sequence range to search
        if invocation.query_mode == "sequence_range":
            seq_start = invocation.scope_overrides.get(
                "seq_start", packet.message_seq_range[0]
            )
            seq_end = invocation.scope_overrides.get(
                "seq_end", packet.message_seq_range[1]
            )
        else:
            # region_search: use the packet's sequence range with some neighborhood
            window = invocation.scope_overrides.get("window_size", 5)
            seq_start = max(0, packet.message_seq_range[0] - window)
            seq_end = packet.message_seq_range[1] + window

        # Find propositions in the sequence range
        in_range_prop_ids: set[str] = set()
        for prop in context.propositions:
            prop_start, prop_end = prop.message_seq_range
            if prop_start <= seq_end and prop_end >= seq_start:
                in_range_prop_ids.add(prop.proposition_id)

        # Find concerns associated with those propositions
        candidate_ids: list[str] = []
        for assoc in context.active_associations:
            if assoc.proposition_id in in_range_prop_ids:
                candidate_ids.append(assoc.concern_id)

        candidate_ids = list(dict.fromkeys(candidate_ids))
        status = (
            RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES
            if candidate_ids
            else RetrievalAttemptStatus.SUCCESS_EMPTY
        )

        return RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id=self._channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference=f"seq_range=[{seq_start},{seq_end}]",
            scope_description=f"Historical region search ({invocation.query_mode}), range=[{seq_start},{seq_end}], propositions_in_range={len(in_range_prop_ids)}",
            status=status,
            candidate_ids=candidate_ids,
            candidate_count=len(candidate_ids),
            latency_ms=0,
            retrieval_policy_version=invocation.scope_overrides.get(
                "policy_version", "unknown"
            ),
        )


# ---------------------------------------------------------------------------
# 7. Alternate Formulation Channel
# ---------------------------------------------------------------------------


class AlternateFormulationChannel:
    """LLM-based query reformulation channel (stub).

    This channel would call an LLM to reformulate the query for better retrieval.
    Currently returns a channel failure (ERROR) since the LLM integration is not
    yet implemented. Per design: alternate-formulation LLM failure is recorded as
    a channel failure; it does NOT automatically abort the pipeline if remaining
    retrieval is adequate.

    Supported query modes:
    - reformulate: rewrite query to capture different semantic framings
    - paraphrase: generate paraphrased versions for broader retrieval
    """

    def __init__(self, channel_id: str = "alternate_formulation_v1") -> None:
        self._channel_id = channel_id

    @property
    def channel_id(self) -> str:
        return self._channel_id

    @property
    def channel_family(self) -> str:
        return "alternate_formulation"

    @property
    def supported_query_modes(self) -> list[str]:
        return ["reformulate", "paraphrase"]

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        """Return ERROR — LLM reformulation not yet implemented.

        This does NOT abort the pipeline. It is recorded as a channel failure.
        The pipeline continues with remaining retrieval channels.
        """
        attempt_id = _make_attempt_id(
            self._channel_id, packet.packet_id, invocation.query_mode
        )

        return RetrievalAttemptRecord(
            attempt_id=attempt_id,
            channel_id=self._channel_id,
            channel_family=self.channel_family,
            query_mode=invocation.query_mode,
            query_reference=packet.user_grounded_meaning[:100],
            scope_description=f"Alternate formulation ({invocation.query_mode}) — LLM stub",
            status=RetrievalAttemptStatus.ERROR,
            candidate_ids=[],
            candidate_count=0,
            latency_ms=0,
            failure_reason="LLM reformulation not yet implemented",
            retrieval_policy_version=invocation.scope_overrides.get(
                "policy_version", "unknown"
            ),
        )


# ---------------------------------------------------------------------------
# Channel factory / convenience
# ---------------------------------------------------------------------------


def create_all_default_channels() -> list[
    EmbeddingPrimaryChannel
    | IdentitySummaryChannel
    | AliasNormalizedChannel
    | LexicalEntityChannel
    | DormantScanChannel
    | HistoricalRegionChannel
    | AlternateFormulationChannel
]:
    """Create instances of all seven canonical channel families with default IDs.

    Returns:
        A list of channel instances ready for registration.
    """
    return [
        EmbeddingPrimaryChannel(),
        IdentitySummaryChannel(),
        AliasNormalizedChannel(),
        LexicalEntityChannel(),
        DormantScanChannel(),
        HistoricalRegionChannel(),
        AlternateFormulationChannel(),
    ]
