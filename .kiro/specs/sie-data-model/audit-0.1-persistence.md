# Audit 0.1 — Existing Persistence and Update Infrastructure

**Status:** READ-ONLY audit. No repository modifications.  
**Date:** 2025-01-XX  
**Spec:** SIE Data Model  

---

## 1. Table Definitions and Migrations

All migrations reside in `docs/migrations/` and are applied manually via the Supabase SQL Editor.

### 1.1 `v2_graph_snapshots`

**Source:** `docs/migrations/create_v2_graph_snapshots.sql`

```sql
CREATE TABLE IF NOT EXISTS v2_graph_snapshots (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  pipeline_version text NOT NULL DEFAULT '2.0.0',
  status text NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed')),
  graph_payload jsonb,
  diagnostics jsonb,
  error_message text,
  generated_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
```

**Post-migration constraint (v2_durable_update_system.sql section 6):**

```sql
ALTER TABLE v2_graph_snapshots DROP CONSTRAINT IF EXISTS v2_graph_snapshots_status_check;
ALTER TABLE v2_graph_snapshots ADD CONSTRAINT v2_graph_snapshots_status_check
  CHECK (status IN ('generating_initial', 'generating', 'ready', 'failed'));
```

- **Primary Key:** `conversation_id` (UUID, references `conversations(id)`)
- **One snapshot per conversation** — upsert pattern used for both baseline and incremental.

### 1.2 `v2_update_state`

**Source:** `docs/migrations/v2_durable_update_system.sql` (section 2)

```sql
CREATE TABLE IF NOT EXISTS v2_update_state (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  last_processed_message_seq bigint NOT NULL DEFAULT 0,
  update_status text NOT NULL DEFAULT 'idle'
    CHECK (update_status IN ('idle', 'queued', 'updating', 'failed')),
  update_version integer NOT NULL DEFAULT 0,
  pending_since timestamptz,
  last_update_error text,
  update_failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- **Primary Key:** `conversation_id` (UUID)
- `last_processed_message_seq`: bigint cursor tracking the highest `message_seq` proven-committed.
- `update_version`: integer, monotonically incremented on each successful commit.
- `update_status`: state machine — `idle` → `queued` → `updating` → `idle`/`failed`.

### 1.3 `v2_mutation_log`

**Source:** `docs/migrations/v2_durable_update_system.sql` (section 4)

```sql
CREATE TABLE IF NOT EXISTS v2_mutation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_version integer NOT NULL,
  to_version integer NOT NULL,
  mutations jsonb NOT NULL DEFAULT '[]',
  message_seq_range int8range,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, from_version, to_version)
);
```

- **Primary Key:** `id` (auto-generated UUID)
- **Uniqueness:** `(conversation_id, from_version, to_version)` — prevents duplicate transitions.
- `mutations`: JSONB array of `GraphMutation` objects (mutationId, type, targetId, beforeState, afterState, sourceUtteranceIds, sourcePropositionIds, reason, confidence, provenance).
- `message_seq_range`: inclusive int8range `[from, to]`.

### 1.4 `continuation_provenance`

**Source:** `docs/migrations/create_continuation_provenance.sql`

```sql
CREATE TABLE IF NOT EXISTS continuation_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  origin_entity_id text NOT NULL,
  origin_graph_version text NOT NULL CHECK (origin_graph_version IN ('v1', 'v2')),
  origin_entity_type text NOT NULL CHECK (origin_entity_type IN ('node', 'object')),
  message_ids text[] NOT NULL DEFAULT '{}',
  current_canonical_entity_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 1.5 `messages.message_seq`

**Source:** `docs/migrations/v2_durable_update_system.sql` (section 1)

```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_seq bigserial;
```

- `bigserial` — auto-incrementing globally (not per-conversation).
- Backfill logic assigns sequence by `created_at` order for pre-existing messages.

---

## 2. Primary Key Types (Confirmed)

