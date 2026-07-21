# SIE Data Model — Implementation Handoff

**Spec:** SIE Data Model (Final Corrected)  
**Status:** Foundation complete — ready for downstream semantic stage implementation  
**Default Authority:** V2 remains the production authoritative engine

---

## 1. Python Models Created (`ml-service/app/sie/`)

| File | Purpose |
|------|---------|
| `enums.py` | All SIE string enums: `RetentionLevel`, `BehavioralConfidenceBand`, `PipelineOutcome`, `PropositionType`, `PropositionProvenance`, `SemanticState`, `CohesionStatus`, `ConcernStatus`, `ParentResolutionState`, `AssociationRole` |
| `id_generation.py` | Stable, idempotent entity ID resolution via UUIDv5 namespaces. Creation-key builders for requests, propositions, packets, concerns, associations, memberships, splits, retention decisions, and pending decisions. Mutable text excluded from ID derivation. |
| `models.py` | Core Pydantic models: `RetentionDecision`, `SIEMessage`, `Proposition`, `ProvisionalConcernBoundary`, `SemanticPacket`, `IdentityResolutionResult`, `ConcernProposal`, `PersistentConcern`, `PendingSemanticDecision` |
| `associations.py` | Normalized association models: `PropositionAssociation` (with `established_by_packet_id`), `PacketMembership`, `PacketSplitRecord` |
| `contracts.py` | Versioned API contract: `ProcessRequest`, `ProcessResult`, `GraphStateContext`, `ConcernSummary`, `PropositionSummary`, `AssociationSummary`, `PendingDecisionSummary`, `PipelineDiagnostics`, `SemanticDependencyGroupRef` |
| `protocols.py` | Typed Protocol interfaces for `RetentionAssessor`, `PropositionExtractor`, `PacketFormer`, `CohesionAnalyzer`, `IdentityResolver` — no implementations |
| `routes.py` | FastAPI router exposing `/sie/process-messages` (disabled by default via config gate). Returns 503 when no stage implementations are installed. |
| `config.py` | Feature flag configuration: `SIE_ENABLED`, `SIE_CONTRACT_ENDPOINT_ENABLED`, `SIE_SHADOW_ENABLED` |

---

## 2. Supabase Migrations Created (`docs/migrations/sie/`)

| File | Purpose |
|------|---------|
| `001_authoritative_engine_and_idempotency.sql` | Adds `authoritative_engine` and `sie_cutover_graph_version` to `v2_update_state`; creates `sie_entity_registry` and `sie_commit_requests` |
| `002_persistent_concerns_and_aliases.sql` | Creates `sie_persistent_concerns` with lifecycle/parent/merge constraints; creates `sie_concern_aliases` with partial unique index on active aliases |
| `003_propositions_and_associations.sql` | Creates `sie_propositions`; creates `sie_proposition_associations` with normalized roles, `established_by_packet_id`, and active PRIMARY_OWNER partial unique index |
| `004_packets_memberships_and_splits.sql` | Creates `sie_semantic_packets`, `sie_packet_memberships`, `sie_packet_splits`; adds deferred FK from associations to packets |
| `005_retention_pending_decisions_and_audit.sql` | Creates `sie_retention_decisions`, `sie_pending_semantic_decisions`, and append-only `sie_audit_history` |
| `006_indexes_and_rls_policies.sql` | Adds conversation-scoped indexes and RLS policies preventing direct client mutation of SIE state |
| `007_rollback.sql` | Reversible rollback procedure: drops all SIE tables, removes added columns from `v2_update_state` |
| `008_versioned_commit_rpc.sql` | Extended `v2_commit_update` RPC with optional SIE parameters (`p_sie_commit_bundle`, `p_request_id`, `p_idempotency_key`, `p_required_engine`). Returns `jsonb`. Backward-compatible — existing V2 callers unchanged. |
| `schema_tests.sql` | Verification queries for CHECK constraints, FK integrity, uniqueness, partial indexes, and RLS enforcement |
| `README.md` | Migration conventions, dependency order, application instructions, and rollback procedures |

---

## 3. TypeScript Implementation (`src/lib/intelligence-v2/sie/`)

