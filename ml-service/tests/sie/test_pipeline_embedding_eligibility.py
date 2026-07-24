"""Property-based tests for embedding eligibility gate (Task 15.1).

Proves via hypothesis:
1. Each invalid condition independently excludes the embedding.
2. An unrelated graph-version advance does not invalidate a compatible embedding.
3. Missing/stale source hash excludes.
4. Invalid/retired model version excludes.
5. Privacy-suppressed excludes.

**Validates: Requirements 3.1, 3.2**
"""

from __future__ import annotations

import hashlib

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from app.sie.contracts import (
    ConcernEmbedding,
    ConcernSummary,
    GraphStateContext,
)
from app.sie.enums import (
    ConcernStatus,
    ParentResolutionState,
)
from app.sie.identity_policy import (
    ChannelFamilyRequirement,
    ChannelInvocation,
    IdentityResolutionPolicy,
    ReEvaluationPolicy,
    RetrievalPolicy,
    WideningBudgetPolicy,
)
from app.sie.pipeline import IdentityResolutionPipeline


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

concern_id_st = st.text(
    min_size=5, max_size=20,
    alphabet=st.characters(whitelist_categories=("L", "N")),
)

model_version_st = st.text(
    min_size=1, max_size=10,
    alphabet=st.characters(whitelist_categories=("L", "N", "P")),
)

identity_summary_st = st.text(min_size=1, max_size=50)


def _compute_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _make_policy() -> IdentityResolutionPolicy:
    """Build a minimal valid policy for testing."""
    return IdentityResolutionPolicy(
        policy_version="1.0.0",
        retrieval_policy=RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[],
            channel_family_requirements={},
            irs_signal_channel_mapping={},
        ),
        widening_budget=WideningBudgetPolicy(
            budget_version="1.0.0",
            max_widening_rounds=3,
            max_total_attempts=10,
            max_latency_ms=5000,
            max_cost_units=100.0,
        ),
        pending_re_evaluation_policy=ReEvaluationPolicy(
            policy_version="1.0.0",
            triggers=["new_evidence"],
            max_re_evaluation_attempts=3,
            cooldown_between_attempts_ms=5000,
        ),
        permitted_embedding_model_versions=["v1.0"],
    )


def _make_concern(
    concern_id: str,
    status: ConcernStatus = ConcernStatus.ACTIVE,
    identity_summary: str = "test concern",
) -> ConcernSummary:
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary=identity_summary,
        display_title="Test",
        current_summary=identity_summary,
        status=status,
        aliases=[],
        parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
        last_active_at="2024-01-01T00:00:00Z",
        semantic_version=1,
    )


def _make_embedding(
    concern_id: str,
    source_text_hash: str,
    model_version: str = "v1.0",
    graph_version: int = 5,
) -> ConcernEmbedding:
    return ConcernEmbedding(
        concern_id=concern_id,
        embedding=[0.1, 0.2, 0.3],
        source_text_hash=source_text_hash,
        embedding_model_version=model_version,
        graph_version=graph_version,
    )


def _make_context(
    concerns: list[ConcernSummary] | None = None,
    embeddings: list[ConcernEmbedding] | None = None,
    graph_version: int = 10,
    suppressed_ids: list[str] | None = None,
) -> GraphStateContext:
    return GraphStateContext(
        graph_version=graph_version,
        snapshot_token="tok-test",
        snapshot_digest="digest-test",
        concerns=concerns or [],
        propositions=[],
        active_associations=[],
        pending_decisions=[],
        concern_embeddings=embeddings or [],
        normalized_aliases=[],
        pending_identity_details=[],
        privacy_suppressed_concern_ids=suppressed_ids or [],
        packet_lineage=[],
    )


# We only need the static/classmethod for filtering, so instantiate minimally
# by accessing the method directly on an instance with None deps.
# The _filter_eligible_embeddings method doesn't use any injected components.

def _call_filter(context: GraphStateContext, policy: IdentityResolutionPolicy):
    """Call _filter_eligible_embeddings without building full pipeline."""
    # Use the static-like method via a minimal instance trick:
    # The method only uses self for _compute_source_hash and _is_model_version_permitted
    # which are static methods. We can call it on any instance.
    pipeline = IdentityResolutionPipeline.__new__(IdentityResolutionPipeline)
    return pipeline._filter_eligible_embeddings(context, policy)


