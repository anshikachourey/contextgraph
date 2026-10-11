# Deferred, post-cutover migrations (NOT auto-applied)

Files in this directory are **deliberately kept OUT of `supabase/migrations/`** so
that `supabase db push` (which applies everything under `supabase/migrations/` in
timestamp order) does **NOT** apply them automatically.

They are **destructive, backward-incompatible** steps that must run **manually**,
and **only after** a strict set of preconditions is met.

## Why these are not in `supabase/migrations/`

`supabase db push` applies every file in `supabase/migrations/` in order. If the
destructive drop lived there, it would run **immediately alongside** the additive
migrations (`20260824000100` adds `legacy_workspace_id` + backfill + bidirectional
sync trigger while retaining `workspace_id`). That would drop
`conversations.workspace_id` **before the new application code is deployed**,
breaking backward compatibility and the live app the instant the migration lands.

The initial production migration set therefore **STOPS at**:

- `20260824000000` — core identity & workspace tables
- `20260824000100` — additive re-parent + `legacy_workspace_id` + backfill + **bidirectional sync trigger** (retains `workspace_id`)
- `20260824000200` — provisioning trigger
- `20260824000300` — `provision_self()` RPC
- `20260824000400` — debug-authz helpers
- `20260824000500` — enable RLS + membership policies
- `20260824000600` — UUID-migration function + fail-closed preflight
- `20260824000700` — preflight-report RPC

## Contents

- `20260824000800_drop_conversations_workspace_id.sql` — **DESTRUCTIVE**: drops the
  bidirectional sync trigger + its function and `DROP COLUMN conversations.workspace_id`.

## How to apply (MANUAL, post-cutover only)

Apply **only after ALL** of the following preconditions hold:

1. **New code fully deployed** — no running instance reads/writes
   `conversations.workspace_id`; the app uses `legacy_workspace_id` (and, at
   cutover, RLS).
2. **Cutover enabled** — `AUTH_SUPABASE_CUTOVER_ENABLED = true` in the target
   environment.
3. **Legacy code removed** — no code path references `conversations.workspace_id`.
4. **Both columns verified in sync** — `workspace_id` and `legacy_workspace_id`
   are identical for every row (the sync trigger has kept them so).

Then, to apply it as a **normally-sequenced** migration:

1. **Copy** this file into `supabase/migrations/` under a **new, later** timestamp
   (e.g. `supabase cp` / regenerate the leading `YYYYMMDDHHMMSS` so it sorts after
   `20260824000700`), keeping the file body intact.
2. Run `supabase db push` (or your normal migration apply) so it runs as a single,
   reviewed, normally-sequenced migration.
3. Verify `conversations.workspace_id` is gone and the sync trigger/function are
   dropped.

Do **not** apply it in place from this directory, and do **not** move the original
back without the new timestamp — the point is that it only ever runs as an explicit,
reviewed, post-cutover step.
