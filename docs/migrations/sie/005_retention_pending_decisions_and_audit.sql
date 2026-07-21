-- SIE Migration 005: Retention Decisions, Pending Semantic Decisions, and Audit History
--
-- Creates:
--   1. sie_retention_decisions — Audit trail of retention assessment outcomes with
--      all retention roles, confidence, provenance references, and version info.
--   2. sie_pending_semantic_decisions — Durable lifecycle state for unresolved,
--      deferred, or pending semantic decisions that persist across requests.
--   3. sie_audit_history — Append-only change history covering concerns,
--      propositions, packets, associations, aliases, pending decisions, and
--      system transitions.
--
-- Depends on: conversations table (existing), sie_semantic_packets (004)
-- Idempotent: uses IF NOT EXISTS / DO $$ blocks for all objects.

-- =============================================================================
-- 1. Retention Decisions
-- =============================================================================
-- Records every retention assessment decision as an immutable audit trail.
-- Each decision captures the primary retention level, secondary roles,
-- confidence band, pipeline outcome, provenance references (source messages,
-- speaker role, sequence position), and the extraction/assessment versions
-- that produced the decision.
--
-- Idempotency: UNIQUE(conversation_id, decision_creation_key) ensures the same
-- assessment event is recorded exactly once even across retries.

CREATE TABLE IF NOT EXISTS sie_retention_decisions (
    -- Opaque stable decision identifier.
    decision_id TEXT PRIMARY KEY,

    -- Retry-stable creation key for this retention assessment event.
    -- Derived from immutable source provenance + extraction position.
    decision_creation_key TEXT NOT NULL,

    -- Conversation scope.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- The processing request that produced this decision.
    request_id TEXT NOT NULL,

    -- Primary retention classification.
    primary_level TEXT NOT NULL CHECK (primary_level IN (
        'DISCARD', 'CONTEXT_ONLY', 'SUPPORTING_EVIDENCE',
        'DURABLE_PROPOSITION', 'EMERGENCE_EVIDENCE',
        'INDEPENDENT_CONCERN_CANDIDATE'
    )),

    -- Additional applicable retention roles (non-exclusive).
    -- A proposition may carry multiple semantic roles simultaneously.
    secondary_roles TEXT[] NOT NULL DEFAULT '{}',

    -- Confidence band governing pipeline behavior.
    confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),

    -- Pipeline outcome — graduated result of the assessment.
    outcome TEXT NOT NULL CHECK (outcome IN (
        'YES', 'NO', 'UNRESOLVED', 'DEFER',
        'RETRIEVAL_INCONCLUSIVE', 'REQUIRES_VALIDATION'
    )),

    -- Source message references (provenance — immutable).
    source_message_ids TEXT[] NOT NULL,

    -- Who authored the source material.
    speaker_role TEXT NOT NULL CHECK (speaker_role IN ('USER', 'ASSISTANT')),

    -- Position in the message sequence for ordering.
    sequence_position INTEGER NOT NULL,

    -- Version of the extraction algorithm that identified the material.
    extraction_version TEXT NOT NULL,

    -- Version of the assessment algorithm that classified it.
    assessment_version TEXT NOT NULL,

    -- Optional human-readable rationale for the decision.
    rationale TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Idempotency constraint: same creation key in a conversation = same decision.
    CONSTRAINT uq_retention_decision_creation_key
        UNIQUE (conversation_id, decision_creation_key)
);

-- Index for loading all retention decisions in a conversation.
CREATE INDEX IF NOT EXISTS idx_retention_decisions_conversation
    ON sie_retention_decisions(conversation_id);

-- Index for filtering by outcome (e.g., find all UNRESOLVED/DEFER decisions).
CREATE INDEX IF NOT EXISTS idx_retention_decisions_outcome
    ON sie_retention_decisions(outcome);

-- =============================================================================
-- 2. Pending Semantic Decisions
-- =============================================================================
-- Durable lifecycle state for semantic decisions that could not be fully
-- resolved in a single processing pass. Pending decisions persist across
-- requests and are reloaded into GraphStateContext on every subsequent
-- processing invocation for that conversation.
--
-- Lifecycle states:
--   - pending:    Initial state when a decision cannot be made yet.
--   - unresolved: Actively needs resolution but context is insufficient.
--   - deferred:   Explicitly postponed (e.g., waiting for more evidence).
--   - resolved:   Successfully resolved in a later processing pass.
--
-- IMPORTANT: Updates to resolved state do NOT delete the row — they set
-- lifecycle_state='resolved' and resolved_at timestamp, preserving full
-- audit history of the decision's lifecycle.

