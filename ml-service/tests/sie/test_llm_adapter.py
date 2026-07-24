"""Tests for the provider-neutral structured LLM adapter.

Verifies:
- Successful invocation returns structured output.
- Primary retry on failure before attempting fallback.
- Fallback invocation after primary exhaustion.
- Total exhaustion returns failure (never fabricates a result).
- All invocation records preserved across attempts.
- DeterministicFakeAdapter behavior (ordering, recording, exhaustion).
"""

from __future__ import annotations

import pytest

from app.sie.evaluator.llm_adapter import (
    BoundedInvocationResult,
    BoundedLLMInvoker,
    DeterministicFakeAdapter,
    LLMAdapterResult,
    LLMInvocationRecord,
    StructuredLLMAdapter,
)
from app.sie.identity_policy import IdentityEvaluationConfig


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_config(
    max_retries_primary: int = 3,
    max_retries_fallback: int = 2,
    primary_model: str = "test-primary-model",
    fallback_model: str | None = "test-fallback-model",
) -> IdentityEvaluationConfig:
    """Create a minimal valid IdentityEvaluationConfig for tests."""
    return IdentityEvaluationConfig(
        config_version="1.0.0",
        primary_model=primary_model,
        fallback_model=fallback_model,
        output_schema_version="1.0.0",
        max_retries_primary=max_retries_primary,
        max_retries_fallback=max_retries_fallback,
        retry_backoff_ms=1,  # minimal for fast tests
        max_input_tokens=4096,
        max_output_tokens=1024,
        system_prompt_version="1.0.0",
        evaluation_prompt_version="1.0.0",
    )


def _success_result(output: dict | None = None) -> LLMAdapterResult:
    """Create a successful LLMAdapterResult."""
    return LLMAdapterResult(
        raw_output=output or {"match": True, "confidence": "HIGH"},
        success=True,
        failure_reason=None,
        tokens_used=150,
        latency_ms=50,
    )


def _failure_result(reason: str = "model error") -> LLMAdapterResult:
    """Create a failed LLMAdapterResult."""
    return LLMAdapterResult(
        raw_output=None,
        success=False,
        failure_reason=reason,
        tokens_used=0,
        latency_ms=10,
    )


_TEST_SYSTEM_PROMPT = "You are an identity evaluator."
_TEST_USER_PROMPT = "Evaluate this candidate."
_TEST_SCHEMA = {"type": "object", "properties": {"match": {"type": "boolean"}}}


# ---------------------------------------------------------------------------
# Tests: Successful invocation
# ---------------------------------------------------------------------------


class TestSuccessfulInvocation:
    """Tests for successful LLM invocation returning structured output."""

    @pytest.mark.asyncio
    async def test_first_attempt_success_returns_output(self) -> None:
        """Primary succeeds on first attempt, returns structured output."""
        config = _make_config()
        primary = DeterministicFakeAdapter([_success_result()])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is True
        assert result.output == {"match": True, "confidence": "HIGH"}
        assert result.model_used == "test-primary-model"
        assert result.failure_reason is None
        assert result.total_attempts == 1
        assert len(result.invocation_records) == 1

    @pytest.mark.asyncio
    async def test_success_record_has_correct_metadata(self) -> None:
        """Successful invocation record contains correct model/version metadata."""
        config = _make_config()
        primary = DeterministicFakeAdapter([_success_result()])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        record = result.invocation_records[0]
        assert record.model == "test-primary-model"
        assert record.prompt_version == "1.0.0"
        assert record.schema_version == "1.0.0"
        assert record.success is True
        assert record.structured_output_valid is True
        assert record.grounding_valid is True
        assert record.failure_reason is None
        assert record.attempt_number == 1

    @pytest.mark.asyncio
    async def test_success_records_tokens_and_latency(self) -> None:
        """Successful invocation records token usage and latency."""
        config = _make_config()
        primary = DeterministicFakeAdapter([_success_result()])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        record = result.invocation_records[0]
        # tokens_used=150 split approximately as input/output
        assert record.input_tokens + record.output_tokens == 150
        assert record.latency_ms == 50


