"""Contract drift tests for the SIE OpenAPI artifact.

These tests ensure the checked-in contract artifact stays in sync with
the Python models. If models change without regenerating the artifact,
these tests fail with an actionable message.

Additionally verifies that critical contract structures are present in
the generated schema.
"""

import json
import sys
from pathlib import Path

import pytest

# Ensure ml-service root is importable
_ML_SERVICE_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_ML_SERVICE_ROOT))

from app.main import app  # noqa: E402

_CONTRACTS_DIR = _ML_SERVICE_ROOT / "contracts"
_ARTIFACT_PATH = _CONTRACTS_DIR / "sie-openapi.json"


def _generate_current_schema() -> str:
    """Generate the current OpenAPI schema from the FastAPI app (deterministic)."""
    schema = app.openapi()
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


class TestContractDrift:
    """Verify the checked-in OpenAPI artifact matches the current models."""

    def test_artifact_exists(self):
        """The contract artifact must be checked in."""
        assert _ARTIFACT_PATH.exists(), (
            f"Contract artifact not found at {_ARTIFACT_PATH}. "
            "Run `python scripts/export_openapi.py` to generate it."
        )

    def test_artifact_is_not_stale(self):
        """Re-generated schema must match the checked-in artifact exactly."""
        if not _ARTIFACT_PATH.exists():
            pytest.skip("Artifact does not exist; see test_artifact_exists")

        checked_in = _ARTIFACT_PATH.read_text(encoding="utf-8")
        current = _generate_current_schema()

        assert checked_in == current, (
            "Contract artifact is stale. "
            "Run `python scripts/export_openapi.py` to regenerate."
        )


class TestContractStructures:
    """Verify critical structures are present in the generated transport contract."""

    @pytest.fixture(autouse=True)
    def _load_schema(self):
        """Load the schema once for all structure tests."""
        schema_text = _generate_current_schema()
        self.schema = json.loads(schema_text)
        self.schema_str = schema_text

    def test_established_by_packet_id_present(self):
        """The established_by_packet_id field must be in the schema."""
        assert "established_by_packet_id" in self.schema_str, (
            "established_by_packet_id is missing from the OpenAPI schema. "
            "PropositionAssociation must include this field per the SIE data model."
        )

    def test_pending_decision_summary_present(self):
        """PendingDecisionSummary must be defined in the schema."""
        schemas = self.schema.get("components", {}).get("schemas", {})
        assert "PendingDecisionSummary" in schemas, (
            "PendingDecisionSummary is missing from the OpenAPI schema definitions. "
            "Pending-decision structures must be present in the transport contract."
        )

    def test_pending_decision_summary_has_required_fields(self):
        """PendingDecisionSummary must contain entity_id, stage, and outcome."""
        schemas = self.schema.get("components", {}).get("schemas", {})
        pending = schemas.get("PendingDecisionSummary", {})
        properties = pending.get("properties", {})
        assert "entity_id" in properties, "PendingDecisionSummary missing entity_id"
        assert "stage" in properties, "PendingDecisionSummary missing stage"
        assert "outcome" in properties, "PendingDecisionSummary missing outcome"

    def test_graph_state_includes_pending_decisions(self):
        """GraphStateContext must include a pending_decisions field."""
        schemas = self.schema.get("components", {}).get("schemas", {})
        graph_state = schemas.get("GraphStateContext", {})
        properties = graph_state.get("properties", {})
        assert "pending_decisions" in properties, (
            "GraphStateContext is missing the pending_decisions field. "
            "Pending decisions must be surfaced in the graph state context."
        )

    def test_proposition_association_in_schema(self):
        """PropositionAssociation must be a defined schema with established_by_packet_id."""
        schemas = self.schema.get("components", {}).get("schemas", {})
        assoc = schemas.get("PropositionAssociation", {})
        properties = assoc.get("properties", {})
        assert "established_by_packet_id" in properties, (
            "PropositionAssociation schema is missing established_by_packet_id field."
        )
