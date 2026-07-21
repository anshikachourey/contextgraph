"""Tests for SIE semantic-stage protocols.

Verifies:
- Protocol classes are importable and have the correct method signatures.
- A mock implementation satisfies the Protocol type check.
- No actual semantic logic is implemented in the protocol module.
"""

import inspect
from typing import get_type_hints, runtime_checkable, Protocol

import pytest

from app.sie.protocols import (
    CohesionAnalyzer,
    IdentityResolver,
    PacketFormer,
    PropositionExtractor,
    RetentionAssessor,
)
from app.sie.models import (
    IdentityResolutionResult,
    Proposition,
    RetentionDecision,
    SemanticPacket,
    SIEMessage,
)
from app.sie.associations import PacketMembership, PacketSplitRecord


# ---------------------------------------------------------------------------
# Importability and structure tests
# ---------------------------------------------------------------------------


class TestProtocolImportability:
    """Verify protocols are importable and have expected structure."""

    def test_retention_assessor_importable(self) -> None:
        assert RetentionAssessor is not None
        assert hasattr(RetentionAssessor, "assess")
        assert "version" in RetentionAssessor.__annotations__

    def test_proposition_extractor_importable(self) -> None:
        assert PropositionExtractor is not None
        assert hasattr(PropositionExtractor, "extract")
        assert "version" in PropositionExtractor.__annotations__

    def test_packet_former_importable(self) -> None:
        assert PacketFormer is not None
        assert hasattr(PacketFormer, "form_packets")
        assert "version" in PacketFormer.__annotations__

    def test_cohesion_analyzer_importable(self) -> None:
        assert CohesionAnalyzer is not None
        assert hasattr(CohesionAnalyzer, "analyze")
        assert "version" in CohesionAnalyzer.__annotations__

    def test_identity_resolver_importable(self) -> None:
        assert IdentityResolver is not None
        assert hasattr(IdentityResolver, "resolve")
        assert "version" in IdentityResolver.__annotations__


class TestProtocolMethodSignatures:
    """Verify protocol methods have the correct signatures."""

    def test_retention_assessor_assess_is_async(self) -> None:
        assert inspect.iscoroutinefunction(RetentionAssessor.assess)

    def test_proposition_extractor_extract_is_async(self) -> None:
        assert inspect.iscoroutinefunction(PropositionExtractor.extract)

    def test_packet_former_form_packets_is_async(self) -> None:
        assert inspect.iscoroutinefunction(PacketFormer.form_packets)

    def test_cohesion_analyzer_analyze_is_async(self) -> None:
        assert inspect.iscoroutinefunction(CohesionAnalyzer.analyze)

    def test_identity_resolver_resolve_is_async(self) -> None:
        assert inspect.iscoroutinefunction(IdentityResolver.resolve)

    def test_retention_assessor_assess_params(self) -> None:
        sig = inspect.signature(RetentionAssessor.assess)
        params = list(sig.parameters.keys())
        assert "self" in params
        assert "messages" in params
        assert "context" in params

    def test_proposition_extractor_extract_params(self) -> None:
        sig = inspect.signature(PropositionExtractor.extract)
        params = list(sig.parameters.keys())
        assert "self" in params
        assert "messages" in params
        assert "retention_decisions" in params
        assert "context" in params

    def test_packet_former_form_packets_params(self) -> None:
        sig = inspect.signature(PacketFormer.form_packets)
        params = list(sig.parameters.keys())
        assert "self" in params
        assert "propositions" in params
        assert "context" in params

    def test_cohesion_analyzer_analyze_params(self) -> None:
        sig = inspect.signature(CohesionAnalyzer.analyze)
        params = list(sig.parameters.keys())
        assert "self" in params
        assert "packets" in params
        assert "propositions" in params
        assert "context" in params

    def test_identity_resolver_resolve_params(self) -> None:
        sig = inspect.signature(IdentityResolver.resolve)
        params = list(sig.parameters.keys())
        assert "self" in params
        assert "packets" in params
        assert "context" in params


# ---------------------------------------------------------------------------
# Mock implementations to verify Protocol structural subtyping
# ---------------------------------------------------------------------------


class _MockGraphStateContext:
    """Minimal stand-in for GraphStateContext for testing protocol compliance."""

    graph_version: int = 1
    concerns: list = []
    propositions: list = []
    active_associations: list = []
    pending_decisions: list = []


