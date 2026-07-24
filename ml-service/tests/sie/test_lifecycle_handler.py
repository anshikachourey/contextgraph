"""Tests for the LifecycleHandler concern lifecycle logic.

Verifies:
- filter_eligible_concerns includes ACTIVE, DORMANT, RETIRED; excludes MERGED.
- No recency bias in filtering.
- follow_merge_redirect resolves valid single and multi-hop chains.
- follow_merge_redirect rejects: missing target, cyclic, suppressed,
  invalid terminal state, and max_depth_exceeded.
- build_reactivation_group produces ALL_OR_NONE with correct mutation refs.
- Reactivation group is deterministic for same inputs.

Design authority: consolidated final design.md §10, Task 11.2.
"""

from __future__ import annotations

import pytest

from app.sie.contracts import ConcernSummary, GraphStateContext, SemanticDependencyGroupRef
from app.sie.enums import ConcernStatus, ParentResolutionState
from app.sie.retrieval.lifecycle_handler import LifecycleHandler, MergeRedirectResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_concern(
    *,
    concern_id: str = "concern-1",
    status: ConcernStatus = ConcernStatus.ACTIVE,
    merged_into_concern_id: str | None = None,
    last_active_at: str = "2024-01-15T00:00:00Z",
    aliases: list[str] | None = None,
) -> ConcernSummary:
    """Create a minimal ConcernSummary for testing."""
    return ConcernSummary(
        concern_id=concern_id,
        identity_summary=f"Summary for {concern_id}",
        display_title=f"Title {concern_id}",
        current_summary=f"Current summary for {concern_id}",
        status=status,
        merged_into_concern_id=merged_into_concern_id,
        aliases=aliases or [],
        canonical_parent_id=None,
        parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
        last_active_at=last_active_at,
        semantic_version=1,
    )


def _make_context(
    concerns: list[ConcernSummary] | None = None,
    suppressed_ids: list[str] | None = None,
) -> GraphStateContext:
    """Create a minimal GraphStateContext for testing."""
    return GraphStateContext(
        graph_version=1,
        snapshot_token="test-token",
        snapshot_digest="test-digest",
        concerns=concerns or [],
        propositions=[],
        active_associations=[],
        pending_decisions=[],
        privacy_suppressed_concern_ids=suppressed_ids or [],
    )


# ---------------------------------------------------------------------------
# Tests: filter_eligible_concerns
# ---------------------------------------------------------------------------


class TestFilterEligibleConcerns:
    """filter_eligible_concerns includes ACTIVE, DORMANT, RETIRED; excludes MERGED."""

    def test_includes_active_concerns(self) -> None:
        """ACTIVE concerns are included in eligible list."""
        handler = LifecycleHandler()
        active = _make_concern(concern_id="c-active", status=ConcernStatus.ACTIVE)
        context = _make_context(concerns=[active])

        result = handler.filter_eligible_concerns(context)

        assert len(result) == 1
        assert result[0].concern_id == "c-active"

    def test_includes_dormant_concerns(self) -> None:
        """DORMANT concerns are included in eligible list."""
        handler = LifecycleHandler()
        dormant = _make_concern(concern_id="c-dormant", status=ConcernStatus.DORMANT)
        context = _make_context(concerns=[dormant])

        result = handler.filter_eligible_concerns(context)

        assert len(result) == 1
        assert result[0].concern_id == "c-dormant"

    def test_includes_retired_concerns(self) -> None:
        """RETIRED concerns are included in eligible list."""
        handler = LifecycleHandler()
        retired = _make_concern(concern_id="c-retired", status=ConcernStatus.RETIRED)
        context = _make_context(concerns=[retired])

        result = handler.filter_eligible_concerns(context)

        assert len(result) == 1
        assert result[0].concern_id == "c-retired"

    def test_excludes_merged_concerns(self) -> None:
        """MERGED concerns are excluded (they redirect)."""
        handler = LifecycleHandler()
        merged = _make_concern(
            concern_id="c-merged",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-target",
        )
        context = _make_context(concerns=[merged])

        result = handler.filter_eligible_concerns(context)

        assert len(result) == 0

    def test_mixed_statuses(self) -> None:
        """Filter correctly from a mix of all statuses."""
        handler = LifecycleHandler()
        concerns = [
            _make_concern(concern_id="c-active", status=ConcernStatus.ACTIVE),
            _make_concern(concern_id="c-dormant", status=ConcernStatus.DORMANT),
            _make_concern(concern_id="c-retired", status=ConcernStatus.RETIRED),
            _make_concern(
                concern_id="c-merged",
                status=ConcernStatus.MERGED,
                merged_into_concern_id="c-active",
            ),
        ]
        context = _make_context(concerns=concerns)

        result = handler.filter_eligible_concerns(context)

        result_ids = {c.concern_id for c in result}
        assert result_ids == {"c-active", "c-dormant", "c-retired"}

    def test_no_recency_bias_old_concerns_included(self) -> None:
        """Concerns with old last_active_at are still included — no recency bias."""
        handler = LifecycleHandler()
        old_concern = _make_concern(
            concern_id="c-old",
            status=ConcernStatus.DORMANT,
            last_active_at="2020-01-01T00:00:00Z",
        )
        recent_concern = _make_concern(
            concern_id="c-recent",
            status=ConcernStatus.ACTIVE,
            last_active_at="2024-12-01T00:00:00Z",
        )
        context = _make_context(concerns=[old_concern, recent_concern])

        result = handler.filter_eligible_concerns(context)

        result_ids = {c.concern_id for c in result}
        assert "c-old" in result_ids
        assert "c-recent" in result_ids

    def test_empty_context_returns_empty(self) -> None:
        """Empty concerns list returns empty eligible list."""
        handler = LifecycleHandler()
        context = _make_context(concerns=[])

        result = handler.filter_eligible_concerns(context)

        assert result == []


