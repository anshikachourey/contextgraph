-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Re-parent graph_workspaces & conversations; add migration_runs
--
-- Feature: google-oauth-authentication (Task 3.2)
-- Requirements: 11.1, 11.8
--
-- Additive & behavior-neutral while the cutover flag is false:
--   - graph_workspaces gains account_workspace_id (FK ON DELETE CASCADE); the
--     legacy workspace_id TEXT column + its CHECK/index are RETAINED.
--   - conversations gains account_workspace_id (FK ON DELETE SET NULL).
--   - migration_runs bookkeeping table for the one-time UUID_Migration.
--
-- messages / nodes / edges / conversation_node_positions are NOT re-parented:
-- they are keyed by conversation_id and inherit scoping transitively.
--
-- ── SAFE DEPLOYMENT ORDER FOR THE workspace_id → legacy_workspace_id RENAME ─────
--
-- The CURRENTLY-DEPLOYED app reads `conversations.workspace_id`. A bare
-- `RENAME COLUMN workspace_id TO legacy_workspace_id` would break the live app
-- the instant the migration lands and BEFORE the new code deploys — there is a
-- window (migration applied, new code not yet deployed) where the old code would
-- query a column that no longer exists.
--
-- This migration therefore does NOT rename. It uses ADD-COLUMN + BACKFILL + a
-- bidirectional SYNC TRIGGER so BOTH columns coexist and stay identical during
-- the transition:
--
--   STEP 1 (THIS migration — additive, zero-downtime):
--     * ADD conversations.legacy_workspace_id TEXT (copy of workspace_id).
--     * BACKFILL legacy_workspace_id := workspace_id for every existing row.
--     * Install a BEFORE INSERT/UPDATE trigger that keeps the two columns in
--       sync in BOTH directions: a write to EITHER column mirrors to the other,
--       and an insert that sets only one populates the other. So the OLD code
--       (writes/reads workspace_id) and the NEW code (reads legacy_workspace_id)
--       both see correct, identical data during the window.
--
--   STEP 2 (deploy new application code):
--     * New code reads/writes legacy_workspace_id (and, at cutover, RLS). The
--       sync trigger keeps workspace_id correct for any still-running old
--       instances during the rollout.
--
--   STEP 3 (LATER migration — only AFTER step 2 is fully rolled out):
--     * Drop the sync trigger and DROP COLUMN conversations.workspace_id (the
--       deferred cleanup migration 20260824000800). By then no deployed code
--       reads workspace_id, so the drop is safe.
--
-- Between migration-apply (step 1) and code-deploy (step 2) the deployed app
-- keeps working because workspace_id still exists and is kept in sync.
--
-- Idempotent: IF NOT EXISTS guards + CREATE OR REPLACE trigger function + a
-- conditional backfill that no-ops on re-run.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── graph_workspaces: add real workspace parent (retain legacy workspace_id) ─
ALTER TABLE graph_workspaces
  ADD COLUMN IF NOT EXISTS account_workspace_id UUID
  REFERENCES account_workspaces(id) ON DELETE CASCADE;

COMMENT ON COLUMN graph_workspaces.account_workspace_id IS
  'Real workspace parent. Populated by the UUID_Migration (Task 15). Legacy workspace_id TEXT is retained until a later cleanup.';

CREATE INDEX IF NOT EXISTS idx_graph_workspaces_account_workspace
  ON graph_workspaces (account_workspace_id);

-- ─── conversations: add real workspace parent + rename legacy column ─────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS account_workspace_id UUID
  REFERENCES account_workspaces(id) ON DELETE SET NULL;

COMMENT ON COLUMN conversations.account_workspace_id IS
  'Real workspace parent. Populated by the UUID_Migration (Task 15). ON DELETE SET NULL to avoid cascading conversation loss if a workspace is removed.';

-- ── STEP 1a: ADD legacy_workspace_id as a COPY (do NOT rename) ────────────────
-- Both columns coexist so the deployed app (workspace_id) and the new code
-- (legacy_workspace_id) keep working during the rollout window.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS legacy_workspace_id TEXT;

COMMENT ON COLUMN conversations.legacy_workspace_id IS
  'Copy of the legacy workspace_id TEXT (''owner''/''demo''), added additively (NOT a rename) so the deployed app keeps reading workspace_id during rollout. Kept in sync with workspace_id by trigger sync_conversations_legacy_workspace_id until the deferred cleanup migration drops workspace_id. Used by the UUID_Migration (owner rows carry ''owner''; demo rows carry ''demo'' and are never touched).';

-- ── STEP 1b: BACKFILL existing rows (idempotent — only fills NULLs) ───────────
UPDATE conversations
SET legacy_workspace_id = workspace_id
WHERE legacy_workspace_id IS DISTINCT FROM workspace_id;

-- ── STEP 1c: BIDIRECTIONAL SYNC TRIGGER ───────────────────────────────────────
-- Keeps workspace_id and legacy_workspace_id identical on every INSERT/UPDATE,
-- in BOTH directions, so neither the old nor the new code can observe a stale or
-- missing value during the transition. On the deferred cleanup migration this
-- trigger is dropped together with the workspace_id column.
CREATE OR REPLACE FUNCTION public.sync_conversations_legacy_workspace_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Populate whichever column the writer left NULL from the other.
    IF NEW.legacy_workspace_id IS NULL AND NEW.workspace_id IS NOT NULL THEN
      NEW.legacy_workspace_id := NEW.workspace_id;
    ELSIF NEW.workspace_id IS NULL AND NEW.legacy_workspace_id IS NOT NULL THEN
      NEW.workspace_id := NEW.legacy_workspace_id;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: mirror whichever column actually changed to the other, so a write
  -- through either name propagates. If both changed to the same value, no-op.
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     AND NEW.legacy_workspace_id IS NOT DISTINCT FROM OLD.legacy_workspace_id THEN
    NEW.legacy_workspace_id := NEW.workspace_id;
  ELSIF NEW.legacy_workspace_id IS DISTINCT FROM OLD.legacy_workspace_id
     AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id THEN
    NEW.workspace_id := NEW.legacy_workspace_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_conversations_legacy_workspace_id ON conversations;
CREATE TRIGGER trg_sync_conversations_legacy_workspace_id
  BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.sync_conversations_legacy_workspace_id();

CREATE INDEX IF NOT EXISTS idx_conversations_account_workspace
  ON conversations (account_workspace_id);

CREATE INDEX IF NOT EXISTS idx_conversations_legacy_workspace
  ON conversations (legacy_workspace_id);

-- ─── migration_runs: one-time UUID_Migration bookkeeping ─────────────────────
CREATE TABLE IF NOT EXISTS migration_runs (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'owner_uuid_migration',
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_runs IS
  'Records completion of the one-time owner-data UUID_Migration per user, enabling skip-if-done idempotency (Req 11.4).';
