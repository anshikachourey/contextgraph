# Implementation Plan: SIE Data Model (Final Corrected)

## Overview

This plan implements the approved **SIE data-model foundation** across Python, TypeScript, Supabase, and the existing V2 compatibility boundary.

It includes:

* semantic enums and durable data structures;
* stable, idempotent entity creation;
* normalized persistence and audit storage;
* the versioned Python–TypeScript contract;
* generated TypeScript transport types;
* deterministic structural validation;
* graph-state retrieval;
* an atomic SIE/V2 commit RPC;
* V2 snapshot projection;
* shadow-mode, cutover, rollback, and single-writer controls;
* mandatory model, database, contract, and integration tests.

It does **not** implement the semantic decision algorithms for retention assessment, proposition extraction, packet formation, cohesion analysis, adaptive retrieval, or identity resolution. This plan creates typed interfaces for those stages. Their behavior must be implemented only after the corresponding semantic designs are approved.

No production conversation is cut over to SIE as part of this plan. The default authoritative engine remains V2.

## Tasks

* [x] 0. Audit the real repository and freeze compatibility facts

  * [x] 0.1 Inspect the existing persistence and update infrastructure

    * Read the current definitions and migrations for `v2_update_state`, `v2_graph_snapshots`, mutation logging, cursor/recovery state, and `v2_commit_update`.
    * Confirm the actual primary-key types for conversations, messages, snapshots, and update-state records.
    * Confirm how message sequence gaps, retries, cursor advancement, and version conflicts currently behave.
    * Identify every existing caller of `v2_commit_update` and its current signature.
    * Do not modify the repository in this subtask.

  * [x] 0.2 Inspect current V2 semantic and UI contracts

    * Inspect the current `Proposition`, `Thread`, `ConversationalObject`, `Relationship`, hierarchy, tree, and snapshot types.
    * Identify which Thread responsibilities remain necessary for ordering, provenance, display, or backward compatibility.
    * Confirm the exact `V2GraphPlan`/snapshot shape consumed by the React Flow UI.
    * Confirm whether runtime validators already exist and where schema generation belongs.
    * Do not modify the repository in this subtask.

  * [x] 0.3 Inspect security, migration, and local-test infrastructure

    * Record existing Supabase RLS policies, service-role boundaries, migration conventions, database-test utilities, and rollback conventions.
    * Confirm how migrations and RPCs can be tested locally without changing a shared or production environment.
    * Identify existing Python and TypeScript test frameworks and code-generation tooling.

  * [x] 0.4 Produce a compatibility record

    * Record verified table/column/RPC/type facts.
    * Record required backward-compatible extensions and auxiliary SIE storage.
    * Record any design assumption contradicted by the repository.
    * Stop and flag a genuine contradiction before implementation rather than silently changing semantic policy.

