-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 007 — COMPLETE ROLLBACK
--
-- Removes all SIE schema objects in reverse dependency order.
-- Safe to run multiple times (uses IF EXISTS for all DROP operations).
--
-- WARNING: This will permanently delete ALL SIE data. Only use in
-- local/test environments or when a full SIE schema removal is required.
--
-- Rollback order (reverse of creation dependency):
--   1. Disable RLS and drop policies (006)
--   2. Drop indexes from 006
--   3. Drop audit, pending decisions, retention decisions (005)
--   4. Drop packet splits, memberships, deferred FK, packets (004)
--   5. Drop proposition associations, propositions (003)
--   6. Drop concern aliases, persistent concerns (002)
--   7. Drop idempotency trigger/function, commit requests, entity registry (001)
--   8. Remove added columns from v2_update_state (001)
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1: DROP RLS POLICIES (reverse of 006)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1.1 sie_audit_history
DROP POLICY IF EXISTS sie_audit_history_deny_delete ON sie_audit_history;
DROP POLICY IF EXISTS sie_audit_history_deny_update ON sie_audit_history;
DROP POLICY IF EXISTS sie_audit_history_deny_insert ON sie_audit_history;
DROP POLICY IF EXISTS sie_audit_history_select ON sie_audit_history;
ALTER TABLE IF EXISTS sie_audit_history DISABLE ROW LEVEL SECURITY;

-- 1.2 sie_pending_semantic_decisions
DROP POLICY IF EXISTS sie_pending_semantic_decisions_deny_delete ON sie_pending_semantic_decisions;
DROP POLICY IF EXISTS sie_pending_semantic_decisions_deny_update ON sie_pending_semantic_decisions;
DROP POLICY IF EXISTS sie_pending_semantic_decisions_deny_insert ON sie_pending_semantic_decisions;
DROP POLICY IF EXISTS sie_pending_semantic_decisions_select ON sie_pending_semantic_decisions;
ALTER TABLE IF EXISTS sie_pending_semantic_decisions DISABLE ROW LEVEL SECURITY;

-- 1.3 sie_retention_decisions
DROP POLICY IF EXISTS sie_retention_decisions_deny_delete ON sie_retention_decisions;
DROP POLICY IF EXISTS sie_retention_decisions_deny_update ON sie_retention_decisions;
DROP POLICY IF EXISTS sie_retention_decisions_deny_insert ON sie_retention_decisions;
DROP POLICY IF EXISTS sie_retention_decisions_select ON sie_retention_decisions;
ALTER TABLE IF EXISTS sie_retention_decisions DISABLE ROW LEVEL SECURITY;

-- 1.4 sie_packet_splits
DROP POLICY IF EXISTS sie_packet_splits_deny_delete ON sie_packet_splits;
DROP POLICY IF EXISTS sie_packet_splits_deny_update ON sie_packet_splits;
DROP POLICY IF EXISTS sie_packet_splits_deny_insert ON sie_packet_splits;
DROP POLICY IF EXISTS sie_packet_splits_select ON sie_packet_splits;
ALTER TABLE IF EXISTS sie_packet_splits DISABLE ROW LEVEL SECURITY;

-- 1.5 sie_packet_memberships
DROP POLICY IF EXISTS sie_packet_memberships_deny_delete ON sie_packet_memberships;
DROP POLICY IF EXISTS sie_packet_memberships_deny_update ON sie_packet_memberships;
DROP POLICY IF EXISTS sie_packet_memberships_deny_insert ON sie_packet_memberships;
DROP POLICY IF EXISTS sie_packet_memberships_select ON sie_packet_memberships;
ALTER TABLE IF EXISTS sie_packet_memberships DISABLE ROW LEVEL SECURITY;

-- 1.6 sie_semantic_packets
DROP POLICY IF EXISTS sie_semantic_packets_deny_delete ON sie_semantic_packets;
DROP POLICY IF EXISTS sie_semantic_packets_deny_update ON sie_semantic_packets;
DROP POLICY IF EXISTS sie_semantic_packets_deny_insert ON sie_semantic_packets;
DROP POLICY IF EXISTS sie_semantic_packets_select ON sie_semantic_packets;
ALTER TABLE IF EXISTS sie_semantic_packets DISABLE ROW LEVEL SECURITY;

-- 1.7 sie_proposition_associations
DROP POLICY IF EXISTS sie_proposition_associations_deny_delete ON sie_proposition_associations;
DROP POLICY IF EXISTS sie_proposition_associations_deny_update ON sie_proposition_associations;
DROP POLICY IF EXISTS sie_proposition_associations_deny_insert ON sie_proposition_associations;
DROP POLICY IF EXISTS sie_proposition_associations_select ON sie_proposition_associations;
ALTER TABLE IF EXISTS sie_proposition_associations DISABLE ROW LEVEL SECURITY;

-- 1.8 sie_propositions
DROP POLICY IF EXISTS sie_propositions_deny_delete ON sie_propositions;
DROP POLICY IF EXISTS sie_propositions_deny_update ON sie_propositions;
DROP POLICY IF EXISTS sie_propositions_deny_insert ON sie_propositions;
DROP POLICY IF EXISTS sie_propositions_select ON sie_propositions;
ALTER TABLE IF EXISTS sie_propositions DISABLE ROW LEVEL SECURITY;

