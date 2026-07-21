-- SIE Migration 020: Composite Reference Keys and Versioned Concern Embeddings
--
-- This migration adds prerequisite composite unique constraints required by
-- identity-resolution tables (009-011) and creates the versioned concern
-- embedding storage table referenced by the identity context loader (014).
--
-- LOGICAL DEPENDENCY ORDER:
--   This migration MUST be applied BEFORE 009, 010, 011, or 014 can enforce
--   composite foreign keys. Although numbered 020, it adds constraints to tables
--   created in 002-005 and creates infrastructure that 014 optionally consumes.
--   To maintain correct dependency order without renumbering existing migrations,
--   this file adds constraints to existing tables idempotently.
--
-- Depends on:
--   002_persistent_concerns_and_aliases.sql (sie_persistent_concerns)
--   003_propositions_and_associations.sql (sie_propositions)
--   004_packets_memberships_and_splits.sql (sie_semantic_packets)
--   005_retention_pending_decisions_and_audit.sql (sie_pending_semantic_decisions)
--   Existing: conversations table
--
-- Idempotent: uses DO blocks with pg_constraint checks and IF NOT EXISTS.

-- =============================================================================
-- 1. COMPOSITE UNIQUE CONSTRAINTS
-- =============================================================================
-- These constraints enable composite foreign keys on identity tables (009-011)
-- so that cross-conversation references are rejected at the database level.
-- Each constraint is guarded by an existence check for idempotent application.

-- 1a. sie_semantic_packets: UNIQUE (conversation_id, packet_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_packets_conversation_packet'
          AND conrelid = 'sie_semantic_packets'::regclass
    ) THEN
        ALTER TABLE sie_semantic_packets
            ADD CONSTRAINT uq_packets_conversation_packet
            UNIQUE (conversation_id, packet_id);
    END IF;
END $$;

-- 1b. sie_persistent_concerns: UNIQUE (conversation_id, concern_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_concerns_conversation_concern'
          AND conrelid = 'sie_persistent_concerns'::regclass
    ) THEN
        ALTER TABLE sie_persistent_concerns
            ADD CONSTRAINT uq_concerns_conversation_concern
            UNIQUE (conversation_id, concern_id);
    END IF;
END $$;

-- 1c. sie_propositions: UNIQUE (conversation_id, proposition_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_propositions_conversation_proposition'
          AND conrelid = 'sie_propositions'::regclass
    ) THEN
        ALTER TABLE sie_propositions
            ADD CONSTRAINT uq_propositions_conversation_proposition
            UNIQUE (conversation_id, proposition_id);
    END IF;
END $$;

-- 1d. sie_pending_semantic_decisions: UNIQUE (conversation_id, decision_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_decisions_conversation_decision'
          AND conrelid = 'sie_pending_semantic_decisions'::regclass
    ) THEN
        ALTER TABLE sie_pending_semantic_decisions
            ADD CONSTRAINT uq_decisions_conversation_decision
            UNIQUE (conversation_id, decision_id);
    END IF;
END $$;

-- =============================================================================
-- 2. VERSIONED CONCERN EMBEDDINGS TABLE
-- =============================================================================
-- Stores embeddings for persistent concerns, keyed by concern + model version.
-- Supports invalidation when source text changes and lifecycle-aware queries.
--
-- The identity context loader (migration 014) checks for this table via
-- information_schema and handles its absence gracefully. Once this table
-- exists, the loader automatically includes embedding data.
--
-- Design principles:
--   - No hardcoded embedding model or similarity threshold.
--   - One active embedding per (concern_id, embedding_model_version).
--   - Invalidation: when source_text_hash changes, old embedding is stale.
--   - Lifecycle state allows soft-delete without losing audit trail.

