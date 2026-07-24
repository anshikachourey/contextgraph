"""Privacy-safe logging for SIE identity resolution.

This module enforces requirement 11.5: logs and diagnostics SHALL preserve
traceability while obeying applicable privacy, access-control, and retention
requirements.

Architecture:
- SENSITIVE fields (raw packet/concern text, user propositions, LLM prompts/
  completions, query text) MUST NEVER appear in general logs.
- SAFE fields (IDs, counts, latencies, statuses, enum values, version strings)
  are permitted in general logs.
- Authorized detail storage (audit-grade diagnostic records) MAY contain
  sensitive fields under approved access/retention controls.
- The privacy purge/redaction RPC (task 5.4) reaches all stored diagnostic
  and model-invocation material.

Usage:
    from .privacy_logging import get_privacy_logger, PrivacyAwareLogger

    logger = get_privacy_logger(__name__)
    logger.info("resolved", packet_id=pkt.packet_id, outcome=outcome.value)

    # Sensitive detail goes to authorized storage only:
    logger.authorized_detail("evaluation_prompt", request_id=req_id, detail=prompt)

Design authority: requirements.md §11.5, design.md §17.
"""

from __future__ import annotations

import logging
from typing import Any


# ---------------------------------------------------------------------------
# Sensitive field definitions
# ---------------------------------------------------------------------------

# Fields whose VALUES must never appear in general (non-authorized) log output.
# These contain raw user content, semantic text, or model invocation material.
SENSITIVE_FIELDS: frozenset[str] = frozenset(
    {
        # Raw packet/concern content
        "user_grounded_meaning",
        "raw_content",
        "concern_text",
        "packet_text",
        "packet_content",
        "proposition_text",
        "proposition_content",
        "identity_summary",
        "identity_summary_text",
        # LLM invocation material
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
        # Query text (retrieval queries)
        "query_text",
        "query_content",
        "search_text",
        "reformulated_query",
        "alternate_query",
        # Evidence/reasoning text that may contain user content
        "reasoning_text",
        "evidence_text",
        "explanation_detail",
        # Alias/user-identifying content
        "alias_text",
        "alias_value",
    }
)

# Fields that are SAFE for general logging — operational metadata only.
SAFE_FIELDS: frozenset[str] = frozenset(
    {
        # Identifiers (opaque, non-content-bearing)
        "request_id",
        "idempotency_key",
        "conversation_id",
        "packet_id",
        "proposition_id",
        "concern_id",
        "decision_id",
        "attempt_id",
        "record_id",
        "channel_id",
        "entity_id",
        # Counts and metrics
        "candidate_count",
        "attempt_count",
        "total_attempts",
        "widening_rounds",
        "re_evaluation_count",
        "input_tokens",
        "output_tokens",
        "tokens_used",
        # Timing
        "latency_ms",
        "duration_ms",
        "elapsed_ms",
        # Status/enum values
        "outcome",
        "action",
        "status",
        "confidence",
        "identity_confidence",
        "sufficiency_confidence",
        "lifecycle_state",
        "stage_status",
        "cohesion_status",
        "signal_type",
        "channel_family",
        # Version strings
        "policy_version",
        "model_version",
        "prompt_version",
        "schema_version",
        "retrieval_policy_version",
        "pipeline_version",
        "graph_version",
        "graph_version_analyzed",
        # Structural metadata
        "processing_mode",
        "query_mode",
        "scope_description",
        "triggered_by",
        "failure_reason",
    }
)

# Diagnostic JSONB fields that require authorized access for viewing.
# These are stored in resolution/audit records and contain detailed
# semantic evaluation material.
AUTHORIZED_ACCESS_FIELDS: frozenset[str] = frozenset(
    {
        "candidates_considered",
        "irs_signals",
        "retrieval_attempts",
        "reasoning",
        "sufficiency_record",
        "proposed_mutations",
        "evidence_references",
    }
)

# Redaction marker used when sensitive content is stripped.
REDACTED_MARKER = "[REDACTED]"


# ---------------------------------------------------------------------------
# Log sanitizer
# ---------------------------------------------------------------------------


def sanitize_log_data(data: dict[str, Any]) -> dict[str, Any]:
    """Strip sensitive fields from a dict intended for general logging.

    Args:
        data: Dictionary of key-value pairs to sanitize.

    Returns:
        A new dict with sensitive field values replaced by REDACTED_MARKER
        and authorized-access fields replaced by a type/length summary.
    """
    sanitized: dict[str, Any] = {}
    for key, value in data.items():
        if key in SENSITIVE_FIELDS:
            sanitized[key] = REDACTED_MARKER
        elif key in AUTHORIZED_ACCESS_FIELDS:
            # Provide structural summary without content
            sanitized[key] = _summarize_authorized_field(key, value)
        else:
            # Recursively sanitize nested dicts
            if isinstance(value, dict):
                sanitized[key] = sanitize_log_data(value)
            elif isinstance(value, list):
                sanitized[key] = _sanitize_list(value)
            else:
                sanitized[key] = value
    return sanitized


