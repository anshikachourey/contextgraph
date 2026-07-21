# SIE Data Model — Compatibility Record

**Produced by:** Task 0.4  
**Depends on:** Audit 0.1 (persistence), Audit 0.2 (semantic/UI contracts), Audit 0.3 (infrastructure)  
**Purpose:** Consolidated reference for all subsequent implementation tasks. Records verified facts, required extensions, auxiliary storage, and flagged contradictions.

---

## 1. Verified Table/Column/RPC/Type Facts

### 1.1 Primary Key Types

| Table | PK Column | PG Type | TS Type | Notes |
|-------|-----------|---------|---------|-------|
| `conversations` | `id` | `uuid` | `string` | Supabase standard UUID |
| `messages` | `id` | `uuid` | `string` | Also has `message_seq bigserial` (non-PK, global monotonic) |
| `v2_graph_snapshots` | `conversation_id` | `uuid` | `string` | FK → conversations(id), ON DELETE CASCADE |
| `v2_update_state` | `conversation_id` | `uuid` | `string` | FK → conversations(id), ON DELETE CASCADE |
| `v2_mutation_log` | `id` | `uuid` (gen_random_uuid()) | `string` | UNIQUE on (conversation_id, from_version, to_version) |
| `continuation_provenance` | `id` | `uuid` (gen_random_uuid()) | `string` | FK → conversations(id) |

**SIE Implication:** All `conversation_id` references in SIE tables MUST be `UUID` type. All `source_message_ids` references MUST be UUID strings.

### 1.2 v2_update_state Columns

| Column | Type | Default | Constraint |
|--------|------|---------|-----------|
| `conversation_id` | uuid (PK) | — | FK conversations(id) ON DELETE CASCADE |
| `last_processed_message_seq` | bigint | 0 | — |
| `update_status` | text | 'idle' | CHECK IN ('idle', 'queued', 'updating', 'failed') |
| `update_version` | integer | 0 | Monotonically incremented on commit |
| `pending_since` | timestamptz | NULL | — |
| `last_update_error` | text | NULL | — |
| `update_failed_at` | timestamptz | NULL | — |
| `updated_at` | timestamptz | now() | — |

### 1.3 v2_graph_snapshots Columns

| Column | Type | Default | Constraint |
|--------|------|---------|-----------|
| `conversation_id` | uuid (PK) | — | FK conversations(id) ON DELETE CASCADE |
| `pipeline_version` | text | '2.0.0' | — |
| `status` | text | 'generating' | CHECK IN ('generating_initial', 'generating', 'ready', 'failed') |
| `graph_payload` | jsonb | NULL | Stores V2Snapshot (objects, relationships, propositions, threads, hierarchy, trees) |
| `diagnostics` | jsonb | NULL | — |
| `error_message` | text | NULL | — |
| `generated_at` | timestamptz | NULL | — |
| `updated_at` | timestamptz | now() | — |

### 1.4 v2_mutation_log Columns

| Column | Type | Constraint |
|--------|------|-----------|
| `id` | uuid (PK) | gen_random_uuid() |
| `conversation_id` | uuid | FK conversations(id) ON DELETE CASCADE |
| `from_version` | integer | UNIQUE with (conversation_id, to_version) |
| `to_version` | integer | — |
| `mutations` | jsonb | Default '[]' |
| `message_seq_range` | int8range | — |
| `created_at` | timestamptz | now() |

### 1.5 v2_commit_update RPC Signature (Current)

```sql
CREATE OR REPLACE FUNCTION v2_commit_update(
  p_conversation_id uuid,
  p_new_snapshot jsonb,
  p_from_version integer,
  p_to_version integer,
  p_mutations jsonb,
  p_last_processed_seq bigint,
  p_message_seq_from bigint,
  p_message_seq_to bigint
) RETURNS void
```

**Atomicity:** Single PL/pgSQL block — updates snapshot, inserts mutation log (ON CONFLICT DO NOTHING), updates cursor/version/status.

**Return type:** `void` — no return value; failure detected via Supabase error.

**Callers (exactly 2):**
1. `src/lib/intelligence-v2/incremental/update-runner.ts` (line 195) — incremental commit
2. `app/api/v2/graph-snapshot/route.ts` (line 156) — baseline generation

### 1.6 message_seq Behavior

- Type: `bigserial` — globally auto-incrementing, NOT per-conversation.
- Within a conversation: monotonic but may have gaps (cross-conversation interleavings).
- No gap detection exists in the current system.
- Cursor (`last_processed_message_seq`) only advances inside the atomic RPC.