# ---------------------------------------------------------------------------
# Tests: follow_merge_redirect — successful resolution
# ---------------------------------------------------------------------------


class TestFollowMergeRedirectSuccess:
    """follow_merge_redirect resolves valid redirect chains."""

    def test_non_merged_concern_returns_itself(self) -> None:
        """Non-MERGED concern resolves to itself immediately."""
        handler = LifecycleHandler()
        active = _make_concern(concern_id="c-active", status=ConcernStatus.ACTIVE)
        context = _make_context(concerns=[active])

        result = handler.follow_merge_redirect(active, context)

        assert result.resolved is True
        assert result.target_concern == active
        assert result.redirect_path == ["c-active"]
        assert result.failure_reason is None

    def test_single_hop_redirect(self) -> None:
        """MERGED → ACTIVE resolves in one hop."""
        handler = LifecycleHandler()
        target = _make_concern(concern_id="c-target", status=ConcernStatus.ACTIVE)
        merged = _make_concern(
            concern_id="c-merged",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-target",
        )
        context = _make_context(concerns=[merged, target])

        result = handler.follow_merge_redirect(merged, context)

        assert result.resolved is True
        assert result.target_concern == target
        assert result.redirect_path == ["c-merged", "c-target"]
        assert result.failure_reason is None

    def test_multi_hop_redirect(self) -> None:
        """MERGED → MERGED → ACTIVE resolves through chain."""
        handler = LifecycleHandler()
        final = _make_concern(concern_id="c-final", status=ConcernStatus.ACTIVE)
        mid = _make_concern(
            concern_id="c-mid",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-final",
        )
        start = _make_concern(
            concern_id="c-start",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-mid",
        )
        context = _make_context(concerns=[start, mid, final])

        result = handler.follow_merge_redirect(start, context)

        assert result.resolved is True
        assert result.target_concern == final
        assert result.redirect_path == ["c-start", "c-mid", "c-final"]

    def test_redirect_to_dormant_target(self) -> None:
        """MERGED → DORMANT is valid (DORMANT is a valid terminal state)."""
        handler = LifecycleHandler()
        dormant = _make_concern(concern_id="c-dormant", status=ConcernStatus.DORMANT)
        merged = _make_concern(
            concern_id="c-merged",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-dormant",
        )
        context = _make_context(concerns=[merged, dormant])

        result = handler.follow_merge_redirect(merged, context)

        assert result.resolved is True
        assert result.target_concern == dormant

    def test_redirect_to_retired_target(self) -> None:
        """MERGED → RETIRED is valid (RETIRED is a valid terminal state)."""
        handler = LifecycleHandler()
        retired = _make_concern(concern_id="c-retired", status=ConcernStatus.RETIRED)
        merged = _make_concern(
            concern_id="c-merged",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-retired",
        )
        context = _make_context(concerns=[merged, retired])

        result = handler.follow_merge_redirect(merged, context)

        assert result.resolved is True
        assert result.target_concern == retired


