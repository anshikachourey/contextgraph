-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 001 — Authoritative Engine State & Idempotency Storage
-- Run this file in the Supabase SQL Editor.
-- Safe to run multiple times (uses IF NOT EXISTS / IF NOT EXISTS patterns).
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. AUTHORITATIVE ENGINE STATE
--
-- Extends v2_update_state with the single-authority selector and cutover
-- version marker. Default 'V2' ensures all existing callers are unaffected.
--
-- States:
--   V2         — legacy pipeline is authoritative (default)
--   SIE_SHADOW — SIE analyzes but does not alter production state
--   SIE        — SIE is the authoritative semantic engine
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE v2_update_state
    ADD COLUMN IF NOT EXISTS authoritative_engine TEXT NOT NULL DEFAULT 'V2'
        CHECK (authoritative_engine IN ('V2', 'SIE_SHADOW', 'SIE'));

ALTER TABLE v2_update_state
    ADD COLUMN IF NOT EXISTS sie_cutover_graph_version INTEGER;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. SIE ENTITY REGISTRY
--
-- Idempotent creation-key → entity-ID mapping. Ensures that replaying the
-- same processing request resolves the same permanent entity IDs and cannot
-- create duplicates. A creation key is derived from immutable source
-- provenance (never from mutable model-generated text).
--
-- Primary key: (conversation_id, entity_kind, creation_key)
-- Uniqueness:  (entity_kind, entity_id) — one ID per kind globally
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sie_entity_registry (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    entity_kind TEXT NOT NULL,
    creation_key TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id, entity_kind, creation_key)
);

-- Ensure a given entity_kind + entity_id pair is globally unique.
-- A creation key can never resolve to a different entity ID.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_entity_registry_kind_id
    ON sie_entity_registry (entity_kind, entity_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. SIE COMMIT REQUESTS
--
-- Tracks processing request lifecycle and enforces idempotency:
--   - A committed idempotency key returns the recorded result without new writes.
--   - Reusing an idempotency key with a different payload fingerprint is rejected.
--
-- Primary key: (conversation_id, idempotency_key)
-- Uniqueness:  (request_id) — each request has a globally unique ID
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sie_commit_requests (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_fingerprint TEXT NOT NULL,
    base_graph_version INTEGER NOT NULL,
    committed_graph_version INTEGER,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMMITTED', 'REJECTED')),
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_commit_requests_request_id
    ON sie_commit_requests (request_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. IDEMPOTENCY KEY FINGERPRINT CONSTRAINT
--
-- Enforces that an idempotency key cannot be reused with a different payload
-- fingerprint. This is implemented as a trigger because CHECK constraints
-- cannot reference other rows.
--
-- Behavior:
--   - INSERT with same (conversation_id, idempotency_key, payload_fingerprint)
--     is allowed (idempotent retry — handled by PK conflict resolution).
--   - INSERT with same (conversation_id, idempotency_key) but DIFFERENT
--     payload_fingerprint is rejected with an exception.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sie_enforce_idempotency_fingerprint()
RETURNS TRIGGER AS $$
DECLARE
    existing_fingerprint TEXT;
BEGIN
    SELECT payload_fingerprint INTO existing_fingerprint
    FROM sie_commit_requests
    WHERE conversation_id = NEW.conversation_id
      AND idempotency_key = NEW.idempotency_key;

    IF existing_fingerprint IS NOT NULL AND existing_fingerprint <> NEW.payload_fingerprint THEN
        RAISE EXCEPTION 'Idempotency key "%" cannot be reused with a different payload fingerprint (existing: %, new: %)',
            NEW.idempotency_key, existing_fingerprint, NEW.payload_fingerprint;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate trigger for idempotent re-application
DROP TRIGGER IF EXISTS trg_sie_enforce_idempotency_fingerprint ON sie_commit_requests;
CREATE TRIGGER trg_sie_enforce_idempotency_fingerprint
    BEFORE INSERT ON sie_commit_requests
    FOR EACH ROW
    EXECUTE FUNCTION sie_enforce_idempotency_fingerprint();
