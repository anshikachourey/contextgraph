# SIE Database Migrations

## Overview

This directory contains the SQL migrations for the Semantic Intelligence Engine (SIE) data model. All migrations are additive and idempotent — they use `IF NOT EXISTS`, `CREATE OR REPLACE`, and `ON CONFLICT` patterns for safe re-application.

## Migration Dependency Order

Migrations MUST be applied in sequential order. Each migration depends on objects created by previous migrations:

| Migration | Creates | Depends On |
|-----------|---------|-----------|
| `001_authoritative_engine_and_idempotency.sql` | `v2_update_state` columns, `sie_entity_registry`, `sie_commit_requests`, idempotency trigger | `conversations`, `v2_update_state` |
| `002_persistent_concerns_and_aliases.sql` | `sie_persistent_concerns`, `sie_concern_aliases` | `conversations` |
| `003_propositions_and_associations.sql` | `sie_propositions`, `sie_proposition_associations` | `conversations`, `sie_persistent_concerns` |
| `004_packets_memberships_and_splits.sql` | `sie_semantic_packets`, `sie_packet_memberships`, `sie_packet_splits`, deferred FK | `conversations`, `sie_propositions`, `sie_proposition_associations` |
| `005_retention_pending_decisions_and_audit.sql` | `sie_retention_decisions`, `sie_pending_semantic_decisions`, `sie_audit_history` | `conversations` |
| `006_indexes_and_rls_policies.sql` | Additional indexes, RLS policies, `sie_user_owns_conversation()` | All SIE tables (001–005) |
| `007_rollback.sql` | — (removes all SIE objects) | N/A |
| `008_versioned_commit_rpc.sql` | `v2_commit_update` RPC extension | All SIE tables (001–006) |
| `009_identity_resolution_records.sql` | `sie_identity_resolution_records` | `conversations`, `sie_entity_registry` (001), `sie_semantic_packets` (004), `sie_persistent_concerns` (002) |

## How to Apply Migrations

### Local/Test Environment (Recommended)

**Option A: Supabase CLI (if configured)**
```bash
supabase start
# Then apply each migration in order via the local SQL editor at http://localhost:54323
```

**Option B: Docker PostgreSQL**
```bash
docker run -d --name sie-test-db \
  -e POSTGRES_PASSWORD=testpass \
  -p 5432:5432 \
  postgres:15

# Apply migrations in order
for f in docs/migrations/sie/00{1,2,3,4,5,6}*.sql; do
  psql -h localhost -U postgres -d postgres -f "$f"
done
```

**Option C: Supabase SQL Editor (hosted test project only)**
1. Open the SQL Editor in your Supabase dashboard
2. Paste and run each migration file in order (001 → 006)

### Production

> **⚠️ Do NOT apply SIE migrations to production during this plan.**
> The default authoritative engine remains V2. SIE migrations should only be applied in local/test environments until the full implementation is validated and approved for production deployment.

## How to Run Schema Tests

The `schema_tests.sql` file contains 30 SQL assertions that verify all CHECK, FK, UNIQUE, and partial-index constraints are correctly enforced.

### Prerequisites

1. All SIE migrations (001–006) must be applied first.
2. A `conversations` table must exist (created by existing V2 migrations).

### Running

```bash
# Via psql (Docker or local Supabase)
psql -h localhost -U postgres -d postgres -f docs/migrations/sie/schema_tests.sql
```

Or paste the contents into the Supabase SQL Editor and run.

### Expected Output

Each test prints either:
- `NOTICE: TEST PASSED: <description>` — constraint works correctly
- `ERROR: TEST FAILED: <description>` — constraint is missing or broken

All 30 tests should output "TEST PASSED". The tests also include a cleanup section that removes all test data.

### What the Tests Cover

| Category | Count | Examples |
|----------|-------|---------|
| CHECK constraints | 16 | Status enums, seq ranges, speaker roles, retention levels, cohesion, parent/merge consistency |
| FK constraints | 4 | Orphaned proposition, concern, packet, parent references |
| UNIQUE constraints | 4 | Entity registry, request_id, membership uniqueness |
| Partial unique indexes | 2 | At-most-one active PRIMARY_OWNER, active alias uniqueness |
| Trigger behavior | 1 | Idempotency fingerprint mismatch rejection |

## Rollback Procedure

The `007_rollback.sql` file completely removes all SIE schema objects and restores the database to its pre-SIE state.

### When to Use

- Removing SIE from a test environment to start fresh
- Rolling back a failed migration attempt
- Reverting to pure V2 operation

### Steps

1. **Verify** you are connected to the correct (non-production) database
2. **Run** `007_rollback.sql`:
   ```bash
   psql -h localhost -U postgres -d postgres -f docs/migrations/sie/007_rollback.sql
   ```
3. **Confirm** all SIE tables, indexes, policies, triggers, and functions are removed
4. **Verify** `v2_update_state` no longer has `authoritative_engine` or `sie_cutover_graph_version` columns

### Rollback is Safe to Re-run

The rollback uses `IF EXISTS` and `DROP ... CASCADE` patterns, making it safe to run multiple times without error.

### What Gets Removed

- All 12 SIE tables and their data
- All SIE indexes (from 001–006)
- All RLS policies on SIE tables
- The `sie_user_owns_conversation()` helper function
- The `sie_enforce_idempotency_fingerprint()` trigger and function
- The `authoritative_engine` and `sie_cutover_graph_version` columns from `v2_update_state`

### What is NOT Affected

- `conversations`, `messages`, and all existing V2 tables
- `v2_graph_snapshots`, `v2_update_state` (core columns), `v2_mutation_log`
- The `v2_commit_update` RPC function
- All existing V2 data and functionality

## V2 Compatibility

### Existing V2 Callers Are Unaffected

The SIE migration 001 extends `v2_update_state` with:
- `authoritative_engine TEXT NOT NULL DEFAULT 'V2'`
- `sie_cutover_graph_version INTEGER` (nullable)

Both use `ADD COLUMN IF NOT EXISTS` with safe defaults. The two existing V2 callers:

1. **`update-runner.ts`** — Calls `v2_commit_update` with the original 8 parameters. Does not read or write `authoritative_engine` or `sie_cutover_graph_version`.
2. **`graph-snapshot/route.ts`** — Calls `v2_commit_update` with the original 8 parameters. Does not read or write the new columns.

Neither caller needs modification. The `DEFAULT 'V2'` ensures all existing rows have valid values without any data migration.

## Environment Notes

- **No Supabase CLI** is configured in this repository. Migrations are applied manually.
- **No automated migration runner** exists. Apply files in order via SQL Editor or `psql`.
- **No down-migration convention** existed prior to SIE. The `007_rollback.sql` establishes the rollback convention.
- All existing tests use **mocked Supabase clients** (Vitest `vi.mock()`). Schema verification tests require a real PostgreSQL instance.
