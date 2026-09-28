-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Create graph_workspaces and related tables
-- 
-- Introduces first-class graph workspace entities to replace the legacy
-- fake-conversation dashboard persistence pattern.
--
-- Tables created:
--   1. graph_workspaces — persistent graph workspace with JSONB payload
--   2. graph_workspace_conversations — many-to-many join (graph ↔ conversation)
--   3. conversation_node_positions — user-arranged node positions for Knowledge Maps
--
-- Also creates:
--   - Auto-update trigger for graph_workspaces.updated_at
--   - Indexes for common query patterns
--
-- Idempotent: safe to re-run (uses IF NOT EXISTS / OR REPLACE where possible).
-- ═══════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. graph_workspaces
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS graph_workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Current ownership model (workspace-based).
    -- Designed for future transition to user_id UUID REFERENCES auth.users(id).
    workspace_id TEXT NOT NULL,
    
    -- User-facing name of this graph workspace.
    name TEXT NOT NULL DEFAULT 'Untitled Graph',
    
    -- Versioned JSONB payload containing nodes, edges, and positions.
    -- Shape (schema_version=1):
    --   { nodes: PersistedNode[], edges: PersistedEdge[] }
    -- PersistedNode: { id, position: {x, y}, conversationId?, data: {title, objectType, description, provenance, createdAt} }
    -- PersistedEdge: { id, source, target, label?, data: {type, explanation, provenance, createdAt} }
    graph_payload JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    
    -- Enables forward-compatible payload evolution without guessing shape.
    schema_version INTEGER NOT NULL DEFAULT 1,
    
    -- Durable legacy import key. When this graph was created by importing legacy
    -- localStorage or fake-conversation data, this field stores a unique identifier
    -- (e.g., "localStorage:owner" or "db-legacy:owner") to prevent duplicate imports.
    -- NULL for graphs created normally by the user.
    legacy_import_key TEXT UNIQUE,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_gw_workspace_id_valid CHECK (workspace_id IN ('owner', 'demo'))
);

COMMENT ON TABLE graph_workspaces IS 
  'First-class graph workspace entities. Each workspace can contain multiple graphs with independent node/edge/position payloads.';

COMMENT ON COLUMN graph_workspaces.legacy_import_key IS 
  'Unique key for idempotent legacy data import. Format: "localStorage:<workspace_id>" or "db-legacy:<workspace_id>". NULL for user-created graphs.';

COMMENT ON COLUMN graph_workspaces.schema_version IS 
  'Version of graph_payload structure. v1 = {nodes: PersistedNode[], edges: PersistedEdge[]}. Increment when payload shape changes.';

-- Primary listing query: "show me my graphs, most recently edited first"
CREATE INDEX IF NOT EXISTS idx_graph_workspaces_listing
    ON graph_workspaces (workspace_id, updated_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Auto-update trigger for graph_workspaces.updated_at
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_graph_workspaces_updated_at ON graph_workspaces;
CREATE TRIGGER trg_graph_workspaces_updated_at
    BEFORE UPDATE ON graph_workspaces
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. graph_workspace_conversations (many-to-many join)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS graph_workspace_conversations (
    graph_workspace_id UUID NOT NULL REFERENCES graph_workspaces(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    
    -- The node inside graph_payload that originally spawned this conversation.
    -- TEXT (not UUID FK) because dashboard node IDs live inside JSONB, not the
    -- relational nodes table. NULL means "manually associated."
    source_node_id TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Same conversation cannot be attached to the same graph twice.
    PRIMARY KEY (graph_workspace_id, conversation_id)
);

COMMENT ON TABLE graph_workspace_conversations IS 
  'Many-to-many association between graph workspaces and conversations. A conversation may belong to multiple graphs.';

COMMENT ON COLUMN graph_workspace_conversations.source_node_id IS 
  'ID of the dashboard node (within graph_payload JSONB) that spawned this conversation. NULL for manually associated conversations.';

-- "Which graphs does conversation X belong to?"
CREATE INDEX IF NOT EXISTS idx_gwc_by_conversation
    ON graph_workspace_conversations (conversation_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. conversation_node_positions (Knowledge Map position persistence)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conversation_node_positions (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,                    -- objectId from the V2 graph snapshot
    position_x DOUBLE PRECISION NOT NULL,
    position_y DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    PRIMARY KEY (conversation_id, node_id)
);

COMMENT ON TABLE conversation_node_positions IS 
  'User-arranged node positions for conversation Knowledge Maps. Auto-layout provides initial coordinates; saved positions override on subsequent loads.';
