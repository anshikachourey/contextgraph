"""Tests for SIE identity resolution policy schemas.

Validates:
- Canonical channel families definition
- Policy model field requirements (no defaults)
- Channel registry validation against policy
- Fail-closed DEFER when policy is missing or invalid
- IRS signal mapping validation
- Channel family requirement validation
"""

import pytest
from pydantic import ValidationError

from app.sie.identity_policy import (
    CANONICAL_CHANNEL_FAMILIES,
    ChannelFamilyRequirement,
    ChannelInvocation,
    ChannelRegistryEntry,
    DeferResult,
    IdentityEvaluationConfig,
    IdentityResolutionPolicy,
    PolicyValidationResult,
    ReEvaluationPolicy,
    RetrievalPolicy,
    WideningBudgetPolicy,
    validate_policy_against_registry,
    validate_policy_or_defer,
)
from app.sie.enums import PipelineOutcome, ResolutionAction


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_registry() -> list[ChannelRegistryEntry]:
    """Create a minimal valid channel registry for testing."""
    return [
        ChannelRegistryEntry(
            channel_id="emb_broad",
            channel_family="embedding_primary",
            supported_query_modes=["broad", "narrow"],
        ),
        ChannelRegistryEntry(
            channel_id="ids_search",
            channel_family="identity_summary",
            supported_query_modes=["exact", "fuzzy"],
        ),
        ChannelRegistryEntry(
            channel_id="alias_lookup",
            channel_family="alias_normalized",
            supported_query_modes=["normalized"],
        ),
        ChannelRegistryEntry(
            channel_id="lex_entity",
            channel_family="lexical_entity",
            supported_query_modes=["entity_match"],
        ),
        ChannelRegistryEntry(
            channel_id="dormant_ch",
            channel_family="dormant_scan",
            supported_query_modes=["full_scan"],
        ),
        ChannelRegistryEntry(
            channel_id="hist_region",
            channel_family="historical_region",
            supported_query_modes=["region_search"],
        ),
        ChannelRegistryEntry(
            channel_id="alt_form",
            channel_family="alternate_formulation",
            supported_query_modes=["reformulate"],
        ),
    ]


def _make_retrieval_policy() -> RetrievalPolicy:
    """Create a minimal valid RetrievalPolicy for testing."""
    return RetrievalPolicy(
        policy_version="1.0.0",
        initial_channels=[
            ChannelInvocation(
                channel_id="emb_broad",
                query_mode="broad",
                scope_overrides={"top_k": 10},
            ),
            ChannelInvocation(
                channel_id="ids_search",
                query_mode="exact",
                scope_overrides={},
            ),
        ],
        channel_family_requirements={
            "embedding_primary": ChannelFamilyRequirement(
                required_for_adequacy=True,
                min_successful_attempts=1,
                failure_blocks_no_match=True,
            ),
            "identity_summary": ChannelFamilyRequirement(
                required_for_adequacy=True,
                min_successful_attempts=1,
                failure_blocks_no_match=False,
            ),
        },
        irs_signal_channel_mapping={
            "ALIAS_OR_VOCABULARY_DRIFT": [
                ChannelInvocation(
                    channel_id="alias_lookup",
                    query_mode="normalized",
                    scope_overrides={},
                ),
                ChannelInvocation(
                    channel_id="alt_form",
                    query_mode="reformulate",
                    scope_overrides={},
                ),
            ],
            "HISTORICAL_REFERENT": [
                ChannelInvocation(
                    channel_id="hist_region",
                    query_mode="region_search",
                    scope_overrides={"lookback_messages": 50},
                ),
            ],
        },
    )


def _make_widening_budget() -> WideningBudgetPolicy:
    """Create a minimal valid WideningBudgetPolicy."""
    return WideningBudgetPolicy(
        budget_version="1.0.0",
        max_widening_rounds=3,
        max_total_attempts=12,
        max_latency_ms=5000,
        max_cost_units=1.5,
    )


def _make_re_evaluation_policy() -> ReEvaluationPolicy:
    """Create a minimal valid ReEvaluationPolicy."""
    return ReEvaluationPolicy(
        policy_version="1.0.0",
        triggers=["new_evidence", "alias_change", "graph_repair"],
        max_re_evaluation_attempts=3,
        cooldown_between_attempts_ms=60000,
    )


def _make_full_policy() -> IdentityResolutionPolicy:
    """Create a fully valid IdentityResolutionPolicy."""
    return IdentityResolutionPolicy(
        policy_version="1.0.0",
        retrieval_policy=_make_retrieval_policy(),
        widening_budget=_make_widening_budget(),
        pending_re_evaluation_policy=_make_re_evaluation_policy(),
        permitted_embedding_model_versions=["v1.0"],
    )