class MockRetentionAssessor:
    """Mock implementation satisfying the RetentionAssessor protocol."""

    version: str = "mock-1.0"

    async def assess(
        self,
        messages: list[SIEMessage],
        context: _MockGraphStateContext,
    ) -> list[RetentionDecision]:
        return []


class MockPropositionExtractor:
    """Mock implementation satisfying the PropositionExtractor protocol."""

    version: str = "mock-1.0"

    async def extract(
        self,
        messages: list[SIEMessage],
        retention_decisions: list[RetentionDecision],
        context: _MockGraphStateContext,
    ) -> list[Proposition]:
        return []


class MockPacketFormer:
    """Mock implementation satisfying the PacketFormer protocol."""

    version: str = "mock-1.0"

    async def form_packets(
        self,
        propositions: list[Proposition],
        context: _MockGraphStateContext,
    ) -> tuple[list[SemanticPacket], list[PacketMembership]]:
        return ([], [])


class MockCohesionAnalyzer:
    """Mock implementation satisfying the CohesionAnalyzer protocol."""

    version: str = "mock-1.0"

    async def analyze(
        self,
        packets: list[SemanticPacket],
        propositions: list[Proposition],
        context: _MockGraphStateContext,
    ) -> tuple[list[SemanticPacket], list[PacketSplitRecord]]:
        return ([], [])


class MockIdentityResolver:
    """Mock implementation satisfying the IdentityResolver protocol."""

    version: str = "mock-1.0"

    async def resolve(
        self,
        packets: list[SemanticPacket],
        context: _MockGraphStateContext,
    ) -> list[IdentityResolutionResult]:
        return []


class TestMockProtocolCompliance:
    """Verify mock implementations are structurally compatible with protocols.

    Uses isinstance checks with runtime_checkable Protocol wrappers to confirm
    structural subtyping compliance.
    """

    def test_mock_retention_assessor_compliance(self) -> None:
        # Create runtime-checkable version for isinstance verification
        @runtime_checkable
        class _CheckableRetentionAssessor(Protocol):
            version: str

            async def assess(self, messages: list, context: object) -> list:
                ...

        impl = MockRetentionAssessor()
        assert isinstance(impl, _CheckableRetentionAssessor)
        assert impl.version == "mock-1.0"

    def test_mock_proposition_extractor_compliance(self) -> None:
        @runtime_checkable
        class _CheckablePropositionExtractor(Protocol):
            version: str

            async def extract(
                self, messages: list, retention_decisions: list, context: object
            ) -> list:
                ...

        impl = MockPropositionExtractor()
        assert isinstance(impl, _CheckablePropositionExtractor)
        assert impl.version == "mock-1.0"

    def test_mock_packet_former_compliance(self) -> None:
        @runtime_checkable
        class _CheckablePacketFormer(Protocol):
            version: str

            async def form_packets(self, propositions: list, context: object) -> tuple:
                ...

        impl = MockPacketFormer()
        assert isinstance(impl, _CheckablePacketFormer)
        assert impl.version == "mock-1.0"

    def test_mock_cohesion_analyzer_compliance(self) -> None:
        @runtime_checkable
        class _CheckableCohesionAnalyzer(Protocol):
            version: str

            async def analyze(
                self, packets: list, propositions: list, context: object
            ) -> tuple:
                ...

        impl = MockCohesionAnalyzer()
        assert isinstance(impl, _CheckableCohesionAnalyzer)
        assert impl.version == "mock-1.0"

    def test_mock_identity_resolver_compliance(self) -> None:
        @runtime_checkable
        class _CheckableIdentityResolver(Protocol):
            version: str

            async def resolve(self, packets: list, context: object) -> list:
                ...

        impl = MockIdentityResolver()
        assert isinstance(impl, _CheckableIdentityResolver)
        assert impl.version == "mock-1.0"


# ---------------------------------------------------------------------------
# Verify no semantic logic is implemented
# ---------------------------------------------------------------------------


