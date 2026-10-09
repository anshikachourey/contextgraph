-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: owner-migration preflight REPORT RPC (callable over PostgREST)
--
-- Feature: google-oauth-authentication (Task 17 hardening item 4)
-- Requirements: 11.2, 11.3, 11.5
--
-- ── Why this exists ────────────────────────────────────────────────────────────
--
-- The TypeScript UUID_Migration runner previously performed its defense-in-depth
-- schema preflight by querying `information_schema.columns` directly through the
-- Supabase client:
--
--     db.schema("information_schema").from("columns").select(...)
--
-- That DOES NOT WORK against real Supabase/PostgREST. PostgREST only exposes the
-- schemas in its `db-schemas` setting — by default `public` (plus `storage` /
-- `graphql_public`). `information_schema` is NOT exposed over the REST
-- interface, so the client call fails with PGRST106
-- ("The schema must be one of the following: public") instead of returning real
-- catalog rows. The TS preflight therefore could never get a true answer through
-- the supported interface.
--
-- ── The fix ────────────────────────────────────────────────────────────────────
--
-- Expose the preflight through a SECURITY DEFINER function in the PUBLIC schema
-- (which PostgREST does expose), callable via `.rpc()`. It runs the SAME
-- information_schema / pg_indexes checks as the fail-closed
-- `assert_owner_migration_preflight()` (the function body runs inside Postgres,
-- where information_schema IS available), but RETURNS a jsonb REPORT instead of
-- raising, so the TS runner gets a real, structured answer through the supported
-- REST interface:
--
--     { "ok": true,  "missing": [] }
--     { "ok": false, "missing": ["conversations.legacy_workspace_id text", ...] }
--
-- The internal fail-before-mutation RAISE assertions in
-- `assert_owner_migration_preflight()` are RETAINED unchanged, and
-- `migrate_owner_data_to_user()` still PERFORMs them first — so the server-side
-- mutation path remains fail-closed regardless of the client-side report. The
-- report RPC is purely the TS runner's early, readable, supported-interface
-- check BEFORE the mutating round-trip.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.assert_owner_migration_preflight_report()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  missing text[] := ARRAY[]::text[];
  dep text;
BEGIN
  -- Helper: append a message when a (table, column, type) is absent.
  -- ── account_workspaces ──────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='account_workspaces'
                   AND column_name='id' AND data_type='uuid') THEN
    missing := missing || 'account_workspaces.id uuid'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='account_workspaces'
                   AND column_name='owner_user_id' AND data_type='uuid') THEN
    missing := missing || 'account_workspaces.owner_user_id uuid'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='account_workspaces'
                   AND column_name='kind' AND data_type='text') THEN
    missing := missing || 'account_workspaces.kind text'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND indexname='uq_personal_workspace') THEN
    missing := missing || 'index uq_personal_workspace'::text;
  END IF;

  -- ── graph_workspaces ──────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspaces'
                   AND column_name='id' AND data_type='uuid') THEN
    missing := missing || 'graph_workspaces.id uuid'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspaces'
                   AND column_name='account_workspace_id' AND data_type='uuid') THEN
    missing := missing || 'graph_workspaces.account_workspace_id uuid'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspaces'
                   AND column_name='workspace_id' AND data_type='text') THEN
    missing := missing || 'graph_workspaces.workspace_id text'::text;
  END IF;

  -- ── conversations ─────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='conversations'
                   AND column_name='id' AND data_type='uuid') THEN
    missing := missing || 'conversations.id uuid'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='conversations'
                   AND column_name='account_workspace_id' AND data_type='uuid') THEN
    missing := missing || 'conversations.account_workspace_id uuid'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='conversations'
                   AND column_name='legacy_workspace_id' AND data_type='text') THEN
    missing := missing || 'conversations.legacy_workspace_id text'::text;
  END IF;

  -- ── dependent tables (keyed by conversation_id) ───────────────────────────
  FOREACH dep IN ARRAY ARRAY['messages','nodes','edges','conversation_node_positions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=dep
                     AND column_name='conversation_id' AND data_type='uuid') THEN
      missing := missing || (dep || '.conversation_id uuid')::text;
    END IF;
  END LOOP;

  -- ── graph_workspace_conversations (join) ──────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspace_conversations'
                   AND column_name='graph_workspace_id' AND data_type='uuid') THEN
    missing := missing || 'graph_workspace_conversations.graph_workspace_id uuid'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspace_conversations'
                   AND column_name='conversation_id' AND data_type='uuid') THEN
    missing := missing || 'graph_workspace_conversations.conversation_id uuid'::text;
  END IF;

  -- ── migration_runs ────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='migration_runs'
                   AND column_name='user_id' AND data_type='uuid') THEN
    missing := missing || 'migration_runs.user_id uuid'::text;
  END IF;

  RETURN jsonb_build_object(
    'ok', (array_length(missing, 1) IS NULL),
    'missing', to_jsonb(missing)
  );
END;
$$;

COMMENT ON FUNCTION public.assert_owner_migration_preflight_report() IS
  'Read-only owner-migration schema preflight REPORT, callable via PostgREST .rpc() (information_schema is not exposed over REST, so the TS runner uses this instead of a direct information_schema query). Returns {ok, missing[]}; does not mutate. The fail-closed RAISE preflight (assert_owner_migration_preflight) is retained and still runs inside migrate_owner_data_to_user before any mutation.';

-- ── EXECUTE grant: service_role ONLY ─────────────────────────────────────────
-- This is a MIGRATION-RUN RPC. The offline UUID_Migration runner connects with
-- the Supabase service-role key (PostgREST role `service_role`), so service_role
-- is the ONLY role that should ever execute it. anon / authenticated / PUBLIC
-- must NOT be able to call it (a request-path user has no business probing the
-- live migration schema). Revokes are explicit and belt-and-suspenders.
REVOKE ALL ON FUNCTION public.assert_owner_migration_preflight_report() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_owner_migration_preflight_report() FROM anon;          -- explicit
REVOKE ALL ON FUNCTION public.assert_owner_migration_preflight_report() FROM authenticated; -- explicit (was previously granted — REMOVED)
GRANT EXECUTE ON FUNCTION public.assert_owner_migration_preflight_report() TO service_role;  -- ONLY the privileged offline-runner role
