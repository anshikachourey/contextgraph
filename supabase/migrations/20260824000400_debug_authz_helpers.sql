-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Debug authorization helpers (no uid param, boolean-only)
--
-- Feature: google-oauth-authentication (Task 3.5)
-- Requirements: 9.2, 9.3, 10.4
--
-- is_member_with_role(target_workspace, required_role) and has_debug_access()
-- are SECURITY DEFINER + STABLE helpers that bind the subject to auth.uid()
-- INSIDE the body and accept NO caller-supplied uid. They return a boolean only
-- and read the CALLER's own current workspace_memberships row. Because they run
-- SECURITY DEFINER (bypassing RLS to read memberships), a uid parameter is
-- forbidden — it would let a caller probe/impersonate other users.
--
-- Hardened with SET search_path = '' and fully-qualified names.
--
-- Idempotent (DDL): CREATE OR REPLACE FUNCTION.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Does the CALLER currently hold `required_role` in `target_workspace`?
CREATE OR REPLACE FUNCTION public.is_member_with_role(
  target_workspace uuid,
  required_role    public.workspace_role
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_memberships m
    WHERE m.workspace_id = target_workspace
      AND m.user_id      = auth.uid()     -- subject bound to the CALLER
      AND m.role         = required_role
  );
$$;

COMMENT ON FUNCTION public.is_member_with_role(uuid, public.workspace_role) IS
  'Boolean: does the current caller (auth.uid()) hold required_role in target_workspace right now? No uid param (SECURITY DEFINER safety).';

-- Does the CALLER currently have debug access anywhere (owner/admin role)?
CREATE OR REPLACE FUNCTION public.has_debug_access()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_memberships m
    WHERE m.user_id = auth.uid()          -- CALLER only
      AND m.role IN ('owner','admin')
  );
$$;

COMMENT ON FUNCTION public.has_debug_access() IS
  'Boolean: does the current caller (auth.uid()) currently hold an owner/admin membership (debug access)? Reads live membership — never a JWT role claim. No uid param.';

REVOKE ALL ON FUNCTION public.is_member_with_role(uuid, public.workspace_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_debug_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_member_with_role(uuid, public.workspace_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_debug_access() TO authenticated;