class TestNoSemanticLogicImplemented:
    """Verify protocols contain no actual implementation logic."""

    def test_protocols_module_has_no_model_calls(self) -> None:
        """The protocols module should not import or reference any LLM/model
        invocation libraries."""
        import app.sie.protocols as protocols_module

        source = inspect.getsource(protocols_module)
        # Should not contain actual implementation patterns
        assert "openai" not in source.lower()
        assert "anthropic" not in source.lower()
        assert "langchain" not in source.lower()
        assert "litellm" not in source.lower()
        assert "httpx.post" not in source
        assert "requests.post" not in source

    def test_protocols_module_has_no_retrieval_logic(self) -> None:
        """The protocols module should not contain any vector search or
        retrieval implementation."""
        import app.sie.protocols as protocols_module

        source = inspect.getsource(protocols_module)
        assert "pgvector" not in source.lower()
        assert "embedding" not in source.lower()
        assert "similarity_search" not in source
        assert "vector_store" not in source

    def test_protocols_module_has_no_threshold_logic(self) -> None:
        """The protocols module should not contain any threshold or heuristic
        constants defined as code (not in docstrings)."""
        import app.sie.protocols as protocols_module

        source = inspect.getsource(protocols_module)
        # No hardcoded threshold constants or heuristic values
        assert "CONFIDENCE_THRESHOLD" not in source
        assert "MIN_SCORE" not in source
        assert "MAX_SCORE" not in source
        # No numeric threshold assignments
        lines = source.split("\n")
        for line in lines:
            stripped = line.strip()
            # Skip comments and docstrings
            if stripped.startswith("#") or stripped.startswith('"') or stripped.startswith("'"):
                continue
            # No threshold variable assignments like THRESHOLD = 0.8
            if "threshold" in stripped.lower() and "=" in stripped and not stripped.startswith("assert"):
                pytest.fail(f"Found threshold logic: {stripped}")

    def test_protocol_methods_are_abstract(self) -> None:
        """Protocol methods should use ... (Ellipsis) as body, not return values."""
        import app.sie.protocols as protocols_module

        source = inspect.getsource(protocols_module)
        # Count return statements (should only appear in type annotations, not logic)
        # Actual returns of fabricated data would use "return [" or "return ("
        lines = source.split("\n")
        for line in lines:
            stripped = line.strip()
            # Skip comment lines, docstrings, and type annotations
            if stripped.startswith("#") or stripped.startswith('"""') or stripped.startswith("->"):
                continue
            # No fabricated return values
            assert not stripped.startswith("return ["), (
                f"Protocol should not return fabricated lists: {stripped}"
            )
            assert not stripped.startswith("return ("), (
                f"Protocol should not return fabricated tuples: {stripped}"
            )


class TestPendingDecisionLifecycleDocumented:
    """Verify that pending decision lifecycle expectations are documented."""

    def test_module_documents_pending_decision_lifecycle(self) -> None:
        """The protocols module docstring should describe the pending decision lifecycle."""
        import app.sie.protocols as protocols_module

        docstring = protocols_module.__doc__
        assert docstring is not None
        assert "pending" in docstring.lower()
        assert "persist" in docstring.lower()
        assert "resolved" in docstring.lower()
        assert "lifecycle_state" in docstring
        assert "resolved_at" in docstring

    def test_module_documents_creation_semantics(self) -> None:
        """Lifecycle documentation covers creation when stage cannot resolve."""
        import app.sie.protocols as protocols_module

        docstring = protocols_module.__doc__
        assert "cannot" in docstring.lower() or "unresolved" in docstring.lower()
        assert "creation" in docstring.lower() or "created" in docstring.lower()

    def test_module_documents_persistence_across_requests(self) -> None:
        """Lifecycle documentation covers persistence across requests."""
        import app.sie.protocols as protocols_module

        docstring = protocols_module.__doc__
        assert "persist" in docstring.lower()
        assert "request" in docstring.lower() or "invocation" in docstring.lower()

    def test_module_documents_resolution_without_deletion(self) -> None:
        """Lifecycle documentation states resolution does NOT delete records."""
        import app.sie.protocols as protocols_module

        docstring = protocols_module.__doc__
        assert "NOT delete" in docstring or "not delete" in docstring.lower()

    def test_module_documents_reload_into_context(self) -> None:
        """Lifecycle documentation describes reloading into GraphStateContext."""
        import app.sie.protocols as protocols_module

        docstring = protocols_module.__doc__
        assert "reload" in docstring.lower() or "reloaded" in docstring.lower()
        assert "GraphStateContext" in docstring
