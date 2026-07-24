"""Tests for SIE privacy-safe logging (task 17.2).

Proves:
- Sensitive content NEVER appears in sanitized log output.
- Safe fields pass through unchanged.
- Authorized-access fields are summarized, not exposed.
- Authorized detail storage works under access/retention controls.
- Purge/redaction reaches all stored diagnostic and model-invocation material.
- The PrivacyAwareLogger sanitizes kwargs before logging.
- LLM prompts/completions never reach general logs.
- Retrieval query text never reaches general logs.

Validates: Requirements 11.5
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from app.sie.privacy_logging import (
    AUTHORIZED_ACCESS_FIELDS,
    REDACTED_MARKER,
    SENSITIVE_FIELDS,
    SAFE_FIELDS,
    AuthorizedDetailStore,
    InMemoryAuthorizedStore,
    PrivacyAwareLogger,
    configure_authorized_store,
    get_privacy_logger,
    is_safe_field,
    is_sensitive_field,
    purge_diagnostic_material,
    sanitize_log_data,
)


# ---------------------------------------------------------------------------
# sanitize_log_data tests
# ---------------------------------------------------------------------------


class TestSanitizeLogData:
    """Tests for the log sanitizer function."""

    def test_sensitive_fields_are_redacted(self) -> None:
        """Sensitive field values are replaced with REDACTED_MARKER."""
        data = {
            "user_grounded_meaning": "I want to learn guitar",
            "system_prompt": "You are an identity evaluator...",
            "user_prompt": "Evaluate the following packet...",
            "raw_output": {"candidates": [{"id": "c1"}]},
            "query_text": "guitar learning preference",
            "packet_id": "pkt-123",  # safe — should pass through
        }
        result = sanitize_log_data(data)

        assert result["user_grounded_meaning"] == REDACTED_MARKER
        assert result["system_prompt"] == REDACTED_MARKER
        assert result["user_prompt"] == REDACTED_MARKER
        assert result["raw_output"] == REDACTED_MARKER
        assert result["query_text"] == REDACTED_MARKER
        # Safe field passes through
        assert result["packet_id"] == "pkt-123"

    def test_safe_fields_pass_through(self) -> None:
        """Safe fields are not modified."""
        data = {
            "request_id": "req-abc",
            "outcome": "YES",
            "latency_ms": 150,
            "candidate_count": 3,
            "policy_version": "v2.1",
            "graph_version": 42,
        }
        result = sanitize_log_data(data)
        assert result == data

    def test_authorized_access_fields_are_summarized(self) -> None:
        """Authorized-access fields show structure but not content."""
        data = {
            "candidates_considered": [
                {"concern_id": "c1", "explanation": "matches..."},
                {"concern_id": "c2", "explanation": "partial..."},
            ],
            "irs_signals": [{"signal_type": "IRS-1"}],
            "reasoning": "The packet demonstrates identity continuity because...",
            "retrieval_attempts": [],
        }
        result = sanitize_log_data(data)

        assert "candidates_considered=[2 items]" == result["candidates_considered"]
        assert "irs_signals=[1 items]" == result["irs_signals"]
        # reasoning is a string in authorized access
        assert "reasoning=[" in result["reasoning"]
        assert "chars]" in result["reasoning"]
        assert "retrieval_attempts=[0 items]" == result["retrieval_attempts"]

        # Original content must not appear
        assert "matches..." not in str(result)
        assert "identity continuity" not in str(result)

    def test_nested_dicts_are_recursively_sanitized(self) -> None:
        """Nested dictionaries have their sensitive fields redacted."""
        data = {
            "metadata": {
                "packet_id": "pkt-1",
                "user_grounded_meaning": "secret user text",
                "latency_ms": 50,
            }
        }
        result = sanitize_log_data(data)

        assert result["metadata"]["packet_id"] == "pkt-1"
        assert result["metadata"]["user_grounded_meaning"] == REDACTED_MARKER
        assert result["metadata"]["latency_ms"] == 50

    def test_lists_with_dicts_are_sanitized(self) -> None:
        """Lists containing dicts have their sensitive fields stripped."""
        data = {
            "entries": [
                {"packet_id": "p1", "query_text": "find guitar stuff"},
                {"packet_id": "p2", "query_text": "find piano stuff"},
            ]
        }
        result = sanitize_log_data(data)

        entries = result["entries"]
        assert entries[0]["packet_id"] == "p1"
        assert entries[0]["query_text"] == REDACTED_MARKER
        assert entries[1]["packet_id"] == "p2"
        assert entries[1]["query_text"] == REDACTED_MARKER

    def test_large_lists_are_summarized(self) -> None:
        """Lists with more than 10 items are summarized by count."""
        data = {"items": list(range(15))}
        result = sanitize_log_data(data)
        assert result["items"] == "[15 items]"

    def test_empty_dict_returns_empty(self) -> None:
        """Empty input returns empty output."""
        assert sanitize_log_data({}) == {}

    def test_none_authorized_field(self) -> None:
        """None-valued authorized fields show 'None'."""
        data = {"sufficiency_record": None}
        result = sanitize_log_data(data)
        assert "None" in result["sufficiency_record"]

    def test_all_llm_fields_are_sensitive(self) -> None:
        """All LLM-related fields are classified as sensitive."""
        llm_fields = [
            "system_prompt",
            "user_prompt",
            "prompt_text",
            "prompt_content",
            "completion",
            "completion_text",
            "raw_output",
            "llm_response",
            "llm_input",
            "model_input",
            "model_output",
        ]
        for field in llm_fields:
            assert field in SENSITIVE_FIELDS, f"{field} should be sensitive"
            data = {field: "some secret LLM content"}
            result = sanitize_log_data(data)
            assert result[field] == REDACTED_MARKER

    def test_all_query_fields_are_sensitive(self) -> None:
        """All retrieval query text fields are classified as sensitive."""
        query_fields = [
            "query_text",
            "query_content",
            "search_text",
            "reformulated_query",
            "alternate_query",
        ]
        for field in query_fields:
            assert field in SENSITIVE_FIELDS, f"{field} should be sensitive"

    def test_all_user_content_fields_are_sensitive(self) -> None:
        """All user content fields are classified as sensitive."""
        content_fields = [
            "user_grounded_meaning",
            "raw_content",
            "concern_text",
            "proposition_text",
            "proposition_content",
        ]
        for field in content_fields:
            assert field in SENSITIVE_FIELDS, f"{field} should be sensitive"


# ---------------------------------------------------------------------------
# Field classification tests
# ---------------------------------------------------------------------------


class TestFieldClassification:
    """Tests for field classification helpers."""

    def test_is_sensitive_field(self) -> None:
        assert is_sensitive_field("user_grounded_meaning") is True
        assert is_sensitive_field("system_prompt") is True
        assert is_sensitive_field("packet_id") is False
        assert is_sensitive_field("unknown_field") is False

    def test_is_safe_field(self) -> None:
        assert is_safe_field("packet_id") is True
        assert is_safe_field("latency_ms") is True
        assert is_safe_field("outcome") is True
        assert is_safe_field("user_grounded_meaning") is False
        assert is_safe_field("unknown_field") is False

    def test_sensitive_and_safe_are_disjoint(self) -> None:
        """No field can be both sensitive and safe."""
        overlap = SENSITIVE_FIELDS & SAFE_FIELDS
        assert overlap == set(), f"Fields in both sets: {overlap}"

    def test_authorized_access_disjoint_from_sensitive(self) -> None:
        """Authorized-access and sensitive fields don't overlap."""
        overlap = AUTHORIZED_ACCESS_FIELDS & SENSITIVE_FIELDS
        assert overlap == set(), f"Fields in both sets: {overlap}"


