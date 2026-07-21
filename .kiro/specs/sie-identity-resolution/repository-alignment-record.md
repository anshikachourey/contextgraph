# Repository Alignment Record — SIE Identity Resolution

**Produced:** Task 0.2 of sie-identity-resolution implementation plan
**Design Authority:** `design-corrections.md` (consolidated final design)
**Audit Date:** Current working tree (uncommitted)

## 1. Migration Sequence

| # | File | Status | Notes |
|---|------|--------|-------|
| 001–008 | Base SIE data model | **Reused** | Pre-existing from sie-data-model spec |
| 009 | `009_identity_resolution_records.sql` | **Newly created** | Identity resolution decision table |
| 010 | `010_retrieval_attempts.sql` | **Newly created** | Retrieval attempt diagnostics |
| 011 | `011_pending_identity_tables.sql` | **Newly created** | Pending identity details + propositions |
| 012 | `012_commit_request_state_machine.sql` | **Newly created** | Extends sie_commit_requests state machine |
| 013 | `013_request_state_rpcs.sql` | **Newly created** | 5 atomic reservation/lease RPCs |
| 014 | `014_identity_context_loader.sql` | **Newly created** | v2_load_sie_identity_context (atomic read) |
| 015 | `015_commit_identity_bundle.sql` | **Newly created** | v2_commit_identity_bundle (atomic write) |
| 016 | `016_commit_invariant_validation.sql` | **Newly created** | v2_validate_identity_bundle (pre-commit) |
| 017 | `017_rls_privileges_append_only.sql` | **Newly created** | RLS + triggers on identity tables |
| 018 | `018_privacy_purge.sql` | **Newly created** | Privacy suppressions + purge RPC |
| 019 | `019_rollback_identity_resolution.sql` | **Newly created** | Rollback 009–018 |

**Next free migration number:** 020+

## 2. Design Table → Repository Mapping

### Tables

| Design Table | Repository Location | Status |
|---|---|---|
| `sie_identity_resolution_records` | Migration 009 | **Created** |
| `sie_retrieval_attempts` | Migration 010 | **Created** |
| `sie_pending_identity_details` | Migration 011 | **Created** |
| `sie_pending_identity_propositions` | Migration 011 | **Created** |
| `sie_privacy_suppressions` | Migration 018 | **Created** |
| `sie_pending_semantic_decisions` | Migration 005 | **Reused** (pre-existing) |
| `sie_commit_requests` | Migration 001 + 012 extension | **Extended** |
| `sie_entity_registry` | Migration 001 | **Reused** |
| `sie_persistent_concerns` | Migration 002 | **Reused** |
| `sie_concern_aliases` | Migration 002 | **Reused** |
| `sie_propositions` | Migration 003 | **Reused** |
| `sie_proposition_associations` | Migration 003 | **Reused** |
| `sie_semantic_packets` | Migration 004 | **Reused** |
| `sie_concern_embeddings` | — | **DEFERRED** (Task 2.2) |
| Composite reference keys | — | **DEFERRED** (Task 2.1) |

### RPCs

| Design RPC | Repository Location | Status |
|---|---|---|
| `sie_reserve_request` | Migration 013 | **Created** |
| `sie_renew_lease` | Migration 013 | **Created** |
| `sie_record_analyzed_result` | Migration 013 | **Created** |
| `sie_mark_failed_retryable` | Migration 013 | **Created** |
| `sie_supersede_request` | Migration 013 | **Created** |
| `v2_load_sie_identity_context` | Migration 014 | **Created** |
| `v2_commit_identity_bundle` | Migration 015/016 | **Created** |
| `v2_validate_identity_bundle` | Migration 016 | **Created** |
| `sie_purge_identity_data` | Migration 018 | **Created** |
| `v2_commit_update` | Migration 008 | **Reused** (not modified) |

### Python Models & Enums