### 1.7 Version Conflict Handling

- **No explicit optimistic lock** in the current RPC. `p_from_version` is NOT verified against `update_version`.
- Process-local Promise chain provides single-writer-per-process serialization.
- No cross-process locking exists.
- Mutation log uses `ON CONFLICT (conversation_id, from_version, to_version) DO NOTHING` for deduplication.

### 1.8 V2 Type Definitions (Canonical)

**Source:** `src/lib/intelligence-v2/schemas.ts`

| Type | Fields Used by UI | Notes |
|------|-------------------|-------|
| `Proposition` | propositionId, propositionType, normalizedContent, sourceUtteranceIds, authoredBy, provenance | V2 uses `sourceUtteranceIds`; SIE uses `source_message_ids` |
| `ConversationalObject` | objectId, objectType (13 values), title, description, propositionIds, threadIds, supportingUtteranceIds, contextualAssistantUtteranceIds, maturity, status, provenanceSummary | — |
| `Relationship` | relationshipId, sourceObjectId, targetObjectId, type, family, confidence, explanation, sourcePropositionIds | — |
| `Thread` | threadId, subject | UI reads only threadId + subject |
| `DerivedHierarchyNode` | objectId, depth, parentObjectId, childObjectIds, treeId | siblingObjectIds stored but NOT consumed by UI |
| `DerivedTree` | treeId, rootObjectId, objectIds | — |

### 1.9 SnapshotPayload (UI Contract)

The React Flow UI (`V2GraphPreview.tsx`) expects exactly this shape from `GET /api/v2/graph-snapshot`:

```typescript
type SnapshotPayload = {
  objects: Array<{ objectId, objectType, title, description, propositionIds, threadIds, supportingUtteranceIds, contextualAssistantUtteranceIds, maturity, status, provenanceSummary }>;
  relationships: Array<{ relationshipId, sourceObjectId, targetObjectId, type, family, confidence, explanation, sourcePropositionIds }>;
  hierarchy: Array<{ objectId, depth, parentObjectId, childObjectIds, treeId }>;
  trees: Array<{ treeId, rootObjectId, objectIds }>;
  propositions: Array<{ propositionId, propositionType, normalizedContent, sourceUtteranceIds, authoredBy, provenance }>;
  threads: Array<{ threadId, subject }>;
};
```

**Critical:** `normalizeGraph()` re-derives hierarchy from objects + relationships. The stored hierarchy is informational — the UI recomputes it.

### 1.10 Supabase Client Access Pattern

| Client | Key | RLS Bypass | Usage |
|--------|-----|-----------|-------|
| Server (`src/lib/supabase/server.ts`) | `SUPABASE_SERVICE_ROLE_KEY` | Yes | ALL API routes, update runner, RPC calls |
| Browser (`src/lib/supabase/client.ts`) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | No | Client components only (currently unused for data mutations) |

---

## 2. Required Backward-Compatible Extensions

### 2.1 v2_update_state — New Columns (Additive, Non-Breaking)

| New Column | Type | Default | Purpose |
|-----------|------|---------|---------|
| `authoritative_engine` | TEXT NOT NULL | `'V2'` | CHECK IN ('V2', 'SIE_SHADOW', 'SIE') — single-authority selector |
| `sie_cutover_graph_version` | INTEGER | NULL | Records graph version at which SIE became authoritative |

**Backward compatibility:** Default `'V2'` means all existing code behaves identically. Existing V2 callers do not read or write these columns.

### 2.2 v2_commit_update RPC — Extended Signature

The RPC must be extended with new OPTIONAL parameters for SIE commits while retaining full backward compatibility for existing V2 callers:

| New Parameter | Type | Default | Purpose |
|--------------|------|---------|---------|
| `p_sie_commit_bundle` | jsonb | NULL | SIE entity/association/audit mutations |
| `p_request_id` | text | NULL | Stable request identifier |
| `p_idempotency_key` | text | NULL | Idempotent commit key |
| `p_required_engine` | text | NULL | Authority assertion ('V2' or 'SIE') |

**Strategy:** Use `CREATE OR REPLACE FUNCTION` with default parameter values. Existing callers pass the original 8 parameters unchanged and new parameters default to NULL (V2-only path).

### 2.3 RPC Behavioral Extension