| File | Purpose |
|------|---------|
| `generated/transport-types.ts` | Transport types generated from the Python OpenAPI contract (enums, `ProcessRequest`, `ProcessResult`, all entity/association/decision types) |
| `generated/index.ts` | Re-exports for generated types |
| `types.ts` | TypeScript-owned orchestration types: `SIEOrchestratorResult`, `InvariantValidationResult`, `InvariantViolation`, `CommitResult`, `SIEGraphState` |
| `graph-state-retriever.ts` | Loads concerns (ACTIVE, DORMANT, RETIRED, MERGED), propositions, associations, aliases, packets, pending decisions, graph version, and authority state for one conversation. Produces `GraphStateContext`. |
| `invariant-validator.ts` | Deterministic structural validation: dangling references, conversation boundaries, one active PRIMARY_OWNER per proposition, single parent, acyclicity, parent-resolution consistency, merge redirects, sequence ranges, base graph version, dependency groups, pending-decision lifecycle |
| `v2-projection.ts` | Projects SIE authoritative state → V2 `SnapshotPayload` for React Flow UI. Maps: PersistentConcern → ConversationalObject, associations → propositionIds/supportingUtteranceIds, confidence bands → numeric, status → V2 status, hierarchy from parent chain, synthetic threads |
| `commit-manager.ts` | Builds validated commit bundles, invokes extended `v2_commit_update` RPC, handles idempotency replay and version-conflict retry semantics |
| `authority-state-machine.ts` | Authority state transitions (V2 → SIE_SHADOW → SIE) with validation. Enforces single writer per conversation. |
| `feature-flags.ts` | Runtime feature flag checks: `SIE_CONTRACT_ENDPOINT_ENABLED`, `SIE_SHADOW_ENABLED`, `SIE_AUTHORITY_ENABLED` |
| `cutover-manager.ts` | Cutover and rollback operations with graph-version guards and audit records. Does not activate SIE for production conversations. |

---

## 4. Test Suites

### Python (`ml-service/tests/sie/`)

| File | Coverage |
|------|----------|
| `test_enums.py` | Serialization round-trip for all enum values |
| `test_id_generation.py` | Creation-key stability, namespace isolation, mutable-text exclusion, deterministic ID resolution |
| `test_models.py` | Model construction, validation, discriminated-result invariants, state transitions, pending decisions |
| `test_associations.py` | Multi-role validity, `established_by_packet_id`, split provenance, invalidation/replacement |
| `test_contracts.py` | Contract version enforcement, graph-version consistency, sequence-range validation, pending-decision lifecycle |
| `test_protocols.py` | Protocol interface compliance, lifecycle expectations |
| `test_routes.py` | Endpoint registration, 503 when unavailable, OpenAPI schema presence, config gating |
| `test_property_models.py` | Hypothesis property-based tests: retention-role preservation, ID stability, provenance immutability, association role combinations |
| `test_contract_drift.py` | Detects Python model changes without regenerated contract artifacts |

### TypeScript (`src/lib/intelligence-v2/sie/__tests__/`)

| File | Coverage |
|------|----------|
| `contract-drift.test.ts` | Validates generated transport types are not stale vs. Python OpenAPI artifact |
| `contract-roundtrip.test.ts` | Enum, nullability, creation-key, version, `established_by_packet_id`, pending-decision fields round-trip between Python payloads and TypeScript validators |
| `invariant-validator.test.ts` | Cycle detection, multi-parent rejection, dangling references, cross-conversation boundaries, merge-redirect validity, dependency-group completeness |
| `v2-projection.test.ts` | SIE state → V2 SnapshotPayload shape correctness, status mapping, confidence mapping, hierarchy derivation, thread synthesis |
| `commit-manager.test.ts` | Bundle construction, idempotent replay, payload mismatch rejection, version-conflict handling, pending-decision inclusion |
| `authority-state-machine.test.ts` | Valid/invalid transitions, dual-writer rejection, shadow isolation |
| `cutover-manager.test.ts` | Cutover with version guards, rollback mechanics, audit record production |

---

## 5. What Is NOT Implemented (Explicit Scope Boundary)

This spec creates typed interfaces and data structures only. The following semantic algorithms are **not** implemented:

