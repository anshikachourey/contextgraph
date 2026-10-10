-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Core identity & workspace tables (Google OAuth / Supabase Auth)
--
-- Feature: google-oauth-authentication (Task 3.1)
-- Requirements: 6.1, 6.2, 7.2, 22.1, 22.3
--
-- Additive, behavior-neutral while AUTH_SUPABASE_CUTOVER_ENABLED = false:
-- creates the new identity model (profiles, account workspaces, membership role
-- enum, memberships) that the cutover will build on. Nothing here alters or
-- reads existing owner/demo data.
--
-- Idempotent: uses IF NOT EXISTS / guarded enum creation; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── User_Profile (keyed by Supabase_User_Id = auth.users.id) ────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_profiles IS
  'Application profile for an authenticated Supabase user, keyed by auth.users.id.';

-- ─── Account_Workspace (personal workspace; future-ready for shared) ─────────
CREATE TABLE IF NOT EXISTS account_workspaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','shared')),
  name          TEXT NOT NULL DEFAULT 'My Workspace',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE account_workspaces IS
  'A user workspace. This feature creates exactly one personal workspace per user; "shared" kind is reserved for future multi-member workspaces (Req 22).';

-- Exactly one personal workspace per user (idempotent provisioning target).
CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_workspace
  ON account_workspaces (owner_user_id) WHERE kind = 'personal';

-- ─── Membership role enum ────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_role') THEN
    CREATE TYPE workspace_role AS ENUM ('owner','admin','member');
  END IF;
END $$;

-- ─── Workspace_Membership (many memberships per workspace allowed — Req 22.1) ─
CREATE TABLE IF NOT EXISTS workspace_memberships (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         workspace_role NOT NULL DEFAULT 'owner',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

COMMENT ON TABLE workspace_memberships IS
  'Associates a user with a workspace and a role. Composite-unique on (workspace_id, user_id) so a workspace can hold multiple members later; this feature only ever creates the owner''s own membership (Req 22).';

CREATE INDEX IF NOT EXISTS idx_membership_by_user
  ON workspace_memberships (user_id);