def _sanitize_list(items: list[Any]) -> list[Any] | str:
    """Sanitize a list, checking for dicts with sensitive fields.

    For large lists, returns a summary string instead of full content.
    """
    if not items:
        return items
    if len(items) > 10:
        # Summarize rather than log potentially large content
        return f"[{len(items)} items]"
    result = []
    for item in items:
        if isinstance(item, dict):
            result.append(sanitize_log_data(item))
        else:
            result.append(item)
    return result


def _summarize_authorized_field(key: str, value: Any) -> str:
    """Produce a non-content-bearing summary of an authorized-access field."""
    if value is None:
        return f"{key}=None"
    if isinstance(value, list):
        return f"{key}=[{len(value)} items]"
    if isinstance(value, dict):
        return f"{key}={{...{len(value)} keys}}"
    if isinstance(value, str):
        return f"{key}=[{len(value)} chars]"
    return f"{key}=<present>"


def is_sensitive_field(field_name: str) -> bool:
    """Check if a field name is classified as sensitive."""
    return field_name in SENSITIVE_FIELDS


def is_safe_field(field_name: str) -> bool:
    """Check if a field name is classified as safe for general logging."""
    return field_name in SAFE_FIELDS


# ---------------------------------------------------------------------------
# Privacy-aware logger
# ---------------------------------------------------------------------------


class PrivacyAwareLogger:
    """A logger wrapper that enforces privacy-safe logging.

    General log methods (debug, info, warning, error) automatically sanitize
    any keyword arguments before emitting them to the standard logger.

    The authorized_detail method stores full diagnostic content under
    the authorized detail storage path, which is subject to access controls
    and retention/purge policies.
    """

    def __init__(self, name: str) -> None:
        self._logger = logging.getLogger(name)
        self._authorized_store: AuthorizedDetailStore | None = None

    @property
    def underlying_logger(self) -> logging.Logger:
        """Access the underlying standard logger (for level checks etc.)."""
        return self._logger

    def set_authorized_store(self, store: AuthorizedDetailStore) -> None:
        """Configure the authorized detail storage backend."""
        self._authorized_store = store

    # --- General (sanitized) log methods ---

    def debug(self, msg: str, **kwargs: Any) -> None:
        """Emit a debug log with all kwargs sanitized."""
        if self._logger.isEnabledFor(logging.DEBUG):
            safe_extra = sanitize_log_data(kwargs) if kwargs else {}
            self._logger.debug(msg, extra={"sanitized_data": safe_extra})

    def info(self, msg: str, **kwargs: Any) -> None:
        """Emit an info log with all kwargs sanitized."""
        if self._logger.isEnabledFor(logging.INFO):
            safe_extra = sanitize_log_data(kwargs) if kwargs else {}
            self._logger.info(msg, extra={"sanitized_data": safe_extra})

    def warning(self, msg: str, **kwargs: Any) -> None:
        """Emit a warning log with all kwargs sanitized."""
        safe_extra = sanitize_log_data(kwargs) if kwargs else {}
        self._logger.warning(msg, extra={"sanitized_data": safe_extra})

    def error(self, msg: str, **kwargs: Any) -> None:
        """Emit an error log with all kwargs sanitized."""
        safe_extra = sanitize_log_data(kwargs) if kwargs else {}
        self._logger.error(msg, extra={"sanitized_data": safe_extra})

    def exception(self, msg: str, **kwargs: Any) -> None:
        """Emit an exception log with all kwargs sanitized.

        Note: The traceback itself is included by the logging framework.
        Kwargs (which might contain user content) are sanitized.
        """
        safe_extra = sanitize_log_data(kwargs) if kwargs else {}
        self._logger.exception(msg, extra={"sanitized_data": safe_extra})

    # --- Authorized detail storage ---

    def authorized_detail(
        self,
        category: str,
        *,
        request_id: str,
        detail: Any,
        retention_policy: str = "standard",
    ) -> None:
        """Store detailed diagnostic content under authorized access controls.

        This content:
        - Is NOT emitted to general logs.
        - Is stored only under approved access and retention controls.
        - Is subject to privacy purge/redaction when source data is deleted.
        - Is accessible only to authorized audit/debug consumers.

        Args:
            category: Type of detail (e.g., "evaluation_prompt",
                "model_completion", "retrieval_query", "candidate_evidence").
            request_id: The processing request this detail belongs to.
            detail: The full content to store (prompts, completions, etc.).
            retention_policy: Retention tier ("standard", "extended", "audit").
        """
        if self._authorized_store is not None:
            self._authorized_store.store(
                category=category,
                request_id=request_id,
                detail=detail,
                retention_policy=retention_policy,
            )
        # If no store configured, detail is silently discarded.
        # This ensures sensitive content never falls through to general logs.


# ---------------------------------------------------------------------------
# Authorized detail store protocol
# ---------------------------------------------------------------------------