* [x] 1. Implement Python data-model foundations

  * [x] 1.1 Create SIE enum definitions

    * Create `ml-service/app/sie/enums.py`.
    * Define `RetentionLevel`, `BehavioralConfidenceBand`, `PipelineOutcome`, `PropositionType`, `PropositionProvenance`, `SemanticState`, `CohesionStatus`, `ConcernStatus`, `ParentResolutionState`, and `AssociationRole` as string enums.
    * Add serialization tests for every enum value.

  * [x] 1.2 Implement stable creation keys and opaque IDs

    * Create `ml-service/app/sie/id_generation.py`.
    * Implement `EntityCreationRef`.
    * Implement namespaced opaque ID resolution from stable creation keys using UUIDv5 or an equivalent deterministic opaque-ID function.
    * Implement creation-key builders for processing requests, retention decisions, propositions, packets, packet partitions/splits, concerns, associations, memberships, and pending semantic decisions.
    * Exclude mutable/model-generated fields such as canonical meaning, identity summary, display title, current summary, aliases, and parent from permanent-ID derivation.
    * Ensure the same creation key always resolves to the same ID and different entity namespaces cannot collide.

  * [x] 1.3 Implement core Pydantic models

    * Create `ml-service/app/sie/models.py`.
    * Implement `RetentionDecision`, `SIEMessage`, `Proposition`, `ProvisionalConcernBoundary`, `SemanticPacket`, `IdentityResolutionResult`, `ConcernProposal`, `PersistentConcern`, and `PendingSemanticDecision`.
    * Preserve all applicable retention roles on propositions.
    * Represent unresolved ownership, unresolved cohesion, deferred parenthood, merge redirects, retired concerns, attachments, structured content, and pending/unresolved/deferred semantic decisions.
    * Enforce the `IdentityResolutionResult` discriminated-result invariant: match, new-concern proposal, or unresolved/deferred—never conflicting combinations.

  * [x] 1.4 Implement normalized association models

    * Create `ml-service/app/sie/associations.py`.
    * Implement `PropositionAssociation`, `PacketMembership`, and `PacketSplitRecord`.
    * Explicitly include `established_by_packet_id` on `PropositionAssociation`, matching the persistence schema and transport contract.
    * Treat supporting evidence as a role-constrained proposition association, not a second independently persisted link.
    * Preserve packet split lineage without introducing new source provenance.
    * Support explicit invalidation/replacement rather than overwriting historical associations.

  * [x] 1.5 Add mandatory Python model/property tests

    * Retention primary and secondary roles survive serialization and downstream model construction.
    * Same creation key produces the same permanent ID; mutable semantic text does not affect IDs.
    * Source provenance remains unchanged through allowed model transitions.
    * Multiple association roles for one proposition are valid.
    * Unresolved/deferred states pass validation.
    * Packet splits cannot introduce source provenance.
    * Invalid identity-resolution result combinations are rejected.
    * `established_by_packet_id` is correctly serialized, validated, and preserved across model transformations.
    * Pending semantic decisions serialize, deserialize, and maintain lifecycle state correctly.

* [x] 2. Create reversible Supabase schema migrations

  * [x] 2.1 Add authoritative-engine and idempotency storage

    * Add backward-compatible `authoritative_engine` and `sie_cutover_graph_version` fields to `v2_update_state`, using the verified repository schema.
    * Create `sie_entity_registry` with unique `(conversation_id, entity_kind, creation_key)` mapping and verified opaque entity IDs.
    * Create `sie_commit_requests` with request ID, idempotency key, payload fingerprint, base/committed graph versions, status, and recorded result.
    * Enforce that an idempotency key cannot be reused with a different payload fingerprint.

  * [x] 2.2 Create Persistent Concern and alias storage

    * Create `sie_persistent_concerns` with lifecycle, parent-resolution, merge-redirect, version, and self-reference constraints.
    * Prevent self-parenting and inconsistent parent/status combinations.
    * Create normalized `sie_concern_aliases` with explicit audited removal.
    * Use a PostgreSQL partial unique index for active aliases.

  * [x] 2.3 Create proposition and normalized association storage

    * Create `sie_propositions` with validated enum/state/sequence/retention fields.
    * Create `sie_proposition_associations` with normalized roles and lifecycle state.
    * Include `established_by_packet_id` column aligned with the Python model and transport contract.
    * Enforce at most one active `PRIMARY_OWNER` per proposition.
    * Add the nullable packet-establishment column initially without a forward foreign-key reference.
    * Enforce conversation-boundary integrity through database constraints where supported and authoritative RPC validation everywhere else.

  * [x] 2.4 Create packet, membership, and split storage

    * Create `sie_semantic_packets`.
    * Create normalized `sie_packet_memberships` with unique proposition and ordinal placement per packet.
    * Create normalized split-edge rows grouped by a stable `split_event_id`.
    * After the packet table exists, add the deferred association-to-establishing-packet foreign key.
    * Ensure child packet sources are derived exclusively from constituent proposition provenance.

  * [x] 2.5 Create retention-decision, pending-decision, and audit storage

    * Create `sie_retention_decisions` with creation key, request ID, all retention roles, confidence, outcome, assessment/extraction versions, and provenance references.
    * Create `sie_pending_semantic_decisions` with durable lifecycle state (pending, unresolved, deferred, resolved), creation key, originating request, dependency references, and resolution metadata.
    * Ensure pending decisions can be updated to resolved state without losing audit history.
    * Create append-only `sie_audit_history` covering concerns, propositions, packets, associations, aliases, pending decisions, and system transitions.

  * [x] 2.6 Add indexes and RLS policies

    * Add indexes required for conversation-scoped graph loading, active-owner lookup, aliases, status, sequence ranges, packet membership, pending-decision lookup, and audit queries.
    * Add RLS policies consistent with the existing conversation-ownership model.
    * Ensure client users cannot bypass the authoritative commit RPC to mutate protected SIE state directly.

  * [x] 2.7 Add migration verification and rollback

    * Add schema tests for every CHECK, FK, uniqueness, and partial-index invariant.
    * Add a reversible rollback/restore procedure following repository conventions.
    * Apply and test migrations only in the approved local/test environment during this plan.
    * Verify existing V2 code and callers still work before proceeding.

