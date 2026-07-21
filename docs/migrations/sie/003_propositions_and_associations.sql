-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 003 — Propositions & Proposition-Concern Associations
-- Run this file in the Supabase SQL Editor.
-- Safe to run multiple times (uses IF NOT EXISTS / IF NOT EXISTS patterns).
--
-- Depends on:
--   001_authoritative_engine_and_idempotency.sql (sie_entity_registry)
--   002_persistent_concerns_and_aliases.sql (sie_persistent_concerns)
--   Existing: conversations table
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. SIE PROPOSITIONS
--
-- Smallest semantic unit with full provenance, retention roles, enum-
-- validated fields, and sequence range constraints.
--
-- Key invariants:
--   - proposition_id is an opaque stable ID resolved from the entity registry.
--   - source_message_ids must have at least one element.
--   - retention_levels must be non-empty and contain only valid enum values.
--   - message_seq_start <= message_seq_end (range ordering).
--   - supersedes_proposition_id is a self-referencing FK for evolution chains.
--   - proposition_creation_key provides retry-stable idempotent creation.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sie_propositions (
    -- Opaque stable ID resolved from proposition_creation_key via entity registry.
    proposition_id TEXT PRIMARY KEY,

    -- Conversation scope — all propositions belong to exactly one conversation.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- Retry-stable creation key for idempotent entity creation.
    proposition_creation_key TEXT NOT NULL,

    -- Source message UUIDs from which this proposition was derived.
    -- Immutable provenance: never rewritten by semantic evolution or repair.
    source_message_ids TEXT[] NOT NULL,

    -- Who authored the source material (USER or ASSISTANT).
    speaker_role TEXT NOT NULL
        CHECK (speaker_role IN ('USER', 'ASSISTANT')),

    -- Normalized semantic meaning of this proposition.
    canonical_meaning TEXT NOT NULL,

    -- Semantic type classification.
    proposition_type TEXT NOT NULL
        CHECK (proposition_type IN (
            'QUESTION', 'CLAIM', 'PREFERENCE', 'GOAL', 'INTENT', 'DECISION',
            'CONSTRAINT', 'PLAN', 'CORRECTION', 'REJECTION', 'UPDATE',
            'REQUEST', 'EMOTIONAL_STATE', 'EXAMPLE'
        )),

    -- Message sequence range (inclusive). Uses BIGINT to match the global
    -- bigserial message_seq column on the messages table.
    message_seq_start BIGINT NOT NULL,
    message_seq_end BIGINT NOT NULL,

    -- How this proposition was derived from the source messages.
    provenance TEXT NOT NULL
        CHECK (provenance IN ('DIRECT', 'PARAPHRASE', 'INTERPRETATION', 'INFERENCE')),

    -- Lifecycle state: ACTIVE → SUPERSEDED/RETRACTED/INVALIDATED.
    semantic_state TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (semantic_state IN ('ACTIVE', 'SUPERSEDED', 'RETRACTED', 'INVALIDATED')),

    -- ALL applicable retention levels preserved (non-exclusive roles).
    -- Must contain at least one valid level.
    retention_levels TEXT[] NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Pipeline version that extracted this proposition.
    extraction_version TEXT NOT NULL,

    -- Self-referencing FK for supersession chains.
    supersedes_proposition_id TEXT REFERENCES sie_propositions(proposition_id),

    -- ══════════════════════════════════════════════════════════════════════
    -- CHECK CONSTRAINTS
    -- ══════════════════════════════════════════════════════════════════════

    -- Sequence range must be ordered.
    CONSTRAINT chk_proposition_seq_range
        CHECK (message_seq_start <= message_seq_end),

    -- At least one source message must be referenced (provenance immutability).
    CONSTRAINT chk_proposition_has_sources
        CHECK (cardinality(source_message_ids) > 0),

    -- Retention levels must be non-empty and contain only valid enum values.
    CONSTRAINT chk_retention_levels_valid
        CHECK (
            cardinality(retention_levels) > 0
            AND retention_levels <@ ARRAY[
                'DISCARD', 'CONTEXT_ONLY', 'SUPPORTING_EVIDENCE',
                'DURABLE_PROPOSITION', 'EMERGENCE_EVIDENCE',
                'INDEPENDENT_CONCERN_CANDIDATE'
            ]::TEXT[]
        )
);