# ---------------------------------------------------------------------------
# Tests: Primary retry on failure
# ---------------------------------------------------------------------------


class TestPrimaryRetry:
    """Tests for retry behavior on the primary adapter."""

    @pytest.mark.asyncio
    async def test_retries_on_failure_then_succeeds(self) -> None:
        """Primary fails first, succeeds on retry."""
        config = _make_config(max_retries_primary=3)
        primary = DeterministicFakeAdapter([
            _failure_result("transient error"),
            _success_result(),
        ])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is True
        assert result.total_attempts == 2
        assert result.model_used == "test-primary-model"
        assert len(result.invocation_records) == 2
        assert result.invocation_records[0].success is False
        assert result.invocation_records[1].success is True

    @pytest.mark.asyncio
    async def test_multiple_retries_before_success(self) -> None:
        """Primary fails twice, succeeds on third attempt."""
        config = _make_config(max_retries_primary=3)
        primary = DeterministicFakeAdapter([
            _failure_result("error 1"),
            _failure_result("error 2"),
            _success_result(),
        ])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is True
        assert result.total_attempts == 3
        assert len(result.invocation_records) == 3

    @pytest.mark.asyncio
    async def test_attempt_numbers_are_sequential(self) -> None:
        """Attempt numbers are 1-based and sequential across retries."""
        config = _make_config(max_retries_primary=3)
        primary = DeterministicFakeAdapter([
            _failure_result(),
            _failure_result(),
            _success_result(),
        ])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        for i, record in enumerate(result.invocation_records):
            assert record.attempt_number == i + 1

    @pytest.mark.asyncio
    async def test_failure_records_have_correct_metadata(self) -> None:
        """Failed attempt records have failure_reason and structured_output_valid=False."""
        config = _make_config(max_retries_primary=2)
        primary = DeterministicFakeAdapter([
            _failure_result("schema validation failed"),
            _success_result(),
        ])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        failed_record = result.invocation_records[0]
        assert failed_record.success is False
        assert failed_record.structured_output_valid is False
        assert failed_record.failure_reason == "schema validation failed"


# ---------------------------------------------------------------------------
# Tests: Fallback invocation after primary exhaustion
# ---------------------------------------------------------------------------


class TestFallbackInvocation:
    """Tests for fallback adapter invocation after primary exhaustion."""

    @pytest.mark.asyncio
    async def test_fallback_invoked_after_primary_exhaustion(self) -> None:
        """Fallback is tried after primary exhausts all retries."""
        config = _make_config(max_retries_primary=2, max_retries_fallback=2)
        primary = DeterministicFakeAdapter([
            _failure_result("primary error 1"),
            _failure_result("primary error 2"),
        ])
        fallback = DeterministicFakeAdapter([_success_result()])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is True
        assert result.model_used == "test-fallback-model"
        assert result.total_attempts == 3  # 2 primary + 1 fallback
        assert len(result.invocation_records) == 3
        assert primary.call_count == 2
        assert fallback.call_count == 1

    @pytest.mark.asyncio
    async def test_fallback_records_use_fallback_model(self) -> None:
        """Fallback invocation records use the fallback model identifier."""
        config = _make_config(max_retries_primary=1, max_retries_fallback=2)
        primary = DeterministicFakeAdapter([_failure_result()])
        fallback = DeterministicFakeAdapter([_success_result()])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        fallback_record = result.invocation_records[1]
        assert fallback_record.model == "test-fallback-model"

    @pytest.mark.asyncio
    async def test_fallback_retries_on_failure(self) -> None:
        """Fallback adapter also retries on failure."""
        config = _make_config(max_retries_primary=1, max_retries_fallback=3)
        primary = DeterministicFakeAdapter([_failure_result()])
        fallback = DeterministicFakeAdapter([
            _failure_result("fallback error 1"),
            _success_result(),
        ])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is True
        assert result.model_used == "test-fallback-model"
        assert result.total_attempts == 3  # 1 primary + 2 fallback
        assert fallback.call_count == 2

    @pytest.mark.asyncio
    async def test_no_fallback_when_primary_succeeds(self) -> None:
        """Fallback is never invoked if primary succeeds."""
        config = _make_config(max_retries_primary=3, max_retries_fallback=2)
        primary = DeterministicFakeAdapter([_success_result()])
        fallback = DeterministicFakeAdapter([_success_result()])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is True
        assert result.model_used == "test-primary-model"
        assert fallback.call_count == 0

    @pytest.mark.asyncio
    async def test_no_fallback_when_fallback_model_is_none(self) -> None:
        """No fallback attempted when config.fallback_model is None."""
        config = _make_config(
            max_retries_primary=1, max_retries_fallback=2, fallback_model=None
        )
        primary = DeterministicFakeAdapter([_failure_result()])
        fallback = DeterministicFakeAdapter([_success_result()])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        # Fallback adapter exists but config says no fallback model
        assert result.success is False
        assert fallback.call_count == 0


