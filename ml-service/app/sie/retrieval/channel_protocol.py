"""Retrieval channel protocol and validated registry.

This module defines:
- `RetrievalChannel`: the Protocol that all retrieval channels must implement.
- `ChannelRegistry`: manages registered channels with startup validation.
- `RetrievalResult`: aggregated results from multiple channel executions.

Design invariants (design-corrections.md §6):
- Each channel searches ONLY the supplied immutable `GraphStateContext`.
- No channel may assign ownership or interpret its score as confidence.
- Registry validation rejects unknown channel IDs and unsupported query modes.
- Invalid policy causes fail-closed DEFER.

Design authority: design-corrections.md §6.1–§6.4.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from ..contracts import GraphStateContext
from ..enums import PipelineOutcome, ResolutionAction
from ..identity_models import CandidateRecord, RetrievalAttemptRecord
from ..identity_policy import (
    CANONICAL_CHANNEL_FAMILIES,
    ChannelInvocation,
    PolicyValidationResult,
    RetrievalPolicy,
)
from ..models import SemanticPacket


# ---------------------------------------------------------------------------
# RetrievalChannel Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class RetrievalChannel(Protocol):
    """Protocol defining the interface all retrieval channels must implement.

    Each channel:
    - Searches ONLY the supplied immutable GraphStateContext.
    - NEVER assigns ownership or produces confidence bands.
    - NEVER interprets its retrieval score as identity confidence.
    - Returns a RetrievalAttemptRecord documenting the attempt outcome.

    Retrieval scores remain channel-local diagnostics. No score, rank,
    count, or threshold can directly cause a YES outcome.
    """

    @property
    def channel_id(self) -> str:
        """Unique identifier for this channel instance."""
        ...

    @property
    def channel_family(self) -> str:
        """Canonical channel family this channel belongs to.

        Must be one of CANONICAL_CHANNEL_FAMILIES.
        """
        ...

    @property
    def supported_query_modes(self) -> list[str]:
        """Query modes this channel supports.

        Query modes parameterize broad/narrow/continuation/historical
        behavior on a single channel — not phantom channels.
        """
        ...

    async def retrieve(
        self,
        packet: SemanticPacket,
        context: GraphStateContext,
        invocation: ChannelInvocation,
    ) -> RetrievalAttemptRecord:
        """Execute a retrieval attempt against the supplied immutable context.

        Args:
            packet: The cohesive semantic packet to find candidates for.
            context: Immutable graph state snapshot — the ONLY data source.
            invocation: Parameterized invocation with query_mode and scope_overrides.

        Returns:
            A RetrievalAttemptRecord documenting the attempt outcome,
            candidates found (if any), latency, and failure reasons.

        The channel MUST NOT:
        - Query live database state beyond the supplied context.
        - Assign ownership or produce identity confidence bands.
        - Interpret retrieval scores as semantic identity evidence.
        """
        ...


# ---------------------------------------------------------------------------
# ChannelRegistry
# ---------------------------------------------------------------------------


class ChannelRegistryError(Exception):
    """Raised when channel registry validation fails."""


class UnknownChannelError(ChannelRegistryError):
    """Raised when attempting to access an unregistered channel ID."""

    def __init__(self, channel_id: str) -> None:
        self.channel_id = channel_id
        super().__init__(
            f"Channel '{channel_id}' is not registered. "
            f"Register it before use or check your policy configuration."
        )


class InvalidChannelFamilyError(ChannelRegistryError):
    """Raised when a channel's family is not one of the canonical families."""

    def __init__(self, channel_family: str) -> None:
        self.channel_family = channel_family
        super().__init__(
            f"Channel family '{channel_family}' is not a canonical family. "
            f"Valid families: {sorted(CANONICAL_CHANNEL_FAMILIES)}"
        )


class UnsupportedQueryModeError(ChannelRegistryError):
    """Raised when an invocation uses a query mode not supported by its channel."""

    def __init__(self, channel_id: str, query_mode: str, supported: list[str]) -> None:
        self.channel_id = channel_id
        self.query_mode = query_mode
        self.supported = supported
        super().__init__(
            f"Query mode '{query_mode}' is not supported by channel '{channel_id}'. "
            f"Supported modes: {supported}"
        )