| Design Entity | Repository File | Status |
|---|---|---|
| `ResolutionAction` | `enums.py` | **Created** |
| `IRSSignalType` | `enums.py` | **Created** |
| `RetrievalAttemptStatus` | `enums.py` | **Created** |
| `StageExecutionStatus` | `enums.py` | **Created** |
| `ProcessingMode` | `enums.py` | **Created** |
| `IdentityResolutionRecord` | `identity_models.py` | **Created** |
| `RetrievalAttemptRecord` | `identity_models.py` | **Created** |
| `CandidateRecord` | `identity_models.py` | **Created** |
| `IRSSignal` | `identity_models.py` | **Created** |
| `SufficiencyRecord` | `identity_models.py` | **Created** |
| `WideningBudget` (runtime) | `identity_models.py` | **Created** |
| `EvidenceReference` | `identity_models.py` | **Created** |
| `ChannelDiagnostic` | `identity_models.py` | **Created** |
| `RetrievalPolicy` | `identity_policy.py` | **Created** |
| `WideningBudgetPolicy` | `identity_policy.py` | **Created** |
| `ReEvaluationPolicy` | `identity_policy.py` | **Created** |
| `IdentityEvaluationConfig` | `identity_policy.py` | **Created** |
| `IdentityResolutionPolicy` | `identity_policy.py` | **Created** |
| `ChannelRegistryEntry` | `identity_policy.py` | **Created** |
| `PayloadFingerprint` | `contracts.py` | **Created** |
| `GraphStateContext` (extended) | `contracts.py` | **Extended** |
| `ProcessRequest` (extended) | `contracts.py` | **Extended** |
| `ProcessResult` (extended) | `contracts.py` | **Extended** |
| `RetrievalChannel` Protocol | `retrieval/channel_protocol.py` | **Created** |
| `ChannelRegistry` | `retrieval/channel_protocol.py` | **Created** |
| `IdentityResolver` Protocol | `protocols.py` | **Reused** (pre-existing) |

### TypeScript Integration

| Design Component | Repository File | Status |
|---|---|---|
| `invariant-validator.ts` | `src/lib/intelligence-v2/sie/` | **Reused** (pre-existing) |
| `commit-manager.ts` | `src/lib/intelligence-v2/sie/` | **Reused** (pre-existing) |
| `graph-state-retriever.ts` | `src/lib/intelligence-v2/sie/` | **Reused** (pre-existing, needs extension for identity RPCs) |
| `authority-state-machine.ts` | `src/lib/intelligence-v2/sie/` | **Reused** (unchanged) |
| `feature-flags.ts` | `src/lib/intelligence-v2/sie/` | **Reused** (unchanged) |
| `types.ts` | `src/lib/intelligence-v2/sie/` | **Reused** (unchanged) |
| Generated types | `src/lib/intelligence-v2/sie/generated/` | **Needs regeneration** (stale) |

## 3. Intentionally Deferred Items

| Item | Reason | Required Before |
|---|---|---|
| `sie_concern_embeddings` table | Task 2.2 — separate migration needed | Task 7 (retrieval channels need embeddings) |
| Composite reference keys | Task 2.1 — needs data verification | Task 3 (composite FKs reference these) |
| OpenAPI regeneration | Task 16.1 — after all Python model changes stabilize | Task 16 (TypeScript adoption) |
| `identity_resolution_record` entity kind | Missing from `id_generation.py` ENTITY_NAMESPACES | Task 7+ (when records need deterministic IDs) |

## 4. Confirmed Non-Conflicts

- **V2/SIE authority state machine:** Unchanged. Identity resolution operates behind existing controls.
- **Legacy V2 commit path:** `v2_commit_update` is NOT modified. Identity bundle uses separate `v2_commit_identity_bundle`.
- **Existing update-runner.ts:** Calls `v2_commit_update` with 8 params. Completely unaffected.
- **Existing tests:** All pre-existing Python tests (339 originally) continue passing with identity additions.
- **Feature flags:** All SIE flags remain disabled by default. No implicit activation.

## 5. Unresolved Decisions

| Decision | Impact | Flagged? |
|---|---|---|
| Numeric quality thresholds for release gate | Blocks production-readiness, not engineering implementation | Documented in spec (explicit deferral) |
| Production model selection for identity evaluator | Blocks production use, not implementation | Documented in `IdentityEvaluationConfig` (all fields required from config) |
| Embedding model and vector dimensions | Blocks Task 2.2 table creation | Needs resolution before retrieval channels work with real embeddings |
| `identity_resolution_record` entity kind not in ENTITY_NAMESPACES | Blocks deterministic record_id generation | Must be added before first real commit |

## 6. Preflight Assessment

**Status: CLEAR TO PROCEED**

- No unexplained contract conflicts found.
- All design-to-repository mappings are documented.
- Deferred items are explicitly noted with dependencies.
- The one missing entity kind (`identity_resolution_record`) is a minor addition that should be made before Task 7 begins executing identity records.
- The stale OpenAPI spec is expected — regeneration is Task 16.1.
- No unresolved decision would materially change semantics, persistence, privacy, or runtime architecture in a way that blocks continued implementation.