-- 1.9 sie_concern_aliases
DROP POLICY IF EXISTS sie_concern_aliases_deny_delete ON sie_concern_aliases;
DROP POLICY IF EXISTS sie_concern_aliases_deny_update ON sie_concern_aliases;
DROP POLICY IF EXISTS sie_concern_aliases_deny_insert ON sie_concern_aliases;
DROP POLICY IF EXISTS sie_concern_aliases_select ON sie_concern_aliases;
ALTER TABLE IF EXISTS sie_concern_aliases DISABLE ROW LEVEL SECURITY;

-- 1.10 sie_persistent_concerns
DROP POLICY IF EXISTS sie_persistent_concerns_deny_delete ON sie_persistent_concerns;
DROP POLICY IF EXISTS sie_persistent_concerns_deny_update ON sie_persistent_concerns;
DROP POLICY IF EXISTS sie_persistent_concerns_deny_insert ON sie_persistent_concerns;
DROP POLICY IF EXISTS sie_persistent_concerns_select ON sie_persistent_concerns;
ALTER TABLE IF EXISTS sie_persistent_concerns DISABLE ROW LEVEL SECURITY;

-- 1.11 sie_commit_requests
DROP POLICY IF EXISTS sie_commit_requests_deny_delete ON sie_commit_requests;
DROP POLICY IF EXISTS sie_commit_requests_deny_update ON sie_commit_requests;
DROP POLICY IF EXISTS sie_commit_requests_deny_insert ON sie_commit_requests;
DROP POLICY IF EXISTS sie_commit_requests_select ON sie_commit_requests;
ALTER TABLE IF EXISTS sie_commit_requests DISABLE ROW LEVEL SECURITY;

-- 1.12 sie_entity_registry
DROP POLICY IF EXISTS sie_entity_registry_deny_delete ON sie_entity_registry;
DROP POLICY IF EXISTS sie_entity_registry_deny_update ON sie_entity_registry;
DROP POLICY IF EXISTS sie_entity_registry_deny_insert ON sie_entity_registry;
DROP POLICY IF EXISTS sie_entity_registry_select ON sie_entity_registry;
ALTER TABLE IF EXISTS sie_entity_registry DISABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2: DROP ADDITIONAL INDEXES (from 006)
-- ═══════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_commit_requests_conversation_status;
DROP INDEX IF EXISTS idx_entity_registry_conversation_kind;
DROP INDEX IF EXISTS idx_retention_decisions_conversation_request;
DROP INDEX IF EXISTS idx_audit_conversation_entity;
DROP INDEX IF EXISTS idx_pending_decisions_conversation_lifecycle;
DROP INDEX IF EXISTS idx_packets_seq_range;
DROP INDEX IF EXISTS idx_propositions_seq_range;
DROP INDEX IF EXISTS idx_aliases_text_active;
DROP INDEX IF EXISTS idx_assoc_active_owners_conversation;
DROP INDEX IF EXISTS idx_concerns_conversation_active;

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 3: DROP RLS HELPER FUNCTION
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS sie_user_owns_conversation(UUID);

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 4: DROP TABLES IN REVERSE DEPENDENCY ORDER
-- ═══════════════════════════════════════════════════════════════════════════

-- 4.1 Audit history (no FKs from other SIE tables)
DROP TABLE IF EXISTS sie_audit_history CASCADE;

-- 4.2 Pending semantic decisions (no FKs from other SIE tables)
DROP TABLE IF EXISTS sie_pending_semantic_decisions CASCADE;

-- 4.3 Retention decisions (no FKs from other SIE tables)
DROP TABLE IF EXISTS sie_retention_decisions CASCADE;

-- 4.4 Packet splits (depends on sie_semantic_packets)
DROP TABLE IF EXISTS sie_packet_splits CASCADE;

-- 4.5 Packet memberships (depends on sie_semantic_packets, sie_propositions)
DROP TABLE IF EXISTS sie_packet_memberships CASCADE;

-- 4.6 Semantic packets (referenced by memberships, splits, associations)
DROP TABLE IF EXISTS sie_semantic_packets CASCADE;

-- 4.7 Proposition associations (depends on sie_propositions, sie_persistent_concerns)
DROP TABLE IF EXISTS sie_proposition_associations CASCADE;

-- 4.8 Propositions (depends on conversations)
DROP TABLE IF EXISTS sie_propositions CASCADE;

-- 4.9 Concern aliases (depends on sie_persistent_concerns)
DROP TABLE IF EXISTS sie_concern_aliases CASCADE;

-- 4.10 Persistent concerns (self-referencing; depends on conversations)
DROP TABLE IF EXISTS sie_persistent_concerns CASCADE;

-- 4.11 Commit requests (depends on conversations)
DROP TABLE IF EXISTS sie_commit_requests CASCADE;

-- 4.12 Entity registry (depends on conversations)
DROP TABLE IF EXISTS sie_entity_registry CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 5: DROP IDEMPOTENCY TRIGGER AND FUNCTION (from 001)
-- ═══════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_sie_enforce_idempotency_fingerprint ON sie_commit_requests;
DROP FUNCTION IF EXISTS sie_enforce_idempotency_fingerprint();

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 6: REMOVE ADDED COLUMNS FROM v2_update_state (from 001)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE v2_update_state
    DROP COLUMN IF EXISTS sie_cutover_graph_version;

ALTER TABLE v2_update_state
    DROP COLUMN IF EXISTS authoritative_engine;

-- ═══════════════════════════════════════════════════════════════════════════
-- DONE
-- After running this rollback, the database schema is restored to its
-- pre-SIE state. All SIE data is permanently removed.
-- ═══════════════════════════════════════════════════════════════════════════