* [x] 3. Implement the versioned Python contract without semantic algorithms

  * [x] 3.1 Create request/response contract models

    * Create `ml-service/app/sie/contracts.py`.
    * Implement `ProcessRequest`, `GraphStateContext`, `ConcernSummary`, `PropositionSummary`, `AssociationSummary`, `PendingDecisionSummary`, `PipelineDiagnostics`, `SemanticDependencyGroupRef`, and `ProcessResult`.
    * Require API, pipeline, model, and extraction versions; stable request/idempotency IDs; base graph version; and source sequence range.
    * Enforce that `current_graph_state.graph_version == base_graph_version`.
    * Include pending/unresolved/deferred semantic decisions in `GraphStateContext` and ensure they are surfaced as `PendingDecisionSummary`.

  * [x] 3.2 Define semantic-stage protocols only

    * Define typed protocols/interfaces for `RetentionAssessor`, `PropositionExtractor`, `PacketFormer`, `CohesionAnalyzer`, and `IdentityResolver`.
    * Define lifecycle expectations for pending semantic decisions: creation when unresolved, persistence across requests, and resolution when later processing succeeds.
    * Do not implement prompts, model calls, retrieval, thresholds, heuristics, or ownership logic in this spec.
    * Do not return fabricated semantic results as placeholders.

  * [x] 3.3 Expose a contract-only API surface

    * Register the versioned `/sie/process-messages` request/response schema for OpenAPI generation behind a disabled-by-default feature/configuration gate.
    * Until approved stage implementations are installed, production invocation must fail explicitly as unavailable and must not commit or fabricate output.
    * Add validation tests for contract-version, graph-version, sequence-range, discriminated-result errors, and pending-decision lifecycle correctness.

  * [x] 3.4 Add contract snapshots and compatibility policy

    * Check in the generated OpenAPI/JSON-schema artifact following repository conventions.
    * Ensure `established_by_packet_id` and pending-decision structures are present in the generated transport contract.
    * Add a contract-version bump rule for breaking changes.
    * Add tests that fail when Python models change without regenerating the contract artifact.

* [x] 4. Generate TypeScript transport types and implement orchestration-only types

  * [x] 4.1 Generate transport types from the Python contract

    * Use the repository-approved OpenAPI/JSON-schema generator.
    * Generate `ProcessRequest`, `ProcessResult`, graph-context, diagnostics, dependency-group, entity, enum, association (including `established_by_packet_id`), and pending-decision transport types.
    * Do not maintain a second handwritten copy of Python transport semantics.

  * [x] 4.2 Add TypeScript-local orchestration types

    * Define only TypeScript-owned types such as `SIEOrchestratorResult`, `InvariantValidationResult`, `InvariantViolation`, `CommitResult`, and local graph-state wrappers.
    * Keep semantic judgments in generated Python-owned transport types.

  * [x] 4.3 Add cross-language contract-drift tests

    * Validate representative Python payloads with the generated TypeScript runtime validator.
    * Verify enum, nullability, sequence, creation-key, version, `established_by_packet_id`, and pending-decision fields round-trip correctly.
    * Fail CI if generated transport artifacts are stale.

