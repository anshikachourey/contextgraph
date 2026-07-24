"""Concern lifecycle handler for SIE identity resolution.

This module implements `LifecycleHandler`, which manages concern lifecycle
transitions during identity resolution:

- Filtering eligible concerns (ACTIVE, DORMANT, RETIRED) without recency bias.
- Following ordered merge redirects with rejection of invalid targets.
- Building atomic ALL_OR_NONE reactivation groups for substantive resumption.

Design authority: consolidated final design.md §10 (Concern Lifecycle Handler).

Key rules:
- ACTIVE and DORMANT concerns are always eligible candidates.
  Age/recency cannot independently lower confidence.
- RETIRED concerns are discoverable for identity evaluation.
  Substantive return proposes RETIRED→ACTIVE. Historical reference leaves RETIRED.
- Reactivation requires substantive resumption (not historical mention).
  Group: association + status mutation + last_active update + audit entry.
- MERGED → follow redirect chain. Reject missing/cyclic/cross-conversation/
  suppressed targets with REQUIRES_VALIDATION.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..contracts import ConcernSummary, GraphStateContext, SemanticDependencyGroupRef
from ..enums import ConcernStatus
from ..id_generation import resolve_entity_id


@dataclass(frozen=True, slots=True)
class MergeRedirectResult:
    """Result of following a merge redirect chain.

    Fields:
        resolved: Whether the redirect chain resolved to a valid target.
        target_concern: The resolved surviving concern, or None if resolution failed.
        redirect_path: Ordered list of concern_ids traversed in the chain.
        failure_reason: Why resolution failed, or None if resolved successfully.
            Possible values: missing_target, cyclic, cross_conversation,
            suppressed, invalid_terminal_state, max_depth_exceeded.
    """

    resolved: bool
    target_concern: ConcernSummary | None
    redirect_path: list[str] = field(default_factory=list)
    failure_reason: str | None = None


class LifecycleHandler:
    """Manages concern lifecycle transitions during identity resolution.

    Responsibilities:
    - Filter eligible concerns for identity evaluation (ACTIVE + DORMANT + RETIRED).
    - Follow merge redirect chains with validation.
    - Build atomic reactivation dependency groups for substantive resumption.
    """

    def follow_merge_redirect(
        self,
        concern: ConcernSummary,
        context: GraphStateContext,
        max_depth: int = 10,
    ) -> MergeRedirectResult:
        """Follow the merge redirect chain from a MERGED concern.

        Walks from a MERGED concern through its merged_into_concern_id chain
        until a non-MERGED terminal concern is reached or a failure condition
        is detected.

        Rejection conditions:
        - Target concern not found in context (missing_target).
        - Cycle detected in redirect chain (cyclic).
        - Target is privacy-suppressed (suppressed).
        - Target is itself MERGED but has no further redirect (invalid_terminal_state).
        - Depth exceeds max_depth (max_depth_exceeded).

        Note: Cross-conversation check is implicitly enforced because
        GraphStateContext.concerns only contains concerns from the same
        conversation. A concern not found in the context list is treated
        as missing_target which covers cross-conversation references.

        Args:
            concern: The MERGED concern to start from.
            context: Current graph state with concerns and suppressed IDs.
            max_depth: Maximum redirect chain depth (default 10).

        Returns:
            MergeRedirectResult with resolution status, target, path, and
            failure reason if applicable.
        """
        if concern.status != ConcernStatus.MERGED:
            # Not a merged concern — nothing to follow
            return MergeRedirectResult(
                resolved=True,
                target_concern=concern,
                redirect_path=[concern.concern_id],
                failure_reason=None,
            )

        # Build a lookup map for concerns by ID
        concern_map: dict[str, ConcernSummary] = {
            c.concern_id: c for c in context.concerns
        }
        suppressed_ids = set(context.privacy_suppressed_concern_ids)

        visited: set[str] = set()
        path: list[str] = [concern.concern_id]
        current = concern

        for _ in range(max_depth):
            visited.add(current.concern_id)

            target_id = current.merged_into_concern_id
            if target_id is None:
                # MERGED concern with no redirect target — invalid state
                return MergeRedirectResult(
                    resolved=False,
                    target_concern=None,
                    redirect_path=path,
                    failure_reason="invalid_terminal_state",
                )

            # Check cycle
            if target_id in visited:
                path.append(target_id)
                return MergeRedirectResult(
                    resolved=False,
                    target_concern=None,
                    redirect_path=path,
                    failure_reason="cyclic",
                )

            # Check target exists in context (covers cross-conversation)
            target = concern_map.get(target_id)
            if target is None:
                path.append(target_id)
                return MergeRedirectResult(
                    resolved=False,
                    target_concern=None,
                    redirect_path=path,
                    failure_reason="missing_target",
                )

            # Check privacy suppression
            if target_id in suppressed_ids:
                path.append(target_id)
                return MergeRedirectResult(
                    resolved=False,
                    target_concern=None,
                    redirect_path=path,
                    failure_reason="suppressed",
                )

            path.append(target_id)

            # If target is not MERGED, we've reached the terminal
            if target.status != ConcernStatus.MERGED:
                return MergeRedirectResult(
                    resolved=True,
                    target_concern=target,
                    redirect_path=path,
                    failure_reason=None,
                )

            # Target is also MERGED — continue following chain
            current = target

        # Exceeded max depth
        return MergeRedirectResult(
            resolved=False,
            target_concern=None,
            redirect_path=path,
            failure_reason="max_depth_exceeded",
        )

    def build_reactivation_group(
        self,
        concern_id: str,
        packet_id: str,
        request_id: str,
    ) -> SemanticDependencyGroupRef:
        """Build an atomic ALL_OR_NONE dependency group for reactivation.

        Reactivation requires substantive resumption (not historical mention).
        The group contains mutation refs for:
        1. Ownership association creation
        2. Status transition (DORMANT/RETIRED → ACTIVE)
        3. last_active_at update
        4. Audit entry

        All mutations succeed or all roll back.

        Args:
            concern_id: The concern being reactivated.
            packet_id: The packet triggering reactivation.
            request_id: The processing request ID.

        Returns:
            SemanticDependencyGroupRef with ALL_OR_NONE failure policy.
        """
        # Generate a deterministic group ID from the reactivation event
        group_creation_key = f"{request_id}:reactivation:{concern_id}:{packet_id}"
        group_id = resolve_entity_id("association", group_creation_key)

        # Define the four mutation refs for the atomic group
        mutation_refs = [
            f"association:{request_id}:{packet_id}:{concern_id}",
            f"status_transition:{concern_id}:ACTIVE",
            f"last_active_update:{concern_id}",
            f"audit_entry:reactivation:{concern_id}:{request_id}",
        ]

        return SemanticDependencyGroupRef(
            group_id=group_id,
            mutation_refs=mutation_refs,
            failure_policy="ALL_OR_NONE",
        )

    def filter_eligible_concerns(
        self,
        context: GraphStateContext,
    ) -> list[ConcernSummary]:
        """Return concerns eligible for identity evaluation.

        Eligible statuses: ACTIVE, DORMANT, RETIRED.
        Excluded: MERGED (they redirect to a surviving concern).
        No recency filtering is applied — age/recency cannot independently
        lower confidence or exclude a concern from evaluation.

        Args:
            context: Current graph state containing all concerns.

        Returns:
            List of ConcernSummary objects with ACTIVE, DORMANT, or RETIRED status.
        """
        eligible_statuses = {
            ConcernStatus.ACTIVE,
            ConcernStatus.DORMANT,
            ConcernStatus.RETIRED,
        }
        return [
            concern
            for concern in context.concerns
            if concern.status in eligible_statuses
        ]