def _make_evaluation_config() -> IdentityEvaluationConfig:
    """Create a valid IdentityEvaluationConfig."""
    return IdentityEvaluationConfig(
        config_version="1.0.0",
        primary_model="claude-sonnet-4-20250514",
        fallback_model="claude-haiku-4-20250514",
        output_schema_version="1.0.0",
        max_retries_primary=2,
        max_retries_fallback=1,
        retry_backoff_ms=500,
        max_input_tokens=8000,
        max_output_tokens=2000,
        system_prompt_version="1.0.0",
        evaluation_prompt_version="1.0.0",
    )


# ---------------------------------------------------------------------------
# Test: Canonical channel families
# ---------------------------------------------------------------------------


class TestCanonicalChannelFamilies:
    """Test the CANONICAL_CHANNEL_FAMILIES frozenset."""

    def test_contains_exactly_seven_families(self) -> None:
        assert len(CANONICAL_CHANNEL_FAMILIES) == 7

    def test_contains_all_expected_families(self) -> None:
        expected = {
            "embedding_primary",
            "identity_summary",
            "alias_normalized",
            "lexical_entity",
            "dormant_scan",
            "historical_region",
            "alternate_formulation",
        }
        assert CANONICAL_CHANNEL_FAMILIES == expected

    def test_is_frozenset(self) -> None:
        assert isinstance(CANONICAL_CHANNEL_FAMILIES, frozenset)

    def test_immutable(self) -> None:
        with pytest.raises(AttributeError):
            CANONICAL_CHANNEL_FAMILIES.add("rogue_channel")  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Test: ChannelInvocation
# ---------------------------------------------------------------------------


class TestChannelInvocation:
    """Test ChannelInvocation model."""

    def test_valid_creation(self) -> None:
        inv = ChannelInvocation(
            channel_id="emb_broad",
            query_mode="broad",
            scope_overrides={"top_k": 10, "threshold": 0.7},
        )
        assert inv.channel_id == "emb_broad"
        assert inv.query_mode == "broad"
        assert inv.scope_overrides == {"top_k": 10, "threshold": 0.7}

    def test_empty_scope_overrides(self) -> None:
        inv = ChannelInvocation(
            channel_id="ch1", query_mode="mode1", scope_overrides={}
        )
        assert inv.scope_overrides == {}

    def test_missing_channel_id_raises(self) -> None:
        with pytest.raises(ValidationError):
            ChannelInvocation(query_mode="broad", scope_overrides={})  # type: ignore[call-arg]

    def test_missing_query_mode_raises(self) -> None:
        with pytest.raises(ValidationError):
            ChannelInvocation(channel_id="ch1", scope_overrides={})  # type: ignore[call-arg]

    def test_missing_scope_overrides_raises(self) -> None:
        with pytest.raises(ValidationError):
            ChannelInvocation(channel_id="ch1", query_mode="broad")  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Test: ChannelFamilyRequirement
# ---------------------------------------------------------------------------


class TestChannelFamilyRequirement:
    """Test ChannelFamilyRequirement model."""

    def test_valid_creation(self) -> None:
        req = ChannelFamilyRequirement(
            required_for_adequacy=True,
            min_successful_attempts=2,
            failure_blocks_no_match=True,
        )
        assert req.required_for_adequacy is True
        assert req.min_successful_attempts == 2
        assert req.failure_blocks_no_match is True

    def test_all_fields_required(self) -> None:
        with pytest.raises(ValidationError):
            ChannelFamilyRequirement(required_for_adequacy=True)  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Test: RetrievalPolicy
# ---------------------------------------------------------------------------


