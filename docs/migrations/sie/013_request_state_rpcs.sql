-- SIE Migration 013: Atomic Request-State RPCs
--
-- Implements the database RPCs for the commit-request state machine defined in
-- migration 012. These functions provide atomic reservation, lease management,
-- result caching, failure handling, and version-conflict supersession.
--
-- Design authority: design-corrections.md § 14.2, § 14.3
--
-- All functions are SECURITY DEFINER with explicit row locking and return JSONB
-- for uniform caller handling. CREATE OR REPLACE ensures idempotent application.
--
-- Depends on:
--   012_commit_request_state_machine.sql (state machine columns and constraints)
--   001_authoritative_engine_and_idempotency.sql (sie_commit_requests table)
--
-- Outcomes:
--   sie_reserve_request()        → NEW_LEASE | ANALYZED_RESULT | COMMITTED_RESULT
--                                   | IN_PROGRESS | FINGERPRINT_CONFLICT | RETRYABLE_LEASE
--   sie_renew_lease()            → {success, lease_expires_at} or {success: false, reason}
--   sie_record_analyzed_result() → {success} or {success: false, reason}
--   sie_mark_failed_retryable()  → {success} or {success: false, reason}
--   sie_supersede_request()      → {success} or {success: false, reason}

-- =============================================================================
-- 1. sie_reserve_request — Atomic reservation with idempotency
-- =============================================================================
-- Atomically determines the correct action for a given request:
--   - New request: INSERT as RESERVED with lease → NEW_LEASE
--   - Same fingerprint + ANALYZED: return cached result → ANALYZED_RESULT
--   - Same fingerprint + COMMITTED: return committed signal → COMMITTED_RESULT
--   - RESERVED with active lease: report in-progress → IN_PROGRESS
--   - Different fingerprint: report conflict → FINGERPRINT_CONFLICT
--   - FAILED_RETRYABLE or expired lease: reacquire → RETRYABLE_LEASE