# ---------------------------------------------------------------------------
# Tests: Total exhaustion returns failure
# ---------------------------------------------------------------------------


class TestTotalExhaustion:
    """Tests verifying total exhaustion returns failure, never a fake result."""

    @pytest.mark.asyncio
    async def test_total_exhaustion_returns_failure(self) -> None:
        """All attempts exhausted returns failure with no output."""
        config = _make_config(max_retries_primary=2, max_retries_fallback=2)
        primary = DeterministicFakeAdapter([
            _failure_result("primary error 1"),
            _failure_result("primary error 2"),
        ])
        fallback = DeterministicFakeAdapter([
            _failure_result("fallback error 1"),
            _failure_result("fallback error 2"),
        ])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is False
        assert result.output is None
        assert result.model_used is None
        assert result.failure_reason is not None
        assert "exhausted" in result.failure_reason.lower()
        assert result.total_attempts == 4  # 2 primary + 2 fallback

    @pytest.mark.asyncio
    async def test_exhaustion_without_fallback(self) -> None:
        """Primary exhaustion with no fallback returns failure."""
        config = _make_config(max_retries_primary=2, fallback_model=None)
        primary = DeterministicFakeAdapter([
            _failure_result("error 1"),
            _failure_result("error 2"),
        ])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is False
        assert result.output is None
        assert result.model_used is None
        assert result.total_attempts == 2

    @pytest.mark.asyncio
    async def test_exhaustion_never_fabricates_output(self) -> None:
        """On total failure, output is always None — never a fabricated dict."""
        config = _make_config(max_retries_primary=1, max_retries_fallback=1)
        primary = DeterministicFakeAdapter([_failure_result()])
        fallback = DeterministicFakeAdapter([_failure_result()])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is False
        assert result.output is None
        # Verify no LOW confidence, NO_MATCH, or novelty fabrication
        assert result.failure_reason is not None
        assert "LOW" not in (result.failure_reason or "")

    @pytest.mark.asyncio
    async def test_exhaustion_failure_reason_mentions_attempt_counts(self) -> None:
        """Failure reason includes primary and fallback attempt counts."""
        config = _make_config(max_retries_primary=3, max_retries_fallback=2)
        primary = DeterministicFakeAdapter([
            _failure_result(), _failure_result(), _failure_result()
        ])
        fallback = DeterministicFakeAdapter([_failure_result(), _failure_result()])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert "5" in result.failure_reason  # total attempts
        assert "primary" in result.failure_reason.lower()
        assert "fallback" in result.failure_reason.lower()


# ---------------------------------------------------------------------------
# Tests: Invocation records preserved
# ---------------------------------------------------------------------------