When `p_required_engine` is non-NULL:
1. Lock and verify `authoritative_engine` matches `p_required_engine`
2. Verify `p_from_version` equals current `update_version` (optimistic lock — **NEW**)
3. Verify `p_idempotency_key` is not already committed with a different payload fingerprint
4. Apply `p_sie_commit_bundle` writes (entity registry, propositions, concerns, associations, packets, memberships, splits, retention decisions, audit history)
5. Continue with existing V2 snapshot/mutation-log/cursor writes

When `p_required_engine` is NULL: execute current V2-only logic unchanged.

### 2.4 RPC Return Type Change

**Current:** `RETURNS void`  
**Required:** `RETURNS jsonb` — returns `{ "graph_version": N, "status": "COMMITTED" }` for SIE commits; returns `NULL` for V2-only commits (backward compatible since current callers ignore return value).

---

## 3. Auxiliary SIE Storage (New Tables)

All new tables are conversation-scoped with FK → `conversations(id)` and ON DELETE CASCADE.

| Table | Purpose | PK Type |
|-------|---------|---------|
| `sie_entity_registry` | Idempotent creation-key → entity-ID mapping | Composite (conversation_id, entity_kind, creation_key) |
| `sie_commit_requests` | Request/idempotency tracking | Composite (conversation_id, idempotency_key) |
| `sie_persistent_concerns` | Durable concern lifecycle | TEXT (concern_id) |
| `sie_concern_aliases` | Normalized aliases with audited removal | TEXT (alias_id) |
| `sie_propositions` | SIE propositions with retention levels | TEXT (proposition_id) |
| `sie_proposition_associations` | Normalized many-to-many with roles | TEXT (association_id) |
| `sie_semantic_packets` | Concern-cohesive processing units | TEXT (packet_id) |
| `sie_packet_memberships` | Normalized proposition-in-packet membership | TEXT (membership_id) |
| `sie_packet_splits` | Split lineage records | TEXT (split_edge_id) |
| `sie_retention_decisions` | Retention assessment audit trail | TEXT (id) |
| `sie_pending_semantic_decisions` | Durable pending/unresolved/deferred state | TEXT (decision_id) |
| `sie_audit_history` | Append-only change history | TEXT (id) |

**SIE tables use TEXT primary keys** (opaque IDs resolved from creation keys via UUIDv5 or equivalent). This is intentionally different from the UUID PKs used by V2 tables — SIE IDs are namespaced, deterministic, and retry-stable.

---

## 4. Design Assumptions Verified Against Repository

### 4.1 Confirmed Assumptions (No Contradiction)

| Design Assumption | Repository Evidence |
|-------------------|-------------------|
| `conversations.id` is UUID | FK references in all migration files; `DbConversation.id: string` in types/db.ts |
| `messages.id` is UUID | FK references; `DbMessage.id: string` |
| `message_seq` is bigint, globally monotonic | Migration adds `bigserial`; no per-conversation reset |
| One snapshot per conversation | `v2_graph_snapshots` PK is `conversation_id` |
| One update-state per conversation | `v2_update_state` PK is `conversation_id` |
| Service-role client used for all server operations | Every API route uses `createServerSupabaseClient()` |
| No RLS policies exist | Zero `CREATE POLICY` statements in repository |
| No Python test framework (pytest) installed | Not in `requirements.txt`; no `conftest.py` |
| No `fast-check` installed | Not in `package.json` |
| No OpenAPI artifact checked in | No `.json`/`.yaml` schema files |
| No cross-language type generation tooling | No codegen scripts |
| Migrations are manual SQL files in `docs/migrations/` | Confirmed; no Supabase CLI |
| Idempotent migration patterns (`IF NOT EXISTS`) | All existing migrations use this pattern |
| `v2_commit_update` is the single atomic commit boundary | Only RPC; both callers confirmed |
| V2 has no version-conflict check | RPC does not verify `p_from_version` against stored `update_version` |
| React Flow UI re-derives hierarchy from normalizeGraph() | UI code confirmed; stored hierarchy is informational |

### 4.2 Confirmed Gaps (Repository Lacks, Design Must Provide)

| Gap | Status | Design Task |
|-----|--------|-------------|
| No optimistic concurrency in v2_commit_update | **Gap confirmed** — SIE must add `WHERE update_version = p_from_version` | Task 6.1 |
| No RLS policies | **Gap confirmed** — SIE establishes from scratch | Task 2.6 |
| No rollback procedures | **Gap confirmed** — SIE establishes conventions | Task 2.7 |
| No Python test framework | **Gap confirmed** — must add pytest + hypothesis | Task 1.5 |
| No TypeScript PBT library | **Gap confirmed** — must add fast-check | Tasks 5.4, 6.3 |
| No OpenAPI/codegen pipeline | **Gap confirmed** — must establish | Tasks 3.4, 4.1 |
| No cross-process locking | **Gap confirmed** — process-local chains only; multi-instance risk for SIE | Task 6.1 RPC locking |
| No local Supabase test environment | **Gap confirmed** — must add for migration testing | Task 2.7 |
| No migration versioning scheme | **Gap confirmed** — should adopt sequential numbering | Task 2.1+ |

