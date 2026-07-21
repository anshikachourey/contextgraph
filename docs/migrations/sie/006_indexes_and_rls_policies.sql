-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 006 — Additional Indexes & Row-Level Security Policies
-- Run this file in the Supabase SQL Editor.
-- Safe to run multiple times (uses IF NOT EXISTS and CREATE OR REPLACE).
--
-- This migration adds:
--   1. Composite indexes for common query patterns not covered by
--      individual table migrations (001–005).
--   2. Row-Level Security (RLS) policies on all SIE tables, ensuring:
--      - Service-role access (used by the server) bypasses RLS (implicit).
--      - Authenticated/anon users can SELECT conversation-scoped data
--        where they own the conversation.
--      - INSERT/UPDATE/DELETE from non-service-role clients is BLOCKED
--        on authoritative SIE tables. Only the commit RPC (which runs
--        via service-role) can mutate SIE state.
--
-- Depends on: 001–005 (all SIE tables must exist)
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1: ADDITIONAL COMPOSITE INDEXES
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1.1 Conversation-scoped graph loading
-- ─────────────────────────────────────────────────────────────────────────
-- Optimizes the primary graph-state retrieval query which loads all active
-- concerns for a conversation.
CREATE INDEX IF NOT EXISTS idx_concerns_conversation_active
    ON sie_persistent_concerns(conversation_id, status)
    WHERE status IN ('ACTIVE', 'DORMANT');

-- ─────────────────────────────────────────────────────────────────────────
-- 1.2 Active-owner lookup
-- ─────────────────────────────────────────────────────────────────────────
-- Finds all active PRIMARY_OWNER associations for a conversation efficiently.
-- Used by graph-state retrieval and V2 projection.
CREATE INDEX IF NOT EXISTS idx_assoc_active_owners_conversation
    ON sie_proposition_associations(conversation_id, concern_id)
    WHERE role = 'PRIMARY_OWNER' AND semantic_state = 'ACTIVE';

-- ─────────────────────────────────────────────────────────────────────────
-- 1.3 Alias text search
-- ─────────────────────────────────────────────────────────────────────────
-- Supports identity resolution queries that search aliases by text content.
CREATE INDEX IF NOT EXISTS idx_aliases_text_active
    ON sie_concern_aliases(alias_text)
    WHERE removed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 1.4 Proposition sequence ranges within a conversation
-- ─────────────────────────────────────────────────────────────────────────
-- Supports loading propositions within a message sequence range for
-- incremental processing (combined start + end for range queries).
CREATE INDEX IF NOT EXISTS idx_propositions_seq_range
    ON sie_propositions(conversation_id, message_seq_start, message_seq_end);

-- ─────────────────────────────────────────────────────────────────────────
-- 1.5 Packet sequence ranges within a conversation
-- ─────────────────────────────────────────────────────────────────────────
-- Supports loading packets within a message sequence range.
CREATE INDEX IF NOT EXISTS idx_packets_seq_range
    ON sie_semantic_packets(conversation_id, message_seq_start, message_seq_end);

-- ─────────────────────────────────────────────────────────────────────────
-- 1.6 Packet membership — conversation-scoped lookup via packet
-- ─────────────────────────────────────────────────────────────────────────
-- Since memberships don't have a direct conversation_id, this index on
-- (packet_id, ordinal) supports ordered membership retrieval per packet.
-- (Already covered by UNIQUE constraint, but making intent explicit.)

-- ─────────────────────────────────────────────────────────────────────────
-- 1.7 Pending decisions — conversation + lifecycle_state composite
-- ─────────────────────────────────────────────────────────────────────────
-- Optimizes the common query pattern: "find all pending/unresolved/deferred
-- decisions for a conversation" used by graph-state retrieval.
CREATE INDEX IF NOT EXISTS idx_pending_decisions_conversation_lifecycle
    ON sie_pending_semantic_decisions(conversation_id, lifecycle_state);

