"""Tests for SIE route processing mode dispatch and fail-closed behavior.

Validates:
- FULL_PIPELINE returns 503 (upstream not implemented)
- IDENTITY_RESOLUTION_ONLY dispatches to pipeline with proper validation
- PENDING_RE_EVALUATION validates trigger and dispatches to pipeline
- Fail-closed: missing policy → DEFER result
- Fail-closed: incomplete context → DEFER result
- Fail-closed: model exhaustion (pipeline failure) → DEFER result
- Fail-closed: invalid trigger → HTTP 422
- Never fabricates successful semantic output
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.sie.enums import PipelineOutcome, ProcessingMode
from app.sie.identity_policy import (
    ChannelFamilyRequirement,
    ChannelInvocation,
    IdentityResolutionPolicy,
    ReEvaluationPolicy,
    RetrievalPolicy,
    WideningBudgetPolicy,
)
from app.sie.pipeline import PipelineResult
from app.sie.routes import set_pipeline, set_policy


@pytest.fixture
def client():
    """Create a test client for the FastAPI app."""
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_injections():
    """Reset global pipeline and policy injections after each test."""
    yield
    set_pipeline(None)
    set_policy(None)


def _make_policy() -> IdentityResolutionPolicy:
    """Build a minimal valid IdentityResolutionPolicy for testing."""
    return IdentityResolutionPolicy(
        policy_version="1.0.0",
        retrieval_policy=RetrievalPolicy(
            policy_version="1.0.0",
            initial_channels=[
                ChannelInvocation(
                    channel_id="ch-embed-1",
                    query_mode="semantic_similarity",
                    scope_overrides={},
                )
            ],
            channel_family_requirements={
                "embedding_primary": ChannelFamilyRequirement(
                    required_for_adequacy=True,
                    min_successful_attempts=1,
                    failure_blocks_no_match=True,
                )
            },
            irs_signal_channel_mapping={},
        ),
        widening_budget=WideningBudgetPolicy(
            budget_version="1.0.0",
            max_widening_rounds=3,
            max_total_attempts=10,
            max_latency_ms=5000,
            max_cost_units=100.0,
        ),
        pending_re_evaluation_policy=ReEvaluationPolicy(
            policy_version="1.0.0",
            triggers=["new_evidence", "policy_change", "alias_change"],
            max_re_evaluation_attempts=3,
            cooldown_between_attempts_ms=60000,
        ),
        permitted_embedding_model_versions=["v1.0"],
    )


def _valid_request_body(
    processing_mode: str = "FULL_PIPELINE",
    **overrides,
) -> dict:
    """Build a valid ProcessRequest body for testing with configurable mode."""
    body = {
        "api_contract_version": "1.0.0",
        "pipeline_version": "1.0.0",
        "model_version": "gpt-4-turbo",
        "extraction_version": "1.0.0",
        "request_id": "req-001",
        "idempotency_key": "idem-001",
        "conversation_id": "conv-001",
        "base_graph_version": 5,
        "message_seq_start": 1,
        "message_seq_end": 3,
        "semantic_policy_version": "1.0.0",
        "retrieval_policy_version": "1.0.0",
        "processing_mode": processing_mode,
        "messages": [
            {
                "message_id": "msg-1",
                "conversation_id": "conv-001",
                "role": "USER",
                "content": "I want to learn Python.",
                "sequence_position": 1,
                "created_at": "2024-01-01T00:00:00Z",
            }
        ],
        "context_window": [],
        "current_graph_state": {
            "graph_version": 5,
            "snapshot_token": "snap-conv001-v5-test",
            "snapshot_digest": "sha256-test-digest",
            "concerns": [],
            "propositions": [],
            "active_associations": [],
            "pending_decisions": [],
        },
    }
    body.update(overrides)
    return body


# ─── FULL_PIPELINE Mode Tests ────────────────────────────────────────────────


class TestFullPipelineMode:
    """FULL_PIPELINE mode should return 503 (upstream not implemented)."""

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_returns_503_for_full_pipeline(self, client: TestClient):
        body = _valid_request_body(processing_mode="FULL_PIPELINE")
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 503
        detail = response.json()["detail"]
        assert "FULL_PIPELINE" in detail
        assert "upstream stages" in detail.lower() or "not implemented" in detail.lower()

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_full_pipeline_does_not_fabricate_output(self, client: TestClient):
        body = _valid_request_body(processing_mode="FULL_PIPELINE")
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 503
        resp_body = response.json()
        # HTTP error, not a ProcessResult
        assert "retention_decisions" not in resp_body
        assert "propositions" not in resp_body

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_full_pipeline_suggests_identity_resolution_only(self, client: TestClient):
        body = _valid_request_body(processing_mode="FULL_PIPELINE")
        response = client.post("/sie/process-messages", json=body)
        detail = response.json()["detail"]
        assert "IDENTITY_RESOLUTION_ONLY" in detail


# ─── IDENTITY_RESOLUTION_ONLY Mode Tests ─────────────────────────────────────


class TestIdentityResolutionOnlyMode:
    """IDENTITY_RESOLUTION_ONLY mode dispatches to the pipeline."""

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_when_no_policy(self, client: TestClient):
        """Missing policy → DEFER result (not HTTP error, not fabricated)."""
        set_policy(None)
        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        # DEFER result — no fabricated identity data
        assert result["identity_resolution_records"] == []
        assert "missing_policy" in result["diagnostics"]["warnings"][0]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_when_no_pipeline(self, client: TestClient):
        """Pipeline not configured → DEFER result."""
        set_policy(_make_policy())
        set_pipeline(None)
        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert result["identity_resolution_records"] == []
        assert "pipeline_not_configured" in result["diagnostics"]["warnings"][0]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_when_no_packets_in_context(self, client: TestClient):
        """No pending_identity_details and no packet_lineage → DEFER."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        set_pipeline(mock_pipeline)
        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        # Empty context — no packets available
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert result["identity_resolution_records"] == []
        assert "incomplete_context" in result["diagnostics"]["warnings"][0]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_on_pipeline_exception(self, client: TestClient):
        """Pipeline raises exception → DEFER (model exhaustion, never fabricate)."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        mock_pipeline.resolve = AsyncMock(
            side_effect=RuntimeError("LLM quota exhausted")
        )
        set_pipeline(mock_pipeline)

        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert result["identity_resolution_records"] == []
        assert "pipeline_failure" in result["diagnostics"]["warnings"][0]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_successful_pipeline_execution(self, client: TestClient):
        """Valid request with pipeline → returns ProcessResult with records."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        mock_pipeline.resolve = AsyncMock(
            return_value=PipelineResult(
                records=[],
                dependency_groups=[],
                mutations=[],
                associations=[],
                pending_bundles=[],
                proposals=[],
            )
        )
        set_pipeline(mock_pipeline)

        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        # Valid ProcessResult shape
        assert "identity_resolution_records" in result
        assert "diagnostics" in result
        assert result["request_id"] == "req-001"
        assert result["conversation_id"] == "conv-001"
        assert result["base_graph_version"] == 5

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_pipeline_called_with_correct_arguments(self, client: TestClient):
        """Verify pipeline.resolve is called with the right parameters."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        mock_pipeline.resolve = AsyncMock(
            return_value=PipelineResult()
        )
        set_pipeline(mock_pipeline)

        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200

        # Verify pipeline was called
        mock_pipeline.resolve.assert_called_once()
        call_kwargs = mock_pipeline.resolve.call_args
        assert call_kwargs.kwargs["request_id"] == "req-001"
        assert call_kwargs.kwargs["conversation_id"] == "conv-001"


# ─── PENDING_RE_EVALUATION Mode Tests ────────────────────────────────────────


class TestPendingReEvaluationMode:
    """PENDING_RE_EVALUATION mode validates trigger and dispatches."""

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_422_when_no_trigger(self, client: TestClient):
        """Missing re_evaluation_trigger → HTTP 422."""
        set_policy(_make_policy())
        body = _valid_request_body(processing_mode="PENDING_RE_EVALUATION")
        # No re_evaluation_trigger set
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422
        assert "re_evaluation_trigger" in response.json()["detail"]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_422_when_invalid_trigger(self, client: TestClient):
        """Invalid trigger value → HTTP 422."""
        set_policy(_make_policy())
        body = _valid_request_body(processing_mode="PENDING_RE_EVALUATION")
        body["re_evaluation_trigger"] = "not_a_valid_trigger"
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "not_a_valid_trigger" in detail
        assert "Configured triggers" in detail

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_when_no_policy(self, client: TestClient):
        """Missing policy → DEFER for re-evaluation."""
        set_policy(None)
        body = _valid_request_body(processing_mode="PENDING_RE_EVALUATION")
        body["re_evaluation_trigger"] = "new_evidence"
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert "missing_policy" in result["diagnostics"]["warnings"][0]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_when_no_pending_decisions(self, client: TestClient):
        """No pending decisions in context → DEFER."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        set_pipeline(mock_pipeline)
        body = _valid_request_body(processing_mode="PENDING_RE_EVALUATION")
        body["re_evaluation_trigger"] = "new_evidence"
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert "no_pending_decisions" in result["diagnostics"]["warnings"][0]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_when_targeted_ids_not_found(self, client: TestClient):
        """Targeted decision IDs not matching → DEFER."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        set_pipeline(mock_pipeline)
        body = _valid_request_body(processing_mode="PENDING_RE_EVALUATION")
        body["re_evaluation_trigger"] = "new_evidence"
        body["targeted_decision_ids"] = ["nonexistent-id"]
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert "targeted_decisions_not_found" in result["diagnostics"]["warnings"][0]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_successful_re_evaluation(self, client: TestClient):
        """Valid trigger + pending decisions → successful pipeline dispatch."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        mock_pipeline.resolve = AsyncMock(
            return_value=PipelineResult()
        )
        set_pipeline(mock_pipeline)

        body = _valid_request_body(processing_mode="PENDING_RE_EVALUATION")
        body["re_evaluation_trigger"] = "new_evidence"
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert result["request_id"] == "req-001"
        assert result["diagnostics"]["stage_versions"]["re_evaluation_trigger"] == "new_evidence"
        mock_pipeline.resolve.assert_called_once()

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_targeted_re_evaluation_filters_decisions(self, client: TestClient):
        """Targeted decision IDs filter which decisions are re-evaluated."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        mock_pipeline.resolve = AsyncMock(
            return_value=PipelineResult()
        )
        set_pipeline(mock_pipeline)

        body = _valid_request_body(processing_mode="PENDING_RE_EVALUATION")
        body["re_evaluation_trigger"] = "policy_change"
        body["targeted_decision_ids"] = ["dec-2"]
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            },
            {
                "decision_id": "dec-2",
                "packet_id": "pkt-2",
                "outcome": "DEFER",
                "proposition_ids": ["prop-2"],
                "graph_version_analyzed": 5,
            },
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200

        # Only dec-2's packet should be processed
        call_kwargs = mock_pipeline.resolve.call_args
        packets = call_kwargs.kwargs["packets"]
        assert len(packets) == 1
        assert packets[0].packet_id == "pkt-2"

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_on_pipeline_exception(self, client: TestClient):
        """Pipeline failure during re-evaluation → DEFER."""
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        mock_pipeline.resolve = AsyncMock(
            side_effect=RuntimeError("model unavailable")
        )
        set_pipeline(mock_pipeline)

        body = _valid_request_body(processing_mode="PENDING_RE_EVALUATION")
        body["re_evaluation_trigger"] = "new_evidence"
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert "re_evaluation_failure" in result["diagnostics"]["warnings"][0]


# ─── Fail-Closed Behavior Tests ──────────────────────────────────────────────


class TestFailClosedBehavior:
    """Verify the route never fabricates successful semantic output."""

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_result_has_empty_identity_records(self, client: TestClient):
        """DEFER results must not contain fabricated identity records."""
        set_policy(None)
        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        result = response.json()
        assert result["identity_resolution_records"] == []
        assert result["identity_mutations"] == []
        assert result["new_concern_proposals"] == []
        assert result["proposed_associations"] == []

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_defer_result_preserves_request_metadata(self, client: TestClient):
        """DEFER results echo back request metadata for correlation."""
        set_policy(None)
        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        result = response.json()
        assert result["request_id"] == "req-001"
        assert result["idempotency_key"] == "idem-001"
        assert result["conversation_id"] == "conv-001"
        assert result["base_graph_version"] == 5
        assert result["api_contract_version"] == "1.0.0"

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_stale_snapshot_produces_defer(self, client: TestClient):
        """Stale snapshot reaching Python → DEFER (TypeScript normally catches)."""
        # If somehow stale data reaches Python (unlikely but fail-closed),
        # the pipeline exception path catches it
        set_policy(_make_policy())
        mock_pipeline = MagicMock()
        mock_pipeline.resolve = AsyncMock(
            side_effect=ValueError("Stale snapshot: graph version mismatch")
        )
        set_pipeline(mock_pipeline)

        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 200
        result = response.json()
        assert result["identity_resolution_records"] == []
        assert "pipeline_failure" in result["diagnostics"]["warnings"][0]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", False)
    def test_endpoint_disabled_returns_503(self, client: TestClient):
        """Endpoint disabled → 503 regardless of mode."""
        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 503
        assert "disabled" in response.json()["detail"].lower()

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_invalid_processing_mode_rejected(self, client: TestClient):
        """Invalid processing mode in request → HTTP 422 from Pydantic."""
        body = _valid_request_body(processing_mode="INVALID_MODE")
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_no_pipeline_no_fabrication(self, client: TestClient):
        """Without pipeline, endpoint never returns fabricated YES/NO results."""
        set_policy(_make_policy())
        set_pipeline(None)
        body = _valid_request_body(processing_mode="IDENTITY_RESOLUTION_ONLY")
        body["current_graph_state"]["pending_identity_details"] = [
            {
                "decision_id": "dec-1",
                "packet_id": "pkt-1",
                "outcome": "UNRESOLVED",
                "proposition_ids": ["prop-1"],
                "graph_version_analyzed": 5,
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        result = response.json()
        # No fabricated results
        for record in result["identity_resolution_records"]:
            assert record["outcome"] not in ["YES", "NO"]