class TestRetrievalPolicy:
    """Test RetrievalPolicy model and validators."""

    def test_valid_creation(self) -> None:
        policy = _make_retrieval_policy()
        assert policy.policy_version == "1.0.0"
        assert len(policy.initial_channels) == 2
        assert len(policy.irs_signal_channel_mapping) == 2

    def test_all_fields_required(self) -> None:
        with pytest.raises(ValidationError):
            RetrievalPolicy(policy_version="1.0.0")  # type: ignore[call-arg]

    def test_rejects_non_canonical_channel_family(self) -> None:
        with pytest.raises(ValidationError, match="non-canonical families"):
            RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[],
                channel_family_requirements={
                    "rogue_family": ChannelFamilyRequirement(
                        required_for_adequacy=True,
                        min_successful_attempts=1,
                        failure_blocks_no_match=True,
                    )
                },
                irs_signal_channel_mapping={},
            )

    def test_accepts_all_canonical_families(self) -> None:
        requirements = {
            fam: ChannelFamilyRequirement(
                required_for_adequacy=True,
                min_successful_attempts=1,
                failure_blocks_no_match=False,
            )
            for fam in CANONICAL_CHANNEL_FAMILIES
        }
        policy = RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[],
            channel_family_requirements=requirements,
            irs_signal_channel_mapping={},
        )
        assert len(policy.channel_family_requirements) == 7

    def test_rejects_invalid_irs_signal_key(self) -> None:
        with pytest.raises(ValidationError, match="invalid signal types"):
            RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[],
                channel_family_requirements={},
                irs_signal_channel_mapping={
                    "MADE_UP_SIGNAL": [
                        ChannelInvocation(
                            channel_id="ch1",
                            query_mode="mode1",
                            scope_overrides={},
                        )
                    ]
                },
            )

    def test_accepts_valid_irs_signal_keys(self) -> None:
        policy = RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[],
            channel_family_requirements={},
            irs_signal_channel_mapping={
                "REVISIT_LANGUAGE": [],
                "HISTORICAL_REFERENT": [],
                "IMPLIED_PRIOR_STATE": [],
                "BROAD_CANDIDATE_MISMATCH": [],
                "ALIAS_OR_VOCABULARY_DRIFT": [],
                "CONTINUATION_HISTORY_MISMATCH": [],
            },
        )
        assert len(policy.irs_signal_channel_mapping) == 6


# ---------------------------------------------------------------------------
# Test: WideningBudgetPolicy
# ---------------------------------------------------------------------------


class TestWideningBudgetPolicy:
    """Test WideningBudgetPolicy model."""

    def test_valid_creation(self) -> None:
        budget = _make_widening_budget()
        assert budget.budget_version == "1.0.0"
        assert budget.max_widening_rounds == 3
        assert budget.max_total_attempts == 12
        assert budget.max_latency_ms == 5000
        assert budget.max_cost_units == 1.5

    def test_all_fields_required(self) -> None:
        with pytest.raises(ValidationError):
            WideningBudgetPolicy(budget_version="1.0.0")  # type: ignore[call-arg]

    def test_no_default_for_max_rounds(self) -> None:
        with pytest.raises(ValidationError):
            WideningBudgetPolicy(
                budget_version="1.0.0",
                max_total_attempts=10,
                max_latency_ms=3000,
                max_cost_units=1.0,
            )  # type: ignore[call-arg]

    def test_no_default_for_max_cost(self) -> None:
        with pytest.raises(ValidationError):
            WideningBudgetPolicy(
                budget_version="1.0.0",
                max_widening_rounds=3,
                max_total_attempts=10,
                max_latency_ms=3000,
            )  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Test: ReEvaluationPolicy
# ---------------------------------------------------------------------------


class TestReEvaluationPolicy:
    """Test ReEvaluationPolicy model."""

    def test_valid_creation(self) -> None:
        policy = _make_re_evaluation_policy()
        assert policy.policy_version == "1.0.0"
        assert "new_evidence" in policy.triggers
        assert policy.max_re_evaluation_attempts == 3
        assert policy.cooldown_between_attempts_ms == 60000

    def test_all_fields_required(self) -> None:
        with pytest.raises(ValidationError):
            ReEvaluationPolicy(policy_version="1.0.0")  # type: ignore[call-arg]

    def test_empty_triggers_allowed(self) -> None:
        policy = ReEvaluationPolicy(
            policy_version="1.0.0",
            triggers=[],
            max_re_evaluation_attempts=0,
            cooldown_between_attempts_ms=0,
        )
        assert policy.triggers == []


# ---------------------------------------------------------------------------
# Test: IdentityEvaluationConfig
# ---------------------------------------------------------------------------


