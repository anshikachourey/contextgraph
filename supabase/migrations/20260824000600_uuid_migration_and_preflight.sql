-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: UUID_Migration function + schema PREFLIGHT assertions
--
-- Feature: google-oauth-authentication (Task 15.1 + Task 14 hardening item 4)
-- Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10
--
-- This migration defines two SECURITY DEFINER functions:
--
--   1. public.assert_owner_migration_preflight()
--      A FAIL-CLOSED schema preflight. Several live tables (messages, nodes,
--      edges, conversation_node_positions, and the graph_workspace_conversations
--      join) were created directly in the live DB without a version-controlled
--      baseline. Before ANY mutation, this function asserts that the exact
--      tables, columns, types, and constraints the UUID_Migration depends on
--      actually exist in the live schema. If the real schema differs, the
--      function RAISES and the migration aborts BEFORE mutating anything
--      (Task 14, hardening item 4).
--
--   2. public.migrate_owner_data_to_user(target_user uuid)
--      The one-time, idempotent reassociation of owner-workspace data to the
--      authenticated user's personal Account_Workspace. Calls the preflight at
--      the very top so it fails closed on schema drift (Req 11).
--
-- NOTE: This migration only CREATES the functions. It does NOT invoke them. The
-- real owner migration is run manually, later, with the real Supabase user UUID
-- obtained after first sign-in (Req 11.2, 11.3) — never automatically, never in
-- this migration, never against prod from CI.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────────
-- 1. PREFLIGHT: fail-closed schema assertions for live-only tables
-- ───────────────────────────────────────────────────────────────────────────────
--
-- Asserts, for the tables the UUID_Migration touches AND the dependent tables it
-- relies on, that the expected columns + types + constraints exist. Each check
-- RAISES EXCEPTION with a precise message if the live schema differs.
--
-- Tables / columns / constraints asserted:
--
--   account_workspaces:        id (uuid), owner_user_id (uuid), kind (text),
--                              unique index uq_personal_workspace (partial, personal)
--   graph_workspaces:          id (uuid), account_workspace_id (uuid),
--                              workspace_id (text)   [legacy owner/demo discriminator]
--   conversations:             id (uuid), account_workspace_id (uuid),
--                              legacy_workspace_id (text) [owner/demo discriminator]
--   messages:                  conversation_id (uuid)   [FK dependent, scoped transitively]
--   nodes:                     conversation_id (uuid)
--   edges:                     conversation_id (uuid)
--   conversation_node_positions: conversation_id (uuid)
--   graph_workspace_conversations: graph_workspace_id (uuid), conversation_id (uuid)
--   migration_runs:            user_id (uuid)           [idempotency bookkeeping]
--
CREATE OR REPLACE FUNCTION public.assert_owner_migration_preflight()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  missing text;
BEGIN
  -- Helper assertion: a column of an exact type must exist on public.<table>.
  -- Implemented inline (no nested fn) via a repeated information_schema lookup.

  -- ── account_workspaces ──────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='account_workspaces'
                   AND column_name='id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: account_workspaces.id uuid missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='account_workspaces'
                   AND column_name='owner_user_id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: account_workspaces.owner_user_id uuid missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='account_workspaces'
                   AND column_name='kind' AND data_type='text') THEN
    RAISE EXCEPTION 'preflight: account_workspaces.kind text missing';
  END IF;
  -- The partial-unique index guaranteeing exactly one personal workspace.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND indexname='uq_personal_workspace') THEN
    RAISE EXCEPTION 'preflight: unique index uq_personal_workspace missing (one personal workspace per user)';
  END IF;

  -- ── graph_workspaces (Dashboard_Graphs) ──────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspaces'
                   AND column_name='id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: graph_workspaces.id uuid missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspaces'
                   AND column_name='account_workspace_id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: graph_workspaces.account_workspace_id uuid missing (run reparent migration first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspaces'
                   AND column_name='workspace_id' AND data_type='text') THEN
    RAISE EXCEPTION 'preflight: graph_workspaces.workspace_id text (owner/demo discriminator) missing';
  END IF;

  -- ── conversations ─────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='conversations'
                   AND column_name='id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: conversations.id uuid missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='conversations'
                   AND column_name='account_workspace_id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: conversations.account_workspace_id uuid missing (run reparent migration first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='conversations'
                   AND column_name='legacy_workspace_id' AND data_type='text') THEN
    RAISE EXCEPTION 'preflight: conversations.legacy_workspace_id text (owner/demo discriminator) missing (run reparent migration first)';
  END IF;

  -- ── dependent tables (keyed by conversation_id, scoped transitively) ──────
  FOREACH missing IN ARRAY ARRAY['messages','nodes','edges','conversation_node_positions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=missing
                     AND column_name='conversation_id' AND data_type='uuid') THEN
      RAISE EXCEPTION 'preflight: %.conversation_id uuid missing (dependent table integrity)', missing;
    END IF;
  END LOOP;

  -- ── graph_workspace_conversations (join: graph ↔ conversation) ────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspace_conversations'
                   AND column_name='graph_workspace_id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: graph_workspace_conversations.graph_workspace_id uuid missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='graph_workspace_conversations'
                   AND column_name='conversation_id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: graph_workspace_conversations.conversation_id uuid missing';
  END IF;

  -- ── migration_runs (idempotency bookkeeping) ──────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='migration_runs'
                   AND column_name='user_id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'preflight: migration_runs.user_id uuid missing (idempotency bookkeeping)';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_owner_migration_preflight() IS
  'Fail-closed schema preflight for the owner UUID_Migration. Asserts expected tables/columns/types/constraints exist before any mutation so a production migration aborts on schema drift (Task 14, item 4).';


