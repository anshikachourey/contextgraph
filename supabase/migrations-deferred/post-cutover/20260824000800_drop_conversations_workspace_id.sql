-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: DEFERRED cleanup — drop the legacy conversations.workspace_id column
--
-- Feature: google-oauth-authentication (Task 17 hardening item 5 — step 3)
-- Requirements: 11.1
--
-- ⚠️  DO NOT APPLY THIS UNTIL THE NEW CODE IS FULLY DEPLOYED.
--
-- This is STEP 3 of the backward-compatible rename sequence designed in
-- migration 20260824000100:
--
--   STEP 1 (20260824000100): ADD conversations.legacy_workspace_id as a copy of
--           workspace_id, BACKFILL it, and install a bidirectional SYNC TRIGGER
--           so both columns stay identical. Zero-downtime; the deployed app
--           keeps reading workspace_id.
--   STEP 2: deploy the new application code that reads/writes
--           legacy_workspace_id (and, at cutover, relies on RLS). The sync
--           trigger keeps workspace_id correct for any old instances still
--           running during the rollout.
--   STEP 3 (THIS migration): once NO deployed code reads conversations.
--           workspace_id anymore, drop the sync trigger + function and DROP the
--           workspace_id column. Safe because nothing references it.
--
-- Applying this BEFORE step 2 completes would reintroduce exactly the breakage
-- the sequence exists to prevent, so it is a SEPARATE, LATER migration — never
-- bundled with the additive step-1 migration.
--
-- Idempotent: DROP ... IF EXISTS guards throughout.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Remove the bidirectional sync trigger + its function first (the column is
-- about to go away, so there is nothing left to keep in sync).
DROP TRIGGER IF EXISTS trg_sync_conversations_legacy_workspace_id ON conversations;
DROP FUNCTION IF EXISTS public.sync_conversations_legacy_workspace_id();

-- Finally drop the legacy column. legacy_workspace_id is now the sole
-- owner/demo discriminator (and the UUID_Migration has reassociated owner rows
-- to real account_workspace_id values).
ALTER TABLE conversations DROP COLUMN IF EXISTS workspace_id;