* [x] 5. Implement deterministic graph loading, validation, and V2 projection

  * [x] 5.1 Implement graph-state retrieval

    * Create `src/lib/intelligence-v2/sie/graph-state-retriever.ts`.
    * Load concerns, active and historical propositions as required, associations (including `established_by_packet_id`), aliases, packets, pending semantic decisions, graph version, and authoritative-engine state for one conversation.
    * Reload all pending/unresolved/deferred semantic decisions into `GraphStateContext` on every request.
    * Include DORMANT and historically relevant RETIRED concerns; do not filter candidates solely by recency.
    * Produce the versioned `GraphStateContext` consumed by Python.

  * [x] 5.2 Implement deterministic invariant validation

    * Create `src/lib/intelligence-v2/sie/invariant-validator.ts`.
    * Validate dangling references, conversation boundaries, one active primary owner, single parent, acyclicity, parent-resolution consistency, merge redirects, sequence ranges, and base graph version.
    * Validate complete semantic dependency groups; never silently drop one dependent mutation and commit the remainder.
    * Validate consistency of pending-decision lifecycle transitions (e.g., cannot resolve a non-existent decision).
    * TypeScript must not reinterpret semantic ownership.

  * [x] 5.3 Implement the V2 snapshot projection

    * Create `src/lib/intelligence-v2/sie/v2-projection.ts`.
    * Project `PersistentConcern` to the existing `ConversationalObject` shape.
    * Project active `PRIMARY_OWNER` associations to proposition ownership.
    * Preserve/derive Threads only for verified compatibility responsibilities; do not run legacy Thread → Object identity formation after SIE cutover.
    * Project canonical parenthood and existing compatible relationships without inventing new semantic edges.
    * Derive legacy `objectType` only for compatibility. Do not recreate `ObjectMaturity` as `semanticVersion`.

  * [x] 5.4 Add mandatory graph/projection tests

    * Test loading of ACTIVE, DORMANT, RETIRED, and MERGED concerns.
    * Test invariant rejection for cycles, multiple active owners, cross-conversation references, invalid merge redirects, and stale graph versions.
    * Test that valid SIE states project to the exact current V2 snapshot/runtime schema.
    * Test the projection against the existing React Flow query/consumption path.
    * Test that pending semantic decisions are correctly loaded, persisted, and marked resolved when appropriate.

* [x] 6. Implement the atomic database commit boundary

  * [x] 6.1 Implement a backward-compatible versioned commit RPC

    * Based on Task 0 findings, safely extend `v2_commit_update` or introduce a versioned SIE commit RPC/wrapper while leaving every existing V2 caller operational.
    * In one PostgreSQL transaction: lock/check authority, version, cursor, request, idempotency key, and payload fingerprint; verify creation-key mappings; apply all SIE entity/association/split/audit/pending-decision mutations; write mutation logs and the V2 projection; advance graph version and cursor exactly once; record the commit result.
    * Persist new pending semantic decisions and update existing ones to resolved when later processing succeeds.
    * Replaying a committed idempotency key must return the original result without new writes.
    * Reusing the key with another payload must fail.
    * Any failure must roll back every SIE, V2, version, audit, pending-decision, and cursor write.

  * [x] 6.2 Implement the TypeScript commit manager

    * Create `src/lib/intelligence-v2/sie/commit-manager.ts`.
    * Build and validate one semantic commit bundle before making any database mutation.
    * Include pending-decision creations and resolutions in the commit bundle.
    * Make exactly one authoritative RPC call.
    * Remove any client-side `writeSIETables` or post-RPC authoritative write path.
    * On version conflict, reload graph state (including pending decisions) and require fresh Python semantic analysis; never blindly replay stale mutations.

  * [x] 6.3 Add mandatory database integration/failure-injection tests

    * Test successful all-or-none commit across SIE tables, V2 snapshot, audit log, mutation log, pending-decision lifecycle updates, graph version, and cursor.
    * Inject failure at each internal RPC phase and verify no partial state becomes visible.
    * Test idempotent replay, payload mismatch, stale version, sequence gaps, duplicate delivery, and concurrent commit attempts.
    * Test persistence and later resolution of pending semantic decisions across multiple commits.
    * Property tests may test bundle generation, but they do not replace real PostgreSQL transaction tests.

