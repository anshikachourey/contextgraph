-- SIE Migration 011: Normalized Pending Identity Tables
--
-- Creates normalized identity-specific detail tables for the generic
-- sie_pending_semantic_decisions record. These tables extend the existing
-- generic pending-decision infrastructure with identity-resolution context.
--
-- Tables created:
--   1. sie_pending_identity_details — one-to-one identity detail for a
--      pending decision, including packet, graph version, source resolution
--      record, stage statuses, and confidence bands.
--   2. sie_pending_identity_propositions — ordered many-to-many membership
--      between the pending decision and propositions.
--
-- Depends on:
--   005_retention_pending_decisions_and_audit.sql (sie_pending_semantic_decisions)
--   009_identity_resolution_records.sql (sie_identity_resolution_records)
--   Existing: conversations table
--
-- Design authority: design-corrections.md § 12.2
--
-- Lifecycle states preserved from sie_pending_semantic_decisions:
--   pending, unresolved, deferred, resolved
-- No 'expired' state is introduced.
-- No sie_pending_decisions table is introduced.
--
-- Idempotent: uses IF NOT EXISTS for all objects.

-- =============================================================================
-- 1. sie_pending_identity_details
-- =============================================================================
-- One-to-one identity-specific detail linked to the generic pending decision.
-- Contains the packet context, graph version at time of deferral, optional
-- source resolution record, and stage statuses/confidences at deferral time.

CREATE TABLE IF NOT EXISTS sie_pending_identity_details (
    detail_id TEXT PRIMARY KEY,

    -- Links to the generic pending decision record (one-to-one).
    decision_id TEXT NOT NULL UNIQUE
        REFERENCES sie_pending_semantic_decisions(decision_id),

    -- Conversation scope — ensures cross-table conversation consistency.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- The packet whose identity resolution was deferred.
    packet_id TEXT NOT NULL,

    -- Graph version at which analysis was performed before deferral.
    graph_version_analyzed INTEGER NOT NULL,

    -- Source resolution record, if a resolution record was created before
    -- the decision was deferred (e.g., DEFER or RETRIEVAL_INCONCLUSIVE
    -- outcomes that still produce a diagnostic record).
    source_resolution_record_id TEXT
        REFERENCES sie_identity_resolution_records(record_id),

    -- Stage statuses at time of deferral.
    identity_stage_status TEXT NOT NULL
        CHECK (identity_stage_status IN ('COMPLETED', 'NOT_RUN', 'FAILED')),

    -- Identity confidence (non-null iff identity stage completed).
    identity_confidence TEXT
        CHECK (identity_confidence IN ('HIGH', 'MEDIUM', 'LOW')),

    -- Retrieval-sufficiency stage status at time of deferral.
    sufficiency_stage_status TEXT NOT NULL
        CHECK (sufficiency_stage_status IN ('COMPLETED', 'NOT_RUN', 'FAILED')),

    -- Sufficiency confidence (non-null iff sufficiency stage completed).
    sufficiency_confidence TEXT
        CHECK (sufficiency_confidence IN ('HIGH', 'MEDIUM', 'LOW')),

    -- Stage-confidence coupling invariants:
    -- COMPLETED requires a confidence band; NOT_RUN/FAILED require NULL.
    CONSTRAINT chk_pid_identity_stage_confidence CHECK (
        (identity_stage_status = 'COMPLETED' AND identity_confidence IS NOT NULL)
        OR (identity_stage_status IN ('NOT_RUN', 'FAILED') AND identity_confidence IS NULL)
    ),

    CONSTRAINT chk_pid_sufficiency_stage_confidence CHECK (
        (sufficiency_stage_status = 'COMPLETED' AND sufficiency_confidence IS NOT NULL)
        OR (sufficiency_stage_status IN ('NOT_RUN', 'FAILED') AND sufficiency_confidence IS NULL)
    ),

    -- Immutable creation timestamp.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 2. sie_pending_identity_propositions
-- =============================================================================
-- Ordered many-to-many membership between a pending decision and the
-- propositions that were included in the deferred packet. Normalizes
-- proposition membership rather than storing in JSONB arrays.

CREATE TABLE IF NOT EXISTS sie_pending_identity_propositions (
    id TEXT PRIMARY KEY,

    -- The pending decision this proposition belongs to.
    decision_id TEXT NOT NULL
        REFERENCES sie_pending_semantic_decisions(decision_id),

    -- The proposition included in the deferred packet.
    proposition_id TEXT NOT NULL,

    -- Conversation scope.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- Deterministic ordering of propositions within the decision.
    ordinal INTEGER NOT NULL,

    -- Immutable creation timestamp.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Each proposition appears at most once per decision.
    CONSTRAINT uq_pip_decision_proposition UNIQUE (decision_id, proposition_id),

    -- Each ordinal position is unique within a decision.
    CONSTRAINT uq_pip_decision_ordinal UNIQUE (decision_id, ordinal)
);

-- =============================================================================
-- 3. Indexes
-- =============================================================================

-- sie_pending_identity_details: conversation-scoped queries for loading
-- identity context alongside pending decisions.
CREATE INDEX IF NOT EXISTS idx_pid_details_conversation
    ON sie_pending_identity_details(conversation_id);

-- sie_pending_identity_details: packet-based lookups (find pending decisions
-- for a specific packet).
CREATE INDEX IF NOT EXISTS idx_pid_details_packet
    ON sie_pending_identity_details(packet_id);

-- sie_pending_identity_propositions: decision-based lookups (load all
-- propositions for a pending decision, ordered by ordinal).
CREATE INDEX IF NOT EXISTS idx_pip_propositions_decision
    ON sie_pending_identity_propositions(decision_id);

-- sie_pending_identity_propositions: conversation-scoped queries.
CREATE INDEX IF NOT EXISTS idx_pip_propositions_conversation
    ON sie_pending_identity_propositions(conversation_id);

-- =============================================================================
-- 4. Notes
-- =============================================================================
-- The existing sie_pending_semantic_decisions table (migration 005) stores
-- the generic lifecycle record with states: pending, unresolved, deferred,
-- resolved. This migration does NOT:
--   - Recreate or modify sie_pending_semantic_decisions
--   - Introduce a new sie_pending_decisions table
--   - Add an 'expired' lifecycle state
--
-- Append-only enforcement, RLS policies, and privilege restrictions for these
-- tables will be added in Task 5.3 (indexes, RLS, privileges, and append-only
-- enforcement), consistent with the approach used for other identity tables.