CREATE OR REPLACE FUNCTION sie_reserve_request(
    p_conversation_id UUID,
    p_request_id TEXT,
    p_idempotency_key TEXT,
    p_payload_fingerprint_hash TEXT,
    p_lease_owner TEXT,
    p_lease_duration_ms INTEGER DEFAULT 30000
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing RECORD;
    v_lease_expires TIMESTAMPTZ;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- Attempt to lock an existing row for this conversation + idempotency key.
    SELECT *
      INTO v_existing
      FROM sie_commit_requests
     WHERE conversation_id = p_conversation_id
       AND idempotency_key = p_idempotency_key
       FOR UPDATE;

    IF NOT FOUND THEN
        -- No existing request: create a new reservation.
        v_lease_expires := v_now + (p_lease_duration_ms || ' milliseconds')::INTERVAL;

        INSERT INTO sie_commit_requests (
            conversation_id,
            request_id,
            idempotency_key,
            payload_fingerprint,
            payload_fingerprint_hash,
            base_graph_version,
            status,
            lease_owner,
            lease_expires_at,
            reserved_at,
            created_at
        ) VALUES (
            p_conversation_id,
            p_request_id,
            p_idempotency_key,
            p_payload_fingerprint_hash,
            p_payload_fingerprint_hash,
            0,
            'RESERVED',
            p_lease_owner,
            v_lease_expires,
            v_now,
            v_now
        );

        RETURN jsonb_build_object(
            'outcome', 'NEW_LEASE',
            'request_id', p_request_id,
            'lease_expires_at', v_lease_expires
        );
    END IF;

    -- Row exists. Check fingerprint match first.
    IF v_existing.payload_fingerprint_hash IS DISTINCT FROM p_payload_fingerprint_hash THEN
        -- Different payload fingerprint → conflict.
        RETURN jsonb_build_object(
            'outcome', 'FINGERPRINT_CONFLICT'
        );
    END IF;

    -- Same fingerprint. Branch on current status.
    CASE v_existing.status
        WHEN 'ANALYZED' THEN
            -- Result already computed and cached; return it.
            RETURN jsonb_build_object(
                'outcome', 'ANALYZED_RESULT',
                'analyzed_result', v_existing.analyzed_result
            );

        WHEN 'COMMITTED' THEN
            -- Already fully committed.
            RETURN jsonb_build_object(
                'outcome', 'COMMITTED_RESULT'
            );

        WHEN 'RESERVED' THEN
            -- Check whether the existing lease has expired.
            IF v_existing.lease_expires_at > v_now THEN
                -- Lease still active; another worker holds it.
                RETURN jsonb_build_object(
                    'outcome', 'IN_PROGRESS',
                    'lease_expires_at', v_existing.lease_expires_at
                );
            ELSE
                -- Lease expired: crashed worker. Reacquire the lease.
                v_lease_expires := v_now + (p_lease_duration_ms || ' milliseconds')::INTERVAL;

                UPDATE sie_commit_requests
                   SET lease_owner = p_lease_owner,
                       lease_expires_at = v_lease_expires,
                       reserved_at = v_now,
                       transition_metadata = jsonb_build_object(
                           'reacquired_from', v_existing.lease_owner,
                           'reacquired_at', v_now,
                           'previous_reserved_at', v_existing.reserved_at
                       )
                 WHERE conversation_id = p_conversation_id
                   AND idempotency_key = p_idempotency_key;

                RETURN jsonb_build_object(
                    'outcome', 'RETRYABLE_LEASE',
                    'request_id', v_existing.request_id,
                    'lease_expires_at', v_lease_expires
                );
            END IF;

        WHEN 'FAILED_RETRYABLE' THEN
            -- Previous attempt failed transiently. Reacquire.
            v_lease_expires := v_now + (p_lease_duration_ms || ' milliseconds')::INTERVAL;

            UPDATE sie_commit_requests
               SET status = 'RESERVED',
                   lease_owner = p_lease_owner,
                   lease_expires_at = v_lease_expires,
                   reserved_at = v_now,
                   transition_metadata = jsonb_build_object(
                       'retried_from', 'FAILED_RETRYABLE',
                       'retried_at', v_now,
                       'previous_failure', v_existing.transition_metadata
                   )
             WHERE conversation_id = p_conversation_id
               AND idempotency_key = p_idempotency_key;

            RETURN jsonb_build_object(
                'outcome', 'RETRYABLE_LEASE',
                'request_id', v_existing.request_id,
                'lease_expires_at', v_lease_expires
            );

        WHEN 'SUPERSEDED' THEN
            -- Superseded requests should not be re-reserved; treat as conflict.
            RETURN jsonb_build_object(
                'outcome', 'FINGERPRINT_CONFLICT'
            );

        WHEN 'REJECTED' THEN
            -- Legacy rejected requests cannot be re-reserved.
            RETURN jsonb_build_object(
                'outcome', 'FINGERPRINT_CONFLICT'
            );

        WHEN 'PENDING' THEN
            -- Legacy PENDING row with same fingerprint: take ownership via lease.
            v_lease_expires := v_now + (p_lease_duration_ms || ' milliseconds')::INTERVAL;

            UPDATE sie_commit_requests
               SET status = 'RESERVED',
                   lease_owner = p_lease_owner,
                   lease_expires_at = v_lease_expires,
                   reserved_at = v_now,
                   payload_fingerprint_hash = p_payload_fingerprint_hash
             WHERE conversation_id = p_conversation_id
               AND idempotency_key = p_idempotency_key;

            RETURN jsonb_build_object(
                'outcome', 'RETRYABLE_LEASE',
                'request_id', v_existing.request_id,
                'lease_expires_at', v_lease_expires
            );

        ELSE
            -- Unknown/unexpected status.
            RETURN jsonb_build_object(
                'outcome', 'FINGERPRINT_CONFLICT'
            );
    END CASE;
END;
$$;


-- =============================================================================
-- 2. sie_renew_lease — Extend an active lease
-- =============================================================================
-- Only succeeds if the caller is the current lease_owner and the request is
-- still in RESERVED status. Prevents unauthorized lease extension.

CREATE OR REPLACE FUNCTION sie_renew_lease(
    p_request_id TEXT,
    p_lease_owner TEXT,
    p_lease_duration_ms INTEGER DEFAULT 30000
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing RECORD;
    v_lease_expires TIMESTAMPTZ;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- Lock the row for the given request_id.
    SELECT *
      INTO v_existing
      FROM sie_commit_requests
     WHERE request_id = p_request_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'request_not_found'
        );
    END IF;

    -- Only RESERVED requests may have their lease renewed.
    IF v_existing.status <> 'RESERVED' THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'invalid_status',
            'current_status', v_existing.status
        );
    END IF;

    -- Only the current lease owner may renew.
    IF v_existing.lease_owner IS DISTINCT FROM p_lease_owner THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'not_lease_owner',
            'current_owner', v_existing.lease_owner
        );
    END IF;

    -- Check that the lease has not already expired (optional guard).
    IF v_existing.lease_expires_at <= v_now THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'lease_expired',
            'expired_at', v_existing.lease_expires_at
        );
    END IF;

    -- Extend the lease.
    v_lease_expires := v_now + (p_lease_duration_ms || ' milliseconds')::INTERVAL;

    UPDATE sie_commit_requests
       SET lease_expires_at = v_lease_expires
     WHERE request_id = p_request_id;

    RETURN jsonb_build_object(
        'success', true,
        'lease_expires_at', v_lease_expires
    );
