-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: provision_user() SECURITY DEFINER trigger on auth.users
--
-- Feature: google-oauth-authentication (Task 3.3)
-- Requirements: 6.1, 6.3, 6.4, 6.5, 21.4
--
-- Primary provisioning mechanism: fires in the SAME transaction as the
-- auth.users INSERT, so the user's profile + personal workspace + membership
-- exist the instant the user does (Req 6.1/6.4). Idempotent and all-or-nothing
-- via ON CONFLICT DO NOTHING keyed by auth.users.id (Req 6.3/6.5). Works for all
-- auth methods (Google + email/password) since it fires on any user insert.
--
-- Additive & behavior-neutral: the trigger only runs when new auth.users rows
-- are created, which does not happen for legacy owner/demo sessions.
--
-- Idempotent (DDL): CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.provision_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws_id UUID;
BEGIN
  INSERT INTO user_profiles (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;

  -- One personal workspace per user; idempotent on the partial unique index
  -- uq_personal_workspace (owner_user_id) WHERE kind = 'personal'.
  INSERT INTO account_workspaces (owner_user_id, kind, name)
    VALUES (NEW.id, 'personal', 'My Workspace')
    ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING
    RETURNING id INTO ws_id;

  IF ws_id IS NULL THEN
    SELECT id INTO ws_id FROM account_workspaces
      WHERE owner_user_id = NEW.id AND kind = 'personal';
  END IF;

  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (ws_id, NEW.id, 'owner')
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.provision_user() IS
  'SECURITY DEFINER trigger fn: provisions profile + personal workspace + owner membership for a new auth.users row, idempotently (ON CONFLICT DO NOTHING).';

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.provision_user();