---

## 5. Design Assumptions Contradicted by Repository

### 5.1 No Genuine Semantic Policy Contradictions Found

After thorough audit, **no design assumption contradicts the repository in a way that would change semantic policy**. The design was written with awareness of the existing infrastructure and correctly identifies gaps rather than making false claims about existing behavior.

### 5.2 Minor Technical Discrepancies (Non-Blocking)

| Discrepancy | Design States | Repository Reality | Resolution |
|-------------|--------------|-------------------|-----------|
| V2 `Proposition.sourceUtteranceIds` vs SIE `source_message_ids` | SIE uses `source_message_ids` | V2 uses `sourceUtteranceIds` (same underlying message UUIDs, different field name) | V2 projection maps SIE `source_message_ids` → V2 `sourceUtteranceIds` — names differ but semantics align |
| V2 `Proposition.confidence` is numeric | SIE uses `BehavioralConfidenceBand` (HIGH/MEDIUM/LOW) | V2 uses `confidence: number` (0.0–1.0) | V2 projection must map: HIGH→0.9, MEDIUM→0.7, LOW→0.4 (or similar) — no semantic conflict |
| V2 `Proposition.confirmedByUser` field | SIE has no equivalent boolean | V2 has `confirmedByUser: boolean` | V2 projection defaults to `false`; confirmation may be modeled as provenance upgrade in SIE — no contradiction |
| Design implies `message_seq_range: tuple[int, int]` | SIE uses `(start, end)` tuple | Repository `message_seq` is `bigint` (could exceed int) | Use `bigint` in DB columns; Python `int` handles arbitrary precision; TypeScript uses `number` (safe for practical ranges) |
| RPC return type | Design needs `RETURNS jsonb` | Current RPC is `RETURNS void` | Changing to `RETURNS jsonb` with NULL for V2 callers is backward-compatible — current callers already ignore return value |

### 5.3 Potential Risk: Global bigserial Gaps

**Observation:** `message_seq` is globally auto-incrementing. Within a conversation, gaps are possible.

**Design assumption:** `message_seq_range: (start, end)` implies contiguous coverage.

**Resolution:** `message_seq_range` represents the inclusive range of processed sequences, not an assertion of gap-free coverage. The SIE cursor advances to the highest seq in the batch. This matches existing V2 behavior. **No contradiction — but implementors should not assume gap-free sequences within a conversation.**

---

## 6. V2 Projection Mapping Rules

These rules govern how SIE authoritative state projects to the V2 `SnapshotPayload` consumed by the React Flow UI:

| SIE Source | V2 Target | Mapping Rule |
|-----------|-----------|--------------|
| `PersistentConcern` | `ConversationalObject` | concern_id → objectId; derive objectType from constituent proposition types; display_title → title; current_summary → description |
| `PersistentConcern.status` | `ObjectStatus` | ACTIVE→'active'; DORMANT→'deferred'; RETIRED→'resolved'; MERGED→'discarded' |
| `PersistentConcern` maturity | `ObjectMaturity` | Derive from proposition count: <3→'nascent', 3-7→'developing', ≥8→'stable' (ObjectMaturity is retired in SIE but required for V2 compat) |
| `PropositionAssociation(PRIMARY_OWNER)` | `object.propositionIds` | Collect all active PRIMARY_OWNER associations for each concern |
| `PropositionAssociation(SUPPORTING_EVIDENCE+)` | `object.supportingUtteranceIds` | Collect source_message_ids from supporting associations |
| `SIEProposition` | V2 `Proposition` subset | proposition_id → propositionId; proposition_type → propositionType; canonical_meaning → normalizedContent; source_message_ids → sourceUtteranceIds; speaker_role → authoredBy (lowercase) |
| `BehavioralConfidenceBand` | numeric confidence | HIGH→0.9, MEDIUM→0.7, LOW→0.4 |
| `canonical_parent_id` hierarchy | `DerivedHierarchyNode` + `DerivedTree` | Derive child_of relationships from parent chain; normalizeGraph() re-derives for UI |
| Synthetic threads | V2 `Thread` | Derive thread-like groupings from packet/message-sequence data; produce (threadId, subject) pairs |
| `PropositionAssociation` | V2 `Relationship` (partial) | Project concern-to-concern structural edges from shared propositions; preserve existing relationship types where applicable |