# ---------------------------------------------------------------------------
# Tests: follow_merge_redirect — failure cases
# ---------------------------------------------------------------------------


class TestFollowMergeRedirectFailures:
    """follow_merge_redirect rejects invalid chains."""

    def test_missing_target(self) -> None:
        """Target concern not in context → missing_target."""
        handler = LifecycleHandler()
        merged = _make_concern(
            concern_id="c-merged",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-missing",
        )
        context = _make_context(concerns=[merged])

        result = handler.follow_merge_redirect(merged, context)

        assert result.resolved is False
        assert result.target_concern is None
        assert result.failure_reason == "missing_target"
        assert "c-missing" in result.redirect_path

    def test_cyclic_redirect(self) -> None:
        """Cycle in redirect chain → cyclic."""
        handler = LifecycleHandler()
        c_a = _make_concern(
            concern_id="c-a",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-b",
        )
        c_b = _make_concern(
            concern_id="c-b",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-a",
        )
        context = _make_context(concerns=[c_a, c_b])

        result = handler.follow_merge_redirect(c_a, context)

        assert result.resolved is False
        assert result.failure_reason == "cyclic"
        assert result.redirect_path == ["c-a", "c-b", "c-a"]

    def test_self_referencing_merge(self) -> None:
        """Concern pointing to itself → cyclic."""
        handler = LifecycleHandler()
        c = _make_concern(
            concern_id="c-self",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-self",
        )
        context = _make_context(concerns=[c])

        result = handler.follow_merge_redirect(c, context)

        assert result.resolved is False
        assert result.failure_reason == "cyclic"

    def test_suppressed_target(self) -> None:
        """Target is privacy-suppressed → suppressed."""
        handler = LifecycleHandler()
        target = _make_concern(concern_id="c-target", status=ConcernStatus.ACTIVE)
        merged = _make_concern(
            concern_id="c-merged",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-target",
        )
        context = _make_context(
            concerns=[merged, target],
            suppressed_ids=["c-target"],
        )

        result = handler.follow_merge_redirect(merged, context)

        assert result.resolved is False
        assert result.failure_reason == "suppressed"

    def test_suppressed_intermediate_target(self) -> None:
        """Intermediate target in chain is suppressed → suppressed."""
        handler = LifecycleHandler()
        final = _make_concern(concern_id="c-final", status=ConcernStatus.ACTIVE)
        mid = _make_concern(
            concern_id="c-mid",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-final",
        )
        start = _make_concern(
            concern_id="c-start",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-mid",
        )
        context = _make_context(
            concerns=[start, mid, final],
            suppressed_ids=["c-mid"],
        )

        result = handler.follow_merge_redirect(start, context)

        assert result.resolved is False
        assert result.failure_reason == "suppressed"

    def test_invalid_terminal_state_merged_with_no_redirect(self) -> None:
        """MERGED concern whose merged_into_concern_id is None → invalid_terminal_state."""
        handler = LifecycleHandler()
        # Manually construct a concern that bypasses normal validation
        # to simulate a corrupt state where merged_into is None
        target = ConcernSummary(
            concern_id="c-target",
            identity_summary="Summary",
            display_title="Title",
            current_summary="Current",
            status=ConcernStatus.MERGED,
            merged_into_concern_id=None,
            aliases=[],
            canonical_parent_id=None,
            parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
            last_active_at="2024-01-01T00:00:00Z",
            semantic_version=1,
        )
        merged = _make_concern(
            concern_id="c-start",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-target",
        )
        context = _make_context(concerns=[merged, target])

        result = handler.follow_merge_redirect(merged, context)

        assert result.resolved is False
        assert result.failure_reason == "invalid_terminal_state"

    def test_max_depth_exceeded(self) -> None:
        """Chain exceeds max_depth → max_depth_exceeded."""
        handler = LifecycleHandler()
        # Build a chain of 12 merged concerns (exceeds default max_depth=10)
        concerns = []
        for i in range(12):
            concerns.append(
                _make_concern(
                    concern_id=f"c-{i}",
                    status=ConcernStatus.MERGED,
                    merged_into_concern_id=f"c-{i + 1}",
                )
            )
        # Final target (never reached within depth limit)
        concerns.append(
            _make_concern(concern_id="c-12", status=ConcernStatus.ACTIVE)
        )
        context = _make_context(concerns=concerns)

        result = handler.follow_merge_redirect(concerns[0], context, max_depth=10)

        assert result.resolved is False
        assert result.failure_reason == "max_depth_exceeded"

    def test_custom_max_depth(self) -> None:
        """Custom max_depth respected."""
        handler = LifecycleHandler()
        concerns = []
        for i in range(5):
            concerns.append(
                _make_concern(
                    concern_id=f"c-{i}",
                    status=ConcernStatus.MERGED,
                    merged_into_concern_id=f"c-{i + 1}",
                )
            )
        concerns.append(
            _make_concern(concern_id="c-5", status=ConcernStatus.ACTIVE)
        )
        context = _make_context(concerns=concerns)

        # max_depth=3 should fail on a chain of length 5
        result = handler.follow_merge_redirect(concerns[0], context, max_depth=3)

        assert result.resolved is False
        assert result.failure_reason == "max_depth_exceeded"

    def test_custom_max_depth_just_enough(self) -> None:
        """Chain resolves when max_depth is exactly sufficient."""
        handler = LifecycleHandler()
        c2 = _make_concern(concern_id="c-2", status=ConcernStatus.ACTIVE)
        c1 = _make_concern(
            concern_id="c-1",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-2",
        )
        c0 = _make_concern(
            concern_id="c-0",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-1",
        )
        context = _make_context(concerns=[c0, c1, c2])

        # Chain is: c-0 → c-1 → c-2 (2 hops, needs max_depth >= 2)
        result = handler.follow_merge_redirect(c0, context, max_depth=2)

        assert result.resolved is True
        assert result.target_concern == c2

    def test_missing_target_in_multi_hop(self) -> None:
        """Missing target in middle of chain → missing_target."""
        handler = LifecycleHandler()
        # c-0 → c-1 → c-missing (not in context)
        c1 = _make_concern(
            concern_id="c-1",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-missing",
        )
        c0 = _make_concern(
            concern_id="c-0",
            status=ConcernStatus.MERGED,
            merged_into_concern_id="c-1",
        )
        context = _make_context(concerns=[c0, c1])

        result = handler.follow_merge_redirect(c0, context)

        assert result.resolved is False
        assert result.failure_reason == "missing_target"
        assert "c-missing" in result.redirect_path


