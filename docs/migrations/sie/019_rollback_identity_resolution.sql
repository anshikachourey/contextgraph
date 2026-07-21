-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 019 — Rollback Identity Resolution
--
-- Reverses migrations 009 through 021 in dependency-safe (reverse) order.
-- Removes all identity-resolution-specific tables, RPCs, triggers, policies,
-- grants, indexes, columns, composite FKs, composite unique constraints, and
-- the embedding table introduced by those migrations.
--
-- PRESERVES pre-existing infrastructure:
--   - conversations table
--   - sie_commit_requests table (base columns from 001)
--   - sie_pending_semantic_decisions table (from 005)
--   - sie_persistent_concerns table (from 002)
--   - sie_semantic_packets table (from 004)
--   - sie_entity_registry table (from 001)
--   - sie_propositions table (from 003)
--   - sie_proposition_associations table (from 003)
--   - sie_concern_aliases table (from 002)
--   - v2_update_state table (pre-existing)
--   - v2_commit_update function (from 008)
--   - sie_user_owns_conversation function (from 006)
--
-- This migration is IDEMPOTENT: safe to run multiple times.
-- Uses IF EXISTS, DROP ... IF EXISTS, and DO blocks with existence checks.
--
-- Reversal order (dependency-safe, reverse of creation):
--   018 → Privacy purge RPC and suppression table
--   017 → RLS, privileges, triggers
--   016 → v2_validate_identity_bundle + updated v2_commit_identity_bundle
--   015 → v2_commit_identity_bundle (original)
--   014 → v2_load_sie_identity_context
--   013 → Request-state RPCs
--   012 → sie_commit_requests state-machine columns and constraints
--   011 → sie_pending_identity_propositions, sie_pending_identity_details
--   010 → sie_retrieval_attempts
--   009 → sie_identity_resolution_records
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION -2: Reverse Migration 021 — Composite Foreign Keys
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE sie_identity_resolution_records DROP CONSTRAINT IF EXISTS fk_ir_records_conversation_packet;
ALTER TABLE sie_identity_resolution_records DROP CONSTRAINT IF EXISTS fk_ir_records_conversation_matched_concern;
ALTER TABLE sie_identity_resolution_records DROP CONSTRAINT IF EXISTS fk_ir_records_conversation_proposed_concern;
ALTER TABLE sie_retrieval_attempts DROP CONSTRAINT IF EXISTS fk_retrieval_attempts_conversation_packet;
ALTER TABLE sie_pending_identity_details DROP CONSTRAINT IF EXISTS fk_pending_details_conversation_packet;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION -1: Reverse Migration 020 — Composite Unique Keys + Embeddings
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop embedding table indexes first
DROP INDEX IF EXISTS idx_concern_embeddings_source_hash;
DROP INDEX IF EXISTS idx_concern_embeddings_active_conversation;
DROP INDEX IF EXISTS idx_concern_embeddings_concern;
DROP INDEX IF EXISTS idx_concern_embeddings_conversation;
DROP INDEX IF EXISTS idx_active_embedding_per_concern_model;
-- Drop embedding table (no CASCADE — it has no dependents)
DROP TABLE IF EXISTS sie_concern_embeddings;

-- Drop composite unique constraints from base tables (safe — no dependents after 021 FKs removed above)
ALTER TABLE sie_pending_semantic_decisions DROP CONSTRAINT IF EXISTS uq_decisions_conversation_decision;
ALTER TABLE sie_propositions DROP CONSTRAINT IF EXISTS uq_propositions_conversation_proposition;
ALTER TABLE sie_persistent_concerns DROP CONSTRAINT IF EXISTS uq_concerns_conversation_concern;
ALTER TABLE sie_semantic_packets DROP CONSTRAINT IF EXISTS uq_packets_conversation_packet;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 0: Reverse Migration 018 — Privacy Purge/Redaction
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop the privacy purge RPC and the suppressions table. These depend on
-- the identity tables being dropped later in this rollback.

