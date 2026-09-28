-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Add conversation_scope column to conversations
--
-- Introduces a persistent scope/origin field so that conversations created from
-- Graph Dashboard nodes can be distinguished from normal independent conversations.
--
-- Values:
--   'main'            — Independent conversation (created via normal chat UI).
--                       Appears in the main application Conversations sidebar.
--   'graph_workspace' — Created from a Graph Dashboard node.
--                       Appears only nested inside its graph, NOT in the main sidebar.
--
-- This does NOT affect:
--   - graph_workspace_conversations membership (which is a separate concept)
--   - existing conversations (all backfilled as 'main')
--   - workspace_id scoping
--
-- Idempotent: uses IF NOT EXISTS / safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add column with default 'main' (all existing rows become 'main')
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS conversation_scope TEXT NOT NULL DEFAULT 'main';

-- 2. Add CHECK constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_conversation_scope_valid'
    ) THEN
        ALTER TABLE conversations
        ADD CONSTRAINT chk_conversation_scope_valid
        CHECK (conversation_scope IN ('main', 'graph_workspace'));
    END IF;
END $$;

-- 3. Add index for filtered listing (main sidebar queries scope='main')
CREATE INDEX IF NOT EXISTS idx_conversations_scope_listing
ON conversations (workspace_id, conversation_scope, created_at DESC);

COMMENT ON COLUMN conversations.conversation_scope IS
  'Determines where this conversation appears. "main" = normal sidebar, "graph_workspace" = only inside its graph. Set at creation time, immutable under normal operation.';