class ChannelRegistry:
    """Manages registered retrieval channels with startup validation.

    The registry enforces:
    - Only channels with canonical channel families may be registered.
    - Only registered channel IDs may be referenced by policy.
    - Only query modes declared by a channel may be invoked.
    - Policy validation at startup catches all configuration errors.

    Invalid policy causes fail-closed DEFER — the subsystem does not proceed.
    """

    def __init__(self) -> None:
        self._channels: dict[str, RetrievalChannel] = {}

    @property
    def registered_channel_ids(self) -> list[str]:
        """Return all registered channel IDs."""
        return list(self._channels.keys())

    def register(self, channel: RetrievalChannel) -> None:
        """Register a retrieval channel after validating its channel family.

        Args:
            channel: A channel implementing the RetrievalChannel protocol.

        Raises:
            InvalidChannelFamilyError: If channel_family is not canonical.
        """
        if channel.channel_family not in CANONICAL_CHANNEL_FAMILIES:
            raise InvalidChannelFamilyError(channel.channel_family)
        self._channels[channel.channel_id] = channel

    def get(self, channel_id: str) -> RetrievalChannel:
        """Retrieve a registered channel by its ID.

        Args:
            channel_id: The unique channel identifier.

        Returns:
            The registered RetrievalChannel instance.

        Raises:
            UnknownChannelError: If channel_id is not registered.
        """
        if channel_id not in self._channels:
            raise UnknownChannelError(channel_id)
        return self._channels[channel_id]

    def validate_invocation(self, invocation: ChannelInvocation) -> bool:
        """Validate a single channel invocation against the registry.

        Checks:
        1. The channel_id exists in the registry.
        2. The query_mode is supported by that channel.

        Args:
            invocation: The channel invocation to validate.

        Returns:
            True if the invocation is valid.

        Raises:
            UnknownChannelError: If the channel_id is not registered.
            UnsupportedQueryModeError: If query_mode is not supported.
        """
        if invocation.channel_id not in self._channels:
            raise UnknownChannelError(invocation.channel_id)

        channel = self._channels[invocation.channel_id]
        if invocation.query_mode not in channel.supported_query_modes:
            raise UnsupportedQueryModeError(
                invocation.channel_id,
                invocation.query_mode,
                channel.supported_query_modes,
            )
        return True

    def validate_policy(self, policy: RetrievalPolicy) -> PolicyValidationResult:
        """Validate all channel invocations in a retrieval policy.

        Checks every channel_id and query_mode referenced in:
        - initial_channels
        - irs_signal_channel_mapping values

        This is the startup validation gate. If this returns invalid,
        the subsystem must fail closed with DEFER.

        Args:
            policy: The retrieval policy to validate.

        Returns:
            PolicyValidationResult with valid=True if all invocations pass,
            or valid=False with a list of error messages.
        """
        errors: list[str] = []

        # Validate initial channels
        for invocation in policy.initial_channels:
            self._collect_invocation_errors(
                invocation, source="initial_channels", errors=errors
            )

        # Validate IRS signal channel mappings
        for signal_key, invocations in policy.irs_signal_channel_mapping.items():
            for invocation in invocations:
                self._collect_invocation_errors(
                    invocation,
                    source=f"irs_signal_mapping[{signal_key}]",
                    errors=errors,
                )

        return PolicyValidationResult(valid=len(errors) == 0, errors=errors)

    def _collect_invocation_errors(
        self,
        invocation: ChannelInvocation,
        *,
        source: str,
        errors: list[str],
    ) -> None:
        """Collect validation errors for a single invocation without raising."""
        if invocation.channel_id not in self._channels:
            errors.append(
                f"{source}: channel_id '{invocation.channel_id}' "
                f"not found in registry"
            )
        else:
            channel = self._channels[invocation.channel_id]
            if invocation.query_mode not in channel.supported_query_modes:
                errors.append(
                    f"{source}: query_mode '{invocation.query_mode}' "
                    f"not supported by channel '{invocation.channel_id}'. "
                    f"Supported: {channel.supported_query_modes}"
                )


# ---------------------------------------------------------------------------
# RetrievalResult
# ---------------------------------------------------------------------------


@dataclass
class RetrievalResult:
    """Aggregated results from multiple retrieval channel executions.

    Contains all attempt records and a deduplicated list of candidates.
    Candidates are deduplicated by concern_id; contributing_attempt_ids
    from multiple channels are merged.

    Retrieval scores in channel_local_diagnostics remain diagnostic only.
    They never constitute proof of ownership.
    """

    attempts: list[RetrievalAttemptRecord] = field(default_factory=list)
    candidates: list[CandidateRecord] = field(default_factory=list)
    total_latency_ms: int = 0