CREATE TABLE IF NOT EXISTS sie_pending_semantic_decisions (
    -- Opaque stable decision identifier.
    decision_id TEXT PRIMARY KEY,

    -- Retry-stable creation key for this pending decision event.
    decision_creation_key TEXT NOT NULL,

    -- Conversation scope.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- Which pipeline stage produced this pending decision
    -- (e.g., 'identity_resolution', 'cohesion_analysis', 'retention_assessment').
    stage TEXT NOT NULL,

    -- The entity creation key this decision pertains to.
    -- Links back to the entity that could not be fully resolved.
    entity_creation_key TEXT NOT NULL,

    -- Pipeline outcome at time of deferral.
    outcome TEXT NOT NULL CHECK (outcome IN (
        'YES', 'NO', 'UNRESOLVED', 'DEFER',
        'RETRIEVAL_INCONCLUSIVE', 'REQUIRES_VALIDATION'
    )),

    -- Durable lifecycle state with explicit valid transitions.
    lifecycle_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (lifecycle_state IN ('pending', 'unresolved', 'deferred', 'resolved')),

    -- The processing request that originally created this pending decision.
    originating_request_id TEXT NOT NULL,

    -- References to other entities/decisions this depends on.
    -- Allows tracking what needs to resolve before this can resolve.
    dependency_refs TEXT[] NOT NULL DEFAULT '{}',

    -- Structured metadata recorded at resolution time.
    -- Contains resolution details (resolving_request_id, resolution_reason, etc.)
    resolution_metadata JSONB,

    -- Optional human-readable rationale.
    rationale TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Set when lifecycle_state transitions to 'resolved'.
    -- NULL while pending/unresolved/deferred.
    resolved_at TIMESTAMPTZ,

    -- Idempotency constraint: same creation key in a conversation = same decision.
    CONSTRAINT uq_pending_decision_creation_key
        UNIQUE (conversation_id, decision_creation_key)
);

-- Index for loading all pending decisions in a conversation (graph-state retrieval).
CREATE INDEX IF NOT EXISTS idx_pending_decisions_conversation
    ON sie_pending_semantic_decisions(conversation_id);

-- Index for filtering by lifecycle state (find all unresolved/deferred decisions).
CREATE INDEX IF NOT EXISTS idx_pending_decisions_lifecycle
    ON sie_pending_semantic_decisions(lifecycle_state);

-- Index for finding pending decisions by originating request.
CREATE INDEX IF NOT EXISTS idx_pending_decisions_request
    ON sie_pending_semantic_decisions(originating_request_id);

-- Partial index for active (non-resolved) decisions — most common query pattern.
CREATE INDEX IF NOT EXISTS idx_pending_decisions_active
    ON sie_pending_semantic_decisions(conversation_id, stage)
    WHERE lifecycle_state <> 'resolved';

-- =============================================================================
-- 3. Audit History (Append-Only)
-- =============================================================================
-- Append-only change history for all SIE entities. Every state change,
-- lifecycle transition, association modification, alias operation, decision
-- resolution, and system event is recorded here.
--
-- This table is NEVER updated or deleted from — it is purely additive.
-- It covers: concerns, propositions, packets, associations, aliases,
-- pending decisions, and system transitions (e.g., authority changes).
--
-- The before_state/after_state pattern allows reconstructing entity state
-- at any point in time for debugging and compliance.

CREATE TABLE IF NOT EXISTS sie_audit_history (
    -- Unique audit record identifier (generated UUID as text).
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,

    -- Conversation scope.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- What kind of entity was changed.
    entity_kind TEXT NOT NULL CHECK (entity_kind IN (
        'concern', 'proposition', 'packet', 'association',
        'alias', 'pending_decision', 'membership', 'split',
        'retention_decision', 'system'
    )),

    -- The specific entity that was changed (its primary ID).
    entity_id TEXT NOT NULL,

    -- What action was performed (e.g., 'created', 'state_changed',
    -- 'resolved', 'merged', 'retired', 'alias_removed', 'authority_changed').
    action TEXT NOT NULL,

    -- Entity state before the change (NULL for creation events).
    before_state JSONB,

    -- Entity state after the change.
    after_state JSONB,

    -- The processing request that triggered this change (nullable for system events).
    request_id TEXT,

    -- Additional structured metadata (versions, triggering conditions, etc.).
    metadata JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying audit history by entity (most common lookup pattern).
CREATE INDEX IF NOT EXISTS idx_audit_entity_kind_id
    ON sie_audit_history(entity_kind, entity_id);

-- Index for loading all audit records in a conversation.
CREATE INDEX IF NOT EXISTS idx_audit_conversation
    ON sie_audit_history(conversation_id);

-- Index for finding audit records by action type within a conversation.
CREATE INDEX IF NOT EXISTS idx_audit_conversation_action
    ON sie_audit_history(conversation_id, action);

-- Index for time-based audit queries (recent changes).
CREATE INDEX IF NOT EXISTS idx_audit_created_at
    ON sie_audit_history(created_at);
