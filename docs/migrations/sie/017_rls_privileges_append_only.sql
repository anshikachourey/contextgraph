-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 017 — RLS, Privileges, and Append-Only Enforcement for
--                      Identity Resolution Tables
--
-- This migration secures the four identity-resolution tables created in
-- migrations 009–011:
--   - sie_identity_resolution_records
--   - sie_retrieval_attempts
--   - sie_pending_identity_details
--   - sie_pending_identity_propositions
--
-- Security layers applied:
--   1. Row-Level Security (RLS) with conversation-owner read policies
--   2. Revocation of direct mutation privileges from the authenticated role
--   3. Append-only triggers preventing UPDATE/DELETE on resolution records
--      and retrieval attempts
--   4. Targeted append-only trigger on pending identity propositions
--      (pending details may receive lifecycle transitions through RPCs)
--
-- Write path: All mutations flow through SECURITY DEFINER RPCs
-- (v2_commit_identity_bundle, privacy purge RPC) which execute as the
-- function owner and bypass RLS. The append-only triggers use a session
-- variable check to allow authorized SECURITY DEFINER functions to perform
-- controlled mutations (e.g., privacy purge).
--
-- Depends on: 009, 010, 011 (identity tables must exist)
--             006 (sie_user_owns_conversation helper must exist)
--
-- Safe to run multiple times (uses IF NOT EXISTS, DROP IF EXISTS, CREATE
-- OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1: ENABLE ROW-LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sie_identity_resolution_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_retrieval_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_pending_identity_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_pending_identity_propositions ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2: CONVERSATION-OWNER READ POLICIES
-- ═══════════════════════════════════════════════════════════════════════════
-- Authenticated users can SELECT rows belonging to conversations they own.
-- Service-role bypasses RLS entirely (Supabase default).
-- Uses the existing sie_user_owns_conversation() helper from migration 006.

-- ─────────────────────────────────────────────────────────────────────────
-- 2.1 sie_identity_resolution_records
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sie_identity_resolution_records_select ON sie_identity_resolution_records;
CREATE POLICY sie_identity_resolution_records_select ON sie_identity_resolution_records
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_identity_resolution_records_deny_insert ON sie_identity_resolution_records;
CREATE POLICY sie_identity_resolution_records_deny_insert ON sie_identity_resolution_records
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_identity_resolution_records_deny_update ON sie_identity_resolution_records;
CREATE POLICY sie_identity_resolution_records_deny_update ON sie_identity_resolution_records
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_identity_resolution_records_deny_delete ON sie_identity_resolution_records;
CREATE POLICY sie_identity_resolution_records_deny_delete ON sie_identity_resolution_records
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.2 sie_retrieval_attempts
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sie_retrieval_attempts_select ON sie_retrieval_attempts;
CREATE POLICY sie_retrieval_attempts_select ON sie_retrieval_attempts
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_retrieval_attempts_deny_insert ON sie_retrieval_attempts;
CREATE POLICY sie_retrieval_attempts_deny_insert ON sie_retrieval_attempts
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_retrieval_attempts_deny_update ON sie_retrieval_attempts;
CREATE POLICY sie_retrieval_attempts_deny_update ON sie_retrieval_attempts
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_retrieval_attempts_deny_delete ON sie_retrieval_attempts;
CREATE POLICY sie_retrieval_attempts_deny_delete ON sie_retrieval_attempts
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.3 sie_pending_identity_details
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sie_pending_identity_details_select ON sie_pending_identity_details;
CREATE POLICY sie_pending_identity_details_select ON sie_pending_identity_details
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_pending_identity_details_deny_insert ON sie_pending_identity_details;
CREATE POLICY sie_pending_identity_details_deny_insert ON sie_pending_identity_details
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_pending_identity_details_deny_update ON sie_pending_identity_details;
CREATE POLICY sie_pending_identity_details_deny_update ON sie_pending_identity_details
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_pending_identity_details_deny_delete ON sie_pending_identity_details;
CREATE POLICY sie_pending_identity_details_deny_delete ON sie_pending_identity_details
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.4 sie_pending_identity_propositions
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sie_pending_identity_propositions_select ON sie_pending_identity_propositions;
CREATE POLICY sie_pending_identity_propositions_select ON sie_pending_identity_propositions
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_pending_identity_propositions_deny_insert ON sie_pending_identity_propositions;
CREATE POLICY sie_pending_identity_propositions_deny_insert ON sie_pending_identity_propositions
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_pending_identity_propositions_deny_update ON sie_pending_identity_propositions;
CREATE POLICY sie_pending_identity_propositions_deny_update ON sie_pending_identity_propositions
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_pending_identity_propositions_deny_delete ON sie_pending_identity_propositions;
CREATE POLICY sie_pending_identity_propositions_deny_delete ON sie_pending_identity_propositions
    FOR DELETE
    USING (false);


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3: REVOKE DIRECT MUTATION PRIVILEGES FROM AUTHENTICATED ROLE
-- ═══════════════════════════════════════════════════════════════════════════
-- All writes happen exclusively through SECURITY DEFINER RPCs
-- (v2_commit_identity_bundle, privacy purge). The authenticated role
-- retains only SELECT (governed by RLS policies above).

REVOKE INSERT, UPDATE, DELETE ON sie_identity_resolution_records FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON sie_retrieval_attempts FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON sie_pending_identity_details FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON sie_pending_identity_propositions FROM authenticated;

-- Also revoke from anon role for defense in depth
REVOKE INSERT, UPDATE, DELETE ON sie_identity_resolution_records FROM anon;
REVOKE INSERT, UPDATE, DELETE ON sie_retrieval_attempts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON sie_pending_identity_details FROM anon;
REVOKE INSERT, UPDATE, DELETE ON sie_pending_identity_propositions FROM anon;

-- Ensure SELECT is granted to authenticated (RLS policies above control visibility)
GRANT SELECT ON sie_identity_resolution_records TO authenticated;
GRANT SELECT ON sie_retrieval_attempts TO authenticated;
GRANT SELECT ON sie_pending_identity_details TO authenticated;
GRANT SELECT ON sie_pending_identity_propositions TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4: APPEND-ONLY ENFORCEMENT TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════
-- These triggers fire BEFORE UPDATE OR DELETE and raise an exception,
-- preventing mutation of append-only records even by the service role.
--
-- The SECURITY DEFINER RPCs that need controlled mutations (privacy purge)
-- set a session variable to bypass the trigger:
--   SET LOCAL sie.allow_mutation = 'true';
--
-- This ensures:
--   - Normal application code (including service role) cannot mutate records
--   - Only explicitly authorized SECURITY DEFINER functions that set the
--     session variable can perform controlled deletions (privacy purge)
--   - The session variable is transaction-scoped (SET LOCAL) and auto-resets

-- ─────────────────────────────────────────────────────────────────────────
-- 4.1 Shared append-only enforcement function
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sie_prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
    -- Allow mutation if the authorized session variable is set.
    -- This is used by SECURITY DEFINER privacy purge RPCs which
    -- execute SET LOCAL sie.allow_mutation = 'true' before operating.
    IF current_setting('sie.allow_mutation', true) = 'true' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        ELSE
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION 'Table % is append-only. % operations are not permitted.',
        TG_TABLE_NAME, TG_OP
        USING ERRCODE = '42501'; -- insufficient_privilege
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- 4.2 Apply to sie_identity_resolution_records (fully append-only)
-- ─────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_append_only_resolution_records ON sie_identity_resolution_records;
CREATE TRIGGER trg_append_only_resolution_records
    BEFORE UPDATE OR DELETE ON sie_identity_resolution_records
    FOR EACH ROW EXECUTE FUNCTION sie_prevent_mutation();

-- ─────────────────────────────────────────────────────────────────────────
-- 4.3 Apply to sie_retrieval_attempts (fully append-only)
-- ─────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_append_only_retrieval_attempts ON sie_retrieval_attempts;
CREATE TRIGGER trg_append_only_retrieval_attempts
    BEFORE UPDATE OR DELETE ON sie_retrieval_attempts
    FOR EACH ROW EXECUTE FUNCTION sie_prevent_mutation();

-- ─────────────────────────────────────────────────────────────────────────
-- 4.4 Apply to sie_pending_identity_propositions (append-only)
-- ─────────────────────────────────────────────────────────────────────────
-- Proposition memberships are immutable once created. Resolution of a
-- pending decision does not modify existing membership rows; instead the
-- parent decision's lifecycle_state transitions (on sie_pending_semantic_decisions).
DROP TRIGGER IF EXISTS trg_append_only_pending_propositions ON sie_pending_identity_propositions;
CREATE TRIGGER trg_append_only_pending_propositions
    BEFORE UPDATE OR DELETE ON sie_pending_identity_propositions
    FOR EACH ROW EXECUTE FUNCTION sie_prevent_mutation();

-- ─────────────────────────────────────────────────────────────────────────
-- 4.5 sie_pending_identity_details — targeted protection
-- ─────────────────────────────────────────────────────────────────────────
-- Pending identity details are NOT fully append-only because resolution of
-- a pending decision may require updating the source_resolution_record_id
-- or linking a successor record. However, DELETE is still restricted to
-- authorized privacy purge only.
--
-- We use a separate function that allows UPDATE but blocks DELETE unless
-- the authorized session variable is set.

CREATE OR REPLACE FUNCTION sie_prevent_delete_only()
RETURNS TRIGGER AS $$
BEGIN
    -- Allow deletion if the authorized session variable is set.
    IF current_setting('sie.allow_mutation', true) = 'true' THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'Table % does not permit DELETE. Use authorized privacy purge RPC.',
        TG_TABLE_NAME
        USING ERRCODE = '42501'; -- insufficient_privilege
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_delete_pending_details ON sie_pending_identity_details;
CREATE TRIGGER trg_prevent_delete_pending_details
    BEFORE DELETE ON sie_pending_identity_details
    FOR EACH ROW EXECUTE FUNCTION sie_prevent_delete_only();


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5: DOCUMENTATION AND NOTES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Security model summary for identity-resolution tables:
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ Layer              │ Effect                                             │
-- ├────────────────────┼────────────────────────────────────────────────────┤
-- │ RLS (SELECT)       │ Authenticated users see only their conversations   │
-- │ RLS (INSERT/       │ Deny all from authenticated/anon                   │
-- │      UPDATE/DELETE) │                                                    │
-- │ REVOKE privileges  │ Authenticated/anon cannot INSERT/UPDATE/DELETE      │
-- │ Append-only trigger│ Even service-role UPDATE/DELETE raises exception    │
-- │ Session variable   │ SECURITY DEFINER purge RPCs bypass trigger via     │
-- │                    │ SET LOCAL sie.allow_mutation = 'true'               │
-- │ Service-role RLS   │ Service role bypasses RLS (Supabase default) but   │
-- │                    │ is still constrained by append-only triggers        │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- Write path:
--   1. v2_commit_identity_bundle (SECURITY DEFINER, runs as owner)
--      → INSERTs resolution records, retrieval attempts, pending details,
--        and pending propositions. No trigger fires on INSERT.
--   2. Privacy purge RPC (SECURITY DEFINER, runs as owner)
--      → Sets LOCAL sie.allow_mutation = 'true', then DELETEs/UPDATEs
--        as needed for redaction. Trigger allows the operation.
--   3. Re-evaluation RPCs (SECURITY DEFINER)
--      → May UPDATE sie_pending_identity_details (no trigger blocks UPDATE
--        on that table; only DELETE is blocked).
--
-- Rollback: See migration 005.5 (rollback migration) for reverse DDL.
