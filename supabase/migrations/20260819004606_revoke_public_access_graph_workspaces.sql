-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Revoke direct PostgREST access to graph workspace tables
--
-- The application accesses these tables exclusively through authenticated server
-- API routes using the service_role client (which bypasses RLS). Direct access
-- via the anon or authenticated PostgREST roles is neither needed nor desired.
--
-- This migration:
--   1. Revokes ALL privileges from anon and authenticated on the three tables.
--   2. Enables RLS as defense-in-depth (no permissive policies = deny all).
--   3. Preserves service_role access (bypasses RLS implicitly).
--   4. Does NOT alter or delete any existing data.
--   5. Does NOT introduce auth.uid() policies (Supabase Auth not yet active).
--
-- Idempotent: REVOKE is safe to repeat; ENABLE ROW LEVEL SECURITY is a no-op
-- if already enabled.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Revoke privileges from anon and authenticated ───────────────────────────

REVOKE ALL ON graph_workspaces FROM anon;
REVOKE ALL ON graph_workspaces FROM authenticated;

REVOKE ALL ON graph_workspace_conversations FROM anon;
REVOKE ALL ON graph_workspace_conversations FROM authenticated;

REVOKE ALL ON conversation_node_positions FROM anon;
REVOKE ALL ON conversation_node_positions FROM authenticated;

-- ─── Enable RLS (defense-in-depth) ──────────────────────────────────────────
-- With RLS enabled and no permissive policies, all operations are denied for
-- non-service-role clients. The service_role key bypasses RLS entirely, so
-- server API routes continue working unchanged.

ALTER TABLE graph_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_workspace_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_node_positions ENABLE ROW LEVEL SECURITY;