| Table | Primary Key Column | Type | Notes |
|-------|-------------------|------|-------|
| `conversations` | `id` | `uuid` | Standard Supabase UUID (from `docs/deployment.md` and FK references) |
| `messages` | `id` | `uuid` (string in TS) | UUID PK; also has `message_seq bigserial` (non-PK, global monotonic) |
| `v2_graph_snapshots` | `conversation_id` | `uuid` | FK → conversations(id), ON DELETE CASCADE |
| `v2_update_state` | `conversation_id` | `uuid` | FK → conversations(id), ON DELETE CASCADE |
| `v2_mutation_log` | `id` | `uuid` | gen_random_uuid(); UNIQUE on (conversation_id, from_version, to_version) |
| `continuation_provenance` | `id` | `uuid` | gen_random_uuid() |

**TypeScript representation:** All UUIDs are typed as `string` in `src/types/db.ts`:
- `DbConversation.id: string`
- `DbMessage.id: string`, `DbMessage.conversation_id: string`

---

## 3. `v2_commit_update` RPC — Definition and Signature

**Source:** `docs/migrations/v2_durable_update_system.sql` (section 5)

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
) RETURNS void AS $$
BEGIN
  -- 1. Update v2_graph_snapshots: payload, status='ready', diagnostics
  -- 2. Insert into v2_mutation_log (ON CONFLICT DO NOTHING → idempotent)
  -- 3. Update v2_update_state: cursor, version, status='idle', clear errors