-- ───────────────────────────────────────────────────────────────────────────────
-- 2. migrate_owner_data_to_user(target_user uuid)
-- ───────────────────────────────────────────────────────────────────────────────
--
-- Parent-first, idempotent, demo-safe reassociation (Req 11). Privileged: runs
-- as the function owner (SECURITY DEFINER) so it can rewrite ownership columns
-- across tables before RLS would admit the rows. Invoked ONLY from the
-- allowlisted UUID_Migration runner, with the real user UUID, manually.
--
CREATE OR REPLACE FUNCTION public.migrate_owner_data_to_user(target_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_ws uuid;
BEGIN
  -- 0. FAIL CLOSED on schema drift BEFORE touching any row (Task 14, item 4).
  PERFORM public.assert_owner_migration_preflight();

  IF target_user IS NULL THEN
    RAISE EXCEPTION 'migrate_owner_data_to_user: target_user is required (the real Supabase user UUID)';
  END IF;

  -- 1. Skip-if-done (Req 11.4): a completed run short-circuits.
  IF EXISTS (SELECT 1 FROM public.migration_runs WHERE user_id = target_user) THEN
    RETURN;
  END IF;

  -- 2. Resolve the target personal Account_Workspace. It MUST be provisioned
  --    already (Req 11.2) — provisioning never runs here.
  SELECT id INTO target_ws
  FROM public.account_workspaces
  WHERE owner_user_id = target_user AND kind = 'personal';

  IF target_ws IS NULL THEN
    RAISE EXCEPTION 'migrate_owner_data_to_user: no personal account_workspace for user % (provision first)', target_user;
  END IF;

  -- 3. Re-parent graph_workspaces (Dashboard_Graphs): keep each original id (no
  --    merge/flatten — Req 11.8, 11.9). Move ONLY legacy owner rows still
  --    unparented; EXCLUDE demo from the WHERE clause entirely (Req 11.6, 11.7).
  UPDATE public.graph_workspaces
  SET account_workspace_id = target_ws
  WHERE workspace_id = 'owner'
    AND account_workspace_id IS DISTINCT FROM target_ws;

  -- 4. Re-parent conversations where legacy_workspace_id = 'owner' (Req 11.1).
  --    Demo ('demo') is never matched. Only rows not already parented move
  --    (idempotent reassociation — Req 11.3, 11.4).
  UPDATE public.conversations
  SET account_workspace_id = target_ws
  WHERE legacy_workspace_id = 'owner'
    AND account_workspace_id IS DISTINCT FROM target_ws;

  -- 5. Dependents (messages, nodes, edges, conversation_node_positions,
  --    graph_workspace_conversations) are keyed by conversation_id /
  --    graph_workspace_id whose IDs are UNCHANGED, so they follow automatically
  --    with referential integrity preserved (Req 11.5, 11.10). No dependent row
  --    is rewritten.

  -- 6. Record completion for idempotency (Req 11.4).
  INSERT INTO public.migration_runs (user_id, kind)
  VALUES (target_user, 'owner_uuid_migration')
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.migrate_owner_data_to_user(uuid) IS
  'One-time, idempotent, demo-safe reassociation of owner-workspace data to the target user''s personal workspace. Parent-first ordering; preserves graph ids (no flatten); dependents follow by unchanged ids. Calls the fail-closed preflight first (Req 11; Task 14 item 4). Invoked manually with the real UUID; never automatically.';


-- ───────────────────────────────────────────────────────────────────────────────
-- 3. EXECUTE grants: service_role ONLY (both migration-run RPCs)
-- ───────────────────────────────────────────────────────────────────────────────
--
-- These are MIGRATION-RUN RPCs. The offline UUID_Migration runner connects with
-- the Supabase service-role key (PostgREST role `service_role`), so service_role
-- is the ONLY role that should ever execute them. anon / authenticated / PUBLIC
-- must NOT be able to call them — a request-path user has no business running the
-- owner migration or its preflight. (migrate_owner_data_to_user is SECURITY
-- DEFINER; locking EXECUTE to service_role is still required so no other role can
-- invoke the privileged body.) Revokes are explicit and belt-and-suspenders.

REVOKE ALL ON FUNCTION public.assert_owner_migration_preflight() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_owner_migration_preflight() FROM anon;          -- explicit
REVOKE ALL ON FUNCTION public.assert_owner_migration_preflight() FROM authenticated; -- explicit
GRANT EXECUTE ON FUNCTION public.assert_owner_migration_preflight() TO service_role;  -- ONLY the privileged offline-runner role

REVOKE ALL ON FUNCTION public.migrate_owner_data_to_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.migrate_owner_data_to_user(uuid) FROM anon;          -- explicit
REVOKE ALL ON FUNCTION public.migrate_owner_data_to_user(uuid) FROM authenticated; -- explicit
GRANT EXECUTE ON FUNCTION public.migrate_owner_data_to_user(uuid) TO service_role;  -- ONLY the privileged offline-runner role
