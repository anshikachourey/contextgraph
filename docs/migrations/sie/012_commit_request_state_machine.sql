-- SIE Migration 012: Commit Request State Machine Extension
--
-- Extends sie_commit_requests (created in 001_authoritative_engine_and_idempotency.sql)
-- to support the full identity-resolution reservation/lease protocol:
--
--   RESERVED → ANALYZED → COMMITTED
--       │          │
--       ├──────→ FAILED_RETRYABLE
--       └──────→ SUPERSEDED
--
-- Each reservation stores lease owner and lease expiry. The validated Python
-- semantic result is persisted in the request record (ANALYZED state) before
-- graph commit, so a retry after response loss returns the same result without
-- rerunning the model.
--
-- If a worker dies before recording a result, an expired lease may be reacquired.
-- A version conflict marks the old request SUPERSEDED and links to the successor.
--
-- Backward compatibility:
--   The original status values ('PENDING', 'COMMITTED', 'REJECTED') remain valid.
--   Existing rows are not migrated; they continue to operate under the legacy
--   idempotency path. The new states are used only by SIE identity-resolution
--   callers participating in the reservation protocol.
--
-- Depends on:
--   001_authoritative_engine_and_idempotency.sql (sie_commit_requests)
--
-- Design authority: design-corrections.md § 14.2
--
-- Idempotent: uses DO blocks with column-existence checks and IF NOT EXISTS.

-- =============================================================================
-- 1. Add new columns for lease, analysis result, fingerprint, and transitions
-- =============================================================================

-- Lease owner — identifies which worker holds the reservation.
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS lease_owner TEXT;

-- Lease expiry — when the lease expires (nullable; only meaningful when RESERVED).
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- The validated Python semantic result stored before graph commit (ANALYZED state).
-- This allows retry-after-response-loss to return the same result without rerunning.
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS analyzed_result JSONB;

-- Snapshot digest — the payload fingerprint's snapshot digest component.
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS snapshot_digest TEXT;

-- Full payload fingerprint content hash (extends the existing payload_fingerprint
-- column which stores the complete fingerprint string; this stores the canonical
-- content hash portion for fast comparison).
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS payload_fingerprint_hash TEXT;

-- Successor linkage — points to the superseding request when version-conflicted.
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS successor_request_id TEXT;

-- Successor idempotency key — the key of the superseding request.
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS successor_idempotency_key TEXT;

-- Graph version at which Python performed semantic reasoning.
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS graph_version_analyzed INTEGER;

-- Additional transition context (failure reasons, retry counts, conflict details).
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS transition_metadata JSONB;

-- Transition timestamps for audit trail.
ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;

ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;

ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;

ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

ALTER TABLE sie_commit_requests
    ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- =============================================================================
-- 2. Extend status CHECK constraint to include new states
-- =============================================================================
-- The original CHECK allows ('PENDING', 'COMMITTED', 'REJECTED').
-- We need to drop and recreate it to add the new states.
-- PostgreSQL does not support ALTER CONSTRAINT, so we use a DO block to
-- drop the existing constraint by finding its name, then add the new one.

DO $$
DECLARE
    constraint_name_var TEXT;
BEGIN
    -- Find the existing CHECK constraint on the status column.
    -- It may be an unnamed constraint (system-generated name) or named.
    SELECT conname INTO constraint_name_var
    FROM pg_constraint
    WHERE conrelid = 'sie_commit_requests'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%';

    -- Drop the old constraint if found.
    IF constraint_name_var IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sie_commit_requests DROP CONSTRAINT %I', constraint_name_var);
    END IF;
END $$;

-- Add the new status constraint with all valid states (legacy + new).
-- Legacy callers continue using PENDING/COMMITTED/REJECTED.
-- Identity-resolution callers use RESERVED/ANALYZED/COMMITTED/FAILED_RETRYABLE/SUPERSEDED.
ALTER TABLE sie_commit_requests
    ADD CONSTRAINT chk_commit_request_status CHECK (
        status IN (
            'PENDING',            -- Legacy: request created, awaiting commit
            'RESERVED',           -- New: lease acquired, analysis in progress
            'ANALYZED',           -- New: Python result stored, awaiting commit
            'COMMITTED',          -- Both: graph committed successfully
            'REJECTED',           -- Legacy: idempotency/fingerprint violation
            'FAILED_RETRYABLE',   -- New: transient failure, lease can be reacquired
            'SUPERSEDED'          -- New: version conflict, successor created
        )
    );

-- =============================================================================
-- 3. State-dependent integrity constraints
-- =============================================================================