-- ─────────────────────────────────────────────────────────────────────────
-- 1.8 Audit history — entity-level audit trails
-- ─────────────────────────────────────────────────────────────────────────
-- Supports entity-specific audit trail queries filtered by time.
-- The base idx_audit_entity_kind_id covers (entity_kind, entity_id).
-- This adds conversation context for conversation-scoped entity audits.
CREATE INDEX IF NOT EXISTS idx_audit_conversation_entity
    ON sie_audit_history(conversation_id, entity_kind, entity_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 1.9 Retention decisions — conversation + request_id
-- ─────────────────────────────────────────────────────────────────────────
-- Supports looking up all retention decisions produced by a specific
-- processing request within a conversation.
CREATE INDEX IF NOT EXISTS idx_retention_decisions_conversation_request
    ON sie_retention_decisions(conversation_id, request_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 1.10 Entity registry — conversation-scoped entity lookup
-- ─────────────────────────────────────────────────────────────────────────
-- Supports loading all entities of a specific kind for a conversation
-- (e.g., all proposition IDs, all concern IDs for graph-state retrieval).
CREATE INDEX IF NOT EXISTS idx_entity_registry_conversation_kind
    ON sie_entity_registry(conversation_id, entity_kind);

-- ─────────────────────────────────────────────────────────────────────────
-- 1.11 Commit requests — status lookup
-- ─────────────────────────────────────────────────────────────────────────
-- Supports finding pending or committed requests for a conversation.
CREATE INDEX IF NOT EXISTS idx_commit_requests_conversation_status
    ON sie_commit_requests(conversation_id, status);


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2: ROW-LEVEL SECURITY (RLS) POLICIES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Security model:
--   1. Service-role (SUPABASE_SERVICE_ROLE_KEY) bypasses RLS entirely.
--      All server-side operations (commit RPC, graph-state retrieval,
--      update runner) use this key.
--   2. Authenticated/anon users (NEXT_PUBLIC_SUPABASE_ANON_KEY) are subject
--      to RLS. They can:
--      - SELECT rows scoped to conversations they own.
--      - NOT INSERT/UPDATE/DELETE on authoritative SIE tables.
--   3. This prevents client-side code from directly mutating SIE state,
--      ensuring all mutations flow through the authoritative commit RPC
--      which runs with service-role privileges.
--
-- Ownership check: conversation_id IN (
--   SELECT id FROM conversations WHERE user_id = auth.uid()
-- )
--
-- NOTE: The conversations table must have a user_id column referencing
-- auth.users(id) for this to work. If user_id does not yet exist, these
-- policies will be restrictive (deny all) until that column is added,
-- which is the safe default.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- Helper: Reusable function to check conversation ownership
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sie_user_owns_conversation(p_conversation_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM conversations
        WHERE id = p_conversation_id
          AND user_id = auth.uid()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ─────────────────────────────────────────────────────────────────────────
-- 2.1 sie_entity_registry
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_entity_registry ENABLE ROW LEVEL SECURITY;

-- Allow SELECT for conversation owners
DROP POLICY IF EXISTS sie_entity_registry_select ON sie_entity_registry;
CREATE POLICY sie_entity_registry_select ON sie_entity_registry
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

-- Block all mutations from non-service-role users
DROP POLICY IF EXISTS sie_entity_registry_deny_insert ON sie_entity_registry;
CREATE POLICY sie_entity_registry_deny_insert ON sie_entity_registry
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_entity_registry_deny_update ON sie_entity_registry;
CREATE POLICY sie_entity_registry_deny_update ON sie_entity_registry
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_entity_registry_deny_delete ON sie_entity_registry;
CREATE POLICY sie_entity_registry_deny_delete ON sie_entity_registry
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.2 sie_commit_requests
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_commit_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_commit_requests_select ON sie_commit_requests;
CREATE POLICY sie_commit_requests_select ON sie_commit_requests
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_commit_requests_deny_insert ON sie_commit_requests;
CREATE POLICY sie_commit_requests_deny_insert ON sie_commit_requests
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_commit_requests_deny_update ON sie_commit_requests;
CREATE POLICY sie_commit_requests_deny_update ON sie_commit_requests
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_commit_requests_deny_delete ON sie_commit_requests;
CREATE POLICY sie_commit_requests_deny_delete ON sie_commit_requests
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.3 sie_persistent_concerns
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_persistent_concerns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_persistent_concerns_select ON sie_persistent_concerns;
CREATE POLICY sie_persistent_concerns_select ON sie_persistent_concerns
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_persistent_concerns_deny_insert ON sie_persistent_concerns;
CREATE POLICY sie_persistent_concerns_deny_insert ON sie_persistent_concerns
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_persistent_concerns_deny_update ON sie_persistent_concerns;
CREATE POLICY sie_persistent_concerns_deny_update ON sie_persistent_concerns
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_persistent_concerns_deny_delete ON sie_persistent_concerns;
CREATE POLICY sie_persistent_concerns_deny_delete ON sie_persistent_concerns
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.4 sie_concern_aliases
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_concern_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_concern_aliases_select ON sie_concern_aliases;
CREATE POLICY sie_concern_aliases_select ON sie_concern_aliases
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_concern_aliases_deny_insert ON sie_concern_aliases;
CREATE POLICY sie_concern_aliases_deny_insert ON sie_concern_aliases
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_concern_aliases_deny_update ON sie_concern_aliases;
CREATE POLICY sie_concern_aliases_deny_update ON sie_concern_aliases
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_concern_aliases_deny_delete ON sie_concern_aliases;
CREATE POLICY sie_concern_aliases_deny_delete ON sie_concern_aliases
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.5 sie_propositions
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_propositions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_propositions_select ON sie_propositions;
CREATE POLICY sie_propositions_select ON sie_propositions
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_propositions_deny_insert ON sie_propositions;
CREATE POLICY sie_propositions_deny_insert ON sie_propositions
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_propositions_deny_update ON sie_propositions;
CREATE POLICY sie_propositions_deny_update ON sie_propositions
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_propositions_deny_delete ON sie_propositions;
CREATE POLICY sie_propositions_deny_delete ON sie_propositions
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.6 sie_proposition_associations
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_proposition_associations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_proposition_associations_select ON sie_proposition_associations;
CREATE POLICY sie_proposition_associations_select ON sie_proposition_associations
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_proposition_associations_deny_insert ON sie_proposition_associations;
CREATE POLICY sie_proposition_associations_deny_insert ON sie_proposition_associations
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_proposition_associations_deny_update ON sie_proposition_associations;
CREATE POLICY sie_proposition_associations_deny_update ON sie_proposition_associations
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_proposition_associations_deny_delete ON sie_proposition_associations;
CREATE POLICY sie_proposition_associations_deny_delete ON sie_proposition_associations
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.7 sie_semantic_packets
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_semantic_packets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_semantic_packets_select ON sie_semantic_packets;
CREATE POLICY sie_semantic_packets_select ON sie_semantic_packets
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_semantic_packets_deny_insert ON sie_semantic_packets;
CREATE POLICY sie_semantic_packets_deny_insert ON sie_semantic_packets
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_semantic_packets_deny_update ON sie_semantic_packets;
CREATE POLICY sie_semantic_packets_deny_update ON sie_semantic_packets
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_semantic_packets_deny_delete ON sie_semantic_packets;
CREATE POLICY sie_semantic_packets_deny_delete ON sie_semantic_packets
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.8 sie_packet_memberships
-- ─────────────────────────────────────────────────────────────────────────
-- Memberships do not have a direct conversation_id column. Access is
-- controlled through the packet's conversation scope. We use a subquery
-- to verify ownership via the parent packet's conversation_id.
ALTER TABLE sie_packet_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_packet_memberships_select ON sie_packet_memberships;
CREATE POLICY sie_packet_memberships_select ON sie_packet_memberships
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM sie_semantic_packets sp
            WHERE sp.packet_id = sie_packet_memberships.packet_id
              AND sie_user_owns_conversation(sp.conversation_id)
        )
    );

DROP POLICY IF EXISTS sie_packet_memberships_deny_insert ON sie_packet_memberships;
CREATE POLICY sie_packet_memberships_deny_insert ON sie_packet_memberships
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_packet_memberships_deny_update ON sie_packet_memberships;
CREATE POLICY sie_packet_memberships_deny_update ON sie_packet_memberships
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_packet_memberships_deny_delete ON sie_packet_memberships;
CREATE POLICY sie_packet_memberships_deny_delete ON sie_packet_memberships
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.9 sie_packet_splits
-- ─────────────────────────────────────────────────────────────────────────
-- Splits reference packets but have no direct conversation_id. Access is
-- controlled through the original packet's conversation scope.
ALTER TABLE sie_packet_splits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_packet_splits_select ON sie_packet_splits;
CREATE POLICY sie_packet_splits_select ON sie_packet_splits
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM sie_semantic_packets sp
            WHERE sp.packet_id = sie_packet_splits.original_packet_id
              AND sie_user_owns_conversation(sp.conversation_id)
        )
    );

