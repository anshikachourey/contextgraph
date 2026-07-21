"""Typed protocols for SIE semantic processing stages.

This module defines structural interfaces (typing.Protocol) for the five
semantic processing stages in the SIE pipeline:

- RetentionAssessor: Classifies incoming material into retention levels.
- PropositionExtractor: Extracts propositions from retained material.
- PacketFormer: Groups propositions into concern-cohesive packets.
- CohesionAnalyzer: Validates packet concern-cohesion; may recommend splits.
- IdentityResolver: Resolves packets against existing concerns.

Each protocol defines:
- Input/output types using existing models from models.py and associations.py.
- A version field tracking the stage's implementation version.
- No implementation logic — these are structural interfaces only.

This module does NOT implement:
- Prompts, model calls, or retrieval logic.
- Thresholds, heuristics, or ownership assignment logic.
- Fabricated semantic results or placeholder return values.

PendingDecisionLifecycle
------------------------
Pending semantic decisions follow a defined lifecycle across pipeline invocations:

1. **Creation**: When a stage cannot fully resolve a decision (e.g., identity
   resolution is inconclusive, cohesion analysis is uncertain), a
   PendingSemanticDecision is created with lifecycle_state="pending" (or
   "unresolved"/"deferred" depending on the reason).

2. **Persistence**: Pending decisions are persisted in the database as durable
   records. They survive across HTTP requests and pipeline invocations. They are
   not ephemeral in-memory state.

3. **Reloading**: On every subsequent pipeline invocation, ALL pending/unresolved/
   deferred decisions for the conversation are reloaded into GraphStateContext
   (via the pending_decisions field). This allows stages to reason about prior
   unresolved work and attempt re-resolution with updated context.

4. **Resolution**: When later processing succeeds in resolving a previously
   pending decision, the record transitions to lifecycle_state="resolved" with
   resolved_at set to the resolution timestamp.

5. **Immutability of history**: Resolution does NOT delete the decision record.
   The original record is updated in place (lifecycle_state and resolved_at
   fields only). All creation metadata, rationale, originating request, and
   dependency references remain intact for audit purposes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from .associations import PacketMembership, PacketSplitRecord
from .models import (
    IdentityResolutionResult,
    Proposition,
    RetentionDecision,
    SemanticPacket,
    SIEMessage,
)

if TYPE_CHECKING:
    from .contracts import GraphStateContext


class RetentionAssessor(Protocol):
    """Classifies incoming material into retention levels.

    The retention assessor evaluates each message (or meaningful unit within
    messages) and produces a RetentionDecision indicating how the material
    should be retained downstream. All retention roles (primary and secondary)
    are preserved in the decision.

    Pending decision semantics:
        If the assessor cannot confidently classify material (e.g., ambiguous
        context, insufficient surrounding messages), it should produce a
        RetentionDecision with outcome=UNRESOLVED or DEFER. The orchestrator
        will persist this as a PendingSemanticDecision for later re-evaluation.
    """

    version: str

    async def assess(
        self,
        messages: list[SIEMessage],
        context: GraphStateContext,
    ) -> list[RetentionDecision]:
        """Assess retention for messages.

        Args:
            messages: Input messages to assess.
            context: Current graph state including existing concerns,
                propositions, associations, and pending decisions.

        Returns:
            A list of RetentionDecision instances, one for each meaningful
            unit identified in the input messages.
        """
        ...


class PropositionExtractor(Protocol):
    """Extracts propositions from retained material.

    The extractor takes messages that passed retention assessment and produces
    fine-grained Proposition instances representing the smallest semantic units.
    Each proposition carries full provenance back to source messages.

    Pending decision semantics:
        If extraction encounters ambiguous material that cannot be confidently
        decomposed into propositions, the stage may produce partial results
        alongside an unresolved/deferred decision for the ambiguous portion.
    """

    version: str

    async def extract(
        self,
        messages: list[SIEMessage],
        retention_decisions: list[RetentionDecision],
        context: GraphStateContext,
    ) -> list[Proposition]:
        """Extract propositions from retained messages.

        Args:
            messages: Source messages (those that passed retention).
            retention_decisions: Retention decisions from the assessor,
                indicating which material to extract from and at what level.
            context: Current graph state for contextual extraction.

        Returns:
            A list of Proposition instances extracted from the messages.
        """
        ...


class PacketFormer(Protocol):
    """Groups propositions into concern-cohesive packets.

    The packet former takes extracted propositions and groups them into
    SemanticPackets — units that likely advance the same primary concern.
    It also produces PacketMembership records capturing the ordered
    relationship between propositions and their packets.

    Pending decision semantics:
        If the former cannot confidently group certain propositions (e.g.,
        they might belong to multiple concerns), packets may be formed with
        cohesion_status=UNRESOLVED_COHESION, triggering a pending decision
        for later cohesion analysis.
    """

    version: str

    async def form_packets(
        self,
        propositions: list[Proposition],
        context: GraphStateContext,
    ) -> tuple[list[SemanticPacket], list[PacketMembership]]:
        """Form concern-cohesive packets from propositions.

        Args:
            propositions: Extracted propositions to group.
            context: Current graph state for contextual grouping.

        Returns:
            A tuple of (packets, memberships) where packets are the formed
            SemanticPackets and memberships record which propositions belong
            to which packets and in what order.
        """
        ...


class CohesionAnalyzer(Protocol):
    """Validates packet concern-cohesion; may recommend splits.

    The cohesion analyzer examines formed packets and determines whether
    their constituent propositions truly advance a single primary concern.
    If a packet is MIXED, the analyzer recommends splits, producing new
    child packets and PacketSplitRecord instances.

    Pending decision semantics:
        If cohesion cannot be determined with confidence (e.g., novel
        concern boundaries, insufficient context), the packet retains
        cohesion_status=UNRESOLVED_COHESION and a pending decision is
        created for later re-analysis when more context is available.
    """

    version: str

    async def analyze(
        self,
        packets: list[SemanticPacket],
        propositions: list[Proposition],
        context: GraphStateContext,
    ) -> tuple[list[SemanticPacket], list[PacketSplitRecord]]:
        """Analyze cohesion of packets and split if necessary.

        Args:
            packets: Packets to validate for concern-cohesion.
            propositions: The propositions within those packets (for
                content-level analysis).
            context: Current graph state for contextual analysis.

        Returns:
            A tuple of (updated_packets, splits) where updated_packets
            includes both original cohesive packets and any new child
            packets from splits, and splits records the lineage of any
            split operations performed.
        """
        ...


class IdentityResolver(Protocol):
    """Resolves packets against existing concerns.

    The identity resolver takes cohesive packets and determines whether
    each packet matches an existing Persistent Concern, proposes a new
    concern, or cannot be resolved. This is the authoritative semantic
    ownership decision.

    Pending decision semantics:
        If identity resolution is inconclusive (no confident match, no
        confident new-concern proposal), the result carries
        outcome=UNRESOLVED, DEFER, or RETRIEVAL_INCONCLUSIVE. The
        orchestrator persists this as a PendingSemanticDecision. On
        subsequent invocations, the pending decision is reloaded into
        GraphStateContext so the resolver can re-attempt resolution with
        additional context or messages.
    """

    version: str

    async def resolve(
        self,
        packets: list[SemanticPacket],
        context: GraphStateContext,
    ) -> list[IdentityResolutionResult]:
        """Resolve packets against existing concerns.

        Args:
            packets: Cohesive packets to resolve identity for.
            context: Current graph state including existing concerns,
                their associations, aliases, and any pending decisions
                from prior resolution attempts.

        Returns:
            A list of IdentityResolutionResult instances, one per packet,
            indicating match, new-concern proposal, or unresolved outcome.
        """
        ...