# ---------------------------------------------------------------------------
# Property 1: Each invalid condition independently excludes the embedding
# ---------------------------------------------------------------------------


class TestInvalidStatusExcludes:
    """MERGED concerns are excluded regardless of all other conditions being valid."""

    @given(concern_id=concern_id_st, identity_summary=identity_summary_st)
    @settings(max_examples=50)
    def test_merged_status_excludes(
        self, concern_id: str, identity_summary: str
    ):
        """Embedding for a MERGED concern is always excluded."""
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(
            concern_id, ConcernStatus.MERGED, identity_summary
        )
        # MERGED requires merged_into_concern_id
        concern.merged_into_concern_id = "target-concern"
        embedding = _make_embedding(concern_id, source_hash, "v1.0", 5)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=10
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 0


class TestEligibleStatusesInclude:
    """ACTIVE, DORMANT, RETIRED concerns with valid conditions are included."""

    @given(
        concern_id=concern_id_st,
        identity_summary=identity_summary_st,
        status=st.sampled_from([
            ConcernStatus.ACTIVE,
            ConcernStatus.DORMANT,
            ConcernStatus.RETIRED,
        ]),
    )
    @settings(max_examples=50)
    def test_eligible_statuses_included(
        self, concern_id: str, identity_summary: str, status: ConcernStatus
    ):
        """Embeddings for ACTIVE/DORMANT/RETIRED with valid conditions are kept."""
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, status, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, "v1.0", 5)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=10
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 1
        assert result[0].concern_id == concern_id


# ---------------------------------------------------------------------------
# Property 2: Unrelated graph-version advance does not invalidate compatible
# ---------------------------------------------------------------------------


class TestGraphVersionCompatibility:
    """An embedding created at an earlier graph version remains valid."""

    @given(
        concern_id=concern_id_st,
        identity_summary=identity_summary_st,
        emb_version=st.integers(min_value=1, max_value=100),
        ctx_version=st.integers(min_value=1, max_value=200),
    )
    @settings(max_examples=100)
    def test_compatible_graph_version_included(
        self,
        concern_id: str,
        identity_summary: str,
        emb_version: int,
        ctx_version: int,
    ):
        """Embedding with graph_version <= context version is compatible."""
        assume(emb_version <= ctx_version)
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, "v1.0", emb_version)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=ctx_version
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 1

    @given(
        concern_id=concern_id_st,
        identity_summary=identity_summary_st,
        emb_version=st.integers(min_value=2, max_value=200),
        ctx_version=st.integers(min_value=1, max_value=199),
    )
    @settings(max_examples=100)
    def test_future_graph_version_excluded(
        self,
        concern_id: str,
        identity_summary: str,
        emb_version: int,
        ctx_version: int,
    ):
        """Embedding with graph_version > context version is excluded."""
        assume(emb_version > ctx_version)
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, "v1.0", emb_version)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=ctx_version
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 0


# ---------------------------------------------------------------------------
# Property 3: Missing/stale source hash excludes
# ---------------------------------------------------------------------------


class TestSourceHashExclusion:
    """Stale or mismatched source_text_hash always excludes embedding."""

    @given(
        concern_id=concern_id_st,
        identity_summary=identity_summary_st,
        stale_hash=st.text(min_size=10, max_size=64),
    )
    @settings(max_examples=50)
    def test_stale_source_hash_excludes(
        self, concern_id: str, identity_summary: str, stale_hash: str
    ):
        """Embedding with a source_text_hash not matching identity_summary is excluded."""
        correct_hash = _compute_hash(identity_summary)
        assume(stale_hash != correct_hash)

        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, stale_hash, "v1.0", 5)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=10
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 0

    @given(concern_id=concern_id_st, identity_summary=identity_summary_st)
    @settings(max_examples=50)
    def test_correct_source_hash_included(
        self, concern_id: str, identity_summary: str
    ):
        """Embedding with correct source_text_hash is included."""
        correct_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, correct_hash, "v1.0", 5)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=10
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# Property 4: Invalid/empty model version excludes
# ---------------------------------------------------------------------------