| Stage | Status | Notes |
|-------|--------|-------|
| Retention assessment logic | Not implemented | `RetentionAssessor` protocol defined; no prompts, thresholds, or model calls |
| Proposition extraction logic | Not implemented | `PropositionExtractor` protocol defined; no NLP or LLM extraction |
| Packet formation logic | Not implemented | `PacketFormer` protocol defined; no grouping heuristics |
| Cohesion analysis logic | Not implemented | `CohesionAnalyzer` protocol defined; no similarity/clustering |
| Identity resolution logic | Not implemented | `IdentityResolver` protocol defined; no matching, embedding, or retrieval |
| LLM calls | None | No OpenAI/Anthropic/embedding invocations |
| Embedding operations | None | No vector generation or similarity search |
| Adaptive retrieval | None | No retrieval logic for identity resolution context |
| Production cutover | None | V2 remains the default authoritative engine for all conversations |

The `/sie/process-messages` endpoint returns HTTP 503 (Service Unavailable) until approved stage implementations are installed.

---

## 6. Next Steps for Downstream Specs

### Implement Semantic Stage Logic

Each stage has a typed Protocol interface ready for implementation:

1. **Implement `RetentionAssessor`** — Classify incoming messages using the 6-level retention model. Returns `RetentionDecision` with primary level, secondary roles, confidence band, and outcome.

2. **Implement `PropositionExtractor`** — Extract atomic propositions from retained material. Returns `Proposition` instances with stable creation keys and full provenance.

3. **Implement `PacketFormer`** — Group propositions into concern-cohesive Semantic Packets. Returns `SemanticPacket` instances with `ProvisionalConcernBoundary` analysis.

4. **Implement `CohesionAnalyzer`** — Validate packet cohesion and split MIXED packets. Produces split records preserving provenance lineage.

5. **Implement `IdentityResolver`** — Resolve COHESIVE packets against the Persistent Concern graph. Returns match/new-proposal/unresolved decisions.

### Enable Shadow Mode for Evaluation

6. **Enable `SIE_SHADOW_ENABLED`** — Allows SIE to process messages in parallel with V2 without affecting production state. Use for evaluation, comparison, and validation of semantic quality.

### Production Cutover (After Validation)

7. **Enable cutover for test conversations** — After shadow-mode validation confirms SIE quality meets requirements, use `cutover-manager.ts` to transition individual test conversations from V2 → SIE authority.

### Integration Considerations

- Python is the **authoritative semantic core** — all semantic decisions originate there.
- TypeScript **orchestrates** calls, retrieves graph state, validates structural invariants, and commits atomically.
- The extended `v2_commit_update` RPC is the **single atomic commit boundary** — no client-side multi-step writes.
- The V2 projection layer keeps the React Flow UI working unchanged during and after cutover.
- Pending semantic decisions persist across requests and are surfaced to Python on every invocation for resolution continuity.

---

## 7. Key Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Python makes all semantic decisions | Keeps semantic logic centralized; TypeScript orchestrates only |
| SIE tables use TEXT primary keys (opaque IDs) | Deterministic, retry-stable, namespaced via UUIDv5 |
| Normalized associations (not ID arrays) | Supports roles, versioning, lifecycle, and audit |
| Single-authority model (V2 or SIE, never both) | Prevents dual-writer conflicts and semantic divergence |
| Extended existing RPC (not new endpoint) | Maintains atomic commit boundary; backward-compatible |
| Generated TypeScript types from Python OpenAPI | Single source of truth; drift detected by CI tests |
| Pending decisions as first-class durable state | Uncertainty persists explicitly rather than being silently dropped |

---

## 8. File Inventory Summary

| Layer | Files | Location |
|-------|-------|----------|
| Python models | 9 files | `ml-service/app/sie/` |
| Python tests | 9 test files | `ml-service/tests/sie/` |
| Supabase migrations | 8 SQL + 1 README + 1 schema test | `docs/migrations/sie/` |
| TypeScript implementation | 10 files (8 source + 2 generated) | `src/lib/intelligence-v2/sie/` |
| TypeScript tests | 7 test files | `src/lib/intelligence-v2/sie/__tests__/` |
| Compatibility record | 1 file | `.kiro/specs/sie-data-model/compatibility-record.md` |
| **Total** | **~40 files** | — |