---

## 7. Infrastructure Requirements for Implementation

### 7.1 New Dev Dependencies Required

| Package | Layer | Purpose | Task |
|---------|-------|---------|------|
| `pytest` | Python (dev) | Unit/integration testing | 1.5 |
| `hypothesis` | Python (dev) | Property-based testing | 1.5 |
| `fast-check` | TypeScript (dev) | Property-based testing | 5.4, 6.3 |
| `openapi-typescript` or equivalent | TypeScript (dev) | Type generation from OpenAPI | 4.1 |
| Supabase CLI (local dev only) | Infrastructure | Local PostgreSQL for migration testing | 2.7 |

### 7.2 Migration Conventions to Establish

- Sequential numbering: `001_`, `002_`, etc. (repository currently has no numbering scheme)
- Location: `docs/migrations/sie/` (separate from existing V2 migrations to avoid confusion)
- Pattern: Continue `IF NOT EXISTS` / `CREATE OR REPLACE` for idempotent re-application
- Rollback: Paired `*_down.sql` files for each migration
- Dependency order: entity_registry → concerns → aliases → propositions → associations → packets → memberships → splits → retention → pending_decisions → audit

### 7.3 Test Infrastructure to Establish

| Infrastructure | Current State | Required State |
|---------------|--------------|----------------|
| Python pytest | Not installed | Install + `ml-service/tests/` directory |
| Python hypothesis | Not installed | Install for PBT |
| TypeScript fast-check | Not installed | Install as devDependency |
| Local Supabase | Not configured | `supabase init` + Docker for migration testing |
| OpenAPI export | Not configured | Script to export FastAPI OpenAPI JSON |
| TypeScript codegen | Not configured | Script to generate types from OpenAPI |
| CI contract-drift check | Not configured | Test that fails when generated artifacts are stale |

---

## 8. Contradictions and Blocking Issues

### Status: NO GENUINE CONTRADICTIONS FOUND

After comprehensive audit of the repository against the SIE design:

1. **No semantic policy contradiction exists.** The design correctly accounts for all existing V2 behavior and infrastructure.
2. **No existing behavior would be broken** by the planned additive changes (new columns with defaults, new tables, extended RPC with optional parameters).
3. **No existing caller needs modification** for backward compatibility — all V2 callers continue to work unchanged.
4. **No data integrity risk** — SIE tables are fully isolated; the only shared touchpoint is the extended `v2_commit_update` RPC which maintains backward compatibility.

### Flagged Risks (Non-Blocking, Require Attention During Implementation)

| Risk | Severity | Mitigation |
|------|----------|-----------|
| RPC return type change (`void` → `jsonb`) | Low | Current callers ignore return value; `CREATE OR REPLACE` handles transition |
| Missing optimistic lock in RPC | Medium | Must add `WHERE update_version = p_from_version` for SIE path; V2 path continues without it (matches existing behavior) |
| No cross-process coordination | Medium | RPC-level locking (SELECT FOR UPDATE on v2_update_state) prevents concurrent commits for the same conversation |
| Global bigserial gaps in message_seq | Low | SIE does not require gap-free sequences; cursor advancement matches existing V2 semantics |
| Thread derivation for V2 compat | Medium | Must synthesize thread-like groupings; no 1:1 packet→thread mapping exists. Requires heuristic in Task 5.3 |
| ObjectType derivation | Medium | No SIE equivalent; must derive from proposition types. Requires mapping rules in Task 5.3 |
| ObjectMaturity is semantically retired | Low | Still required for V2 snapshot format; derive mechanically from proposition count |

---

## 9. Summary

This compatibility record confirms that:

1. **Implementation can proceed** — no blocking contradictions exist between the SIE design and the repository.
2. **Backward compatibility is achievable** through additive columns, optional RPC parameters, and isolated SIE tables.
3. **The V2 projection layer** (Task 5.3) is the primary compatibility challenge, requiring synthetic mappings for threads, object types, maturity, and confidence values.
4. **Infrastructure gaps** (testing frameworks, codegen, local Supabase) are well-understood and addressable in early implementation tasks.
5. **The single-authority model** is safe because the default remains V2 and SIE writes are gated behind explicit engine-state transitions.

All subsequent implementation tasks should reference this document for verified facts about the repository state.
