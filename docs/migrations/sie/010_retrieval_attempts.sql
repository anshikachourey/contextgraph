-- SIE Migration 010: Retrieval Attempts
--
-- Creates the append-only retrieval-attempt table for identity resolution.
-- Each row records one retrieval channel invocation (initial or widening)
-- linked to its parent resolution record, conversation, and packet.
--
-- Candidate IDs are stored as immutable diagnostics only — no array-level
-- FK integrity is claimed over their contents.
--
-- Depends on:
--   009_identity_resolution_records.sql (sie_identity_resolution_records)
--   Existing: conversations table
--
-- Idempotent: uses IF NOT EXISTS for all objects.

-- =============================================================================
-- 1. Retrieval Attempts
-- =============================================================================

CREATE TABLE IF NOT EXISTS sie_retrieval_attempts (
    -- Opaque stable attempt ID.
    attempt_id TEXT PRIMARY KEY,

    -- Link to the parent resolution record.
    record_id TEXT NOT NULL REFERENCES sie_identity_resolution_records(record_id),

    -- Conversation scope.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- The packet being resolved (informational; composite FK deferred to Task 5.3).
    packet_id TEXT NOT NULL,

    -- Channel identification.
    channel_id TEXT NOT NULL,
    channel_family TEXT NOT NULL CHECK (channel_family IN (
        'embedding_primary',
        'identity_summary',
        'alias_normalized',
        'lexical_entity',
        'dormant_scan',
        'historical_region',
        'alternate_formulation'
    )),

    -- Query details (required, not defaulted).
    query_mode TEXT NOT NULL,
    query_reference TEXT NOT NULL,
    scope_description TEXT NOT NULL,

    -- Attempt outcome.
    status TEXT NOT NULL CHECK (status IN (
        'SUCCESS_WITH_CANDIDATES',
        'SUCCESS_EMPTY',
        'ERROR',
        'TIMEOUT',
        'UNAVAILABLE',
        'SKIPPED_WITH_REASON'
    )),

    -- Immutable diagnostic: candidate IDs snapshot (no FK integrity claimed).
    -- These are informational references only; candidates may be merged, split,
    -- or removed in subsequent graph operations without invalidating this record.
    candidate_ids TEXT[] NOT NULL DEFAULT '{}',
    candidate_count INTEGER NOT NULL DEFAULT 0,

    -- Performance metrics.
    latency_ms INTEGER,
    failure_reason TEXT,

    -- Policy version that governed this attempt.
    retrieval_policy_version TEXT NOT NULL,

    -- Widening context: whether this attempt was part of adaptive widening.
    is_widening_attempt BOOLEAN NOT NULL DEFAULT FALSE,

    -- IRS signal that triggered this attempt (null for initial-plan attempts).
    triggered_by_signal TEXT CHECK (triggered_by_signal IN (
        'REVISIT_LANGUAGE',
        'HISTORICAL_REFERENT',
        'IMPLIED_PRIOR_STATE',
        'BROAD_CANDIDATE_MISMATCH',
        'ALIAS_OR_VOCABULARY_DRIFT',
        'CONTINUATION_HISTORY_MISMATCH'
    )),

    -- Immutable creation timestamp.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- =========================================================================
    -- DIAGNOSTIC CARDINALITY: candidate_count must equal array length.
    -- =========================================================================
    CONSTRAINT chk_candidate_count_matches_array CHECK (
        candidate_count = coalesce(array_length(candidate_ids, 1), 0)
    )
);

-- =============================================================================
-- 2. Indexes
-- =============================================================================

-- Join back to resolution records (most common access pattern).
CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_record
    ON sie_retrieval_attempts(record_id);

-- Conversation-scoped loading (context queries, privacy purge).
CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_conversation
    ON sie_retrieval_attempts(conversation_id);

-- Analytics: channel-family distribution and performance.
CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_channel_family
    ON sie_retrieval_attempts(channel_family);

-- =============================================================================
-- 3. Notes on Append-Only Enforcement
-- =============================================================================
-- This table is designed to be append-only under normal operation:
-- - No UPDATE or DELETE is permitted through standard application paths.
-- - Append-only enforcement (triggers/policies blocking UPDATE/DELETE) will be
--   added in Task 5.3 (indexes, RLS, privileges, and append-only enforcement).
-- - The only exception is controlled privacy purge/redaction (Task 5.4), which
--   operates through a separately authorized SECURITY DEFINER RPC.
