-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Enable RLS + membership policies on all user-data tables
--
-- Feature: google-oauth-authentication (Task 3.6)
-- Requirements: 7.4, 7.5, 10.1, 10.4
--
-- Default-deny membership-scoped access via public.is_member(ws). Enables RLS on
-- every user-data table and grants access only through a linking membership.
--
-- ─── IMPORTANT: BEHAVIOR-NEUTRAL WHILE THE CUTOVER FLAG IS FALSE ─────────────
-- RLS policies apply ONLY to the anon/authenticated (user-scoped) PostgREST
-- roles. The service-role key BYPASSES RLS entirely. Every current route still
-- uses the service-role client (createServerSupabaseClient) while
-- AUTH_SUPABASE_CUTOVER_ENABLED = false, so enabling these policies does NOT
-- change existing runtime behavior — current routes keep reading/writing all
-- rows exactly as before. The policies only start mattering once routes are
-- converted to createUserScopedClient() (Task 5+) and the flag is flipped.
--
-- This migration also REPLACES the service-role-only graph_workspaces policy
-- posture from 20260819004606 (RLS-enabled, zero permissive policies) with the
-- membership policies below, and restores authenticated grants (RLS still gates
-- rows) so the user-scoped client can operate post-cutover.
--
-- Idempotent: IF NOT EXISTS enum/func guards; DROP POLICY IF EXISTS before each
-- CREATE POLICY; ENABLE RLS is a no-op if already enabled.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Membership predicate helper ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_member(ws uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships m
    WHERE m.workspace_id = ws AND m.user_id = auth.uid()
  );
$$;

COMMENT ON FUNCTION public.is_member(uuid) IS
  'Boolean: is the current caller (auth.uid()) a member of workspace ws? Basis for all membership RLS policies.';

-- ─── Enable RLS on every user-data table ─────────────────────────────────────
ALTER TABLE account_workspaces           ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships        ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_workspaces             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE edges                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_node_positions  ENABLE ROW LEVEL SECURITY;

-- ─── Restore authenticated grants (RLS still gates row visibility) ───────────
-- 20260819004606 revoked these; the user-scoped client runs as `authenticated`
-- and needs table-level privileges before RLS can admit specific rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON account_workspaces          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_memberships       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON graph_workspaces            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversations               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON messages                    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON nodes                       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON edges                       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_node_positions TO authenticated;

-- ─── Policies ────────────────────────────────────────────────────────────────

-- A user sees their own memberships.
DROP POLICY IF EXISTS mem_self ON workspace_memberships;
CREATE POLICY mem_self ON workspace_memberships
  FOR SELECT USING (user_id = auth.uid());

-- Workspaces the user belongs to.
DROP POLICY IF EXISTS ws_member ON account_workspaces;
CREATE POLICY ws_member ON account_workspaces
  FOR ALL USING (public.is_member(id)) WITH CHECK (public.is_member(id));

-- Graphs scoped through their workspace. (Replaces the service-role-only
-- posture from 20260819004606.)
DROP POLICY IF EXISTS graph_member ON graph_workspaces;
CREATE POLICY graph_member ON graph_workspaces
  FOR ALL USING (public.is_member(account_workspace_id))
  WITH CHECK (public.is_member(account_workspace_id));

-- Conversations scoped through their workspace.
DROP POLICY IF EXISTS conv_member ON conversations;
CREATE POLICY conv_member ON conversations
  FOR ALL USING (public.is_member(account_workspace_id))
  WITH CHECK (public.is_member(account_workspace_id));

-- Dependents scoped transitively through the conversation.
DROP POLICY IF EXISTS msg_member ON messages;
CREATE POLICY msg_member ON messages
  FOR ALL USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id AND public.is_member(c.account_workspace_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id AND public.is_member(c.account_workspace_id)));

DROP POLICY IF EXISTS nodes_member ON nodes;
CREATE POLICY nodes_member ON nodes
  FOR ALL USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = nodes.conversation_id AND public.is_member(c.account_workspace_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = nodes.conversation_id AND public.is_member(c.account_workspace_id)));

DROP POLICY IF EXISTS edges_member ON edges;
CREATE POLICY edges_member ON edges
  FOR ALL USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = edges.conversation_id AND public.is_member(c.account_workspace_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = edges.conversation_id AND public.is_member(c.account_workspace_id)));

DROP POLICY IF EXISTS cnp_member ON conversation_node_positions;
CREATE POLICY cnp_member ON conversation_node_positions
  FOR ALL USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_node_positions.conversation_id
      AND public.is_member(c.account_workspace_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_node_positions.conversation_id
      AND public.is_member(c.account_workspace_id)));
