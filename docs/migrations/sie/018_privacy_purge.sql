-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 018 — Privacy Purge / Redaction RPC
--
-- Implements controlled privacy purge/redaction for identity-resolution
-- tables. This is an authorized exception to ordinary audit immutability,
-- consistent with system privacy/deletion requirements.
--
-- Components:
--   1. sie_privacy_suppressions — Records which entities have been suppressed
--      so that future context snapshots continue excluding them.
--   2. sie_purge_identity_data() — SECURITY DEFINER RPC that performs the
--      purge operation, bypassing append-only triggers via the session
--      variable mechanism established in migration 017.
--
-- Security model:
--   - The purge RPC is SECURITY DEFINER (runs as function owner).
--   - Only service_role can invoke it (REVOKE from authenticated/anon).
--   - It sets `SET LOCAL sie.allow_mutation = 'true'` to bypass the
--     append-only triggers from migration 017.
--   - The session variable is transaction-scoped and auto-resets.
--
-- Privacy guarantees:
--   - Reasoning, evidence snapshots, candidates, LLM diagnostics, retrieval
--     records, and pending memberships containing suppressed content are
--     removed or redacted.
--   - Only a minimal non-content-bearing audit event is recorded.
--   - Future context snapshots (identity-context loader, RPC 014) exclude
--     suppressed concerns by checking sie_privacy_suppressions.
--
-- Depends on:
--   009 (sie_identity_resolution_records)
--   010 (sie_retrieval_attempts)
--   011 (sie_pending_identity_details, sie_pending_identity_propositions)
--   017 (append-only triggers with sie.allow_mutation bypass)
--   005 (sie_audit_history)
--
-- Idempotent: uses IF NOT EXISTS and CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1: PRIVACY SUPPRESSIONS TABLE
-- ═══════════════════════════════════════════════════════════════════════════
-- Tracks which entities have been privacy-suppressed so the identity-context
-- loader (migration 014) and any future context-building queries can exclude
-- them without needing to re-check deleted content.

CREATE TABLE IF NOT EXISTS sie_privacy_suppressions (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,

    -- Conversation scope.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- What kind of entity was suppressed (e.g., 'concern', 'proposition').
    entity_type TEXT NOT NULL,

    -- The specific entity ID that was suppressed.
    entity_id TEXT NOT NULL,

    -- Whether the suppression is currently active.
    suppressed BOOLEAN NOT NULL DEFAULT TRUE,

    -- Non-content reason for the purge (e.g., 'user_deletion_request',
    -- 'privacy_regulation', 'content_policy').
    purge_reason TEXT,

    -- When the purge was performed.
    purged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- System identifier that initiated the purge (e.g., 'privacy_service',
    -- 'admin_tool', 'automated_policy').
    purged_by TEXT,

    -- Each entity can only be suppressed once per conversation.
    CONSTRAINT uq_suppression_conversation_entity
        UNIQUE(conversation_id, entity_type, entity_id)
);

-- Index for context-loader exclusion queries.
CREATE INDEX IF NOT EXISTS idx_suppressions_conversation_active
    ON sie_privacy_suppressions(conversation_id)
    WHERE suppressed = TRUE;