-- Index for loading all propositions in a conversation (graph-state retrieval).
CREATE INDEX IF NOT EXISTS idx_propositions_conversation
    ON sie_propositions(conversation_id);

-- Index for filtering by lifecycle state.
CREATE INDEX IF NOT EXISTS idx_propositions_state
    ON sie_propositions(semantic_state);

-- Index for sequence-range queries within a conversation.
CREATE INDEX IF NOT EXISTS idx_propositions_seq
    ON sie_propositions(conversation_id, message_seq_start);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. SIE PROPOSITION-CONCERN ASSOCIATIONS
--
-- Normalized many-to-many between propositions and concerns with explicit
-- roles, lifecycle state, confidence, and packet-establishment provenance.
--
-- Key invariants:
--   - A proposition may have multiple associations with different roles.
--   - At most one ACTIVE PRIMARY_OWNER per proposition (partial unique index).
--   - established_by_packet_id is nullable TEXT — FK added in migration 004
--     after the packet table exists.
--   - conversation_id enables RLS and conversation-boundary enforcement.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sie_proposition_associations (
    -- Opaque stable ID resolved from association_creation_key via entity registry.
    association_id TEXT PRIMARY KEY,

    -- Retry-stable creation key for idempotent association creation.
    association_creation_key TEXT NOT NULL,

    -- The proposition being associated.
    proposition_id TEXT NOT NULL REFERENCES sie_propositions(proposition_id),

    -- The concern this proposition is associated with.
    concern_id TEXT NOT NULL REFERENCES sie_persistent_concerns(concern_id),

    -- Association role — determines semantic relationship type.
    role TEXT NOT NULL
        CHECK (role IN (
            'PRIMARY_OWNER', 'SUPPORTING_EVIDENCE', 'EMERGENCE_EVIDENCE',
            'CONTEXT', 'CROSS_OBJECT_IMPACT'
        )),

    -- Behavioral confidence band for this association.
    confidence TEXT NOT NULL
        CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),

    -- How this association was established (free-text provenance description).
    provenance TEXT NOT NULL,

    -- Nullable reference to the packet that established this association.
    -- FK constraint added in migration 004 after sie_semantic_packets exists.
    established_by_packet_id TEXT,

    -- Lifecycle state: ACTIVE → SUPERSEDED/RETRACTED/INVALIDATED.
    semantic_state TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (semantic_state IN ('ACTIVE', 'SUPERSEDED', 'RETRACTED', 'INVALIDATED')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Monotonically increasing version; incremented on reassignment/repair.
    version INTEGER NOT NULL DEFAULT 1,

    -- Conversation scope — enables RLS and conversation-boundary enforcement.
    conversation_id UUID NOT NULL REFERENCES conversations(id)
);

-- Index for looking up all associations for a given proposition.
CREATE INDEX IF NOT EXISTS idx_assoc_proposition
    ON sie_proposition_associations(proposition_id);

-- Index for looking up all associations for a given concern.
CREATE INDEX IF NOT EXISTS idx_assoc_concern
    ON sie_proposition_associations(concern_id);

-- Index for filtering active associations by role.
CREATE INDEX IF NOT EXISTS idx_assoc_role_active
    ON sie_proposition_associations(role)
    WHERE semantic_state = 'ACTIVE';

-- Index for conversation-scoped queries (RLS, boundary enforcement).
CREATE INDEX IF NOT EXISTS idx_assoc_conversation
    ON sie_proposition_associations(conversation_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. PARTIAL UNIQUE INDEX: AT MOST ONE ACTIVE PRIMARY_OWNER PER PROPOSITION
--
-- Enforces that a proposition cannot have more than one ACTIVE PRIMARY_OWNER
-- association at any time. This is the authoritative ownership constraint.
-- Historical (SUPERSEDED/INVALIDATED) PRIMARY_OWNER records are preserved
-- for audit — only ACTIVE ones are constrained to uniqueness.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_primary_owner
    ON sie_proposition_associations(proposition_id)
    WHERE role = 'PRIMARY_OWNER' AND semantic_state = 'ACTIVE';
