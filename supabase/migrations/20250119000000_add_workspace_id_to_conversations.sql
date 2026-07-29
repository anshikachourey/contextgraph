-- Migration: Add workspace_id column to conversations for two-workspace isolation.
-- Ordered steps: nullable → backfill → constraint → NOT NULL → index.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Add workspace_id as nullable text
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS workspace_id TEXT;

COMMENT ON COLUMN conversations.workspace_id IS
  'Workspace that owns this conversation. Must be "owner" or "demo". Set explicitly by server code on creation — no database default.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Backfill all existing conversations as "owner"
-- ═══════════════════════════════════════════════════════════════════════════════
UPDATE conversations
SET workspace_id = 'owner'
WHERE workspace_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Add CHECK constraint restricting values to owner | demo
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE conversations
ADD CONSTRAINT chk_workspace_id_valid
CHECK (workspace_id IN ('owner', 'demo'));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Make workspace_id NOT NULL now that all rows are backfilled
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE conversations
ALTER COLUMN workspace_id SET NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Add index for efficient workspace-scoped listing queries
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_listing
ON conversations (workspace_id, created_at DESC);
