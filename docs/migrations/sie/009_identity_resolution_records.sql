-- SIE Migration 009: Identity Resolution Records
--
-- Creates the append-only identity-resolution decision record table.
-- Each record represents one complete identity-resolution decision for a
-- (request_id, packet_id) pair, with versioned policy/model references,
-- immutable diagnostics, and cross-field invariant enforcement.
--
-- Depends on:
--   001_authoritative_engine_and_idempotency.sql (sie_entity_registry, sie_commit_requests)
--   002_persistent_concerns_and_aliases.sql (sie_persistent_concerns)
--   004_packets_memberships_and_splits.sql (sie_semantic_packets)
--   Existing: conversations table
--
-- NOTE ON COMPOSITE FOREIGN KEYS:
--   The design requires composite FKs for (conversation_id, packet_id),
--   (conversation_id, matched_concern_id), and (conversation_id, proposed_concern_id)
--   to prevent cross-conversation references. These composite FKs require
--   corresponding UNIQUE constraints on the target tables:
--     - sie_semantic_packets(conversation_id, packet_id)
--     - sie_persistent_concerns(conversation_id, concern_id)
--   These composite reference keys are added in Task 2.1. Until those constraints
--   exist, composite FKs cannot be declared here. The conversation_id column and
--   basic FK on conversation_id are present; composite FK enforcement will be
--   added by a subsequent migration after Task 2.1 completes.
--
-- Idempotent: uses IF NOT EXISTS for all objects.

-- =============================================================================
-- 1. Identity Resolution Records
-- =============================================================================

CREATE TABLE IF NOT EXISTS sie_identity_resolution_records (
    -- Opaque stable record ID, resolvable through sie_entity_registry.
    -- Entity kind: 'identity_resolution_record'
    -- The record_id is deterministically derived from the canonical semantic
    -- request identity and registered in sie_entity_registry before insertion.
    record_id TEXT PRIMARY KEY,

    -- The request that produced this record.
    request_id TEXT NOT NULL,

    -- Conversation scope — ensures all referenced entities belong to the same conversation.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- The packet being resolved. One resolution record per (request_id, packet_id).
    packet_id TEXT NOT NULL,

    -- Graph version at which Python performed semantic reasoning.
    graph_version_analyzed INTEGER NOT NULL,

    -- Snapshot token binding the exact graph state used for analysis.
    graph_snapshot_token TEXT NOT NULL,

    -- Pipeline outcome: the semantic decision.
    outcome TEXT NOT NULL CHECK (outcome IN (
        'YES', 'NO', 'UNRESOLVED', 'DEFER',
        'RETRIEVAL_INCONCLUSIVE', 'REQUIRES_VALIDATION'
    )),

    -- Resolution action: what the commit should do.
    action TEXT NOT NULL CHECK (action IN (
        'ASSIGN_EXISTING', 'PROPOSE_NEW', 'RETAIN_PENDING', 'NONE'
    )),

    -- Identity evaluation stage execution status.
    identity_stage_status TEXT NOT NULL CHECK (identity_stage_status IN (
        'COMPLETED', 'NOT_RUN', 'FAILED'
    )),

    -- Identity stage confidence (non-null iff identity_stage_status = 'COMPLETED').
    identity_confidence TEXT CHECK (identity_confidence IN ('HIGH', 'MEDIUM', 'LOW')),

    -- Retrieval-sufficiency stage execution status.
    sufficiency_stage_status TEXT NOT NULL CHECK (sufficiency_stage_status IN (
        'COMPLETED', 'NOT_RUN', 'FAILED'
    )),

    -- Sufficiency stage confidence (non-null iff sufficiency_stage_status = 'COMPLETED').
    sufficiency_confidence TEXT CHECK (sufficiency_confidence IN ('HIGH', 'MEDIUM', 'LOW')),

    -- Matched existing concern ID (non-null only for YES/ASSIGN_EXISTING).
    matched_concern_id TEXT,

    -- Proposed new concern ID (non-null only for NO/PROPOSE_NEW).
    proposed_concern_id TEXT,

    -- Immutable diagnostic arrays (JSONB). These are non-authoritative snapshots
    -- and do not claim foreign-key integrity over their contents.
    candidates_considered JSONB NOT NULL DEFAULT '[]',
    irs_signals JSONB NOT NULL DEFAULT '[]',
    retrieval_attempts JSONB NOT NULL DEFAULT '[]',
    sufficiency_record JSONB,
    evidence_references JSONB NOT NULL DEFAULT '[]',

    -- Semantic reasoning justification tied to evidence references.
    reasoning TEXT NOT NULL,

    -- Versioned policy and model references for reproducibility.
    semantic_policy_version TEXT NOT NULL,
    retrieval_policy_version TEXT NOT NULL,
    model_config_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,

    -- Optional dependency group for shared proposals.
    proposed_dependency_group_id TEXT,

    -- Immutable creation timestamp.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- =========================================================================
    -- UNIQUENESS: One record per (request_id, packet_id)
    -- =========================================================================
    CONSTRAINT uq_ir_record_request_packet UNIQUE (request_id, packet_id),

    -- =========================================================================
    -- CROSS-FIELD INVARIANT: Mutually exclusive result branches
    -- Uses explicit IS NOT NULL checks to prevent PostgreSQL null semantics
    -- from bypassing invariants.
    -- =========================================================================
    CONSTRAINT chk_ir_result_branch CHECK (
        (
            -- Branch 1: YES/ASSIGN_EXISTING
            -- Requires completed identity stage with HIGH confidence,
            -- exactly one matched concern, and no proposed concern.
            outcome = 'YES'
            AND action = 'ASSIGN_EXISTING'
            AND identity_stage_status = 'COMPLETED'
            AND identity_confidence IS NOT NULL
            AND identity_confidence = 'HIGH'
            AND matched_concern_id IS NOT NULL
            AND proposed_concern_id IS NULL
        )
        OR
        (
            -- Branch 2: NO/PROPOSE_NEW
            -- Requires completed sufficiency stage with HIGH confidence,
            -- exactly one proposed concern, and no matched concern.
            outcome = 'NO'
            AND action = 'PROPOSE_NEW'
            AND sufficiency_stage_status = 'COMPLETED'
            AND sufficiency_confidence IS NOT NULL
            AND sufficiency_confidence = 'HIGH'
            AND matched_concern_id IS NULL
            AND proposed_concern_id IS NOT NULL
        )
        OR
        (
            -- Branch 3: Pending/deferred outcomes
            -- No ownership-changing mutation; neither concern ID is set.
            outcome IN ('UNRESOLVED', 'DEFER', 'RETRIEVAL_INCONCLUSIVE', 'REQUIRES_VALIDATION')
            AND action IN ('RETAIN_PENDING', 'NONE')
            AND matched_concern_id IS NULL
            AND proposed_concern_id IS NULL
        )
    ),

    -- =========================================================================
    -- STAGE-STATUS / CONFIDENCE COUPLING
    -- Ensures confidence is present iff stage completed.
    -- =========================================================================
    CONSTRAINT chk_identity_stage_confidence CHECK (
        (identity_stage_status = 'COMPLETED' AND identity_confidence IS NOT NULL)
        OR (identity_stage_status IN ('NOT_RUN', 'FAILED') AND identity_confidence IS NULL)
    ),

    CONSTRAINT chk_sufficiency_stage_confidence CHECK (
        (sufficiency_stage_status = 'COMPLETED' AND sufficiency_confidence IS NOT NULL)
        OR (sufficiency_stage_status IN ('NOT_RUN', 'FAILED') AND sufficiency_confidence IS NULL)
    )
);