END;
$$;

-- =============================================================================
-- 3. sie_record_analyzed_result — Persist validated Python semantic result
-- =============================================================================
-- Transitions from RESERVED → ANALYZED. Only the lease owner may record.
-- The analyzed result is persisted before graph commit so that response-loss
-- recovery does not rerun nondeterministic Python analysis.

CREATE OR REPLACE FUNCTION sie_record_analyzed_result(
    p_request_id TEXT,
    p_lease_owner TEXT,
    p_analyzed_result JSONB,
    p_graph_version_analyzed INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing RECORD;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- Lock the row.
    SELECT *
      INTO v_existing
      FROM sie_commit_requests
     WHERE request_id = p_request_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'request_not_found'
        );
    END IF;

    -- Must be in RESERVED status.
    IF v_existing.status <> 'RESERVED' THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'invalid_status',
            'current_status', v_existing.status
        );
    END IF;

    -- Only the lease owner may record.
    IF v_existing.lease_owner IS DISTINCT FROM p_lease_owner THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'not_lease_owner',
            'current_owner', v_existing.lease_owner
        );
    END IF;

    -- Verify lease has not expired (guard against stale workers).
    IF v_existing.lease_expires_at <= v_now THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'lease_expired',
            'expired_at', v_existing.lease_expires_at
        );
    END IF;

    -- Transition to ANALYZED: store result, graph version, and timestamp.
    UPDATE sie_commit_requests
       SET status = 'ANALYZED',
           analyzed_result = p_analyzed_result,
           graph_version_analyzed = p_graph_version_analyzed,
           analyzed_at = v_now
     WHERE request_id = p_request_id;

    RETURN jsonb_build_object(
        'success', true
    );
END;
$$;

-- =============================================================================
-- 4. sie_mark_failed_retryable — Mark a request as transiently failed
-- =============================================================================
-- Callable from RESERVED or ANALYZED by the lease owner. Transitions to
-- FAILED_RETRYABLE, records failure reason, and clears the lease so another
-- worker can reacquire. Ensures crashed requests do not remain permanently
-- in progress.

CREATE OR REPLACE FUNCTION sie_mark_failed_retryable(
    p_request_id TEXT,
    p_lease_owner TEXT,
    p_failure_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing RECORD;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- Lock the row.
    SELECT *
      INTO v_existing
      FROM sie_commit_requests
     WHERE request_id = p_request_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'request_not_found'
        );
    END IF;

    -- Must be RESERVED or ANALYZED.
    IF v_existing.status NOT IN ('RESERVED', 'ANALYZED') THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'invalid_status',
            'current_status', v_existing.status
        );
    END IF;

    -- Only the lease owner may mark failure.
    IF v_existing.lease_owner IS DISTINCT FROM p_lease_owner THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'not_lease_owner',
            'current_owner', v_existing.lease_owner
        );
    END IF;

    -- Transition to FAILED_RETRYABLE: clear lease, record failure.
    UPDATE sie_commit_requests
       SET status = 'FAILED_RETRYABLE',
           lease_owner = NULL,
           lease_expires_at = NULL,
           failed_at = v_now,
           transition_metadata = jsonb_build_object(
               'failure_reason', p_failure_reason,
               'failed_from_status', v_existing.status,
               'failed_at', v_now,
               'failed_by', p_lease_owner
           )
     WHERE request_id = p_request_id;

    RETURN jsonb_build_object(
        'success', true
    );
END;
$$;