DROP POLICY IF EXISTS sie_packet_splits_deny_insert ON sie_packet_splits;
CREATE POLICY sie_packet_splits_deny_insert ON sie_packet_splits
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_packet_splits_deny_update ON sie_packet_splits;
CREATE POLICY sie_packet_splits_deny_update ON sie_packet_splits
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_packet_splits_deny_delete ON sie_packet_splits;
CREATE POLICY sie_packet_splits_deny_delete ON sie_packet_splits
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.10 sie_retention_decisions
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_retention_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_retention_decisions_select ON sie_retention_decisions;
CREATE POLICY sie_retention_decisions_select ON sie_retention_decisions
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_retention_decisions_deny_insert ON sie_retention_decisions;
CREATE POLICY sie_retention_decisions_deny_insert ON sie_retention_decisions
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_retention_decisions_deny_update ON sie_retention_decisions;
CREATE POLICY sie_retention_decisions_deny_update ON sie_retention_decisions
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_retention_decisions_deny_delete ON sie_retention_decisions;
CREATE POLICY sie_retention_decisions_deny_delete ON sie_retention_decisions
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.11 sie_pending_semantic_decisions
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_pending_semantic_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_pending_semantic_decisions_select ON sie_pending_semantic_decisions;
CREATE POLICY sie_pending_semantic_decisions_select ON sie_pending_semantic_decisions
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_pending_semantic_decisions_deny_insert ON sie_pending_semantic_decisions;
CREATE POLICY sie_pending_semantic_decisions_deny_insert ON sie_pending_semantic_decisions
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_pending_semantic_decisions_deny_update ON sie_pending_semantic_decisions;
CREATE POLICY sie_pending_semantic_decisions_deny_update ON sie_pending_semantic_decisions
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_pending_semantic_decisions_deny_delete ON sie_pending_semantic_decisions;
CREATE POLICY sie_pending_semantic_decisions_deny_delete ON sie_pending_semantic_decisions
    FOR DELETE
    USING (false);

-- ─────────────────────────────────────────────────────────────────────────
-- 2.12 sie_audit_history
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sie_audit_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_audit_history_select ON sie_audit_history;
CREATE POLICY sie_audit_history_select ON sie_audit_history
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

DROP POLICY IF EXISTS sie_audit_history_deny_insert ON sie_audit_history;
CREATE POLICY sie_audit_history_deny_insert ON sie_audit_history
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_audit_history_deny_update ON sie_audit_history;
CREATE POLICY sie_audit_history_deny_update ON sie_audit_history
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_audit_history_deny_delete ON sie_audit_history;
CREATE POLICY sie_audit_history_deny_delete ON sie_audit_history
    FOR DELETE
    USING (false);