class AuthorizedDetailStore:
    """Protocol/base for authorized diagnostic detail storage.

    Concrete implementations may write to:
    - A dedicated append-only table with RLS access controls.
    - A separate encrypted store with retention TTLs.
    - An audit log system with purge integration.

    All stored content is subject to:
    - Access control (only authorized consumers may read).
    - Retention policies (automatic expiration per tier).
    - Privacy purge/redaction (task 5.4 RPC reaches this storage).
    """

    def store(
        self,
        *,
        category: str,
        request_id: str,
        detail: Any,
        retention_policy: str = "standard",
    ) -> None:
        """Store authorized detail. Override in concrete implementations."""
        pass  # Base no-op; concrete implementations persist.

    def purge_for_request(self, request_id: str) -> int:
        """Purge all stored detail for a given request.

        Returns the count of records purged.
        Called by the privacy purge/redaction RPC.
        """
        return 0

    def purge_for_conversation(self, conversation_id: str) -> int:
        """Purge all stored detail for a conversation.

        Returns the count of records purged.
        Called by the privacy purge/redaction RPC.
        """
        return 0

    def redact_field(
        self, request_id: str, field_name: str
    ) -> bool:
        """Redact a specific field from stored detail.

        Returns True if the field was found and redacted.
        """
        return False


# ---------------------------------------------------------------------------
# In-memory authorized store (for tests and development)
# ---------------------------------------------------------------------------


class InMemoryAuthorizedStore(AuthorizedDetailStore):
    """In-memory implementation of authorized detail storage for testing.

    Stores detail records in a list, supporting purge and redaction.
    NOT for production use — no access control enforcement.
    """

    def __init__(self) -> None:
        self._records: list[dict[str, Any]] = []

    @property
    def records(self) -> list[dict[str, Any]]:
        """All stored records (for test assertions)."""
        return list(self._records)

    def store(
        self,
        *,
        category: str,
        request_id: str,
        detail: Any,
        retention_policy: str = "standard",
    ) -> None:
        """Store a record in memory."""
        self._records.append(
            {
                "category": category,
                "request_id": request_id,
                "detail": detail,
                "retention_policy": retention_policy,
            }
        )

    def purge_for_request(self, request_id: str) -> int:
        """Remove all records for the given request_id."""
        before = len(self._records)
        self._records = [
            r for r in self._records if r["request_id"] != request_id
        ]
        return before - len(self._records)

    def purge_for_conversation(self, conversation_id: str) -> int:
        """Remove all records with the given conversation_id in detail."""
        before = len(self._records)
        self._records = [
            r
            for r in self._records
            if not (
                isinstance(r.get("detail"), dict)
                and r["detail"].get("conversation_id") == conversation_id
            )
        ]
        return before - len(self._records)

    def redact_field(
        self, request_id: str, field_name: str
    ) -> bool:
        """Redact a specific field from stored records matching request_id."""
        found = False
        for record in self._records:
            if record["request_id"] == request_id:
                if isinstance(record.get("detail"), dict):
                    if field_name in record["detail"]:
                        record["detail"][field_name] = REDACTED_MARKER
                        found = True
        return found


# ---------------------------------------------------------------------------
# Module-level factory
# ---------------------------------------------------------------------------

# Global registry of privacy-aware loggers (one per module name).
_loggers: dict[str, PrivacyAwareLogger] = {}

# Global authorized detail store (set during app startup).
_global_authorized_store: AuthorizedDetailStore | None = None


def configure_authorized_store(store: AuthorizedDetailStore) -> None:
    """Configure the global authorized detail store.

    Called during application startup. All subsequently created
    PrivacyAwareLogger instances will use this store.
    Existing loggers are also updated.
    """
    global _global_authorized_store
    _global_authorized_store = store
    for logger in _loggers.values():
        logger.set_authorized_store(store)


def get_privacy_logger(name: str) -> PrivacyAwareLogger:
    """Get or create a privacy-aware logger for the given module name.

    Args:
        name: Logger name (typically __name__ of the calling module).

    Returns:
        A PrivacyAwareLogger that automatically sanitizes general log output.
    """
    if name not in _loggers:
        logger = PrivacyAwareLogger(name)
        if _global_authorized_store is not None:
            logger.set_authorized_store(_global_authorized_store)
        _loggers[name] = logger
    return _loggers[name]


def purge_diagnostic_material(
    *, request_id: str | None = None, conversation_id: str | None = None
) -> int:
    """Purge stored diagnostic/model-invocation material.

    Called by the privacy purge/redaction RPC (task 5.4) to ensure
    diagnostic content is properly removed when source data is deleted.

    Args:
        request_id: Purge all material for this request.
        conversation_id: Purge all material for this conversation.

    Returns:
        Total count of records purged.
    """
    if _global_authorized_store is None:
        return 0

    count = 0
    if request_id:
        count += _global_authorized_store.purge_for_request(request_id)
    if conversation_id:
        count += _global_authorized_store.purge_for_conversation(conversation_id)
    return count
