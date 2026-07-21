"""Versioned policy and configuration schemas for SIE identity resolution.

This module defines the canonical configuration schemas that govern identity
resolution behavior. All operational parameters — budgets, retries, model
versions, channel plans, and IRS mappings — come from approved versioned
configuration. No behavioral defaults are embedded in code.

Design authority: design-corrections.md §6 and §8.2.

Policy loading hierarchy:
1. Load approved versioned policy from configuration source.
2. Validate all channel IDs and query modes against the channel registry.
3. If validation fails or policy is absent, fail closed with DEFER.

The seven canonical channel families define the full retrieval vocabulary.
IRS-to-channel mappings live exclusively in RetrievalPolicy; example mappings
may exist only in test fixtures or explicit configuration artifacts.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, model_validator

from .enums import IRSSignalType, PipelineOutcome, ResolutionAction


# ---------------------------------------------------------------------------
# Canonical channel families
# ---------------------------------------------------------------------------

CANONICAL_CHANNEL_FAMILIES: frozenset[str] = frozenset(
    {
        "embedding_primary",
        "identity_summary",
        "alias_normalized",
        "lexical_entity",
        "dormant_scan",
        "historical_region",
        "alternate_formulation",
    }
)
"""The seven materially distinct retrieval channel families for identity resolution.