class TestModelVersionExclusion:
    """Empty or whitespace-only model version always excludes."""

    @given(
        concern_id=concern_id_st,
        identity_summary=identity_summary_st,
        empty_version=st.sampled_from(["", "   ", "\t", "\n"]),
    )
    @settings(max_examples=20)
    def test_empty_model_version_excludes(
        self, concern_id: str, identity_summary: str, empty_version: str
    ):
        """Embedding with empty/whitespace model version is excluded."""
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, empty_version, 5)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=10
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 0

    @given(
        concern_id=concern_id_st,
        identity_summary=identity_summary_st,
    )
    @settings(max_examples=50)
    def test_valid_model_version_included(
        self, concern_id: str, identity_summary: str
    ):
        """Embedding with model version in the policy allowlist is included."""
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, "v1.0", 5)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=10
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# Property 5: Privacy-suppressed excludes
# ---------------------------------------------------------------------------


class TestPrivacySuppressedExclusion:
    """Embeddings for privacy-suppressed concerns are always excluded."""

    @given(concern_id=concern_id_st, identity_summary=identity_summary_st)
    @settings(max_examples=50)
    def test_suppressed_concern_excluded(
        self, concern_id: str, identity_summary: str
    ):
        """Embedding for a suppressed concern is excluded even if all else valid."""
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, "v1.0", 5)
        context = _make_context(
            concerns=[concern],
            embeddings=[embedding],
            graph_version=10,
            suppressed_ids=[concern_id],
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 0

    @given(concern_id=concern_id_st, identity_summary=identity_summary_st)
    @settings(max_examples=50)
    def test_non_suppressed_concern_included(
        self, concern_id: str, identity_summary: str
    ):
        """Embedding for a non-suppressed concern is included when all else valid."""
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, "v1.0", 5)
        context = _make_context(
            concerns=[concern],
            embeddings=[embedding],
            graph_version=10,
            suppressed_ids=["other-id"],
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# Property 6: Model version not in policy allowlist excludes (fail-closed)
# ---------------------------------------------------------------------------


class TestModelVersionNotInAllowlistExcludes:
    """Non-empty model version NOT in the policy allowlist is excluded."""

    @given(
        concern_id=concern_id_st,
        identity_summary=identity_summary_st,
        unlisted_version=st.text(
            min_size=1, max_size=10,
            alphabet=st.characters(whitelist_categories=("L", "N", "P")),
        ),
    )
    @settings(max_examples=50)
    def test_unlisted_model_version_excluded(
        self, concern_id: str, identity_summary: str, unlisted_version: str
    ):
        """Embedding with model version not in policy allowlist is excluded."""
        assume(unlisted_version.strip() != "")
        assume(unlisted_version.strip() not in ["v1.0"])

        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, unlisted_version, 5)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=10
        )
        policy = _make_policy()

        result = _call_filter(context, policy)
        assert len(result) == 0


# ---------------------------------------------------------------------------
# Property 7: Empty permitted_embedding_model_versions excludes ALL embeddings
# ---------------------------------------------------------------------------


class TestEmptyAllowlistExcludesAll:
    """When permitted_embedding_model_versions is empty, ALL embeddings excluded."""

    @given(
        concern_id=concern_id_st,
        identity_summary=identity_summary_st,
        model_ver=model_version_st,
    )
    @settings(max_examples=50)
    def test_empty_allowlist_excludes_all(
        self, concern_id: str, identity_summary: str, model_ver: str
    ):
        """With empty allowlist, even a valid-looking model version is excluded."""
        assume(model_ver.strip() != "")
        source_hash = _compute_hash(identity_summary)
        concern = _make_concern(concern_id, ConcernStatus.ACTIVE, identity_summary)
        embedding = _make_embedding(concern_id, source_hash, model_ver, 5)
        context = _make_context(
            concerns=[concern], embeddings=[embedding], graph_version=10
        )
        # Policy with empty allowlist — fail-closed means nothing is permitted
        policy = IdentityResolutionPolicy(
            policy_version="1.0.0",
            retrieval_policy=RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[],
                channel_family_requirements={},
                irs_signal_channel_mapping={},
            ),
            widening_budget=WideningBudgetPolicy(
                budget_version="1.0.0",
                max_widening_rounds=3,
                max_total_attempts=10,
                max_latency_ms=5000,
                max_cost_units=100.0,
            ),
            pending_re_evaluation_policy=ReEvaluationPolicy(
                policy_version="1.0.0",
                triggers=["new_evidence"],
                max_re_evaluation_attempts=3,
                cooldown_between_attempts_ms=5000,
            ),
            permitted_embedding_model_versions=[],
        )

        result = _call_filter(context, policy)
        assert len(result) == 0