# ---------------------------------------------------------------------------
# Tests: build_reactivation_group
# ---------------------------------------------------------------------------


class TestBuildReactivationGroup:
    """build_reactivation_group produces ALL_OR_NONE atomic groups."""

    def test_returns_all_or_none_failure_policy(self) -> None:
        """Reactivation group has ALL_OR_NONE failure policy."""
        handler = LifecycleHandler()

        group = handler.build_reactivation_group(
            concern_id="concern-123",
            packet_id="pkt-456",
            request_id="req-789",
        )

        assert group.failure_policy == "ALL_OR_NONE"

    def test_contains_four_mutation_refs(self) -> None:
        """Group contains exactly 4 mutations: association, status, last_active, audit."""
        handler = LifecycleHandler()

        group = handler.build_reactivation_group(
            concern_id="concern-123",
            packet_id="pkt-456",
            request_id="req-789",
        )

        assert len(group.mutation_refs) == 4

    def test_mutation_refs_contain_association(self) -> None:
        """Group includes an ownership association mutation."""
        handler = LifecycleHandler()

        group = handler.build_reactivation_group(
            concern_id="concern-123",
            packet_id="pkt-456",
            request_id="req-789",
        )

        association_refs = [r for r in group.mutation_refs if r.startswith("association:")]
        assert len(association_refs) == 1
        assert "concern-123" in association_refs[0]

    def test_mutation_refs_contain_status_transition(self) -> None:
        """Group includes a status transition mutation to ACTIVE."""
        handler = LifecycleHandler()

        group = handler.build_reactivation_group(
            concern_id="concern-123",
            packet_id="pkt-456",
            request_id="req-789",
        )

        status_refs = [r for r in group.mutation_refs if r.startswith("status_transition:")]
        assert len(status_refs) == 1
        assert "ACTIVE" in status_refs[0]
        assert "concern-123" in status_refs[0]

    def test_mutation_refs_contain_last_active_update(self) -> None:
        """Group includes a last_active_at update mutation."""
        handler = LifecycleHandler()

        group = handler.build_reactivation_group(
            concern_id="concern-123",
            packet_id="pkt-456",
            request_id="req-789",
        )

        last_active_refs = [r for r in group.mutation_refs if r.startswith("last_active_update:")]
        assert len(last_active_refs) == 1
        assert "concern-123" in last_active_refs[0]

    def test_mutation_refs_contain_audit_entry(self) -> None:
        """Group includes an audit entry mutation."""
        handler = LifecycleHandler()

        group = handler.build_reactivation_group(
            concern_id="concern-123",
            packet_id="pkt-456",
            request_id="req-789",
        )

        audit_refs = [r for r in group.mutation_refs if r.startswith("audit_entry:")]
        assert len(audit_refs) == 1
        assert "reactivation" in audit_refs[0]
        assert "concern-123" in audit_refs[0]

    def test_deterministic_group_id(self) -> None:
        """Same inputs produce the same group_id (deterministic)."""
        handler = LifecycleHandler()

        group1 = handler.build_reactivation_group(
            concern_id="concern-123",
            packet_id="pkt-456",
            request_id="req-789",
        )
        group2 = handler.build_reactivation_group(
            concern_id="concern-123",
            packet_id="pkt-456",
            request_id="req-789",
        )

        assert group1.group_id == group2.group_id

    def test_different_inputs_produce_different_group_id(self) -> None:
        """Different concern_id or packet_id produces different group_id."""
        handler = LifecycleHandler()

        group_a = handler.build_reactivation_group(
            concern_id="concern-A",
            packet_id="pkt-1",
            request_id="req-1",
        )
        group_b = handler.build_reactivation_group(
            concern_id="concern-B",
            packet_id="pkt-1",
            request_id="req-1",
        )

        assert group_a.group_id != group_b.group_id

    def test_group_id_is_nonempty(self) -> None:
        """Group ID is always a non-empty string."""
        handler = LifecycleHandler()

        group = handler.build_reactivation_group(
            concern_id="c-1",
            packet_id="p-1",
            request_id="r-1",
        )

        assert group.group_id
        assert len(group.group_id) > 0

    def test_is_valid_semantic_dependency_group_ref(self) -> None:
        """Result is a valid SemanticDependencyGroupRef model."""
        handler = LifecycleHandler()

        group = handler.build_reactivation_group(
            concern_id="c-1",
            packet_id="p-1",
            request_id="r-1",
        )

        assert isinstance(group, SemanticDependencyGroupRef)


# ---------------------------------------------------------------------------
# Tests: MergeRedirectResult dataclass
# ---------------------------------------------------------------------------


class TestMergeRedirectResult:
    """Tests for the MergeRedirectResult frozen dataclass."""

    def test_result_is_frozen(self) -> None:
        """MergeRedirectResult instances are immutable."""
        result = MergeRedirectResult(
            resolved=True,
            target_concern=None,
            redirect_path=["c-1"],
            failure_reason=None,
        )
        with pytest.raises(AttributeError):
            result.resolved = False  # type: ignore[misc]

    def test_defaults(self) -> None:
        """Default values for redirect_path and failure_reason."""
        result = MergeRedirectResult(resolved=True, target_concern=None)

        assert result.redirect_path == []
        assert result.failure_reason is None

    def test_equality(self) -> None:
        """Two results with same fields are equal."""
        r1 = MergeRedirectResult(
            resolved=False,
            target_concern=None,
            redirect_path=["c-1", "c-2"],
            failure_reason="cyclic",
        )
        r2 = MergeRedirectResult(
            resolved=False,
            target_concern=None,
            redirect_path=["c-1", "c-2"],
            failure_reason="cyclic",
        )
        assert r1 == r2