-- Index for entity-type-scoped lookups.
CREATE INDEX IF NOT EXISTS idx_suppressions_entity_type
    ON sie_privacy_suppressions(entity_type, entity_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2: PRIVACY PURGE RPC
-- ═══════════════════════════════════════════════════════════════════════════
-- Performs controlled deletion/redaction of identity-resolution data
-- associated with a suppressed concern. This function:
--
--   1. Sets sie.allow_mutation = 'true' to bypass append-only triggers.
--   2. Deletes retrieval attempts referencing the concern.
--   3. Redacts resolution records (keeps minimal audit skeleton).
--   4. Deletes pending identity details referencing the concern.
--   5. Deletes pending identity propositions for affected decisions.
--   6. Records the suppression in sie_privacy_suppressions.
--   7. Records a minimal non-content-bearing audit event.
--   8. Returns count of affected rows.
--
-- The function is idempotent: re-running for an already-suppressed concern
-- returns 0 affected rows without error.

CREATE OR REPLACE FUNCTION sie_purge_identity_data(
    p_conversation_id UUID,
    p_concern_id TEXT,
    p_purge_reason TEXT DEFAULT NULL,
    p_purged_by TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_retrieval_deleted INTEGER := 0;
    v_records_redacted INTEGER := 0;
    v_details_deleted INTEGER := 0;
    v_propositions_deleted INTEGER := 0;
    v_already_suppressed BOOLEAN;
    v_affected_record_ids TEXT[];
    v_affected_decision_ids TEXT[];
BEGIN
    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 0: Check if already suppressed (idempotency)
    -- ─────────────────────────────────────────────────────────────────────
    SELECT EXISTS(
        SELECT 1 FROM sie_privacy_suppressions
        WHERE conversation_id = p_conversation_id
          AND entity_type = 'concern'
          AND entity_id = p_concern_id
          AND suppressed = TRUE
    ) INTO v_already_suppressed;

    IF v_already_suppressed THEN
        RETURN jsonb_build_object(
            'status', 'already_suppressed',
            'retrieval_attempts_deleted', 0,
            'records_redacted', 0,
            'pending_details_deleted', 0,
            'pending_propositions_deleted', 0,
            'total_affected', 0
        );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 1: Authorize mutation bypass for append-only triggers
    -- ─────────────────────────────────────────────────────────────────────
    -- This is transaction-scoped (SET LOCAL) and auto-resets on commit/rollback.
    PERFORM set_config('sie.allow_mutation', 'true', true);

    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 2: Identify affected resolution records
    -- ─────────────────────────────────────────────────────────────────────
    -- Records that reference the concern as matched or proposed.
    SELECT array_agg(record_id) INTO v_affected_record_ids
    FROM sie_identity_resolution_records
    WHERE conversation_id = p_conversation_id
      AND (matched_concern_id = p_concern_id OR proposed_concern_id = p_concern_id);

    -- Default to empty array if no records found.
    IF v_affected_record_ids IS NULL THEN
        v_affected_record_ids := '{}';
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 3: Delete retrieval attempts for affected records
    -- ─────────────────────────────────────────────────────────────────────
    -- Retrieval attempts are linked to resolution records. If the resolution
    -- record references the suppressed concern, all its retrieval attempts
    -- contain potentially sensitive diagnostic data and must be removed.
    DELETE FROM sie_retrieval_attempts
    WHERE conversation_id = p_conversation_id
      AND record_id = ANY(v_affected_record_ids);

    GET DIAGNOSTICS v_retrieval_deleted = ROW_COUNT;

    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 4: Redact resolution records (keep minimal audit skeleton)
    -- ─────────────────────────────────────────────────────────────────────
    -- We preserve the record_id, request_id, conversation_id, packet_id,
    -- graph_version_analyzed, outcome, action, and timestamps for minimal
    -- audit traceability. All content-bearing fields are redacted.
    UPDATE sie_identity_resolution_records
    SET
        reasoning = '[REDACTED: privacy purge]',
        candidates_considered = '[]'::jsonb,
        irs_signals = '[]'::jsonb,
        retrieval_attempts = '[]'::jsonb,
        sufficiency_record = NULL,
        evidence_references = '[]'::jsonb,
        matched_concern_id = NULL,
        proposed_concern_id = NULL,
        -- Reset to pending/deferred state to reflect purge
        outcome = 'DEFER',
        action = 'NONE',
        identity_stage_status = 'FAILED',
        identity_confidence = NULL,
        sufficiency_stage_status = 'NOT_RUN',
        sufficiency_confidence = NULL
    WHERE conversation_id = p_conversation_id
      AND record_id = ANY(v_affected_record_ids);

    GET DIAGNOSTICS v_records_redacted = ROW_COUNT;

    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 5: Delete pending identity details referencing the concern
    -- ─────────────────────────────────────────────────────────────────────
    -- Identify pending decisions whose source resolution record references
    -- the suppressed concern, or whose packet is associated with the concern.
    SELECT array_agg(d.decision_id) INTO v_affected_decision_ids
    FROM sie_pending_identity_details d
    WHERE d.conversation_id = p_conversation_id
      AND d.source_resolution_record_id = ANY(v_affected_record_ids);

    IF v_affected_decision_ids IS NULL THEN
        v_affected_decision_ids := '{}';
    END IF;

    -- Delete pending propositions for affected decisions first (FK dependency).
    DELETE FROM sie_pending_identity_propositions
    WHERE conversation_id = p_conversation_id
      AND decision_id = ANY(v_affected_decision_ids);

    GET DIAGNOSTICS v_propositions_deleted = ROW_COUNT;

    -- Delete the pending identity details themselves.
    DELETE FROM sie_pending_identity_details
    WHERE conversation_id = p_conversation_id
      AND decision_id = ANY(v_affected_decision_ids);

    GET DIAGNOSTICS v_details_deleted = ROW_COUNT;

    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 6: Record the suppression
    -- ─────────────────────────────────────────────────────────────────────
    INSERT INTO sie_privacy_suppressions (
        conversation_id, entity_type, entity_id,
        suppressed, purge_reason, purged_by
    ) VALUES (
        p_conversation_id, 'concern', p_concern_id,
        TRUE, p_purge_reason, p_purged_by
    )
    ON CONFLICT (conversation_id, entity_type, entity_id)
    DO UPDATE SET
        suppressed = TRUE,
        purge_reason = COALESCE(EXCLUDED.purge_reason, sie_privacy_suppressions.purge_reason),
        purged_by = COALESCE(EXCLUDED.purged_by, sie_privacy_suppressions.purged_by),
        purged_at = NOW();

    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 7: Record minimal non-content-bearing audit event
    -- ─────────────────────────────────────────────────────────────────────
    -- The audit event contains no content, reasoning, evidence, or LLM
    -- diagnostics — only the fact that a privacy purge occurred, the entity
    -- affected, and minimal operational metadata.
    INSERT INTO sie_audit_history (
        conversation_id,
        entity_kind,
        entity_id,
        action,
        before_state,
        after_state,
        metadata
    ) VALUES (
        p_conversation_id,
        'concern',
        p_concern_id,
        'privacy_purge',
        NULL,  -- No content-bearing before_state
        jsonb_build_object('suppressed', TRUE),
        jsonb_build_object(
            'purge_reason', p_purge_reason,
            'purged_by', p_purged_by,
            'retrieval_attempts_deleted', v_retrieval_deleted,
            'records_redacted', v_records_redacted,
            'pending_details_deleted', v_details_deleted,
            'pending_propositions_deleted', v_propositions_deleted
        )
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- STEP 8: Return summary
    -- ─────────────────────────────────────────────────────────────────────
    RETURN jsonb_build_object(
        'status', 'purged',
        'retrieval_attempts_deleted', v_retrieval_deleted,
        'records_redacted', v_records_redacted,
        'pending_details_deleted', v_details_deleted,
        'pending_propositions_deleted', v_propositions_deleted,
        'total_affected', v_retrieval_deleted + v_records_redacted +
                          v_details_deleted + v_propositions_deleted
    );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3: PRIVILEGE RESTRICTIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- The purge RPC is only callable by service_role. Authenticated and anon
-- roles cannot invoke it.

REVOKE ALL ON FUNCTION sie_purge_identity_data(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION sie_purge_identity_data(UUID, TEXT, TEXT, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION sie_purge_identity_data(UUID, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION sie_purge_identity_data(UUID, TEXT, TEXT, TEXT) TO service_role;

-- Grant service_role access to the suppressions table (needed by context loader).
GRANT SELECT, INSERT, UPDATE ON sie_privacy_suppressions TO service_role;
GRANT SELECT ON sie_privacy_suppressions TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4: RLS ON PRIVACY SUPPRESSIONS
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sie_privacy_suppressions ENABLE ROW LEVEL SECURITY;

-- Authenticated users can see suppressions for their conversations (read-only).
DROP POLICY IF EXISTS sie_privacy_suppressions_select ON sie_privacy_suppressions;
CREATE POLICY sie_privacy_suppressions_select ON sie_privacy_suppressions
    FOR SELECT
    USING (sie_user_owns_conversation(conversation_id));

-- Block all direct mutations from authenticated/anon.
DROP POLICY IF EXISTS sie_privacy_suppressions_deny_insert ON sie_privacy_suppressions;
CREATE POLICY sie_privacy_suppressions_deny_insert ON sie_privacy_suppressions
    FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS sie_privacy_suppressions_deny_update ON sie_privacy_suppressions;
CREATE POLICY sie_privacy_suppressions_deny_update ON sie_privacy_suppressions
    FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS sie_privacy_suppressions_deny_delete ON sie_privacy_suppressions;
CREATE POLICY sie_privacy_suppressions_deny_delete ON sie_privacy_suppressions
    FOR DELETE
    USING (false);


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5: DOCUMENTATION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Privacy purge design summary:
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ Step │ Table                               │ Action                     │
-- ├──────┼─────────────────────────────────────┼────────────────────────────┤
-- │  1   │ (session variable)                  │ SET LOCAL allow_mutation    │
-- │  2   │ sie_identity_resolution_records     │ Identify affected records  │
-- │  3   │ sie_retrieval_attempts              │ DELETE (full removal)       │
-- │  4   │ sie_identity_resolution_records     │ UPDATE (redact to skeleton)│
-- │  5   │ sie_pending_identity_propositions   │ DELETE (full removal)      │
-- │  5   │ sie_pending_identity_details        │ DELETE (full removal)      │
-- │  6   │ sie_privacy_suppressions            │ INSERT/UPSERT              │
-- │  7   │ sie_audit_history                   │ INSERT (non-content event) │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- Future context loading:
--   The identity-context loader (migration 014) must check
--   sie_privacy_suppressions and exclude any concern whose entity_id
--   appears with suppressed=TRUE. This ensures:
--     - Python never receives suppressed concern data.
--     - Suppressed concerns cannot be returned as identity candidates.
--     - Retrieval channels cannot surface suppressed concerns.
--
-- Redaction approach for resolution records:
--   Rather than DELETE (which would lose the audit skeleton entirely),
--   we UPDATE the record to:
--     - Clear all content-bearing JSONB fields (candidates, IRS signals,
--       retrieval attempts, evidence, sufficiency record).
--     - Set reasoning to '[REDACTED: privacy purge]'.
--     - Clear matched/proposed concern IDs.
--     - Reset outcome to DEFER/NONE with FAILED identity stage.
--   This preserves the fact that a resolution occurred (record_id,
--   request_id, packet_id, conversation_id, timestamps) while removing
--   all sensitive content.
--
-- Idempotency:
--   Re-invoking the function for an already-suppressed concern returns
--   immediately with status='already_suppressed' and 0 affected rows.
--   The ON CONFLICT clause on sie_privacy_suppressions ensures the
--   suppression record is updated rather than duplicated.
--
-- Rollback:
--   Privacy purge is intentionally NOT reversible through normal rollback.
--   The deleted content cannot be recovered from this migration alone.
--   This is by design — privacy deletion is permanent.