Each family uses different indexed fields, query formulations, temporal/status
scopes, or retrieval mechanisms capable of recovering different candidates.
"""


# ---------------------------------------------------------------------------
# Channel invocation model
# ---------------------------------------------------------------------------


class ChannelInvocation(BaseModel):
    """A single parameterized retrieval channel invocation.

    Attributes:
        channel_id: Registered channel identifier (must exist in registry).
        query_mode: The query mode to use (must be supported by the channel).
        scope_overrides: Channel-specific scope parameters (lifecycle filters,
            temporal bounds, result limits, etc.).
    """

    channel_id: str
    query_mode: str
    scope_overrides: dict[str, Any]


# ---------------------------------------------------------------------------
# Channel family requirement
# ---------------------------------------------------------------------------


class ChannelFamilyRequirement(BaseModel):
    """Policy requirement for a specific channel family's role in adequacy.

    Attributes:
        required_for_adequacy: Whether this family must complete successfully
            for retrieval to be deemed adequate.
        min_successful_attempts: Minimum number of successful attempts required.
        failure_blocks_no_match: Whether a failure in this family blocks a
            NO_MATCH conclusion even if other adequacy criteria pass.
    """

    required_for_adequacy: bool
    min_successful_attempts: int
    failure_blocks_no_match: bool


# ---------------------------------------------------------------------------
# Retrieval policy
# ---------------------------------------------------------------------------


class RetrievalPolicy(BaseModel):
    """Versioned retrieval policy governing channel plans and IRS mappings.

    All IRS-to-channel mappings live here, not in application code.
    At startup, every configured channel_id and query_mode is validated
    against the channel registry.

    Attributes:
        policy_version: Semantic version string for this policy configuration.
        initial_channels: Ordered list of channel invocations for initial retrieval.
        channel_family_requirements: Per-family adequacy requirements.
        irs_signal_channel_mapping: Maps each IRS signal type to the list of
            additional channel invocations to execute when that signal is detected.
    """

    policy_version: str
    initial_channels: list[ChannelInvocation]
    channel_family_requirements: dict[str, ChannelFamilyRequirement]
    irs_signal_channel_mapping: dict[str, list[ChannelInvocation]]

    @model_validator(mode="after")
    def validate_channel_families(self) -> "RetrievalPolicy":
        """Validate that channel family requirements reference canonical families."""
        invalid_families = (
            set(self.channel_family_requirements.keys()) - CANONICAL_CHANNEL_FAMILIES
        )
        if invalid_families:
            raise ValueError(
                f"channel_family_requirements references non-canonical families: "
                f"{sorted(invalid_families)}. "
                f"Valid families: {sorted(CANONICAL_CHANNEL_FAMILIES)}"
            )
        return self

    @model_validator(mode="after")
    def validate_irs_signal_keys(self) -> "RetrievalPolicy":
        """Validate that IRS signal mapping keys are valid IRSSignalType values."""
        valid_signal_values = {s.value for s in IRSSignalType}
        invalid_keys = set(self.irs_signal_channel_mapping.keys()) - valid_signal_values
        if invalid_keys:
            raise ValueError(
                f"irs_signal_channel_mapping contains invalid signal types: "
                f"{sorted(invalid_keys)}. "
                f"Valid types: {sorted(valid_signal_values)}"
            )
        return self


# ---------------------------------------------------------------------------
# Widening budget policy
# ---------------------------------------------------------------------------


class WideningBudgetPolicy(BaseModel):
    """Versioned budget constraints for adaptive widening.

    This is the POLICY schema (approved configuration limits).
    The runtime budget tracker in identity_models.WideningBudget tracks
    consumption against these limits.

    All fields are required — no defaults are permitted for operational budgets.

    Attributes:
        budget_version: Semantic version string for this budget configuration.
        max_widening_rounds: Maximum number of widening iterations permitted.
        max_total_attempts: Maximum total retrieval attempts across all rounds.
        max_latency_ms: Maximum cumulative latency budget in milliseconds.
        max_cost_units: Maximum cost budget in abstract cost units.
    """

    budget_version: str
    max_widening_rounds: int
    max_total_attempts: int
    max_latency_ms: int
    max_cost_units: float


# ---------------------------------------------------------------------------
# Re-evaluation policy
# ---------------------------------------------------------------------------


class ReEvaluationPolicy(BaseModel):
    """Versioned policy governing pending-decision re-evaluation.

    Controls when and how often pending identity decisions may be
    reconsidered based on new evidence or system changes.

    Attributes:
        policy_version: Semantic version string for this policy.
        triggers: List of event types that may trigger re-evaluation
            (e.g., 'new_evidence', 'alias_change', 'graph_repair',
            'merge_event', 'retrieval_improvement', 'manual_review',
            'policy_change').
        max_re_evaluation_attempts: Maximum times a pending decision may
            be re-evaluated before it requires manual intervention.
        cooldown_between_attempts_ms: Minimum time between re-evaluation
            attempts in milliseconds.
    """

    policy_version: str
    triggers: list[str]
    max_re_evaluation_attempts: int
    cooldown_between_attempts_ms: int


# ---------------------------------------------------------------------------
# Identity evaluation config
# ---------------------------------------------------------------------------


class IdentityEvaluationConfig(BaseModel):
    """Versioned configuration for the LLM-backed identity evaluator.

    Controls model selection, retry behavior, token budgets, and prompt
    versioning. All fields are required from approved configuration.

    Attributes:
        config_version: Semantic version string for this configuration.
        primary_model: Model identifier for primary evaluation.
        fallback_model: Model identifier for fallback (None if no fallback).
        output_schema_version: Version of the structured output schema expected.
        max_retries_primary: Max retries on the primary model before fallback.
        max_retries_fallback: Max retries on the fallback model before DEFER.
        retry_backoff_ms: Base backoff duration between retries in milliseconds.
        max_input_tokens: Maximum input token budget per evaluation call.
        max_output_tokens: Maximum output token budget per evaluation call.
        system_prompt_version: Version identifier for the system prompt.
        evaluation_prompt_version: Version identifier for the evaluation prompt.
    """

    config_version: str
    primary_model: str
    fallback_model: str | None
    output_schema_version: str
    max_retries_primary: int
    max_retries_fallback: int
    retry_backoff_ms: int
    max_input_tokens: int
    max_output_tokens: int
    system_prompt_version: str
    evaluation_prompt_version: str


# ---------------------------------------------------------------------------
# Top-level identity resolution policy
# ---------------------------------------------------------------------------


class IdentityResolutionPolicy(BaseModel):
    """Top-level versioned policy composing all identity resolution sub-policies.

    This is the single configuration object that must be loaded and validated
    before identity resolution can proceed. If any sub-policy is missing or
    invalid, the subsystem fails closed with DEFER.

    Attributes:
        policy_version: Semantic version for the composite policy.
        retrieval_policy: Governs channel plans, IRS mappings, and adequacy.
        widening_budget: Governs adaptive widening resource limits.
        pending_re_evaluation_policy: Governs pending decision re-evaluation.
    """

    policy_version: str
    retrieval_policy: RetrievalPolicy
    widening_budget: WideningBudgetPolicy
    pending_re_evaluation_policy: ReEvaluationPolicy


# ---------------------------------------------------------------------------
# Channel registry validation
# ---------------------------------------------------------------------------


class ChannelRegistryEntry(BaseModel):
    """A single entry in the channel registry defining supported query modes.

    Attributes:
        channel_id: Unique identifier for the channel.
        channel_family: Which canonical family this channel belongs to.
        supported_query_modes: Set of query modes this channel supports.
    """

    channel_id: str
    channel_family: str
    supported_query_modes: list[str]

    @model_validator(mode="after")
    def validate_family(self) -> "ChannelRegistryEntry":
        """Validate channel_family is one of the canonical families."""
        if self.channel_family not in CANONICAL_CHANNEL_FAMILIES:
            raise ValueError(
                f"channel_family '{self.channel_family}' is not a canonical family. "
                f"Valid families: {sorted(CANONICAL_CHANNEL_FAMILIES)}"
            )
        return self


# ---------------------------------------------------------------------------
# Policy validation result
# ---------------------------------------------------------------------------


class PolicyValidationResult(BaseModel):
    """Result of policy validation at startup.

    Attributes:
        valid: Whether the policy passed all validation checks.
        errors: List of validation error messages (empty if valid).
    """

    valid: bool
    errors: list[str]


# ---------------------------------------------------------------------------
# Fail-closed validation
# ---------------------------------------------------------------------------


class DeferResult(BaseModel):
    """A fail-closed DEFER result returned when policy is missing or invalid.

    Attributes:
        outcome: Always DEFER.
        action: Always NONE.
        reason: Human-readable explanation of why DEFER was produced.
        validation_errors: Specific validation failures that caused DEFER.
    """

    outcome: PipelineOutcome = PipelineOutcome.DEFER
    action: ResolutionAction = ResolutionAction.NONE
    reason: str
    validation_errors: list[str]


def validate_policy_against_registry(
    policy: IdentityResolutionPolicy,
    registry: list[ChannelRegistryEntry],
) -> PolicyValidationResult:
    """Validate a loaded policy's channel IDs and query modes against the registry.

    Every channel_id referenced in the policy (initial channels and IRS mappings)
    must exist in the registry, and every query_mode must be supported by that
    channel.

    Args:
        policy: The identity resolution policy to validate.
        registry: The channel registry entries defining valid channels/modes.

    Returns:
        PolicyValidationResult indicating whether validation passed and any errors.
    """
    errors: list[str] = []

    # Build lookup from registry
    registry_map: dict[str, ChannelRegistryEntry] = {
        entry.channel_id: entry for entry in registry
    }

    # Collect all channel invocations from the policy
    all_invocations: list[tuple[str, ChannelInvocation]] = []
    for inv in policy.retrieval_policy.initial_channels:
        all_invocations.append(("initial_channels", inv))
    for signal_key, invocations in (
        policy.retrieval_policy.irs_signal_channel_mapping.items()
    ):
        for inv in invocations:
            all_invocations.append((f"irs_signal_mapping[{signal_key}]", inv))

    # Validate each invocation
    for source, invocation in all_invocations:
        if invocation.channel_id not in registry_map:
            errors.append(
                f"{source}: channel_id '{invocation.channel_id}' "
                f"not found in registry"
            )
        else:
            entry = registry_map[invocation.channel_id]
            if invocation.query_mode not in entry.supported_query_modes:
                errors.append(
                    f"{source}: query_mode '{invocation.query_mode}' "
                    f"not supported by channel '{invocation.channel_id}'. "
                    f"Supported: {entry.supported_query_modes}"
                )

    return PolicyValidationResult(valid=len(errors) == 0, errors=errors)


def validate_policy_or_defer(
    policy: IdentityResolutionPolicy | None,
    registry: list[ChannelRegistryEntry],
) -> DeferResult | None:
    """Validate that an approved policy is present and valid; otherwise fail closed.

    This is the top-level startup/request-time check. If the policy is None
    (missing) or fails registry validation, a DeferResult is returned
    indicating the system must not proceed with identity resolution.

    Args:
        policy: The loaded policy, or None if no approved policy is available.
        registry: The channel registry to validate against.

    Returns:
        None if the policy is valid and the system may proceed.
        DeferResult if the policy is missing or invalid (fail-closed DEFER).
    """
    if policy is None:
        return DeferResult(
            reason="No approved identity resolution policy is available. "
            "The subsystem cannot proceed without a valid versioned policy.",
            validation_errors=["Policy is None/missing"],
        )

    result = validate_policy_against_registry(policy, registry)
    if not result.valid:
        return DeferResult(
            reason="Identity resolution policy failed validation against "
            "the channel registry. All configured channel IDs and query modes "
            "must be registered and supported.",
            validation_errors=result.errors,
        )

    return None