class TestIdentityEvaluationConfig:
    """Test IdentityEvaluationConfig model."""

    def test_valid_creation(self) -> None:
        config = _make_evaluation_config()
        assert config.config_version == "1.0.0"
        assert config.primary_model == "claude-sonnet-4-20250514"
        assert config.fallback_model == "claude-haiku-4-20250514"
        assert config.max_retries_primary == 2

    def test_fallback_model_can_be_none(self) -> None:
        config = IdentityEvaluationConfig(
            config_version="1.0.0",
            primary_model="model-a",
            fallback_model=None,
            output_schema_version="1.0.0",
            max_retries_primary=3,
            max_retries_fallback=0,
            retry_backoff_ms=1000,
            max_input_tokens=4000,
            max_output_tokens=1000,
            system_prompt_version="1.0.0",
            evaluation_prompt_version="1.0.0",
        )
        assert config.fallback_model is None

    def test_all_fields_required_except_fallback(self) -> None:
        with pytest.raises(ValidationError):
            IdentityEvaluationConfig(
                config_version="1.0.0",
                primary_model="model-a",
            )  # type: ignore[call-arg]

    def test_no_default_for_retry_backoff(self) -> None:
        with pytest.raises(ValidationError):
            IdentityEvaluationConfig(
                config_version="1.0.0",
                primary_model="model-a",
                fallback_model=None,
                output_schema_version="1.0.0",
                max_retries_primary=3,
                max_retries_fallback=0,
                max_input_tokens=4000,
                max_output_tokens=1000,
                system_prompt_version="1.0.0",
                evaluation_prompt_version="1.0.0",
            )  # type: ignore[call-arg]

    def test_no_default_for_token_limits(self) -> None:
        with pytest.raises(ValidationError):
            IdentityEvaluationConfig(
                config_version="1.0.0",
                primary_model="model-a",
                fallback_model=None,
                output_schema_version="1.0.0",
                max_retries_primary=3,
                max_retries_fallback=0,
                retry_backoff_ms=1000,
                system_prompt_version="1.0.0",
                evaluation_prompt_version="1.0.0",
            )  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Test: IdentityResolutionPolicy (top-level)
# ---------------------------------------------------------------------------


class TestIdentityResolutionPolicy:
    """Test the top-level IdentityResolutionPolicy composition."""

    def test_valid_creation(self) -> None:
        policy = _make_full_policy()
        assert policy.policy_version == "1.0.0"
        assert isinstance(policy.retrieval_policy, RetrievalPolicy)
        assert isinstance(policy.widening_budget, WideningBudgetPolicy)
        assert isinstance(policy.pending_re_evaluation_policy, ReEvaluationPolicy)

    def test_all_sub_policies_required(self) -> None:
        with pytest.raises(ValidationError):
            IdentityResolutionPolicy(
                policy_version="1.0.0",
                retrieval_policy=_make_retrieval_policy(),
            )  # type: ignore[call-arg]

    def test_serialization_roundtrip(self) -> None:
        policy = _make_full_policy()
        data = policy.model_dump()
        restored = IdentityResolutionPolicy.model_validate(data)
        assert restored == policy

    def test_json_roundtrip(self) -> None:
        policy = _make_full_policy()
        json_str = policy.model_dump_json()
        restored = IdentityResolutionPolicy.model_validate_json(json_str)
        assert restored == policy


# ---------------------------------------------------------------------------
# Test: ChannelRegistryEntry
# ---------------------------------------------------------------------------


class TestChannelRegistryEntry:
    """Test ChannelRegistryEntry model."""

    def test_valid_creation(self) -> None:
        entry = ChannelRegistryEntry(
            channel_id="emb_broad",
            channel_family="embedding_primary",
            supported_query_modes=["broad", "narrow"],
        )
        assert entry.channel_id == "emb_broad"
        assert entry.channel_family == "embedding_primary"

    def test_rejects_non_canonical_family(self) -> None:
        with pytest.raises(ValidationError, match="not a canonical family"):
            ChannelRegistryEntry(
                channel_id="ch1",
                channel_family="made_up_family",
                supported_query_modes=["mode1"],
            )


# ---------------------------------------------------------------------------
# Test: validate_policy_against_registry
# ---------------------------------------------------------------------------


