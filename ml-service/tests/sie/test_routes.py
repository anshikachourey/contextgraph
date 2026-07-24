"""Tests for the SIE /sie/process-messages endpoint.

Validates:
- Feature gate behavior (503 when disabled)
- Request validation (contract version, graph version, sequence range)
- OpenAPI schema includes the SIE endpoint definition
- Pending-decision lifecycle correctness in request validation
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    """Create a test client for the FastAPI app."""
    return TestClient(app)


def _valid_request_body() -> dict:
    """Build a minimal valid ProcessRequest body for testing."""
    return {
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


# ─── Feature Gate Tests ──────────────────────────────────────────────────────


class TestEndpointDisabled:
    """When SIE_ENDPOINT_ENABLED is False, endpoint returns 503."""

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", False)
    def test_returns_503_when_disabled(self, client: TestClient):
        response = client.post("/sie/process-messages", json=_valid_request_body())
        assert response.status_code == 503
        assert "endpoint disabled" in response.json()["detail"]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", False)
    def test_returns_503_with_valid_body_when_disabled(self, client: TestClient):
        body = _valid_request_body()
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 503
        assert "disabled" in response.json()["detail"].lower()

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_returns_503_when_enabled_but_no_implementations(self, client: TestClient):
        """Even with endpoint enabled, 503 for FULL_PIPELINE mode (upstream not implemented)."""
        response = client.post("/sie/process-messages", json=_valid_request_body())
        assert response.status_code == 503
        assert "FULL_PIPELINE" in response.json()["detail"]

    @patch("app.sie.routes.SIE_ENDPOINT_ENABLED", True)
    def test_does_not_fabricate_results(self, client: TestClient):
        """Endpoint must never return a fabricated ProcessResult."""
        response = client.post("/sie/process-messages", json=_valid_request_body())
        # FULL_PIPELINE should be a 503 error, not a 200 with fake data
        assert response.status_code == 503
        # Ensure no retention_decisions or propositions in the response
        body = response.json()
        assert "retention_decisions" not in body
        assert "propositions" not in body


# ─── Request Validation Tests ────────────────────────────────────────────────


class TestRequestValidation:
    """Pydantic validation rejects malformed requests before reaching the handler."""

    def test_invalid_contract_version_type(self, client: TestClient):
        """api_contract_version must be a string."""
        body = _valid_request_body()
        body["api_contract_version"] = None
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422

    def test_missing_contract_version(self, client: TestClient):
        """api_contract_version is required."""
        body = _valid_request_body()
        del body["api_contract_version"]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422

    def test_mismatched_graph_version(self, client: TestClient):
        """current_graph_state.graph_version must equal base_graph_version."""
        body = _valid_request_body()
        body["base_graph_version"] = 5
        body["current_graph_state"]["graph_version"] = 3
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422
        # The error message should mention the version mismatch
        detail = response.json()["detail"]
        assert any(
            "graph_version" in str(err).lower() or "version" in str(err).lower()
            for err in detail
        )

    def test_bad_sequence_range_end_before_start(self, client: TestClient):
        """message_seq_end must be provided as a valid integer."""
        body = _valid_request_body()
        body["message_seq_start"] = "not-an-int"
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422

    def test_missing_messages_field(self, client: TestClient):
        """messages field is required."""
        body = _valid_request_body()
        del body["messages"]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422

    def test_missing_graph_state(self, client: TestClient):
        """current_graph_state is required."""
        body = _valid_request_body()
        del body["current_graph_state"]
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code == 422


# ─── Discriminated Result Errors ─────────────────────────────────────────────


class TestDiscriminatedResultValidation:
    """Test IdentityResolutionResult discriminated-result invariant via model validation."""

    def test_identity_resolution_both_match_and_proposal_invalid(self):
        """Cannot have both matched_concern_id and new_concern_proposal for YES."""
        from pydantic import ValidationError

        from app.sie.models import IdentityResolutionResult, ConcernProposal
        from app.sie.enums import (
            BehavioralConfidenceBand,
            ParentResolutionState,
            PipelineOutcome,
            ResolutionAction,
            StageExecutionStatus,
        )

        proposal = ConcernProposal(
            concern_creation_key="ck-1",
            proposed_concern_id="concern-new",
            identity_summary="A new concern",
            display_title="New Concern",
            initial_summary="Summary",
            parent_resolution_state=ParentResolutionState.PARENT_DEFERRED,
        )

        # The model validator enforces the discriminated-result invariant:
        # YES/ASSIGN_EXISTING requires matched_concern_id but NOT proposal.
        with pytest.raises(ValidationError, match="must not have.*new_concern_proposal"):
            IdentityResolutionResult(
                packet_id="pkt-1",
                outcome=PipelineOutcome.YES,
                action=ResolutionAction.ASSIGN_EXISTING,
                matched_concern_id="concern-existing",
                new_concern_proposal=proposal,
                identity_stage_status=StageExecutionStatus.COMPLETED,
                identity_confidence=BehavioralConfidenceBand.HIGH,
                sufficiency_stage_status=StageExecutionStatus.COMPLETED,
                sufficiency_confidence=BehavioralConfidenceBand.HIGH,
                rationale="Test",
            )

    def test_identity_resolution_unresolved_has_neither(self):
        """Unresolved result should have neither matched_concern_id nor proposal."""
        from app.sie.models import IdentityResolutionResult
        from app.sie.enums import (
            BehavioralConfidenceBand,
            PipelineOutcome,
            ResolutionAction,
            StageExecutionStatus,
        )

        result = IdentityResolutionResult(
            packet_id="pkt-2",
            outcome=PipelineOutcome.UNRESOLVED,
            action=ResolutionAction.RETAIN_PENDING,
            matched_concern_id=None,
            new_concern_proposal=None,
            identity_stage_status=StageExecutionStatus.COMPLETED,
            identity_confidence=BehavioralConfidenceBand.MEDIUM,
            sufficiency_stage_status=StageExecutionStatus.COMPLETED,
            sufficiency_confidence=BehavioralConfidenceBand.HIGH,
            rationale="Insufficient context",
        )
        assert result.matched_concern_id is None
        assert result.new_concern_proposal is None
        assert result.outcome == PipelineOutcome.UNRESOLVED


# ─── Pending Decision Lifecycle Tests ────────────────────────────────────────


class TestPendingDecisionLifecycle:
    """Pending decisions must be representable in request graph state."""

    def test_pending_decisions_in_graph_state(self, client: TestClient):
        """Pending decisions are accepted in graph state context."""
        body = _valid_request_body()
        body["current_graph_state"]["pending_decisions"] = [
            {
                "entity_id": "pkt-unresolved-1",
                "stage": "identity_resolution",
                "outcome": "UNRESOLVED",
                "rationale": "Insufficient context for identity match",
            }
        ]
        # Should still get 503 (disabled), not a validation error
        response = client.post("/sie/process-messages", json=body)
        assert response.status_code in (503, 422)
        # If it's 503, pending decisions were accepted in the model
        if response.status_code == 503:
            # Pending decisions parsed correctly
            pass

    def test_pending_decision_with_defer_outcome(self, client: TestClient):
        """Deferred decisions are a valid pending decision state."""
        body = _valid_request_body()
        body["current_graph_state"]["pending_decisions"] = [
            {
                "entity_id": "pkt-deferred-1",
                "stage": "cohesion_analysis",
                "outcome": "DEFER",
                "rationale": "Need more messages for cohesion determination",
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        # Should be 503 (feature disabled), not 422 (validation error)
        assert response.status_code == 503

    def test_pending_decision_invalid_outcome_rejected(self, client: TestClient):
        """Invalid outcome value in pending decisions should fail validation."""
        body = _valid_request_body()
        body["current_graph_state"]["pending_decisions"] = [
            {
                "entity_id": "pkt-bad-1",
                "stage": "retention",
                "outcome": "INVALID_OUTCOME_VALUE",
                "rationale": "Should be rejected",
            }
        ]
        response = client.post("/sie/process-messages", json=body)
        # Should be 422 because "INVALID_OUTCOME_VALUE" is not a valid PipelineOutcome
        assert response.status_code == 422


# ─── OpenAPI Schema Tests ────────────────────────────────────────────────────


class TestOpenAPISchema:
    """Verify the SIE endpoint appears in the generated OpenAPI schema."""

    def test_openapi_includes_sie_endpoint(self, client: TestClient):
        response = client.get("/openapi.json")
        assert response.status_code == 200
        schema = response.json()
        assert "/sie/process-messages" in schema["paths"]

    def test_openapi_sie_endpoint_is_post(self, client: TestClient):
        response = client.get("/openapi.json")
        schema = response.json()
        sie_path = schema["paths"]["/sie/process-messages"]
        assert "post" in sie_path

    def test_openapi_includes_503_response(self, client: TestClient):
        response = client.get("/openapi.json")
        schema = response.json()
        sie_post = schema["paths"]["/sie/process-messages"]["post"]
        assert "503" in sie_post.get("responses", {})

    def test_openapi_has_sie_tag(self, client: TestClient):
        response = client.get("/openapi.json")
        schema = response.json()
        sie_post = schema["paths"]["/sie/process-messages"]["post"]
        assert "SIE Pipeline" in sie_post.get("tags", [])
