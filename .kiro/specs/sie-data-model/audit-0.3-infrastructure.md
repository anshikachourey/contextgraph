# Audit 0.3 — Security, Migration, and Local-Test Infrastructure

## 1. Supabase RLS Policies

### Finding: No RLS policies exist in the repository

- **Zero SQL files** define `CREATE POLICY`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, or any RLS configuration.
- The project has **two Supabase clients** with distinct security boundaries:
  - `src/lib/supabase/client.ts` — Browser-side, uses `NEXT_PUBLIC_SUPABASE_ANON_KEY` (subject to RLS).
  - `src/lib/supabase/server.ts` — Server-side, uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS entirely).
- All existing API routes and database operations (`src/lib/db/*.ts`, `src/lib/intelligence-v2/index.ts`, etc.) use **`createServerSupabaseClient()`** exclusively — meaning all current database access bypasses RLS via the service-role key.
- The deployment docs (`docs/deployment.md`) list no authentication or RLS setup.
- The project explicitly states **"Authentication (no login)"** is not included in the MVP.

### Implication for SIE

The SIE data-model tasks (Task 2.6) plan to add RLS policies "consistent with the existing conversation-ownership model." Since **no ownership model or RLS policies currently exist**, SIE will need to establish them from scratch. The existing pattern is service-role-only access with no client-side data exposure beyond what the anon key allows on unprotected tables.

---

## 2. Service-Role Boundaries

| Client | Key | Location | Usage |
|--------|-----|----------|-------|
| Browser client | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `src/lib/supabase/client.ts` | Not imported by any API route; effectively unused in current codebase |
| Server client | `SUPABASE_SERVICE_ROLE_KEY` | `src/lib/supabase/server.ts` | Used by ALL database operations (conversations, messages, nodes, edges, candidates, mutations, snapshots, engine state) |

Key rules documented in the codebase:
- "Only import [server client] in API routes, never in client components."
- "The service role key must NEVER be prefixed with NEXT_PUBLIC_."

All RPC calls (`v2_commit_update`) are made through the service-role client, which has full database access.

---

## 3. Migration Conventions

### Location and Format

- Migrations are stored as **standalone `.sql` files** in `docs/migrations/`.
- There is **no Supabase CLI project** (`supabase/` directory, `supabase.toml`, or `config.toml` do not exist).
- There is **no automated migration runner** — migrations are applied manually via the **Supabase SQL Editor** (per `docs/deployment.md`).

### Existing Migrations (in chronological/dependency order)

1. `add_engine_state_v2_columns.sql` — Adds `cursor` and `open_segment` columns to `conversation_engine_state`; adds `last_touched_run` to `topic_candidates`.
2. `create_continuation_provenance.sql` — Creates `continuation_provenance` table with FK to `conversations(id)`.
3. `create_v2_graph_snapshots.sql` — Creates `v2_graph_snapshots` table with status enum constraint.
4. `v2_durable_update_system.sql` — The most comprehensive migration:
   - Adds `message_seq` to `messages` with backfill logic.
   - Creates `v2_update_state` (cursor/status per conversation).
   - Bootstraps cursor for existing snapshots.
   - Creates `v2_mutation_log` (versioned transitions).
   - Creates `v2_commit_update` RPC (PL/pgSQL function).
   - Updates `v2_graph_snapshots` status constraint.

### Conventions Observed

- All use `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` for idempotent re-application.
- Comments explain purpose and rationale.
- No versioning numbering scheme (no sequential migration numbers).
- No down-migrations or explicit rollback scripts exist.
- The `v2_commit_update` RPC uses `CREATE OR REPLACE FUNCTION` for safe re-deployment.
- `ON DELETE CASCADE` is used for conversation-scoped tables.
- CHECK constraints are used for enum-like columns (status fields).
- Indexes are created with `IF NOT EXISTS`.
- `ON CONFLICT ... DO NOTHING` is used for idempotent inserts.

---

## 4. Database-Test Utilities

### Finding: No dedicated database-test utilities exist

- There is **no local Supabase instance** configuration (no `supabase/` directory, no Docker compose for local Postgres).
- There is **no test database** — the `.env.local` points directly to a hosted Supabase project (`trhqsybqeqgjgiobsism.supabase.co`).
- The existing TypeScript tests (`update-runner.test.ts`) mock the entire Supabase client using `vi.mock()` — they do **not** test against a real database.
- There are **no database integration tests** that validate RPC behavior, constraint enforcement, or transactional rollback against actual PostgreSQL.

### Mocking Pattern (used in update-runner.test.ts)

```typescript
vi.mock("@/src/lib/supabase/server", () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => { /* simulated DB responses */ },
    rpc: (_name: string, args: Record<string, unknown>) => { /* simulated RPC */ },
  }),
}));
```

This mock simulates:
- Table reads (select/eq/single)
- Upserts
- RPC calls (v2_commit_update) with success/failure injection
- Cursor advancement logic

---

## 5. Rollback Conventions

### Finding: No formal rollback conventions exist

- No "down" migration files exist.
- No migration versioning system supports rollback.
- The only rollback mechanism observed is PostgreSQL's implicit transactional guarantee via the `v2_commit_update` RPC (`BEGIN`...`END` in PL/pgSQL).
- The design doc references rollback as "an explicit migration/restore operation" for SIE authority changes, but this is aspirational — no existing implementation exists.
- Migrations use `IF NOT EXISTS` patterns which make them idempotent but don't provide reversibility.

### Implication for SIE

Task 2.7 will need to **establish** rollback conventions rather than follow existing ones. Options include:
- Paired up/down `.sql` files
- Adopting Supabase CLI for managed migrations
- Manual rollback scripts in a new `docs/migrations/rollback/` directory