* [x] 7. Implement shadow mode and single-authority controls

  * [x] 7.1 Implement the authority state machine

    * Support `V2`, `SIE_SHADOW`, and `SIE` authority states with validated transitions.
    * Enforce exactly one production semantic writer per conversation.
    * In `SIE_SHADOW`, SIE output must be isolated from production snapshot, production cursor, and production mutation history.
    * In `SIE`, the legacy Thread → Object identity path must not write authoritative objects.

  * [x] 7.2 Implement feature flags and guarded cutover/rollback operations

    * Add disabled-by-default flags for contract endpoint exposure, shadow execution, and SIE authority.
    * Implement cutover and rollback mechanics with graph-version guards and audit records.
    * Do not activate SIE authority for production conversations in this plan.

  * [x] 7.3 Add mandatory authority-transition tests

    * Verify shadow analysis cannot alter production state.
    * Verify dual production writers are rejected.
    * Verify cutover and rollback require valid versions and produce audit records.
    * Verify existing V2 callers remain functional while authority is V2.

* [x] 8. Final verification and handoff

  * [x] 8.1 Run all mandatory test suites

    * Python unit and property tests.
    * TypeScript unit, runtime-schema, contract-drift, and projection tests.
    * Local Supabase migration, RLS, RPC, transaction, concurrency, and failure-injection tests.
    * Existing V2 regression suite, TypeScript compilation, and Python validation/linting used by the repository.

  * [x] 8.2 Verify scope containment

    * Confirm no retention, extraction, cohesion, retrieval, or identity algorithm was invented.
    * Confirm `/sie/process-messages` cannot produce or commit fabricated semantic output without approved stage implementations.
    * Confirm V2 remains the default production authority.

  * [x] 8.3 Produce the implementation handoff

    * Summarize created models


## Notes

- This plan creates typed interfaces for semantic stages but does NOT implement the semantic decision algorithms (retention, extraction, cohesion, identity resolution). Those require separate approved designs.
- No production conversation is cut over to SIE as part of this plan. The default authoritative engine remains V2.
- Tasks marked with `*` are optional property tests that can be deferred for faster MVP.
- Supabase migrations must run in dependency order (entity registry → concerns → propositions → associations → packets → memberships → splits → retention → audit).
- Python models are the source of truth; TypeScript types are generated from the Python OpenAPI contract.
- The `v2_commit_update` RPC extension must maintain backward compatibility with existing V2 callers.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1", "0.2", "0.3"] },
    { "id": 1, "tasks": ["0.4"] },
    { "id": 2, "tasks": ["1.1", "1.2"] },
    { "id": 3, "tasks": ["1.3", "1.4"] },
    { "id": 4, "tasks": ["1.5"] },
    { "id": 5, "tasks": ["2.1", "2.2"] },
    { "id": 6, "tasks": ["2.3", "2.4"] },
    { "id": 7, "tasks": ["2.5", "2.6"] },
    { "id": 8, "tasks": ["2.7"] },
    { "id": 9, "tasks": ["3.1", "3.2"] },
    { "id": 10, "tasks": ["3.3", "3.4"] },
    { "id": 11, "tasks": ["4.1"] },
    { "id": 12, "tasks": ["4.2", "4.3"] },
    { "id": 13, "tasks": ["5.1", "5.2", "5.3"] },
    { "id": 14, "tasks": ["5.4"] },
    { "id": 15, "tasks": ["6.1"] },
    { "id": 16, "tasks": ["6.2"] },
    { "id": 17, "tasks": ["6.3"] },
    { "id": 18, "tasks": ["7.1", "7.2"] },
    { "id": 19, "tasks": ["7.3"] },
    { "id": 20, "tasks": ["8.1", "8.2", "8.3"] }
  ]
}
```