class TestInvocationRecordsPreserved:
    """Tests verifying all invocation records are preserved."""

    @pytest.mark.asyncio
    async def test_all_records_preserved_on_success(self) -> None:
        """Even on eventual success, all prior failure records are kept."""
        config = _make_config(max_retries_primary=3)
        primary = DeterministicFakeAdapter([
            _failure_result("error 1"),
            _failure_result("error 2"),
            _success_result(),
        ])
        invoker = BoundedLLMInvoker(primary, None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert len(result.invocation_records) == 3
        assert result.invocation_records[0].success is False
        assert result.invocation_records[1].success is False
        assert result.invocation_records[2].success is True

    @pytest.mark.asyncio
    async def test_all_records_preserved_on_total_failure(self) -> None:
        """On total exhaustion, all attempt records are preserved."""
        config = _make_config(max_retries_primary=2, max_retries_fallback=1)
        primary = DeterministicFakeAdapter([_failure_result(), _failure_result()])
        fallback = DeterministicFakeAdapter([_failure_result()])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert len(result.invocation_records) == 3
        assert all(not r.success for r in result.invocation_records)

    @pytest.mark.asyncio
    async def test_records_include_both_primary_and_fallback_models(self) -> None:
        """Records clearly distinguish primary and fallback model attempts."""
        config = _make_config(max_retries_primary=1, max_retries_fallback=1)
        primary = DeterministicFakeAdapter([_failure_result()])
        fallback = DeterministicFakeAdapter([_success_result()])
        invoker = BoundedLLMInvoker(primary, fallback, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.invocation_records[0].model == "test-primary-model"
        assert result.invocation_records[1].model == "test-fallback-model"

    @pytest.mark.asyncio
    async def test_exception_handling_records_failure(self) -> None:
        """Adapter exceptions are caught and recorded as failed attempts."""
        config = _make_config(max_retries_primary=2, fallback_model=None)

        class ExplodingAdapter:
            async def invoke(self, system_prompt, user_prompt, output_schema, config):
                raise ConnectionError("network down")

        invoker = BoundedLLMInvoker(ExplodingAdapter(), None, config)

        result = await invoker.invoke_with_retry(
            _TEST_SYSTEM_PROMPT, _TEST_USER_PROMPT, _TEST_SCHEMA
        )

        assert result.success is False
        assert result.total_attempts == 2
        assert len(result.invocation_records) == 2
        for record in result.invocation_records:
            assert record.success is False
            assert "ConnectionError" in record.failure_reason
            assert "network down" in record.failure_reason


# ---------------------------------------------------------------------------
# Tests: DeterministicFakeAdapter behavior
# ---------------------------------------------------------------------------


class TestDeterministicFakeAdapter:
    """Tests for the DeterministicFakeAdapter test utility."""

    @pytest.mark.asyncio
    async def test_returns_responses_in_order(self) -> None:
        """Responses are returned in the order provided."""
        config = _make_config()
        responses = [
            _failure_result("first"),
            _success_result({"attempt": 2}),
        ]
        adapter = DeterministicFakeAdapter(responses)

        r1 = await adapter.invoke("sys", "user", {}, config)
        r2 = await adapter.invoke("sys", "user", {}, config)

        assert r1.success is False
        assert r1.failure_reason == "first"
        assert r2.success is True
        assert r2.raw_output == {"attempt": 2}

    @pytest.mark.asyncio
    async def test_records_all_calls(self) -> None:
        """All invocation calls are recorded with correct arguments."""
        config = _make_config()
        adapter = DeterministicFakeAdapter([_success_result(), _success_result()])

        await adapter.invoke("system1", "user1", {"schema": 1}, config)
        await adapter.invoke("system2", "user2", {"schema": 2}, config)

        assert adapter.call_count == 2
        assert adapter.calls[0].system_prompt == "system1"
        assert adapter.calls[0].user_prompt == "user1"
        assert adapter.calls[0].output_schema == {"schema": 1}
        assert adapter.calls[1].system_prompt == "system2"
        assert adapter.calls[1].user_prompt == "user2"
        assert adapter.calls[1].output_schema == {"schema": 2}

    @pytest.mark.asyncio
    async def test_raises_on_exhausted_responses(self) -> None:
        """Raises RuntimeError when all canned responses are consumed."""
        config = _make_config()
        adapter = DeterministicFakeAdapter([_success_result()])

        await adapter.invoke("sys", "user", {}, config)

        with pytest.raises(RuntimeError, match="exhausted"):
            await adapter.invoke("sys", "user", {}, config)

    @pytest.mark.asyncio
    async def test_call_count_tracks_invocations(self) -> None:
        """call_count increments with each invocation."""
        config = _make_config()
        adapter = DeterministicFakeAdapter([
            _success_result(),
            _success_result(),
            _success_result(),
        ])

        assert adapter.call_count == 0
        await adapter.invoke("s", "u", {}, config)
        assert adapter.call_count == 1
        await adapter.invoke("s", "u", {}, config)
        assert adapter.call_count == 2

    @pytest.mark.asyncio
    async def test_satisfies_protocol(self) -> None:
        """DeterministicFakeAdapter satisfies the StructuredLLMAdapter protocol."""
        adapter = DeterministicFakeAdapter([])
        assert isinstance(adapter, StructuredLLMAdapter)

    @pytest.mark.asyncio
    async def test_empty_responses_raises_immediately(self) -> None:
        """Empty responses list raises on first call."""
        config = _make_config()
        adapter = DeterministicFakeAdapter([])

        with pytest.raises(RuntimeError, match="exhausted"):
            await adapter.invoke("sys", "user", {}, config)


# ---------------------------------------------------------------------------
# Tests: LLMInvocationRecord dataclass
# ---------------------------------------------------------------------------


class TestLLMInvocationRecord:
    """Tests for the LLMInvocationRecord dataclass."""

    def test_frozen_record_creation(self) -> None:
        """LLMInvocationRecord can be created with all fields."""
        record = LLMInvocationRecord(
            model="test-model",
            prompt_version="1.0.0",
            schema_version="2.0.0",
            input_tokens=100,
            output_tokens=50,
            latency_ms=200,
            attempt_number=1,
            success=True,
            structured_output_valid=True,
            grounding_valid=True,
            failure_reason=None,
        )
        assert record.model == "test-model"
        assert record.input_tokens == 100
        assert record.output_tokens == 50
        assert record.latency_ms == 200

    def test_frozen_record_immutable(self) -> None:
        """LLMInvocationRecord is immutable (frozen dataclass)."""
        record = LLMInvocationRecord(
            model="m",
            prompt_version="1",
            schema_version="1",
            input_tokens=0,
            output_tokens=0,
            latency_ms=0,
            attempt_number=1,
            success=True,
            structured_output_valid=True,
            grounding_valid=True,
        )
        with pytest.raises(Exception):
            record.model = "other"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Tests: BoundedInvocationResult dataclass
# ---------------------------------------------------------------------------


class TestBoundedInvocationResult:
    """Tests for the BoundedInvocationResult dataclass."""

    def test_success_result_construction(self) -> None:
        """BoundedInvocationResult can represent a successful outcome."""
        result = BoundedInvocationResult(
            success=True,
            output={"match": True},
            invocation_records=[],
            total_attempts=1,
            model_used="model-a",
            failure_reason=None,
        )
        assert result.success is True
        assert result.output == {"match": True}
        assert result.model_used == "model-a"

    def test_failure_result_construction(self) -> None:
        """BoundedInvocationResult can represent a failed outcome."""
        result = BoundedInvocationResult(
            success=False,
            output=None,
            invocation_records=[],
            total_attempts=5,
            model_used=None,
            failure_reason="All attempts exhausted",
        )
        assert result.success is False
        assert result.output is None
        assert result.model_used is None
        assert result.failure_reason == "All attempts exhausted"