---

## 6. Local-Test Environment for Migrations and RPCs

### Current State

- **No local Supabase setup** — no `supabase init`, no Docker Postgres configuration.
- All current testing is either:
  - **Unit tests with full mocks** (TypeScript/Vitest) — no real DB.
  - **Manual integration against hosted Supabase** — the only `.env.local` points to the cloud project.
- The ml-service has its own local `test_cluster.py` that tests against a running local uvicorn server (no DB involvement).

### How Migrations/RPCs CAN Be Tested Locally

Given the current setup, the options for SIE are:

1. **Supabase CLI local dev** (`supabase start`) — Would provide a local PostgreSQL + PostgREST + Auth stack via Docker. Not currently configured but is the standard approach for testing migrations and RPCs without touching shared environments.

2. **Direct Docker PostgreSQL** — A standalone Postgres container with the migration scripts applied. Simpler but loses PostgREST/RPC testing.

3. **Continue mocking** — Extend the existing Vitest mock pattern (as in `update-runner.test.ts`). This tests business logic but does NOT validate SQL correctness, constraints, or RPC behavior.

### Confirmed: No Shared/Production Risk for Testing

- The existing test suite (`vitest run`) uses **only mocks** and makes zero network calls.
- Python tests (`test_cluster.py`) call a local HTTP server only.
- There is no test that touches the hosted Supabase project.
- SIE testing can safely proceed with a local Supabase CLI instance or Docker PostgreSQL without any risk to the hosted project.

---

## 7. TypeScript Test Framework

### Vitest (primary)

- **Config**: `vitest.config.mts` — minimal setup with `globals: true` and `@` path alias.
- **Runner**: `npm run test` → `vitest run` (single run); `npm run test:watch` → `vitest` (watch mode).
- **Version**: `vitest ^4.1.9` (latest major).
- **Mocking**: Uses `vi.mock()` for module-level mocks, `vi.fn()` for function spies.
- **Assertions**: Uses Vitest's built-in `expect` (Jest-compatible API).

### Existing Test Coverage

| Directory | Test Files | Focus |
|-----------|-----------|-------|
| `src/lib/intelligence-v2/__tests__/` | 8 files | Invariants, propositions, objects, relationships, JSON parsing, display layout, normalization, baseline-race |
| `src/lib/intelligence-v2/incremental/__tests__/` | 2 files | Update runner, incremental processing |
| `src/lib/intelligence/__tests__/` | 1 file | Preservation property tests (segmentation, routing, confidence) |

### Property-Based Testing

- **No dedicated PBT library** (`fast-check` is NOT in `package.json` or `package-lock.json`).
- The "preservation property tests" in `src/lib/intelligence/__tests__/preservation.test.ts` are conventional unit tests with deterministic fixtures — not true generative property tests.
- The SIE design specifies PBT for model validation. **`fast-check` will need to be added as a dev dependency.**

---

## 8. Python Test Framework

### Current State: Minimal

- **No pytest** — not in `requirements.txt`, no `pytest.ini`, no `conftest.py`.
- **No unittest** usage found.
- **No hypothesis** (Python PBT library) installed.
- Single test file: `ml-service/test_cluster.py` — a manual integration test that:
  - Sends HTTP requests to a running local FastAPI server.
  - Validates responses with print statements and assertions.
  - Is NOT a unit test framework — requires the service to be running.

### Python Runtime

- **Python 3.11** (per ml-service README; venv configured with Python 3.13).
- **FastAPI** `0.115.6` with **Pydantic** `>=2.0.0` — models are already Pydantic v2.
- **No linter or formatter** configured (no `ruff.toml`, `pyproject.toml`, `.flake8`, or `black` config).

### Implication for SIE

The SIE Python tasks will need to:
- Add `pytest` to `requirements.txt` (or a separate `requirements-dev.txt`).
- Add `hypothesis` for property-based testing.
- Establish a `tests/` directory structure in `ml-service/`.
- Consider adding `ruff` or `mypy` for type checking (Pydantic v2 models benefit greatly).

---

## 9. Code-Generation Tooling

### Finding: No code-generation tooling is currently configured

- No OpenAPI generator, JSON Schema generator, or TypeScript-from-Python code-gen tool exists in the project.
- The `package.json` has no `generate`, `codegen`, or schema-related scripts.
- The ml-service has no `openapi.json` export configuration.
- FastAPI can auto-generate OpenAPI specs at runtime (`/docs`, `/openapi.json`) but no artifact is checked into the repository.

### Planned for SIE (from design doc)

- **Source of truth**: Python Pydantic models → FastAPI OpenAPI spec.
- **Generated artifacts**: TypeScript transport types from OpenAPI/JSON-schema.
- **Tools to establish**: OpenAPI export script + TypeScript type generator (e.g., `openapi-typescript`, `openapi-generator-cli`, or similar).

---

## 10. Summary of Gaps for SIE Implementation

| Capability | Current State | Required for SIE |
|-----------|---------------|-----------------|
| RLS policies | None exist | Must be created from scratch (Task 2.6) |
| Local Supabase | Not configured | Supabase CLI or Docker Postgres needed |
| Database integration tests | None | Required for RPC/constraint validation (Task 6.3) |
| Rollback procedures | None | Must be established (Task 2.7) |
| Python test framework | Manual HTTP script only | pytest + hypothesis needed (Task 1.5) |
| TypeScript PBT library | Not installed | fast-check needed |
| OpenAPI/codegen tooling | Not configured | Must be established (Tasks 3.4, 4.1) |
| Python linting/type checking | Not configured | Recommended for model correctness |
| Migration versioning | No numbering scheme | Should be established for dependency ordering |
