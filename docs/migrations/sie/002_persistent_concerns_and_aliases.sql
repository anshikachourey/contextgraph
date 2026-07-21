-- SIE Migration 002: Persistent Concerns and Concern Aliases
--
-- Creates the durable concern lifecycle table and normalized alias storage.
-- Depends on: conversations table (existing)
-- Idempotent: uses IF NOT EXISTS for all objects.

-- =============================================================================
-- 1. Persistent Concerns
-- =============================================================================
-- Durable semantic identities with stable IDs, lifecycle status, parent
-- resolution, merge redirects, and version tracking.

CREATE TABLE IF NOT EXISTS sie_persistent_concerns (
    -- Opaque stable ID resolved from a creation key via the entity registry.
    concern_id TEXT PRIMARY KEY,

    -- Conversation scope — all concerns belong to exactly one conversation.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- Internal semantic identity representation (not user-facing).
    identity_summary TEXT NOT NULL,

    -- User-facing display title; may change independently from identity.
    display_title TEXT NOT NULL,

    -- Current state summary expressing what this concern currently means.
    current_summary TEXT NOT NULL,

    -- Lifecycle status governing retrieval eligibility and merge behavior.
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'DORMANT', 'RETIRED', 'MERGED')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Self-referencing parent for hierarchy. NULL means root or unresolved
    -- (disambiguated by parent_resolution_state).
    canonical_parent_id TEXT REFERENCES sie_persistent_concerns(concern_id),

    -- Disambiguates NULL parent: ROOT_CONFIRMED vs PARENT_DEFERRED.
    -- PARENT_ASSIGNED requires a non-null canonical_parent_id.
    parent_resolution_state TEXT NOT NULL DEFAULT 'PARENT_DEFERRED'
        CHECK (parent_resolution_state IN ('ROOT_CONFIRMED', 'PARENT_DEFERRED', 'PARENT_ASSIGNED')),

    -- Extensible metadata (tags, flags, UI hints).
    metadata JSONB DEFAULT '{}',

    -- Monotonically increasing version; incremented on each commit that
    -- touches this concern.
    semantic_version INTEGER NOT NULL DEFAULT 1,

    -- When status = MERGED, points to the surviving concern.
    merged_into_concern_id TEXT REFERENCES sie_persistent_concerns(concern_id),

    -- ==========================================================================
    -- CHECK CONSTRAINTS
    -- ==========================================================================

    -- Prevent self-parenting: a concern cannot be its own parent.
    CONSTRAINT chk_no_self_parent
        CHECK (canonical_parent_id IS NULL OR canonical_parent_id <> concern_id),

    -- Parent-resolution consistency: PARENT_ASSIGNED requires a parent;
    -- ROOT_CONFIRMED and PARENT_DEFERRED require NULL parent.
    CONSTRAINT chk_parent_resolution_consistency
        CHECK (
            (parent_resolution_state = 'PARENT_ASSIGNED' AND canonical_parent_id IS NOT NULL)
            OR (parent_resolution_state IN ('ROOT_CONFIRMED', 'PARENT_DEFERRED') AND canonical_parent_id IS NULL)
        ),

    -- Merge-redirect consistency: MERGED status requires a target;
    -- non-MERGED status must not have a merge target.
    CONSTRAINT chk_merge_redirect_consistency
        CHECK (
            (status = 'MERGED' AND merged_into_concern_id IS NOT NULL)
            OR (status <> 'MERGED' AND merged_into_concern_id IS NULL)
        )
);

-- Index for loading all concerns in a conversation (graph-state retrieval).
CREATE INDEX IF NOT EXISTS idx_concerns_conversation
    ON sie_persistent_concerns(conversation_id);

-- Index for filtering by lifecycle status (e.g., active concerns for retrieval).
CREATE INDEX IF NOT EXISTS idx_concerns_status
    ON sie_persistent_concerns(status);

-- Index for traversing the parent hierarchy.
CREATE INDEX IF NOT EXISTS idx_concerns_parent
    ON sie_persistent_concerns(canonical_parent_id);

-- =============================================================================
-- 2. Concern Aliases (Normalized, Audited Removal)
-- =============================================================================
-- Aliases are alternative names, vocabulary drift, historical terminology, and
-- user-specific references. They are retrieval evidence, not identity-defining.
-- Removal is explicit and audited (soft-delete with reason).

CREATE TABLE IF NOT EXISTS sie_concern_aliases (
    -- Opaque stable alias identifier.
    alias_id TEXT PRIMARY KEY,

    -- The concern this alias belongs to.
    concern_id TEXT NOT NULL REFERENCES sie_persistent_concerns(concern_id),

    -- The alias text (e.g., alternative name, historical term).
    alias_text TEXT NOT NULL,

    -- When this alias was added.
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Audited removal: NULL means the alias is active.
    removed_at TIMESTAMPTZ,

    -- Reason for removal (privacy deletion, semantic correction, merge, etc.).
    removed_reason TEXT,

    -- Conversation in which this alias was established (provenance).
    conversation_id UUID NOT NULL REFERENCES conversations(id)
);

-- Partial unique index: only one active alias per (concern_id, alias_text).
-- Allows the same text to be re-added after removal without violating uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_aliases_unique
    ON sie_concern_aliases(concern_id, alias_text)
    WHERE removed_at IS NULL;

-- Index for loading all aliases for a given concern.
CREATE INDEX IF NOT EXISTS idx_aliases_concern
    ON sie_concern_aliases(concern_id);

-- Index for loading aliases by conversation (provenance queries).
CREATE INDEX IF NOT EXISTS idx_aliases_conversation
    ON sie_concern_aliases(conversation_id);