-- Drop RLS policies on sie_privacy_suppressions
DROP POLICY IF EXISTS sie_privacy_suppressions_select ON sie_privacy_suppressions;
DROP POLICY IF EXISTS sie_privacy_suppressions_deny_insert ON sie_privacy_suppressions;
DROP POLICY IF EXISTS sie_privacy_suppressions_deny_update ON sie_privacy_suppressions;
DROP POLICY IF EXISTS sie_privacy_suppressions_deny_delete ON sie_privacy_suppressions;

-- Drop the privacy purge function
DROP FUNCTION IF EXISTS sie_purge_identity_data(UUID, TEXT, TEXT, TEXT) CASCADE;

-- Drop the suppressions table and its indexes
DROP INDEX IF EXISTS idx_suppressions_entity_type;
DROP INDEX IF EXISTS idx_suppressions_conversation_active;
DROP TABLE IF EXISTS sie_privacy_suppressions CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1: Reverse Migration 017 — Triggers and Append-Only Functions
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop append-only enforcement triggers on identity tables.

DROP TRIGGER IF EXISTS trg_prevent_delete_pending_details ON sie_pending_identity_details;
DROP TRIGGER IF EXISTS trg_append_only_pending_propositions ON sie_pending_identity_propositions;
DROP TRIGGER IF EXISTS trg_append_only_retrieval_attempts ON sie_retrieval_attempts;
DROP TRIGGER IF EXISTS trg_append_only_resolution_records ON sie_identity_resolution_records;

-- Drop the shared append-only enforcement functions.
DROP FUNCTION IF EXISTS sie_prevent_delete_only() CASCADE;
DROP FUNCTION IF EXISTS sie_prevent_mutation() CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2: Reverse Migration 017 — RLS Policies
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop all RLS policies on identity tables.

-- sie_identity_resolution_records policies
DROP POLICY IF EXISTS sie_identity_resolution_records_select ON sie_identity_resolution_records;
DROP POLICY IF EXISTS sie_identity_resolution_records_deny_insert ON sie_identity_resolution_records;
DROP POLICY IF EXISTS sie_identity_resolution_records_deny_update ON sie_identity_resolution_records;
DROP POLICY IF EXISTS sie_identity_resolution_records_deny_delete ON sie_identity_resolution_records;

-- sie_retrieval_attempts policies
DROP POLICY IF EXISTS sie_retrieval_attempts_select ON sie_retrieval_attempts;
DROP POLICY IF EXISTS sie_retrieval_attempts_deny_insert ON sie_retrieval_attempts;
DROP POLICY IF EXISTS sie_retrieval_attempts_deny_update ON sie_retrieval_attempts;
DROP POLICY IF EXISTS sie_retrieval_attempts_deny_delete ON sie_retrieval_attempts;

-- sie_pending_identity_details policies
DROP POLICY IF EXISTS sie_pending_identity_details_select ON sie_pending_identity_details;
DROP POLICY IF EXISTS sie_pending_identity_details_deny_insert ON sie_pending_identity_details;
DROP POLICY IF EXISTS sie_pending_identity_details_deny_update ON sie_pending_identity_details;
DROP POLICY IF EXISTS sie_pending_identity_details_deny_delete ON sie_pending_identity_details;

-- sie_pending_identity_propositions policies
DROP POLICY IF EXISTS sie_pending_identity_propositions_select ON sie_pending_identity_propositions;
DROP POLICY IF EXISTS sie_pending_identity_propositions_deny_insert ON sie_pending_identity_propositions;
DROP POLICY IF EXISTS sie_pending_identity_propositions_deny_update ON sie_pending_identity_propositions;
DROP POLICY IF EXISTS sie_pending_identity_propositions_deny_delete ON sie_pending_identity_propositions;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3: Reverse Migration 017 — Disable RLS on Identity Tables
-- ═══════════════════════════════════════════════════════════════════════════
-- Disable RLS (tables will be dropped later, but this ensures clean state
-- if any step is run independently).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'sie_identity_resolution_records') THEN
        ALTER TABLE sie_identity_resolution_records DISABLE ROW LEVEL SECURITY;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'sie_retrieval_attempts') THEN
        ALTER TABLE sie_retrieval_attempts DISABLE ROW LEVEL SECURITY;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'sie_pending_identity_details') THEN
        ALTER TABLE sie_pending_identity_details DISABLE ROW LEVEL SECURITY;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'sie_pending_identity_propositions') THEN
        ALTER TABLE sie_pending_identity_propositions DISABLE ROW LEVEL SECURITY;
    END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4: Reverse Migration 016 — Drop v2_validate_identity_bundle
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop the validation function (the updated v2_commit_identity_bundle that
-- calls it will be dropped in the next section).

