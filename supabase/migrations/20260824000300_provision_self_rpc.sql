-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: provision_self() auth.uid()-bound SECURITY DEFINER RPC
--
-- Feature: google-oauth-authentication (Task 3.4)
-- Requirements: 6.3, 6.5, 10.3, 12.1
--
-- App-side provisioning fallback / gate. Called via .rpc('provision_self')
-- through the USER-SCOPED client. Provisions ONLY the caller's own records,
-- deriving the subject from auth.uid() inside the body — NO uid parameter, NO
-- service-role. Idempotent and all-or-nothing like the trigger (Req 6.5).
--
-- Hardened: SET search_path = '' with fully-qualified names so the function
-- cannot be hijacked via a mutable search_path.
--
-- Idempotent (DDL): CREATE OR REPLACE FUNCTION.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.provision_self()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid   uuid := auth.uid();   -- subject is the CALLER, never a parameter
  ws_id uuid;
  mail  text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'provision_self requires an authenticated caller';
  END IF;

  SELECT u.email INTO mail FROM auth.users u WHERE u.id = uid;

  INSERT INTO public.user_profiles (id, email)
    VALUES (uid, mail)
    ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.account_workspaces (owner_user_id, kind, name)
    VALUES (uid, 'personal', 'My Workspace')
    ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING
    RETURNING id INTO ws_id;

  IF ws_id IS NULL THEN
    SELECT w.id INTO ws_id FROM public.account_workspaces w
      WHERE w.owner_user_id = uid AND w.kind = 'personal';
  END IF;

  INSERT INTO public.workspace_memberships (workspace_id, user_id, role)
    VALUES (ws_id, uid, 'owner')
    ON CONFLICT (workspace_id, user_id) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.provision_self() IS
  'Authenticated, auth.uid()-bound provisioning fallback. No uid param, no service-role. Idempotent ON CONFLICT DO NOTHING upsert of profile + personal workspace + owner membership for the caller only.';

-- Only authenticated users may call it (anon cannot provision).
REVOKE ALL ON FUNCTION public.provision_self() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_self() TO authenticated;
