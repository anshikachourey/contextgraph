-- ═══════════════════════════════════════════════════════════════════════════
-- V2 DURABLE UPDATE SYSTEM — Final Migration
-- Run this entire file in the Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. STABLE MONOTONIC MESSAGE SEQUENCE
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_seq bigserial;

-- Backfill: assign sequence by created_at order for existing messages
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS seq
  FROM messages
)
UPDATE messages SET message_seq = ordered.seq
FROM ordered WHERE messages.id = ordered.id AND messages.message_seq = 0;

-- Reset sequence to continue after highest existing value
SELECT setval(pg_get_serial_sequence('messages', 'message_seq'),
  COALESCE((SELECT MAX(message_seq) FROM messages), 0));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. V2 UPDATE STATE (per-conversation cursor + incremental status)
-- ───────────────────────────────────────────────────────────────────────────

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

-- ───────────────────────────────────────────────────────────────────────────
-- 3. SAFE CURSOR BOOTSTRAP
--
-- RULE: Never initialize cursor past data the snapshot is not proven to contain.
--
-- Strategy: Current snapshots are development/test data without trustworthy
-- message-level coverage metadata. Rather than guessing coverage, we mark
-- existing snapshots as needing a baseline rebuild. The cursor starts at 0
-- (meaning "no messages have been proven processed for this snapshot").
--
-- On the next V2 full-regeneration (POST /api/v2/graph-snapshot), the
-- snapshot and cursor will be established together at a known boundary.
--
-- For any existing snapshot: initialize cursor = 0 and mark the conversation
-- for a full rebuild by setting a diagnostic flag. The incremental engine
-- will only run after a new baseline is established.
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO v2_update_state (conversation_id, last_processed_message_seq, update_version, update_status)
SELECT
  s.conversation_id,
  0,  -- cursor=0: no messages proven incorporated by this snapshot
  COALESCE((s.diagnostics->>'updateVersion')::integer, 0),
  'idle'
FROM v2_graph_snapshots s
WHERE s.status = 'ready'
ON CONFLICT (conversation_id) DO NOTHING;

-- Mark existing snapshots as needing baseline rebuild in diagnostics
UPDATE v2_graph_snapshots
SET diagnostics = COALESCE(diagnostics, '{}'::jsonb) || '{"needsBaselineRebuild": true}'::jsonb
WHERE status = 'ready'
  AND NOT (diagnostics ? 'cursorEstablished');

-- ───────────────────────────────────────────────────────────────────────────
-- 4. V2 MUTATION LOG (versioned transitions for future animation/replay)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS v2_mutation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_version integer NOT NULL,
  to_version integer NOT NULL,
  mutations jsonb NOT NULL DEFAULT '[]',
  message_seq_range int8range,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Prevent duplicate version transitions for the same conversation
  UNIQUE (conversation_id, from_version, to_version)
);

CREATE INDEX IF NOT EXISTS idx_v2_mutation_log_conv_ver
  ON v2_mutation_log(conversation_id, to_version);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. TRANSACTIONAL COMMIT RPC
-- Atomically commits: snapshot + mutation log + cursor advance.
-- Either all succeed or all roll back.
-- ───────────────────────────────────────────────────────────────────────────

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
  -- 1. Update snapshot payload + mark ready
  UPDATE v2_graph_snapshots
  SET graph_payload = p_new_snapshot,
      status = 'ready',
      diagnostics = COALESCE(diagnostics, '{}'::jsonb)
        || jsonb_build_object(
          'updateVersion', p_to_version,
          'lastIncrementalUpdate', now()::text,
          'lastIncrementalMutations', jsonb_array_length(p_mutations),
          'lastUpdateError', null,
          'updateFailedAt', null,
          'cursorEstablished', true,
          'needsBaselineRebuild', false
        ),
      updated_at = now()
  WHERE conversation_id = p_conversation_id;

  -- 2. Insert mutation log (idempotent via UNIQUE constraint)
  INSERT INTO v2_mutation_log (
    conversation_id, from_version, to_version, mutations, message_seq_range
  ) VALUES (
    p_conversation_id, p_from_version, p_to_version, p_mutations,
    int8range(p_message_seq_from, p_message_seq_to, '[]')
  ) ON CONFLICT (conversation_id, from_version, to_version) DO NOTHING;

  -- 3. Advance cursor + clear update state
  UPDATE v2_update_state
  SET last_processed_message_seq = p_last_processed_seq,
      update_version = p_to_version,
      update_status = 'idle',
      pending_since = NULL,
      last_update_error = NULL,
      update_failed_at = NULL,
      updated_at = now()
  WHERE conversation_id = p_conversation_id;
END;
$$ LANGUAGE plpgsql;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. SEPARATE SNAPSHOT STATUS
-- Ensure v2_graph_snapshots.status supports the needed values.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE v2_graph_snapshots DROP CONSTRAINT IF EXISTS v2_graph_snapshots_status_check;
ALTER TABLE v2_graph_snapshots ADD CONSTRAINT v2_graph_snapshots_status_check
  CHECK (status IN ('generating_initial', 'generating', 'ready', 'failed'));

-- Rename in-progress rows without payload to generating_initial
UPDATE v2_graph_snapshots
SET status = 'generating_initial'
WHERE status = 'generating' AND graph_payload IS NULL;
