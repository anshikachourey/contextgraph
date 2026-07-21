"""Grounded IRS (Intelligent Retrieval Signal) assessment.

This module implements the `IRSAssessor` which detects retrieval gaps using
a hybrid approach:

- Deterministic checks use explicit structured provenance, continuation origin,
  lifecycle state, and candidate/history mismatches.
- Structured provenance checks use conversation history and alias mappings.
- Semantic or multilingual cues may be assessed through the structured semantic
  evaluator (placeholder — requires LLM integration).

Design authority: design-corrections.md §7.1.

Key invariants:
- Every signal MUST be grounded in source evidence (EvidenceReference list).
- Keyword lists alone are insufficient and must not become domain- or
  language-specific truth rules.
- Signals start with resolved=False, resolved_by_attempt_ids=[].
"""

from __future__ import annotations

from ..contracts import GraphStateContext
from ..enums import BehavioralConfidenceBand, ConcernStatus, IRSSignalType
from ..identity_models import CandidateRecord, EvidenceReference, IRSSignal
from ..models import SemanticPacket
from .channel_protocol import RetrievalResult


class IRSAssessor:
    """Detects retrieval gaps by assessing Intelligent Retrieval Signals.

    Uses a hybrid approach per design-corrections.md §7.1:
    1. Deterministic checks (no LLM required):
       - IRS-3 IMPLIED_PRIOR_STATE
       - IRS-4 BROAD_CANDIDATE_MISMATCH
       - IRS-6 CONTINUATION_HISTORY_MISMATCH
    2. Structured provenance checks:
       - IRS-2 HISTORICAL_REFERENT
       - IRS-5 ALIAS_OR_VOCABULARY_DRIFT
    3. Semantic checks (LLM placeholder):
       - IRS-1 REVISIT_LANGUAGE

    Every emitted signal is grounded in source evidence. No domain-specific
    keyword lists are used as truth rules.
    """

    async def assess(
        self,
        packet: SemanticPacket,
        candidates: list[CandidateRecord],
        retrieval_result: RetrievalResult,
        context: GraphStateContext,
    ) -> list[IRSSignal]:
        """Assess all IRS signals for the given packet and retrieval state.

        Args:
            packet: The cohesive semantic packet being resolved.
            candidates: Evaluated identity candidates from retrieval.
            retrieval_result: Full retrieval result with attempt records.
            context: Immutable graph state context.

        Returns:
            List of grounded IRS signals detected. Empty if no gaps found.
        """
        signals: list[IRSSignal] = []

        # Deterministic checks (IRS-3, IRS-4, IRS-6)
        signal = self._check_implied_prior_state(packet, context)
        if signal is not None:
            signals.append(signal)

        signal = self._check_broad_candidate_mismatch(packet, candidates, context)
        if signal is not None:
            signals.append(signal)

        signal = self._check_continuation_history_mismatch(
            packet, candidates, context
        )
        if signal is not None:
            signals.append(signal)

        # Structured provenance checks (IRS-2, IRS-5)
        signal = self._check_historical_referent(packet, candidates, context)
        if signal is not None:
            signals.append(signal)

        signal = self._check_alias_or_vocabulary_drift(candidates, context)
        if signal is not None:
            signals.append(signal)

        # Semantic checks (IRS-1) — placeholder for LLM integration
        signal = await self._check_revisit_language(packet, candidates, context)
        if signal is not None:
            signals.append(signal)

        return signals

    # ------------------------------------------------------------------
    # Deterministic checks
    # ------------------------------------------------------------------

    def _check_implied_prior_state(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
    ) -> IRSSignal | None:
        """IRS-3: Detect when packet's continuation_origin references a
        concern in DORMANT or RETIRED state.

        If the packet explicitly continues from a concern that is no longer
        active, this is a HIGH confidence signal that retrieval should cover
        historical/dormant regions.
        """
        if packet.continuation_origin is None:
            return None

        # Find the concern referenced by continuation_origin
        for concern in context.concerns:
            if concern.concern_id == packet.continuation_origin:
                if concern.status in (ConcernStatus.DORMANT, ConcernStatus.RETIRED):
                    return IRSSignal(
                        signal_type=IRSSignalType.IMPLIED_PRIOR_STATE,
                        confidence=BehavioralConfidenceBand.HIGH,
                        source_evidence=[
                            EvidenceReference(
                                entity_id=concern.concern_id,
                                entity_type="concern",
                                description=(
                                    f"Packet continuation_origin references "
                                    f"concern '{concern.concern_id}' which has "
                                    f"lifecycle status {concern.status.value}"
                                ),
                            ),
                            EvidenceReference(
                                entity_id=packet.packet_id,
                                entity_type="packet",
                                description=(
                                    f"Packet has continuation_origin='{packet.continuation_origin}'"
                                ),
                            ),
                        ],
                        explanation=(
                            f"Packet continuation_origin references concern "
                            f"'{concern.concern_id}' in {concern.status.value} state. "
                            f"Retrieval may need dormant/historical coverage."
                        ),
                        resolved=False,
                        resolved_by_attempt_ids=[],
                    )
        return None

    def _check_broad_candidate_mismatch(
        self,
        packet: SemanticPacket,
        candidates: list[CandidateRecord],
        context: GraphStateContext,
    ) -> IRSSignal | None:
        """IRS-4: Detect when all candidates have non-ACTIVE lifecycle status
        but the packet appears to be about an active topic.

        If the packet has no continuation_origin (suggesting it is fresh/active
        material) but every retrieved candidate is in a non-ACTIVE state,
        this indicates a retrieval gap for active concerns.
        """
        if not candidates:
            return None

        # Check if ALL candidates are non-ACTIVE
        non_active_candidates = [
            c for c in candidates if c.lifecycle_status != ConcernStatus.ACTIVE
        ]
        if len(non_active_candidates) != len(candidates):
            return None

        # The packet seems to be about an active topic when it lacks a
        # continuation_origin pointing to a dormant/retired concern
        # (i.e., it's fresh material not explicitly continuing something old).
        # We also verify there are active concerns in context that could
        # potentially match but were not retrieved.
        active_concerns_in_context = [
            c for c in context.concerns if c.status == ConcernStatus.ACTIVE
        ]
        if not active_concerns_in_context:
            # No active concerns exist at all — mismatch is not meaningful
            return None

        evidence: list[EvidenceReference] = [
            EvidenceReference(
                entity_id=packet.packet_id,
                entity_type="packet",
                description=(
                    "Packet appears to address active material but all "
                    f"{len(candidates)} retrieved candidates are non-ACTIVE"
                ),
            ),
        ]
        # Add evidence for non-active candidates (up to 3 for brevity)
        for candidate in non_active_candidates[:3]:
            evidence.append(
                EvidenceReference(
                    entity_id=candidate.concern_id,
                    entity_type="concern",
                    description=(
                        f"Candidate concern has lifecycle_status="
                        f"{candidate.lifecycle_status.value}"
                    ),
                )
            )

        return IRSSignal(
            signal_type=IRSSignalType.BROAD_CANDIDATE_MISMATCH,
            confidence=BehavioralConfidenceBand.MEDIUM,
            source_evidence=evidence,
            explanation=(
                f"All {len(candidates)} retrieved candidates are non-ACTIVE "
                f"(statuses: {[c.lifecycle_status.value for c in candidates]}), "
                f"but {len(active_concerns_in_context)} active concerns exist in "
                f"context. Retrieval may have missed relevant active concerns."
            ),
            resolved=False,
            resolved_by_attempt_ids=[],
        )

    def _check_continuation_history_mismatch(
        self,
        packet: SemanticPacket,
        candidates: list[CandidateRecord],
        context: GraphStateContext,
    ) -> IRSSignal | None:
        """IRS-6: Detect when packet has continuation_origin but no candidate
        matches that origin concern.

        If the packet declares it continues a specific concern but none of the
        retrieved candidates correspond to that concern, retrieval has missed
        the relevant historical context.
        """
        if packet.continuation_origin is None:
            return None

        # Check if any candidate matches the continuation origin
        candidate_concern_ids = {c.concern_id for c in candidates}

        # Also check resolved merge targets
        for candidate in candidates:
            if candidate.resolved_merge_target is not None:
                candidate_concern_ids.add(candidate.resolved_merge_target)

        if packet.continuation_origin in candidate_concern_ids:
            return None

        # Build grounded evidence
        evidence: list[EvidenceReference] = [
            EvidenceReference(
                entity_id=packet.packet_id,
                entity_type="packet",
                description=(
                    f"Packet declares continuation_origin='{packet.continuation_origin}'"
                ),
            ),
        ]

        # Check if the origin concern exists in context at all
        origin_in_context = any(
            c.concern_id == packet.continuation_origin for c in context.concerns
        )
        if origin_in_context:
            evidence.append(
                EvidenceReference(
                    entity_id=packet.continuation_origin,
                    entity_type="concern",
                    description=(
                        "Origin concern exists in graph state but was not "
                        "retrieved as a candidate"
                    ),
                )
            )

        return IRSSignal(
            signal_type=IRSSignalType.CONTINUATION_HISTORY_MISMATCH,
            confidence=BehavioralConfidenceBand.HIGH,
            source_evidence=evidence,
            explanation=(
                f"Packet has continuation_origin='{packet.continuation_origin}' "
                f"but no candidate matches that concern. "
                f"Candidates: {sorted(candidate_concern_ids) if candidate_concern_ids else '(none)'}. "
                f"Historical-region retrieval may be needed."
            ),
            resolved=False,
            resolved_by_attempt_ids=[],
        )

    # ------------------------------------------------------------------
    # Structured provenance checks
    # ------------------------------------------------------------------

    def _check_historical_referent(
        self,
        packet: SemanticPacket,
        candidates: list[CandidateRecord],
        context: GraphStateContext,
    ) -> IRSSignal | None:
        """IRS-2: Detect when packet references propositions from early in
        the conversation that no candidate covers.

        If there are propositions associated with concerns from early in the
        conversation history (low message_seq_range) that are referenced by
        packet content but not represented in the candidate set, this indicates
        a retrieval gap for historically distant concerns.
        """
        if not context.propositions:
            return None

        # Identify propositions from early conversation (first quartile of seq range)
        all_seq_starts = [p.message_seq_range[0] for p in context.propositions]
        if not all_seq_starts:
            return None

        max_seq = max(all_seq_starts) if all_seq_starts else 0
        if max_seq == 0:
            return None

        # "Early" means first quarter of the conversation history
        early_threshold = max_seq // 4 if max_seq >= 4 else 0

        # Find concerns that own early propositions
        early_proposition_concern_ids: set[str] = set()
        early_propositions: list[str] = []
        for assoc in context.active_associations:
            prop = next(
                (
                    p
                    for p in context.propositions
                    if p.proposition_id == assoc.proposition_id
                ),
                None,
            )
            if prop is not None and prop.message_seq_range[0] <= early_threshold:
                early_proposition_concern_ids.add(assoc.concern_id)
                early_propositions.append(prop.proposition_id)

        if not early_proposition_concern_ids:
            return None

        # Check if these early-history concerns are covered by candidates
        candidate_concern_ids = {c.concern_id for c in candidates}
        uncovered_early_concerns = (
            early_proposition_concern_ids - candidate_concern_ids
        )

        if not uncovered_early_concerns:
            return None

        # Check if packet's seq range is significantly later than the early propositions
        # (indicating the packet is potentially revisiting old material)
        packet_seq_start = packet.message_seq_range[0]
        if packet_seq_start <= early_threshold:
            # Packet is itself from early — not a historical referent situation
            return None

        evidence: list[EvidenceReference] = [
            EvidenceReference(
                entity_id=packet.packet_id,
                entity_type="packet",
                description=(
                    f"Packet at seq_range={packet.message_seq_range} may reference "
                    f"early-conversation propositions (threshold≤{early_threshold})"
                ),
            ),
        ]
        # Add evidence for uncovered concerns (up to 3)
        for concern_id in list(uncovered_early_concerns)[:3]:
            evidence.append(
                EvidenceReference(
                    entity_id=concern_id,
                    entity_type="concern",
                    description=(
                        "Concern owns early-conversation propositions but "
                        "was not retrieved as a candidate"
                    ),
                )
            )

        return IRSSignal(
            signal_type=IRSSignalType.HISTORICAL_REFERENT,
            confidence=BehavioralConfidenceBand.MEDIUM,
            source_evidence=evidence,
            explanation=(
                f"Packet at seq_range={packet.message_seq_range} has later context "
                f"but {len(uncovered_early_concerns)} concern(s) with early-conversation "
                f"propositions (seq≤{early_threshold}) were not retrieved. "
                f"Historical-region or identity-summary retrieval may be needed."
            ),
            resolved=False,
            resolved_by_attempt_ids=[],
        )

    def _check_alias_or_vocabulary_drift(
        self,
        candidates: list[CandidateRecord],
        context: GraphStateContext,
    ) -> IRSSignal | None:
        """IRS-5: Detect when normalized aliases exist for concerns not in the
        candidate set.

        If the graph state contains normalized aliases pointing to concerns
        that were not retrieved as candidates, retrieval may have missed
        concerns due to vocabulary drift or aliasing.
        """
        if not context.normalized_aliases:
            return None

        candidate_concern_ids = {c.concern_id for c in candidates}

        # Find concerns that have aliases but are not in the candidate set
        aliased_concern_ids: set[str] = set()
        alias_evidence: list[tuple[str, str]] = []  # (concern_id, alias_text)
        for alias in context.normalized_aliases:
            if alias.concern_id not in candidate_concern_ids:
                aliased_concern_ids.add(alias.concern_id)
                alias_evidence.append((alias.concern_id, alias.alias_text))

        if not aliased_concern_ids:
            return None

        # Only emit signal if the aliased concerns are in ACTIVE or DORMANT state
        # (they're meaningful candidates for identity resolution)
        eligible_uncovered = set()
        for concern in context.concerns:
            if (
                concern.concern_id in aliased_concern_ids
                and concern.status in (ConcernStatus.ACTIVE, ConcernStatus.DORMANT)
            ):
                eligible_uncovered.add(concern.concern_id)

        if not eligible_uncovered:
            return None

        evidence: list[EvidenceReference] = []
        # Add evidence for aliased concerns not in candidates (up to 3)
        for concern_id, alias_text in alias_evidence[:3]:
            if concern_id in eligible_uncovered:
                evidence.append(
                    EvidenceReference(
                        entity_id=concern_id,
                        entity_type="concern",
                        description=(
                            f"Concern has normalized alias '{alias_text}' "
                            f"but was not retrieved as a candidate"
                        ),
                    )
                )

        if not evidence:
            # All aliased concerns with evidence are not eligible
            return None

        return IRSSignal(
            signal_type=IRSSignalType.ALIAS_OR_VOCABULARY_DRIFT,
            confidence=BehavioralConfidenceBand.MEDIUM,
            source_evidence=evidence,
            explanation=(
                f"{len(eligible_uncovered)} concern(s) with normalized aliases "
                f"were not retrieved as candidates. Alias-normalized or "
                f"alternate-formulation retrieval may be needed."
            ),
            resolved=False,
            resolved_by_attempt_ids=[],
        )

    # ------------------------------------------------------------------
    # Semantic checks (LLM placeholder)
    # ------------------------------------------------------------------

    async def _check_revisit_language(
        self,
        packet: SemanticPacket,
        candidates: list[CandidateRecord],
        context: GraphStateContext,
    ) -> IRSSignal | None:
        """IRS-1: Detect revisit/return language cues in packet content.

        This check requires LLM-based semantic evaluation to detect
        multilingual or implicit revisit cues (e.g., "going back to...",
        "as I mentioned earlier...", "remember when we discussed...").

        Keyword lists alone are insufficient and must not become
        domain- or language-specific truth rules per design-corrections.md §7.1.

        TODO: Integrate with structured semantic evaluator for multilingual
        and implicit revisit cue detection. This requires the provider-neutral
        LLM adapter from task 8.1.

        Returns:
            None — placeholder until semantic evaluator is integrated.
        """
        # TODO: Use the structured semantic evaluator (task 8.1) to detect
        # revisit language cues. The evaluator should:
        # 1. Analyze packet.user_grounded_meaning for revisit/return patterns
        # 2. Support multilingual cue detection without keyword lists
        # 3. Ground evidence in specific text spans when detected
        # 4. Return HIGH or MEDIUM confidence based on cue strength
        return None