class TestValidatePolicyAgainstRegistry:
    """Test channel/mode validation against the registry."""

    def test_valid_policy_passes(self) -> None:
        policy = _make_full_policy()
        registry = _make_registry()
        result = validate_policy_against_registry(policy, registry)
        assert result.valid is True
        assert result.errors == []

    def test_unknown_channel_id_fails(self) -> None:
        policy = IdentityResolutionPolicy(
            policy_version="1.0.0",
            retrieval_policy=RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[
                    ChannelInvocation(
                        channel_id="nonexistent_channel",
                        query_mode="broad",
                        scope_overrides={},
                    )
                ],
                channel_family_requirements={},
                irs_signal_channel_mapping={},
            ),
            widening_budget=_make_widening_budget(),
            pending_re_evaluation_policy=_make_re_evaluation_policy(),
            permitted_embedding_model_versions=["v1.0"],
        )
        registry = _make_registry()
        result = validate_policy_against_registry(policy, registry)
        assert result.valid is False
        assert any("nonexistent_channel" in e for e in result.errors)

    def test_unsupported_query_mode_fails(self) -> None:
        policy = IdentityResolutionPolicy(
            policy_version="1.0.0",
            retrieval_policy=RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[
                    ChannelInvocation(
                        channel_id="emb_broad",
                        query_mode="unsupported_mode",
                        scope_overrides={},
                    )
                ],
                channel_family_requirements={},
                irs_signal_channel_mapping={},
            ),
            widening_budget=_make_widening_budget(),
            pending_re_evaluation_policy=_make_re_evaluation_policy(),
            permitted_embedding_model_versions=["v1.0"],
        )
        registry = _make_registry()
        result = validate_policy_against_registry(policy, registry)
        assert result.valid is False
        assert any("unsupported_mode" in e for e in result.errors)

    def test_invalid_channel_in_irs_mapping_fails(self) -> None:
        policy = IdentityResolutionPolicy(
            policy_version="1.0.0",
            retrieval_policy=RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[],
                channel_family_requirements={},
                irs_signal_channel_mapping={
                    "REVISIT_LANGUAGE": [
                        ChannelInvocation(
                            channel_id="ghost_channel",
                            query_mode="mode1",
                            scope_overrides={},
                        )
                    ]
                },
            ),
            widening_budget=_make_widening_budget(),
            pending_re_evaluation_policy=_make_re_evaluation_policy(),
            permitted_embedding_model_versions=["v1.0"],
        )
        registry = _make_registry()
        result = validate_policy_against_registry(policy, registry)
        assert result.valid is False
        assert any("ghost_channel" in e for e in result.errors)

    def test_empty_policy_passes(self) -> None:
        """A policy with no invocations is valid (nothing to validate)."""
        policy = IdentityResolutionPolicy(
            policy_version="1.0.0",
            retrieval_policy=RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[],
                channel_family_requirements={},
                irs_signal_channel_mapping={},
            ),
            widening_budget=_make_widening_budget(),
            pending_re_evaluation_policy=_make_re_evaluation_policy(),
            permitted_embedding_model_versions=["v1.0"],
        )
        registry = _make_registry()
        result = validate_policy_against_registry(policy, registry)
        assert result.valid is True


# ---------------------------------------------------------------------------
# Test: validate_policy_or_defer (fail-closed behavior)
# ---------------------------------------------------------------------------


class TestValidatePolicyOrDefer:
    """Test fail-closed DEFER behavior."""

    def test_valid_policy_returns_none(self) -> None:
        policy = _make_full_policy()
        registry = _make_registry()
        result = validate_policy_or_defer(policy, registry)
        assert result is None

    def test_none_policy_returns_defer(self) -> None:
        registry = _make_registry()
        result = validate_policy_or_defer(None, registry)
        assert result is not None
        assert isinstance(result, DeferResult)
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert "None/missing" in result.validation_errors[0]

    def test_invalid_policy_returns_defer(self) -> None:
        policy = IdentityResolutionPolicy(
            policy_version="1.0.0",
            retrieval_policy=RetrievalPolicy(
                policy_version="1.0.0",
                initial_channels=[
                    ChannelInvocation(
                        channel_id="bad_channel",
                        query_mode="bad_mode",
                        scope_overrides={},
                    )
                ],
                channel_family_requirements={},
                irs_signal_channel_mapping={},
            ),
            widening_budget=_make_widening_budget(),
            pending_re_evaluation_policy=_make_re_evaluation_policy(),
            permitted_embedding_model_versions=["v1.0"],
        )
        registry = _make_registry()
        result = validate_policy_or_defer(policy, registry)
        assert result is not None
        assert isinstance(result, DeferResult)
        assert result.outcome == PipelineOutcome.DEFER
        assert result.action == ResolutionAction.NONE
        assert len(result.validation_errors) > 0

    def test_defer_result_contains_reason(self) -> None:
        result = validate_policy_or_defer(None, _make_registry())
        assert result is not None
        assert "policy" in result.reason.lower()


# ---------------------------------------------------------------------------
# Test: DeferResult model
# ---------------------------------------------------------------------------


class TestDeferResult:
    """Test DeferResult model invariants."""

    def test_outcome_is_always_defer(self) -> None:
        result = DeferResult(
            reason="Test reason", validation_errors=["error1"]
        )
        assert result.outcome == PipelineOutcome.DEFER

    def test_action_is_always_none(self) -> None:
        result = DeferResult(
            reason="Test reason", validation_errors=["error1"]
        )
        assert result.action == ResolutionAction.NONE
