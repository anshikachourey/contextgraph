"""Provider-neutral structured LLM adapter for SIE identity evaluation.

This module defines the provider-neutral adapter protocol and orchestration
layer for invoking LLMs with structured output contracts. It records all
invocation metadata (model, prompt/schema versions, tokens, latency, attempts,
structured-output status, grounding status) and provides deterministic fake
adapters for tests.

Design authority: design.md §8.2 and design-corrections.md.

Key contract rules:
- No provider-specific semantic policy.
- Operational/model failure must never become fake LOW confidence, NO_MATCH, or novelty.
- Failed evaluation → DEFER or REQUIRES_VALIDATION with correct stage execution status.
- Structured outputs with schema validation.
- Bounded retry with fallback.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from ..identity_policy import IdentityEvaluationConfig


# ---------------------------------------------------------------------------
# LLM Invocation Record
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LLMInvocationRecord:
    """Records metadata for each LLM call attempt.

    Attributes:
        model: Model identifier used for this invocation.
        prompt_version: Version of the prompt template used.
        schema_version: Version of the structured output schema.
        input_tokens: Number of input tokens consumed.
        output_tokens: Number of output tokens produced.
        latency_ms: Wall-clock latency in milliseconds.
        attempt_number: 1-based attempt number within the retry sequence.
        success: Whether this invocation produced a valid result.
        structured_output_valid: Whether the raw output conformed to the schema.
        grounding_valid: Whether the output passed grounding validation.
        failure_reason: Human-readable failure reason (None if successful).
    """

    model: str
    prompt_version: str
    schema_version: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    attempt_number: int
    success: bool
    structured_output_valid: bool
    grounding_valid: bool
    failure_reason: str | None = None


# ---------------------------------------------------------------------------
# LLM Adapter Result
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LLMAdapterResult:
    """Result from a single adapter invocation.

    Attributes:
        raw_output: Parsed structured output dict, or None on failure.
        success: Whether this invocation succeeded.
        failure_reason: Human-readable reason on failure, None on success.
        tokens_used: Total tokens consumed (input + output).
        latency_ms: Wall-clock latency in milliseconds.
    """

    raw_output: dict | None
    success: bool
    failure_reason: str | None
    tokens_used: int
    latency_ms: int


# ---------------------------------------------------------------------------
# Structured LLM Adapter Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class StructuredLLMAdapter(Protocol):
    """Provider-neutral protocol for invoking an LLM with structured output.

    Implementations must be stateless with respect to semantic policy.
    They accept prompts and a schema, return structured output or failure.
    They NEVER fabricate semantic results on failure.
    """

    async def invoke(
        self,
        system_prompt: str,
        user_prompt: str,
        output_schema: dict,
        config: IdentityEvaluationConfig,
    ) -> LLMAdapterResult:
        """Invoke the LLM with the given prompts and expected output schema.

        Args:
            system_prompt: The system-level prompt text.
            user_prompt: The user-level evaluation prompt text.
            output_schema: JSON Schema dict describing the expected output structure.
            config: Evaluation configuration with model/token/version parameters.

        Returns:
            LLMAdapterResult with parsed output or failure details.
        """
        ...


# ---------------------------------------------------------------------------
# Bounded Invocation Result
# ---------------------------------------------------------------------------


@dataclass
class BoundedInvocationResult:
    """Result of bounded retry/fallback invocation orchestration.

    Attributes:
        success: Whether a valid result was obtained.
        output: The parsed structured output dict, or None on total failure.
        invocation_records: All invocation records (both primary and fallback).
        total_attempts: Total number of invocation attempts made.
        model_used: Model identifier that produced the successful result, or None.
        failure_reason: Reason for failure (non-None only when success=False).
    """

    success: bool
    output: dict | None
    invocation_records: list[LLMInvocationRecord]
    total_attempts: int
    model_used: str | None
    failure_reason: str | None = None


# ---------------------------------------------------------------------------
# Bounded LLM Invoker
# ---------------------------------------------------------------------------


class BoundedLLMInvoker:
    """Orchestrates retry/fallback invocation with bounded attempts.

    Tries the primary adapter up to max_retries_primary times.
    On exhaustion, tries the fallback adapter up to max_retries_fallback times.
    Records all invocation records for observability.
    On total exhaustion, returns failure — NEVER fabricates a semantic result.

    The caller is responsible for converting failure into DEFER or
    REQUIRES_VALIDATION with the correct stage execution status.
    """

    def __init__(
        self,
        primary: StructuredLLMAdapter,
        fallback: StructuredLLMAdapter | None,
        config: IdentityEvaluationConfig,
    ) -> None:
        """Initialize the bounded invoker.

        Args:
            primary: The primary LLM adapter to try first.
            fallback: Optional fallback adapter after primary exhaustion.
            config: Configuration with retry/model/version parameters.
        """
        self._primary = primary
        self._fallback = fallback
        self._config = config

    @property
    def config(self) -> IdentityEvaluationConfig:
        """The evaluation configuration."""
        return self._config

    async def invoke_with_retry(
        self,
        system_prompt: str,
        user_prompt: str,
        output_schema: dict,
    ) -> BoundedInvocationResult:
        """Invoke the LLM with bounded retry and optional fallback.

        Retry strategy:
        1. Try primary adapter up to config.max_retries_primary times.
        2. If primary exhausted and fallback available, try fallback up to
           config.max_retries_fallback times.
        3. On total exhaustion, return failure. The caller produces DEFER or
           REQUIRES_VALIDATION — this method NEVER fabricates a semantic result.

        Args:
            system_prompt: The system-level prompt text.
            user_prompt: The user-level evaluation prompt text.
            output_schema: JSON Schema dict for the expected output structure.

        Returns:
            BoundedInvocationResult with success/failure and all records.
        """
        records: list[LLMInvocationRecord] = []
        attempt_number = 0

        # --- Primary adapter attempts ---
        for i in range(self._config.max_retries_primary):
            attempt_number += 1

            if i > 0:
                # Apply backoff between retries
                backoff_ms = self._config.retry_backoff_ms * (2 ** (i - 1))
                await asyncio.sleep(backoff_ms / 1000.0)

            start_time = time.monotonic()
            try:
                result = await self._primary.invoke(
                    system_prompt, user_prompt, output_schema, self._config
                )
            except Exception as e:
                latency_ms = int((time.monotonic() - start_time) * 1000)
                records.append(
                    LLMInvocationRecord(
                        model=self._config.primary_model,
                        prompt_version=self._config.evaluation_prompt_version,
                        schema_version=self._config.output_schema_version,
                        input_tokens=0,
                        output_tokens=0,
                        latency_ms=latency_ms,
                        attempt_number=attempt_number,
                        success=False,
                        structured_output_valid=False,
                        grounding_valid=False,
                        failure_reason=f"Exception: {type(e).__name__}: {e}",
                    )
                )
                continue

            latency_ms = result.latency_ms
            record = LLMInvocationRecord(
                model=self._config.primary_model,
                prompt_version=self._config.evaluation_prompt_version,
                schema_version=self._config.output_schema_version,
                input_tokens=max(0, result.tokens_used - (result.tokens_used // 3)),
                output_tokens=result.tokens_used // 3,
                latency_ms=latency_ms,
                attempt_number=attempt_number,
                success=result.success,
                structured_output_valid=result.raw_output is not None,
                grounding_valid=result.success,
                failure_reason=result.failure_reason,
            )
            records.append(record)

            if result.success:
                return BoundedInvocationResult(
                    success=True,
                    output=result.raw_output,
                    invocation_records=records,
                    total_attempts=attempt_number,
                    model_used=self._config.primary_model,
                    failure_reason=None,
                )

        # --- Fallback adapter attempts ---
        if self._fallback is not None and self._config.fallback_model is not None:
            for i in range(self._config.max_retries_fallback):
                attempt_number += 1

                if i > 0:
                    backoff_ms = self._config.retry_backoff_ms * (2 ** (i - 1))
                    await asyncio.sleep(backoff_ms / 1000.0)

                start_time = time.monotonic()
                try:
                    result = await self._fallback.invoke(
                        system_prompt, user_prompt, output_schema, self._config
                    )
                except Exception as e:
                    latency_ms = int((time.monotonic() - start_time) * 1000)
                    records.append(
                        LLMInvocationRecord(
                            model=self._config.fallback_model,
                            prompt_version=self._config.evaluation_prompt_version,
                            schema_version=self._config.output_schema_version,
                            input_tokens=0,
                            output_tokens=0,
                            latency_ms=latency_ms,
                            attempt_number=attempt_number,
                            success=False,
                            structured_output_valid=False,
                            grounding_valid=False,
                            failure_reason=f"Exception: {type(e).__name__}: {e}",
                        )
                    )
                    continue

                latency_ms = result.latency_ms
                record = LLMInvocationRecord(
                    model=self._config.fallback_model,
                    prompt_version=self._config.evaluation_prompt_version,
                    schema_version=self._config.output_schema_version,
                    input_tokens=max(0, result.tokens_used - (result.tokens_used // 3)),
                    output_tokens=result.tokens_used // 3,
                    latency_ms=latency_ms,
                    attempt_number=attempt_number,
                    success=result.success,
                    structured_output_valid=result.raw_output is not None,
                    grounding_valid=result.success,
                    failure_reason=result.failure_reason,
                )
                records.append(record)

                if result.success:
                    return BoundedInvocationResult(
                        success=True,
                        output=result.raw_output,
                        invocation_records=records,
                        total_attempts=attempt_number,
                        model_used=self._config.fallback_model,
                        failure_reason=None,
                    )

        # --- Total exhaustion: NEVER fabricate a semantic result ---
        return BoundedInvocationResult(
            success=False,
            output=None,
            invocation_records=records,
            total_attempts=attempt_number,
            model_used=None,
            failure_reason=(
                f"All attempts exhausted: {attempt_number} total attempts "
                f"(primary: {self._config.max_retries_primary}, "
                f"fallback: {self._config.max_retries_fallback})"
            ),
        )


# ---------------------------------------------------------------------------
# Deterministic Fake Adapter (for tests)
# ---------------------------------------------------------------------------


@dataclass
class _FakeCall:
    """Record of a call made to the DeterministicFakeAdapter."""

    system_prompt: str
    user_prompt: str
    output_schema: dict
    config: IdentityEvaluationConfig


class DeterministicFakeAdapter:
    """Deterministic fake LLM adapter for testing.

    Accepts a list of canned LLMAdapterResult responses and returns them
    in order on successive invocations. Records all calls for assertion.

    If all canned responses are exhausted, raises RuntimeError.
    """

    def __init__(self, responses: list[LLMAdapterResult]) -> None:
        """Initialize with canned responses.

        Args:
            responses: Ordered list of results to return on successive calls.
        """
        self._responses = list(responses)
        self._call_index = 0
        self._calls: list[_FakeCall] = []

    @property
    def calls(self) -> list[_FakeCall]:
        """All calls recorded by this adapter."""
        return list(self._calls)

    @property
    def call_count(self) -> int:
        """Number of calls made to this adapter."""
        return len(self._calls)

    async def invoke(
        self,
        system_prompt: str,
        user_prompt: str,
        output_schema: dict,
        config: IdentityEvaluationConfig,
    ) -> LLMAdapterResult:
        """Return the next canned response, recording the call.

        Args:
            system_prompt: The system-level prompt text.
            user_prompt: The user-level evaluation prompt text.
            output_schema: JSON Schema dict for the expected output structure.
            config: Evaluation configuration.

        Returns:
            The next canned LLMAdapterResult in sequence.

        Raises:
            RuntimeError: If all canned responses have been exhausted.
        """
        self._calls.append(
            _FakeCall(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                output_schema=output_schema,
                config=config,
            )
        )

        if self._call_index >= len(self._responses):
            raise RuntimeError(
                f"DeterministicFakeAdapter: all {len(self._responses)} canned "
                f"responses exhausted after {self._call_index} calls"
            )

        response = self._responses[self._call_index]
        self._call_index += 1
        return response