DROP FUNCTION IF EXISTS v2_validate_identity_bundle(
    UUID, TEXT, TEXT, TEXT, INTEGER, JSONB, JSONB, JSONB, JSONB
) CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5: Reverse Migration 015/016 — Drop v2_commit_identity_bundle
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 016 replaced v2_commit_identity_bundle with an expanded signature
-- (12 params). Drop both possible signatures to handle partial rollback states.

DROP FUNCTION IF EXISTS v2_commit_identity_bundle(
    UUID, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, TEXT, TEXT, INTEGER
) CASCADE;

-- Original 9-param signature from migration 015 (in case 016 was not applied)
DROP FUNCTION IF EXISTS v2_commit_identity_bundle(
    UUID, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB
) CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6: Reverse Migration 014 — Drop v2_load_sie_identity_context
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS v2_load_sie_identity_context(UUID) CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7: Reverse Migration 013 — Drop Request-State RPCs
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop all atomic request-state management functions.

DROP FUNCTION IF EXISTS sie_supersede_request(TEXT, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS sie_mark_failed_retryable(TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS sie_record_analyzed_result(TEXT, TEXT, JSONB, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS sie_renew_lease(TEXT, TEXT, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS sie_reserve_request(UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 8: Reverse Migration 012 — Remove State-Machine Columns from
--            sie_commit_requests
-- ═══════════════════════════════════════════════════════════════════════════
-- IMPORTANT: Only drops columns ADDED by migration 012. Preserves:
--   conversation_id, request_id, idempotency_key, payload_fingerprint,
--   base_graph_version, committed_graph_version, status, result,
--   created_at, completed_at (all from migration 001).

-- Drop state-dependent integrity constraints added by 012
ALTER TABLE sie_commit_requests DROP CONSTRAINT IF EXISTS chk_superseded_requires_successor;
ALTER TABLE sie_commit_requests DROP CONSTRAINT IF EXISTS chk_analyzed_requires_result;
ALTER TABLE sie_commit_requests DROP CONSTRAINT IF EXISTS chk_reserved_requires_lease;

-- Drop indexes added by 012
DROP INDEX IF EXISTS idx_commit_requests_failed_retryable;
DROP INDEX IF EXISTS idx_commit_requests_successor;
DROP INDEX IF EXISTS idx_commit_requests_reserved;
DROP INDEX IF EXISTS idx_commit_requests_lease_expiry;
DROP INDEX IF EXISTS idx_commit_requests_conv_key_fingerprint;

-- Drop the extended status CHECK constraint added by 012
ALTER TABLE sie_commit_requests DROP CONSTRAINT IF EXISTS chk_commit_request_status;

-- Drop columns added by 012 (all nullable, so removal is safe)
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS superseded_at;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS failed_at;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS committed_at;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS analyzed_at;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS reserved_at;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS transition_metadata;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS graph_version_analyzed;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS successor_idempotency_key;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS successor_request_id;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS payload_fingerprint_hash;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS snapshot_digest;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS analyzed_result;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS lease_expires_at;
ALTER TABLE sie_commit_requests DROP COLUMN IF EXISTS lease_owner;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 9: Reverse Migration 012 — Restore Original Status CHECK Constraint
-- ═══════════════════════════════════════════════════════════════════════════
-- Restore the original status constraint from migration 001 that only allows
-- 'PENDING', 'COMMITTED', 'REJECTED'.
-- First, ensure any rows with new states are cleaned up (set to REJECTED)
-- to prevent constraint violation. This handles the case where identity
-- resolution was partially used before rollback.

UPDATE sie_commit_requests
SET status = 'REJECTED'
WHERE status NOT IN ('PENDING', 'COMMITTED', 'REJECTED');

-- Recreate the original CHECK constraint.
-- Use a DO block to avoid errors if it already exists.
DO $$
BEGIN
    -- Only add if no CHECK constraint on status currently exists.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'sie_commit_requests'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
    ) THEN
        ALTER TABLE sie_commit_requests
            ADD CONSTRAINT chk_commit_request_status_original
            CHECK (status IN ('PENDING', 'COMMITTED', 'REJECTED'));
    END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 10: Reverse Migration 011 — Drop sie_pending_identity_propositions
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop indexes first, then the table.

DROP INDEX IF EXISTS idx_pip_propositions_conversation;
DROP INDEX IF EXISTS idx_pip_propositions_decision;

DROP TABLE IF EXISTS sie_pending_identity_propositions CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 11: Reverse Migration 011 — Drop sie_pending_identity_details
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop indexes first, then the table.

DROP INDEX IF EXISTS idx_pid_details_packet;
DROP INDEX IF EXISTS idx_pid_details_conversation;

DROP TABLE IF EXISTS sie_pending_identity_details CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 12: Reverse Migration 010 — Drop sie_retrieval_attempts
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop indexes first, then the table.

DROP INDEX IF EXISTS idx_retrieval_attempts_channel_family;
DROP INDEX IF EXISTS idx_retrieval_attempts_conversation;
DROP INDEX IF EXISTS idx_retrieval_attempts_record;

DROP TABLE IF EXISTS sie_retrieval_attempts CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 13: Reverse Migration 009 — Drop sie_identity_resolution_records
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop indexes first, then the table.

DROP INDEX IF EXISTS idx_ir_records_request;
DROP INDEX IF EXISTS idx_ir_records_proposed;
DROP INDEX IF EXISTS idx_ir_records_concern;
DROP INDEX IF EXISTS idx_ir_records_conversation;

DROP TABLE IF EXISTS sie_identity_resolution_records CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 14: Restore Grants (cleanup)
-- ═══════════════════════════════════════════════════════════════════════════
-- The REVOKE statements from 017 removed INSERT/UPDATE/DELETE from
-- authenticated/anon roles on identity tables. Since we dropped those tables
-- entirely, no grant restoration is needed — the tables no longer exist.
-- Pre-existing tables retain their pre-existing grants unchanged.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION NOTES
-- ═══════════════════════════════════════════════════════════════════════════
-- After running this rollback, the following should be true:
--
-- 1. Tables DROPPED:
--    - sie_identity_resolution_records
--    - sie_retrieval_attempts
--    - sie_pending_identity_details
--    - sie_pending_identity_propositions
--    - sie_privacy_suppressions (from 018)
--
-- 2. Functions DROPPED:
--    - v2_commit_identity_bundle (all signatures)
--    - v2_validate_identity_bundle
--    - v2_load_sie_identity_context
--    - sie_reserve_request
--    - sie_renew_lease
--    - sie_record_analyzed_result
--    - sie_mark_failed_retryable
--    - sie_supersede_request
--    - sie_prevent_mutation
--    - sie_prevent_delete_only
--    - sie_purge_identity_data (from 018)
--
-- 3. Tables PRESERVED (unchanged):
--    - conversations
--    - sie_commit_requests (with original columns and status constraint)
--    - sie_pending_semantic_decisions
--    - sie_persistent_concerns
--    - sie_semantic_packets
--    - sie_entity_registry
--    - sie_propositions
--    - sie_proposition_associations
--    - sie_concern_aliases
--    - v2_update_state
--
-- 4. Functions PRESERVED:
--    - v2_commit_update (migration 008)
--    - sie_user_owns_conversation (migration 006)
--    - sie_enforce_idempotency_fingerprint (migration 001)
--
-- 5. sie_commit_requests columns PRESERVED (from 001):
--    - conversation_id, request_id, idempotency_key, payload_fingerprint,
--      base_graph_version, committed_graph_version, status, result,
--      created_at, completed_at
--
-- 6. sie_commit_requests status constraint RESTORED:
--    - CHECK (status IN ('PENDING', 'COMMITTED', 'REJECTED'))

COMMIT;
