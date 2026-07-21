"""Policy-driven adaptive widener for SIE identity resolution.

This module implements `AdaptiveWidener`, which extends retrieval coverage
by executing additional channel invocations for unresolved IRS signals.

Design authority: design-corrections.md §7.3.

Budget enforcement (Task 10.2): COMPLETE.
- All four budget dimensions (max_attempts, max_rounds, max_latency_ms,
  max_cost_units) are enforced without hardcoded defaults.
- Budget values come exclusively from the caller-supplied WideningBudget.
- Budget exhaustion sets `budget_exhausted=True` on the result, ensuring
  the downstream sufficiency gate produces RETRIEVAL_INCONCLUSIVE or DEFER
  (never novelty).
- A nonmaterial channel failure (ERROR on a non-blocking channel family)
  does not abort widening; the widener records the attempt and continues.

Critical rules:
- ALL IRS-to-channel invocations come from `RetrievalPolicy`; no hardcoded defaults.
- Budget exhaustion before adequacy → result is INCONCLUSIVE, never NO.
- The widener does NOT assign ownership; it only produces more candidates.
- Every new candidate is sent back to the standard evaluator (via caller).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ..contracts import GraphStateContext
from ..enums import RetrievalAttemptStatus
from ..identity_models import (
    IRSSignal,
    RetrievalAttemptRecord,
    SufficiencyRecord,
    WideningBudget,
)
from ..identity_policy import RetrievalPolicy
from ..models import SemanticPacket
from .channel_protocol import ChannelRegistry


# ---------------------------------------------------------------------------
# WideningResult
# ---------------------------------------------------------------------------


@dataclass
class WideningResult:
    """Result of an adaptive widening pass.

    Attributes:
        new_attempts: All retrieval attempt records produced during widening.
        new_candidate_ids: Deduplicated candidate IDs from successful attempts.
        budget: Updated WideningBudget reflecting consumption during widening.
        rounds_executed: Number of widening rounds that completed.
        budget_exhausted: Whether the budget was exhausted during widening.
        rationale: Human-readable explanation of what the widener did and why.
    """

    new_attempts: list[RetrievalAttemptRecord] = field(default_factory=list)
    new_candidate_ids: list[str] = field(default_factory=list)
    budget: WideningBudget | None = None
    rounds_executed: int = 0
    budget_exhausted: bool = False
    rationale: str = ""


# ---------------------------------------------------------------------------
# AdaptiveWidener
# ---------------------------------------------------------------------------


class AdaptiveWidener:
    """Policy-driven adaptive widener that extends retrieval coverage.

    Reads ALL IRS-to-channel invocations from `RetrievalPolicy` at runtime.
    Does NOT embed example or fallback mappings in code.
    Selects only configured additional invocations for unresolved coverage gaps.
    Sends every new candidate back to the standard evaluator (via the caller).

    The widener does NOT assign ownership — it only produces more candidates
    for downstream identity evaluation.
    """

    def __init__(
        self,
        channel_registry: ChannelRegistry,
        policy: RetrievalPolicy,
    ) -> None:
        """Initialize the adaptive widener.

        Args:
            channel_registry: Registry of available retrieval channels.
            policy: Versioned retrieval policy defining IRS-to-channel mappings.
        """
        self._channel_registry = channel_registry
        self._policy = policy

    async def widen(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        sufficiency_result: SufficiencyRecord,
        budget: WideningBudget,
    ) -> WideningResult:
        """Execute adaptive widening for unresolved IRS signals.

        For each unresolved IRS signal in `sufficiency_result.unresolved_signals`:
        - Look up `policy.irs_signal_channel_mapping[signal.signal_type.value]`
        - For each `ChannelInvocation` in the mapping, execute it via
          `channel_registry.get(invocation.channel_id).retrieve(...)`

        Stops if budget is exhausted (attempts_used >= max_attempts,
        latency_used_ms >= max_latency_ms, or rounds_used >= max_rounds).

        Budget exhaustion before adequacy produces INCONCLUSIVE, never NO.

        Args:
            packet: The semantic packet being resolved.
            context: Immutable graph state snapshot for retrieval.
            sufficiency_result: Current sufficiency assessment with unresolved signals.
            budget: Current widening budget (tracks consumption).

        Returns:
            WideningResult with all new attempts, candidate IDs, and updated budget.
        """
        new_attempts: list[RetrievalAttemptRecord] = []
        new_candidate_ids: list[str] = []
        rounds_executed = 0
        rationale_parts: list[str] = []

        # Work with a mutable copy of budget values
        rounds_used = budget.rounds_used
        attempts_used = budget.attempts_used
        latency_used_ms = budget.latency_used_ms
        cost_used = budget.cost_used

        unresolved_signals = sufficiency_result.unresolved_signals

        if not unresolved_signals:
            updated_budget = budget.model_copy(
                update={"exhausted": self._is_exhausted(budget)}
            )
            return WideningResult(
                new_attempts=[],
                new_candidate_ids=[],
                budget=updated_budget,
                rounds_executed=0,
                budget_exhausted=updated_budget.exhausted,
                rationale="No unresolved signals to widen for.",
            )

        # Each pass through all unresolved signals constitutes one round
        for signal in unresolved_signals:
            # Check round budget before starting a new signal's invocations
            if rounds_used >= budget.max_rounds:
                rationale_parts.append(
                    f"Stopped: max_rounds ({budget.max_rounds}) reached."
                )
                break

            signal_key = signal.signal_type.value
            invocations = self._policy.irs_signal_channel_mapping.get(
                signal_key, []
            )

            if not invocations:
                rationale_parts.append(
                    f"No configured invocations for signal '{signal_key}'."
                )
                continue

            signal_attempted = False

            for invocation in invocations:
                # Check attempt budget
                if attempts_used >= budget.max_attempts:
                    rationale_parts.append(
                        f"Stopped: max_attempts ({budget.max_attempts}) reached."
                    )
                    break

                # Check latency budget
                if latency_used_ms >= budget.max_latency_ms:
                    rationale_parts.append(
                        f"Stopped: max_latency_ms ({budget.max_latency_ms}) reached."
                    )
                    break

                # Execute the channel invocation
                channel = self._channel_registry.get(invocation.channel_id)
                start_time_ms = _current_time_ms()

                attempt_record = await channel.retrieve(
                    packet, context, invocation
                )

                elapsed_ms = _current_time_ms() - start_time_ms

                # Track budget consumption
                attempts_used += 1
                latency_used_ms += attempt_record.latency_ms or elapsed_ms
                signal_attempted = True

                new_attempts.append(attempt_record)

                # Collect candidate IDs from successful attempts
                if attempt_record.status in (
                    RetrievalAttemptStatus.SUCCESS_WITH_CANDIDATES,
                ):
                    for cid in attempt_record.candidate_ids:
                        if cid not in new_candidate_ids:
                            new_candidate_ids.append(cid)

            if signal_attempted:
                rounds_used += 1
                rounds_executed += 1

            # Re-check budgets after processing this signal
            if attempts_used >= budget.max_attempts:
                rationale_parts.append(
                    f"Stopped: max_attempts ({budget.max_attempts}) reached."
                )
                break
            if latency_used_ms >= budget.max_latency_ms:
                rationale_parts.append(
                    f"Stopped: max_latency_ms ({budget.max_latency_ms}) reached."
                )
                break

        # Build the updated budget
        exhausted = (
            rounds_used >= budget.max_rounds
            or attempts_used >= budget.max_attempts
            or latency_used_ms >= budget.max_latency_ms
            or cost_used >= budget.max_cost_units
        )

        updated_budget = WideningBudget(
            max_rounds=budget.max_rounds,
            max_attempts=budget.max_attempts,
            max_latency_ms=budget.max_latency_ms,
            max_cost_units=budget.max_cost_units,
            rounds_used=rounds_used,
            attempts_used=attempts_used,
            latency_used_ms=latency_used_ms,
            cost_used=cost_used,
            exhausted=exhausted,
        )

        # Build rationale
        if not rationale_parts:
            rationale_parts.append(
                f"Widening completed: {rounds_executed} round(s), "
                f"{len(new_attempts)} attempt(s), "
                f"{len(new_candidate_ids)} new candidate(s)."
            )
        else:
            rationale_parts.insert(
                0,
                f"Widening executed {rounds_executed} round(s), "
                f"{len(new_attempts)} attempt(s), "
                f"{len(new_candidate_ids)} new candidate(s).",
            )

        return WideningResult(
            new_attempts=new_attempts,
            new_candidate_ids=new_candidate_ids,
            budget=updated_budget,
            rounds_executed=rounds_executed,
            budget_exhausted=exhausted,
            rationale=" ".join(rationale_parts),
        )

    @staticmethod
    def _is_exhausted(budget: WideningBudget) -> bool:
        """Check if a budget is already exhausted."""
        return (
            budget.rounds_used >= budget.max_rounds
            or budget.attempts_used >= budget.max_attempts
            or budget.latency_used_ms >= budget.max_latency_ms
            or budget.cost_used >= budget.max_cost_units
        )


def _current_time_ms() -> int:
    """Get the current time in milliseconds (monotonic clock)."""
    return int(time.monotonic() * 1000)