CREATE TABLE IF NOT EXISTS sie_concern_embeddings (
    -- Opaque stable embedding identifier.
    embedding_id TEXT PRIMARY KEY,

    -- The concern this embedding represents.
    concern_id TEXT NOT NULL
        REFERENCES sie_persistent_concerns(concern_id),

    -- Conversation scope — matches the concern's conversation.
    conversation_id UUID NOT NULL
        REFERENCES conversations(id),

    -- Embedding vector stored as a float8 array.
    -- pgvector extension can be used optionally; float8[] is universally compatible.
    embedding FLOAT8[] NOT NULL,

    -- SHA-256 hash of the identity_summary text that was embedded.
    -- When this changes, the embedding becomes stale and should be refreshed.
    source_text_hash TEXT NOT NULL,

    -- Version identifier for the embedding model used (e.g., "text-embedding-3-small-v1").
    -- NOT hardcoded — populated by the embedding service at generation time.
    embedding_model_version TEXT NOT NULL,

    -- Graph version at which this embedding was generated.
    -- Used by context loader to determine staleness (is_current = graph_version matches).
    graph_version INTEGER NOT NULL,

    -- Whether this embedding is currently active for retrieval.
    -- FALSE means invalidated/stale but preserved for audit.
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- Immutable creation timestamp.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Timestamp when this embedding was invalidated (NULL while active).
    invalidated_at TIMESTAMPTZ,

    -- Reason for invalidation when is_active = FALSE.
    invalidation_reason TEXT,

    -- =========================================================================
    -- CONSTRAINTS
    -- =========================================================================

    -- Active flag and invalidation timestamp consistency:
    -- Active embeddings must not have invalidated_at set.
    -- Inactive embeddings must have invalidated_at set.
    CONSTRAINT chk_embedding_active_consistency CHECK (
        (is_active = TRUE AND invalidated_at IS NULL)
        OR (is_active = FALSE AND invalidated_at IS NOT NULL)
    )
);

-- =============================================================================
-- 3. PARTIAL UNIQUE INDEX: One Active Embedding Per (concern, model version)
-- =============================================================================
-- Enforces that at most one active embedding exists for each combination of
-- concern_id and embedding_model_version. Historical (invalidated) embeddings
-- are preserved for audit purposes.

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_embedding_per_concern_model
    ON sie_concern_embeddings(concern_id, embedding_model_version)
    WHERE is_active = TRUE;

-- =============================================================================
-- 4. SUPPORTING INDEXES
-- =============================================================================

-- Conversation-scoped retrieval (used by context loader).
CREATE INDEX IF NOT EXISTS idx_concern_embeddings_conversation
    ON sie_concern_embeddings(conversation_id);

-- Concern-based lookups (find all embeddings for a concern).
CREATE INDEX IF NOT EXISTS idx_concern_embeddings_concern
    ON sie_concern_embeddings(concern_id);

-- Active embeddings by conversation (most common query pattern for retrieval).
CREATE INDEX IF NOT EXISTS idx_concern_embeddings_active_conversation
    ON sie_concern_embeddings(conversation_id)
    WHERE is_active = TRUE;

-- Source text hash lookup (detect stale embeddings when identity_summary changes).
CREATE INDEX IF NOT EXISTS idx_concern_embeddings_source_hash
    ON sie_concern_embeddings(concern_id, source_text_hash);

-- =============================================================================
-- 5. INVALIDATION BEHAVIOR DOCUMENTATION
-- =============================================================================
-- Embedding invalidation occurs when:
--
--   1. Source text changes: The concern's identity_summary is updated, producing
--      a new source_text_hash. The embedding service detects the hash mismatch
--      and marks the old embedding as stale (is_active = FALSE, invalidated_at = NOW(),
--      invalidation_reason = 'source_text_hash_changed'), then generates a new one.
--
--   2. Embedding model version changes: A new model version is deployed. New
--      embeddings are generated under the new version string. Old-version
--      embeddings may remain active (if the policy supports multi-version
--      retrieval) or be invalidated (invalidation_reason = 'model_version_retired').
--
--   3. Privacy purge: When a concern is suppressed, its embeddings are
--      invalidated (invalidation_reason = 'privacy_suppression').
--
-- The context loader (migration 014) marks embeddings with
-- is_current = (graph_version = current_graph_version) so consumers can
-- distinguish fresh vs stale embeddings without hardcoding version logic.

-- =============================================================================
-- 6. DEPENDENCY VERIFICATION NOTE
-- =============================================================================
-- This migration adds composite unique constraints that are PREREQUISITES for
-- composite foreign keys in migrations 009-011. The application order must be:
--
--   020_composite_keys_and_embeddings.sql (this file)
--     ↓
--   009_identity_resolution_records.sql (can now add composite FKs)
--   010_retrieval_attempts.sql
--   011_pending_identity_tables.sql
--
-- When deploying to a new environment, apply this migration before 009-011.
-- When deploying to an existing environment that already has 009-011 applied
-- (without composite FKs), this migration enables subsequent ALTER TABLE
-- statements to add the deferred composite FK constraints.