-- =============================================================================
-- 2. Indexes
-- =============================================================================

-- Conversation-scoped retrieval (graph-state loading, context queries).
CREATE INDEX IF NOT EXISTS idx_ir_records_conversation
    ON sie_identity_resolution_records(conversation_id);

-- Partial index for matched-concern lookups (only rows with a match).
CREATE INDEX IF NOT EXISTS idx_ir_records_concern
    ON sie_identity_resolution_records(matched_concern_id)
    WHERE matched_concern_id IS NOT NULL;

-- Partial index for proposed-concern lookups (only rows with a proposal).
CREATE INDEX IF NOT EXISTS idx_ir_records_proposed
    ON sie_identity_resolution_records(proposed_concern_id)
    WHERE proposed_concern_id IS NOT NULL;

-- Request-scoped retrieval (idempotency checks, request history).
CREATE INDEX IF NOT EXISTS idx_ir_records_request
    ON sie_identity_resolution_records(request_id);

-- =============================================================================
-- 3. Entity Registry Integration
-- =============================================================================
-- The record_id is registered in sie_entity_registry with:
--   entity_kind = 'identity_resolution_record'
--   creation_key = deterministic canonical semantic request identity
--   entity_id = record_id
--
-- Registration occurs through the v2_commit_update RPC during atomic commit.
-- The entity registry ensures that retries of the same semantic creation event
-- resolve to the same record_id (deterministic, retry-stable IDs).
--
-- This is enforced at the application/RPC level rather than by a FK from this
-- table to sie_entity_registry, because the entity registry uses a composite PK
-- (conversation_id, entity_kind, creation_key) that does not directly map to
-- record_id as a simple FK target. The commit RPC validates entity-registry
-- consistency before inserting resolution records.

-- =============================================================================
-- 4. Notes on Append-Only Enforcement
-- =============================================================================
-- This table is designed to be append-only under normal operation:
-- - No UPDATE or DELETE is permitted through standard application paths.
-- - Append-only enforcement (triggers/policies blocking UPDATE/DELETE) will be
--   added in Task 5.3 (indexes, RLS, privileges, and append-only enforcement).
-- - The only exception is controlled privacy purge/redaction (Task 5.4), which
--   operates through a separately authorized SECURITY DEFINER RPC.

-- =============================================================================
-- 5. Composite FK Enforcement (Deferred)
-- =============================================================================
-- The following composite foreign keys will be added after Task 2.1 creates
-- the required composite unique constraints on target tables:
--
--   FOREIGN KEY (conversation_id, packet_id)
--       REFERENCES sie_semantic_packets(conversation_id, packet_id)
--
--   FOREIGN KEY (conversation_id, matched_concern_id)
--       REFERENCES sie_persistent_concerns(conversation_id, concern_id)
--       -- Only enforced when matched_concern_id IS NOT NULL
--
--   FOREIGN KEY (conversation_id, proposed_concern_id)
--       REFERENCES sie_persistent_concerns(conversation_id, concern_id)
--       -- Only enforced when proposed_concern_id IS NOT NULL
--
-- Until then, conversation_id consistency is validated at the RPC level
-- during atomic commit (v2_commit_update).