END;
$$ LANGUAGE plpgsql;
```

### RPC Parameters

| Parameter | Type | Purpose |
|-----------|------|---------|
| `p_conversation_id` | uuid | Target conversation |
| `p_new_snapshot` | jsonb | Full graph payload (objects, relationships, propositions, threads, hierarchy, trees) |
| `p_from_version` | integer | Current version before this commit |
| `p_to_version` | integer | New version after commit |
| `p_mutations` | jsonb | Array of GraphMutation objects for this transition |
| `p_last_processed_seq` | bigint | Highest message_seq incorporated by this commit |
| `p_message_seq_from` | bigint | Lowest message_seq in this batch |
| `p_message_seq_to` | bigint | Highest message_seq in this batch |

### Atomicity Guarantees

The function executes in a single PL/pgSQL block (single transaction):
1. Updates `v2_graph_snapshots` (payload + status + diagnostics)
2. Inserts mutation log entry (idempotent via UNIQUE constraint ON CONFLICT DO NOTHING)
3. Updates `v2_update_state` (cursor advance + version bump + status='idle')

All three succeed or all roll back.

### Return Type

`RETURNS void` — no return value. Caller detects failure via Supabase error response.

---

## 4. All Callers of `v2_commit_update`

### 4.1 `src/lib/intelligence-v2/incremental/update-runner.ts` (line 195)

**Context:** Incremental update after processing new messages from cursor.

```typescript
const { error: rpcError } = await db.rpc("v2_commit_update", {
  p_conversation_id: conversationId,
  p_new_snapshot: payload,
  p_from_version: currentVersion,
  p_to_version: newVersion,         // currentVersion + 1
  p_mutations: mutations,
  p_last_processed_seq: highestSeq,
  p_message_seq_from: lowestSeq,
  p_message_seq_to: highestSeq,
});
```

**Caller flow:** `enqueueV2Update()` → `processFromCursor()` → loads cursor → queries messages > cursor → runs incremental engine → calls RPC.

### 4.2 `app/api/v2/graph-snapshot/route.ts` (line 156)

**Context:** Full baseline generation (POST endpoint).

```typescript
const { error: rpcError } = await db.rpc("v2_commit_update", {
  p_conversation_id: conversationId,
  p_new_snapshot: graphPayload,
  p_from_version: 0,
  p_to_version: 0,                   // Baseline is version 0
  p_mutations: [],                   // No incremental mutations for baseline
  p_last_processed_seq: baselineMessageSeq,
  p_message_seq_from: 1,
  p_message_seq_to: baselineMessageSeq,
});
```

**Note:** Has a fallback path for pre-migration environments (sequential writes to `v2_graph_snapshots` + `v2_update_state` separately). After migration, only the RPC path should execute.

### 4.3 No other callers

The debug endpoint `POST /api/debug/v2-incremental` runs the incremental engine in **shadow mode** — it does NOT persist changes or call the RPC.

---

## 5. Cursor, Recovery, and Retry Behavior

### 5.1 Cursor Advancement

- Cursor (`last_processed_message_seq`) is **only advanced inside the atomic RPC**.
- It advances to the highest `message_seq` in the processed batch.
- On RPC failure, cursor stays at its previous value — messages remain unprocessed.
- Cursor is never advanced past proven coverage (design invariant).

### 5.2 Baseline Establishment

1. Captures `baselineMessageSeq` = MAX(message_seq) **before** generation starts.
2. Pipeline receives only messages with `message_seq <= baselineMessageSeq`.
3. RPC sets cursor = `baselineMessageSeq` atomically with the snapshot.
4. Messages arriving during generation (`message_seq > baselineMessageSeq`) trigger an incremental queue.

### 5.3 Recovery (Stale/Abandoned Work)

- **Module-level flag**: `recoveryTriggered` ensures exactly one recovery sweep per process lifetime.
- **Trigger points**: `enqueueV2Update()` and `GET /api/v2/graph-snapshot` both call `triggerRecoveryOnce()`.
- **Sweep logic**: Queries `v2_update_state` for rows with `update_status = 'queued'` OR (`update_status = 'updating'` AND `updated_at < staleThreshold`). Stale threshold = 5 minutes.
- **Recovery action**: Re-enqueues each stale conversation into the process-local chain for `processFromCursor`.

### 5.4 Retry Semantics

- After failure: `update_status` = `'failed'`, cursor stays, version stays.
- Next `enqueueV2Update` for the same conversation triggers `processFromCursor` again from the persisted cursor.
- The process-local Promise chain ensures sequential execution per conversation (no concurrent processing for the same conversation).
- Multiple rapid enqueues for the same conversation are serialized — second job sees nothing new after first processes all available messages.

### 5.5 Version Conflicts

**Current behavior: NO explicit optimistic locking check in the RPC.**

- The RPC does not verify that `p_from_version` matches the current `update_version` in `v2_update_state`.
- The mutation log uses `ON CONFLICT (conversation_id, from_version, to_version) DO NOTHING` — a duplicate version transition is silently ignored (idempotent).
- The process-local Promise chain provides **single-writer-per-process** serialization.
- There is no cross-process locking mechanism — if two server instances process the same conversation, both could call the RPC. The last writer's cursor/snapshot wins.
- **SIE implication:** An explicit version check (`WHERE update_version = p_from_version`) will need to be added for proper optimistic concurrency control.

---

## 6. Message Sequence Gaps

### 6.1 Sequence Generation

- `message_seq` is a `bigserial` — globally auto-incrementing, not per-conversation.
- Values are monotonically increasing across ALL conversations.
- Within a single conversation, sequences are monotonic but may have gaps (due to cross-conversation interleavings).

### 6.2 Gap Handling

- **No gap detection in the current system.** The incremental runner queries `message_seq > cursor` ordered ascending and processes all results.
- The cursor advances to the highest seq in the batch. If gaps exist (e.g., seq 5, 7, 8 — missing 6), the system would process 5/7/8 and advance cursor to 8. Message 6, if it appeared later (out-of-order insert), would have seq < cursor and be permanently skipped.
- **In practice**, messages are inserted sequentially per conversation through the messages API, and the `bigserial` assignment is monotonic, so gaps within a conversation are not expected under normal operation.
- **SIE implication:** If SIE requires strictly gap-free processing, it would need a per-conversation monotonic sequence or explicit gap detection.

---

## 7. Graph Snapshot Payload Shape (V2Snapshot)

**Source:** `src/lib/intelligence-v2/incremental/schemas.ts`

```typescript
export interface V2Snapshot {
  conversationId: string;
  objects: ConversationalObject[];
  relationships: Relationship[];
  propositions: Proposition[];
  threads: Thread[];
  hierarchy: DerivedHierarchyNode[];
  trees: DerivedTree[];
}
```

The `graph_payload` JSONB column stores exactly this shape (without `conversationId`):
```json
{
  "objects": [...],
  "relationships": [...],
  "propositions": [...],
  "threads": [...],
  "hierarchy": [...],
  "trees": [...]
}
```

---

## 8. Supabase Client Configuration

| Client | Key | RLS Bypass | Usage |
|--------|-----|-----------|-------|
| Server (`src/lib/supabase/server.ts`) | `SUPABASE_SERVICE_ROLE_KEY` | Yes — bypasses RLS | All API routes, update runner, RPC calls |
| Browser (`src/lib/supabase/client.ts`) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | No — subject to RLS | Client components only |

**Implication for SIE:** All current persistence operations use the service-role client. No RLS policies are currently enforced on V2 tables for server-side operations.

---

## 9. Entry Points into the Update Pipeline

| Entry Point | File | Triggers |
|-------------|------|----------|
| `POST /api/messages` | `app/api/messages/route.ts` | On new messages, if snapshot is ready and baseline is established |
| `POST /api/v2/graph-snapshot` (after baseline) | `app/api/v2/graph-snapshot/route.ts` | If messages arrived during generation, queues incremental |
| Recovery sweep | `update-runner.ts: recoverAbandonedWork()` | Reclaims queued/stale-updating conversations |
| `GET /api/v2/graph-snapshot` (side effect) | `app/api/v2/graph-snapshot/route.ts` | Triggers `triggerRecoveryOnce()` |

---

## 10. Summary of Key Facts for SIE Integration

| Fact | Value | Implication |
|------|-------|-------------|
| `conversations.id` type | UUID | SIE `conversation_id` must be UUID |
| `messages.id` type | UUID | SIE `source_message_ids` must reference UUID strings |
| `message_seq` type | bigint (bigserial) | Global, not per-conversation; gaps possible |
| `v2_update_state` PK | UUID (conversation_id) | One state row per conversation — SIE columns can be added |
| `v2_graph_snapshots` PK | UUID (conversation_id) | One snapshot per conversation |
| `update_version` type | integer | Monotonically increasing; no ceiling expected |
| RPC return type | void | SIE extension may need to return committed version or status |
| Version conflict check | **ABSENT** | Must be added for SIE optimistic concurrency |
| Cross-process locking | **ABSENT** | Process-local chains only; multi-instance risk exists |
| Mutation log idempotency | `ON CONFLICT DO NOTHING` | Same version-transition is silently deduped |
| Sequence gap detection | **ABSENT** | Not a current concern but relevant for SIE completeness guarantees |
| Service role bypasses RLS | Yes | SIE tables will need explicit RLS policies for anon-key paths |

---

## 11. Files Examined

- `docs/migrations/create_v2_graph_snapshots.sql`
- `docs/migrations/v2_durable_update_system.sql`
- `docs/migrations/create_continuation_provenance.sql`
- `docs/migrations/add_engine_state_v2_columns.sql`
- `docs/deployment.md`
- `src/lib/intelligence-v2/incremental/update-runner.ts`
- `src/lib/intelligence-v2/incremental/__tests__/update-runner.test.ts`
- `src/lib/intelligence-v2/__tests__/baseline-race.test.ts`
- `src/lib/intelligence-v2/incremental/schemas.ts`
- `src/lib/intelligence-v2/schemas.ts`
- `src/lib/supabase/server.ts`
- `src/lib/supabase/client.ts`
- `src/lib/db/conversations.ts`
- `src/types/db.ts`
- `app/api/v2/graph-snapshot/route.ts`
- `app/api/messages/route.ts`
- `app/api/debug/v2-incremental/route.ts`