-- When RESERVED, lease_owner and lease_expires_at must be present.
-- This ensures no reservation exists without an identifiable owner and timeout.
ALTER TABLE sie_commit_requests
    ADD CONSTRAINT chk_reserved_requires_lease CHECK (
        status <> 'RESERVED'
        OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    );

-- When ANALYZED, analyzed_result must be present.
-- The validated Python result is stored before commit to enable retry recovery.
ALTER TABLE sie_commit_requests
    ADD CONSTRAINT chk_analyzed_requires_result CHECK (
        status <> 'ANALYZED'
        OR analyzed_result IS NOT NULL
    );

-- When SUPERSEDED, successor_request_id must be present.
-- A superseded request always links to its successor for audit tracing.
ALTER TABLE sie_commit_requests
    ADD CONSTRAINT chk_superseded_requires_successor CHECK (
        status <> 'SUPERSEDED'
        OR successor_request_id IS NOT NULL
    );

-- =============================================================================
-- 4. Indexes for reservation and lease management
-- =============================================================================

-- Reservation lookups by (conversation_id, idempotency_key) are already covered
-- by the PRIMARY KEY. Add an index for efficient idempotency-key-based queries
-- that also need payload fingerprint (fingerprint conflict detection).
CREATE INDEX IF NOT EXISTS idx_commit_requests_conv_key_fingerprint
    ON sie_commit_requests (conversation_id, idempotency_key, payload_fingerprint);

-- Expired lease scanning — find RESERVED requests whose leases have expired
-- so they can be reacquired by other workers.
CREATE INDEX IF NOT EXISTS idx_commit_requests_lease_expiry
    ON sie_commit_requests (lease_expires_at)
    WHERE status = 'RESERVED' AND lease_expires_at IS NOT NULL;

-- Active lease management — partial index on RESERVED status for queries
-- that need to find all currently reserved requests.
CREATE INDEX IF NOT EXISTS idx_commit_requests_reserved
    ON sie_commit_requests (conversation_id, status)
    WHERE status = 'RESERVED';

-- Successor linkage lookup — find requests that superseded a given request.
CREATE INDEX IF NOT EXISTS idx_commit_requests_successor
    ON sie_commit_requests (successor_request_id)
    WHERE successor_request_id IS NOT NULL;

-- FAILED_RETRYABLE requests — for scanning and lease reacquisition.
CREATE INDEX IF NOT EXISTS idx_commit_requests_failed_retryable
    ON sie_commit_requests (conversation_id, status)
    WHERE status = 'FAILED_RETRYABLE';

-- =============================================================================
-- 5. Backward Compatibility Notes
-- =============================================================================
-- Existing rows with status = 'PENDING', 'COMMITTED', or 'REJECTED' are
-- unaffected. The new columns are all nullable and default to NULL, so
-- existing data remains valid.
--
-- The original idempotency fingerprint trigger (trg_sie_enforce_idempotency_fingerprint)
-- from migration 001 remains active and continues to protect against fingerprint
-- reuse for all callers.
--
-- The new reservation protocol is opt-in: only SIE identity-resolution callers
-- that call the reservation RPC will produce RESERVED/ANALYZED/FAILED_RETRYABLE/
-- SUPERSEDED states. Legacy callers continue to INSERT with status = 'PENDING'
-- and update to 'COMMITTED' or 'REJECTED' through the existing path.
--
-- The 'COMMITTED' status is shared between legacy and new callers. Both paths
-- end in the same terminal state, ensuring consistent downstream queries.

-- =============================================================================
-- 6. Append-Only and Transition Enforcement Notes
-- =============================================================================
-- Valid state transitions for the new protocol:
--   RESERVED → ANALYZED (lease owner records Python result)
--   RESERVED → FAILED_RETRYABLE (transient failure during analysis)
--   RESERVED → SUPERSEDED (version conflict before analysis completes)
--   ANALYZED → COMMITTED (graph committed successfully)
--   ANALYZED → FAILED_RETRYABLE (transient failure during commit)
--   ANALYZED → SUPERSEDED (version conflict detected at commit time)
--   FAILED_RETRYABLE → RESERVED (lease reacquired after expiry/failure)
--
-- Transition enforcement triggers will be added in Task 5.3 (indexes, RLS,
-- privileges, and append-only enforcement), consistent with the approach used
-- for other identity tables in this migration series.
--
-- The legacy path transitions (PENDING → COMMITTED, PENDING → REJECTED)
-- remain valid and are not constrained by new identity-resolution transitions.