# ---------------------------------------------------------------------------
# PrivacyAwareLogger tests
# ---------------------------------------------------------------------------


class TestPrivacyAwareLogger:
    """Tests for the PrivacyAwareLogger wrapper."""

    def test_info_sanitizes_kwargs(self, caplog: pytest.LogCaptureFixture) -> None:
        """Info-level logs have sensitive kwargs sanitized."""
        logger = PrivacyAwareLogger("test.info")
        with caplog.at_level(logging.INFO, logger="test.info"):
            logger.info(
                "resolved packet",
                packet_id="pkt-1",
                user_grounded_meaning="I want to learn guitar",
                outcome="YES",
            )

        # The log message itself should appear
        assert "resolved packet" in caplog.text
        # Sensitive content must NOT appear
        assert "I want to learn guitar" not in caplog.text

    def test_warning_sanitizes_kwargs(self, caplog: pytest.LogCaptureFixture) -> None:
        """Warning-level logs have sensitive kwargs sanitized."""
        logger = PrivacyAwareLogger("test.warning")
        with caplog.at_level(logging.WARNING, logger="test.warning"):
            logger.warning(
                "retrieval query formed",
                query_text="find guitar learning preferences",
                channel_id="embedding_primary",
            )

        assert "retrieval query formed" in caplog.text
        assert "find guitar learning preferences" not in caplog.text

    def test_error_sanitizes_kwargs(self, caplog: pytest.LogCaptureFixture) -> None:
        """Error-level logs have sensitive kwargs sanitized."""
        logger = PrivacyAwareLogger("test.error")
        with caplog.at_level(logging.ERROR, logger="test.error"):
            logger.error(
                "evaluation failed",
                system_prompt="You are a semantic identity evaluator...",
                request_id="req-1",
            )

        assert "evaluation failed" in caplog.text
        assert "You are a semantic identity evaluator" not in caplog.text

    def test_exception_sanitizes_kwargs(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Exception logs sanitize kwargs (traceback still appears)."""
        logger = PrivacyAwareLogger("test.exc")
        with caplog.at_level(logging.ERROR, logger="test.exc"):
            try:
                raise ValueError("test error")
            except ValueError:
                logger.exception(
                    "pipeline error",
                    raw_content="secret user data",
                    packet_id="pkt-2",
                )

        assert "pipeline error" in caplog.text
        assert "secret user data" not in caplog.text

    def test_authorized_detail_not_in_general_logs(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Authorized detail is stored but not emitted to general logs."""
        store = InMemoryAuthorizedStore()
        logger = PrivacyAwareLogger("test.detail")
        logger.set_authorized_store(store)

        secret_prompt = "Evaluate identity for: user wants guitar lessons"

        with caplog.at_level(logging.DEBUG, logger="test.detail"):
            logger.authorized_detail(
                "evaluation_prompt",
                request_id="req-42",
                detail={"prompt": secret_prompt, "conversation_id": "conv-1"},
            )

        # Nothing should appear in general logs
        assert secret_prompt not in caplog.text
        assert "evaluation_prompt" not in caplog.text

        # But it IS in the authorized store
        assert len(store.records) == 1
        assert store.records[0]["detail"]["prompt"] == secret_prompt

    def test_authorized_detail_silently_discarded_without_store(self) -> None:
        """Without a store configured, authorized detail is discarded safely."""
        logger = PrivacyAwareLogger("test.no_store")
        # Should not raise
        logger.authorized_detail(
            "model_completion",
            request_id="req-1",
            detail="LLM said: the packet matches concern c1 because...",
        )


# ---------------------------------------------------------------------------
# Authorized detail store tests
# ---------------------------------------------------------------------------


class TestInMemoryAuthorizedStore:
    """Tests for the in-memory authorized detail store."""

    def test_store_and_retrieve(self) -> None:
        """Records are stored and retrievable."""
        store = InMemoryAuthorizedStore()
        store.store(
            category="evaluation_prompt",
            request_id="req-1",
            detail={"prompt": "evaluate this..."},
            retention_policy="standard",
        )
        assert len(store.records) == 1
        assert store.records[0]["category"] == "evaluation_prompt"
        assert store.records[0]["request_id"] == "req-1"

    def test_purge_by_request_id(self) -> None:
        """Purge removes all records for the given request_id."""
        store = InMemoryAuthorizedStore()
        store.store(category="a", request_id="req-1", detail="x")
        store.store(category="b", request_id="req-1", detail="y")
        store.store(category="c", request_id="req-2", detail="z")

        count = store.purge_for_request("req-1")
        assert count == 2
        assert len(store.records) == 1
        assert store.records[0]["request_id"] == "req-2"

    def test_purge_by_conversation_id(self) -> None:
        """Purge removes records whose detail contains the conversation_id."""
        store = InMemoryAuthorizedStore()
        store.store(
            category="prompt",
            request_id="req-1",
            detail={"conversation_id": "conv-A", "text": "..."},
        )
        store.store(
            category="prompt",
            request_id="req-2",
            detail={"conversation_id": "conv-B", "text": "..."},
        )

        count = store.purge_for_conversation("conv-A")
        assert count == 1
        assert len(store.records) == 1
        assert store.records[0]["request_id"] == "req-2"

    def test_redact_field(self) -> None:
        """Redact replaces a specific field value within stored detail."""
        store = InMemoryAuthorizedStore()
        store.store(
            category="completion",
            request_id="req-1",
            detail={
                "raw_output": "The concern matches because...",
                "latency_ms": 200,
            },
        )

        result = store.redact_field("req-1", "raw_output")
        assert result is True
        assert store.records[0]["detail"]["raw_output"] == REDACTED_MARKER
        # Other fields unchanged
        assert store.records[0]["detail"]["latency_ms"] == 200

    def test_redact_nonexistent_field(self) -> None:
        """Redacting a field that doesn't exist returns False."""
        store = InMemoryAuthorizedStore()
        store.store(
            category="x", request_id="req-1", detail={"a": 1}
        )
        assert store.redact_field("req-1", "nonexistent") is False

    def test_purge_reaches_model_invocation_material(self) -> None:
        """Purge/redaction reaches LLM prompts and completions."""
        store = InMemoryAuthorizedStore()
        store.store(
            category="model_invocation",
            request_id="req-1",
            detail={
                "system_prompt": "You are an evaluator...",
                "user_prompt": "Evaluate: user wants guitar...",
                "completion": "Candidate c1 matches...",
                "conversation_id": "conv-1",
            },
        )

        # Purge by request removes everything
        count = store.purge_for_request("req-1")
        assert count == 1
        assert len(store.records) == 0

    def test_purge_reaches_diagnostic_material(self) -> None:
        """Purge removes diagnostic records (candidates, reasoning, etc.)."""
        store = InMemoryAuthorizedStore()
        store.store(
            category="diagnostics",
            request_id="req-1",
            detail={
                "candidates_considered": [{"id": "c1", "text": "..."}],
                "reasoning": "Identity continuity established via...",
                "retrieval_attempts": [{"query": "..."}],
                "conversation_id": "conv-1",
            },
        )

        count = store.purge_for_conversation("conv-1")
        assert count == 1
        assert len(store.records) == 0


# ---------------------------------------------------------------------------
# Module-level function tests
# ---------------------------------------------------------------------------


class TestModuleFunctions:
    """Tests for module-level convenience functions."""

    def test_get_privacy_logger_returns_same_instance(self) -> None:
        """Same name returns same logger instance."""
        l1 = get_privacy_logger("test.module")
        l2 = get_privacy_logger("test.module")
        assert l1 is l2

    def test_configure_authorized_store_propagates(self) -> None:
        """Configuring global store propagates to existing loggers."""
        logger = get_privacy_logger("test.propagation")
        store = InMemoryAuthorizedStore()
        configure_authorized_store(store)

        logger.authorized_detail(
            "test", request_id="req-1", detail="hello"
        )
        assert len(store.records) == 1

    def test_purge_diagnostic_material_by_request(self) -> None:
        """Module-level purge function delegates to the global store."""
        store = InMemoryAuthorizedStore()
        configure_authorized_store(store)

        store.store(category="x", request_id="req-1", detail="a")
        store.store(category="y", request_id="req-1", detail="b")

        count = purge_diagnostic_material(request_id="req-1")
        assert count == 2
        assert len(store.records) == 0

    def test_purge_diagnostic_material_without_store(self) -> None:
        """Purge returns 0 when no store is configured."""
        # Reset global state for this test
        from app.sie import privacy_logging

        old_store = privacy_logging._global_authorized_store
        privacy_logging._global_authorized_store = None
        try:
            count = purge_diagnostic_material(request_id="req-1")
            assert count == 0
        finally:
            privacy_logging._global_authorized_store = old_store


# ---------------------------------------------------------------------------
# Integration-style tests: prove sensitive content can't leak
# ---------------------------------------------------------------------------


class TestSensitiveContentNeverLeaks:
    """End-to-end tests proving sensitive content never reaches general logs."""

    SENSITIVE_SAMPLES = {
        "user_grounded_meaning": "I've been thinking about learning guitar for a while now",
        "system_prompt": "You are a semantic identity evaluator for ContextGraph",
        "user_prompt": "Given the packet with meaning 'guitar lessons', evaluate...",
        "completion": "The packet matches concern c-guitar because of identity continuity",
        "raw_output": {"match": True, "reason": "guitar concern continuity"},
        "query_text": "guitar lessons learning preference concern",
        "proposition_text": "User wants to learn guitar",
        "concern_text": "Guitar learning journey",
        "identity_summary": "User's guitar learning goals and progress",
        "reasoning_text": "Evidence shows the user has been discussing guitar since...",
    }

    def test_sanitize_removes_all_sensitive_samples(self) -> None:
        """No sensitive sample value appears in sanitized output."""
        result = sanitize_log_data(self.SENSITIVE_SAMPLES)
        result_str = str(result)

        for field, value in self.SENSITIVE_SAMPLES.items():
            # The original value (or any substring of it) must not appear
            value_str = str(value) if not isinstance(value, str) else value
            assert value_str not in result_str, (
                f"Sensitive content from '{field}' leaked into sanitized output"
            )

    def test_logger_never_emits_sensitive_content(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """PrivacyAwareLogger never emits sensitive field values."""
        logger = PrivacyAwareLogger("test.leak_check")

        with caplog.at_level(logging.DEBUG, logger="test.leak_check"):
            logger.info("processing", **self.SENSITIVE_SAMPLES)
            logger.debug("detail", **self.SENSITIVE_SAMPLES)
            logger.warning("issue", **self.SENSITIVE_SAMPLES)
            logger.error("failure", **self.SENSITIVE_SAMPLES)

        log_output = caplog.text
        for field, value in self.SENSITIVE_SAMPLES.items():
            value_str = str(value) if not isinstance(value, str) else value
            assert value_str not in log_output, (
                f"Sensitive content from '{field}' found in log output"
            )

    def test_mixed_safe_and_sensitive_fields(self) -> None:
        """Safe fields pass through while sensitive fields are redacted."""
        data = {
            "packet_id": "pkt-abc-123",
            "outcome": "YES",
            "latency_ms": 42,
            "user_grounded_meaning": "secret user text",
            "system_prompt": "secret prompt",
            "candidate_count": 3,
        }
        result = sanitize_log_data(data)

        # Safe fields intact
        assert result["packet_id"] == "pkt-abc-123"
        assert result["outcome"] == "YES"
        assert result["latency_ms"] == 42
        assert result["candidate_count"] == 3
        # Sensitive fields redacted
        assert result["user_grounded_meaning"] == REDACTED_MARKER
        assert result["system_prompt"] == REDACTED_MARKER

    def test_deeply_nested_sensitive_content(self) -> None:
        """Sensitive content in deeply nested structures is still redacted."""
        data = {
            "stage_results": {
                "evaluation": {
                    "packet_id": "pkt-1",
                    "user_prompt": "Evaluate identity for this user's concern...",
                    "outcome": "HIGH",
                }
            }
        }
        result = sanitize_log_data(data)
        result_str = str(result)

        assert "Evaluate identity for this user" not in result_str
        assert result["stage_results"]["evaluation"]["packet_id"] == "pkt-1"
        assert result["stage_results"]["evaluation"]["user_prompt"] == REDACTED_MARKER