-- =============================================================================
-- 5. sie_supersede_request — Version-conflict supersession with successor linkage
-- =============================================================================
-- Callable from RESERVED or ANALYZED by the lease owner. Marks the request
-- SUPERSEDED, records the successor request/key, and clears the lease.
-- Used when a version conflict is detected: the stale request is superseded
-- and a new reservation is created by the caller for the updated version.

CREATE OR REPLACE FUNCTION sie_supersede_request(
    p_request_id TEXT,
    p_lease_owner TEXT,
    p_successor_request_id TEXT,
    p_successor_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing RECORD;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- Lock the row.
    SELECT *
      INTO v_existing
      FROM sie_commit_requests
     WHERE request_id = p_request_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'request_not_found'
        );
    END IF;

    -- Must be RESERVED or ANALYZED.
    IF v_existing.status NOT IN ('RESERVED', 'ANALYZED') THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'invalid_status',
            'current_status', v_existing.status
        );
    END IF;

    -- Only the lease owner may supersede.
    IF v_existing.lease_owner IS DISTINCT FROM p_lease_owner THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'not_lease_owner',
            'current_owner', v_existing.lease_owner
        );
    END IF;

    -- Transition to SUPERSEDED: link successor, clear lease.
    UPDATE sie_commit_requests
       SET status = 'SUPERSEDED',
           successor_request_id = p_successor_request_id,
           successor_idempotency_key = p_successor_idempotency_key,
           lease_owner = NULL,
           lease_expires_at = NULL,
           superseded_at = v_now,
           transition_metadata = jsonb_build_object(
               'superseded_from_status', v_existing.status,
               'superseded_at', v_now,
               'superseded_by', p_lease_owner,
               'successor_request_id', p_successor_request_id,
               'successor_idempotency_key', p_successor_idempotency_key
           )
     WHERE request_id = p_request_id;

    RETURN jsonb_build_object(
        'success', true
    );
END;
$$;

-- =============================================================================
-- 6. Permissions
-- =============================================================================
-- Grant execution to the service role used by the TypeScript orchestrator.
-- These RPCs are the only authorized way to mutate request state; direct table
-- updates are blocked by append-only enforcement (added in migration 005/006).

DO $$
BEGIN
    -- Grant to service_role (Supabase convention)
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION sie_reserve_request(UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
        GRANT EXECUTE ON FUNCTION sie_renew_lease(TEXT, TEXT, INTEGER) TO service_role;
        GRANT EXECUTE ON FUNCTION sie_record_analyzed_result(TEXT, TEXT, JSONB, INTEGER) TO service_role;
        GRANT EXECUTE ON FUNCTION sie_mark_failed_retryable(TEXT, TEXT, TEXT) TO service_role;
        GRANT EXECUTE ON FUNCTION sie_supersede_request(TEXT, TEXT, TEXT, TEXT) TO service_role;
    END IF;

    -- Revoke from public to enforce narrow access.
    REVOKE EXECUTE ON FUNCTION sie_reserve_request(UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM public;
    REVOKE EXECUTE ON FUNCTION sie_renew_lease(TEXT, TEXT, INTEGER) FROM public;
    REVOKE EXECUTE ON FUNCTION sie_record_analyzed_result(TEXT, TEXT, JSONB, INTEGER) FROM public;
    REVOKE EXECUTE ON FUNCTION sie_mark_failed_retryable(TEXT, TEXT, TEXT) FROM public;
    REVOKE EXECUTE ON FUNCTION sie_supersede_request(TEXT, TEXT, TEXT, TEXT) FROM public;
END $$;

-- =============================================================================
-- 7. Summary
-- =============================================================================
-- This migration provides the full set of atomic RPCs for the request state
-- machine. Together with migration 012's schema changes, they implement:
--
-- 1. Atomic reservation with idempotent outcome detection.
-- 2. Lease-based ownership ensuring only one worker processes at a time.
-- 3. Pre-commit result caching (ANALYZED state) so response-loss recovery
--    returns the same Python result without rerunning nondeterministic analysis.
-- 4. Lease renewal for long-running operations.
-- 5. Explicit failure marking that clears leases for retry by other workers.
-- 6. Version-conflict supersession with full successor linkage.
-- 7. Expired-lease recovery: crashed workers' requests become available after
--    lease expiry; they cannot remain permanently in-progress.
--
-- All functions use SELECT ... FOR UPDATE row locking to prevent race conditions
-- and return JSONB for uniform handling by the TypeScript orchestrator.
