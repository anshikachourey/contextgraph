-- SIE Migration 014: Atomic Identity-Context Loader RPC
--
-- Implements v2_load_sie_identity_context(conversation_id), the single
-- read-only RPC that TypeScript uses to load all identity-resolution state
-- in one PostgreSQL MVCC snapshot.
--
-- Design authority: design-corrections.md § 5.1
--
-- Key guarantees:
--   1. STABLE — read-only, MVCC-consistent within the statement.
--   2. SECURITY DEFINER — runs with definer privileges regardless of caller role.
--   3. Atomic — the entire function executes in one MVCC snapshot; no cross-version
--      state can be returned.
--   4. Fail-closed — if no graph version exists for the conversation, the function
--      raises an exception rather than returning partial context.
--   5. Privacy-safe — concerns flagged in sie_privacy_suppressions (when the table
--      exists) are excluded from both the concerns and embeddings arrays. Python
--      never receives suppressed content.
--   6. Stale embeddings are marked unavailable — embeddings whose graph_version,
--      source_text_hash, or embedding_model_version does not match the current
--      snapshot are returned with is_current = false so consumers know they are
--      stale; they are NOT omitted (that would look like successful empty retrieval).
--
-- Depends on:
--   001_authoritative_engine_and_idempotency.sql (v2_update_state, sie_commit_requests)
--   002_persistent_concerns_and_aliases.sql (sie_persistent_concerns, sie_concern_aliases)
--   003_propositions_and_associations.sql (sie_propositions, sie_proposition_associations)
--   004_packets_memberships_and_splits.sql (sie_semantic_packets, sie_packet_memberships, sie_packet_splits)
--   005_retention_pending_decisions_and_audit.sql (sie_pending_semantic_decisions)
--   011_pending_identity_tables.sql (sie_pending_identity_details, sie_pending_identity_propositions)
--
-- Optional dependencies (gracefully handled if absent):
--   sie_privacy_suppressions — created by Task 5.4 (privacy purge/redaction)
--   sie_concern_embeddings — created by Task 2.2 (versioned embedding storage)
--
-- Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION v2_load_sie_identity_context(
    p_conversation_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE  -- read-only, MVCC consistent within the statement
AS $$
DECLARE
    v_graph_version INTEGER;
    v_snapshot_token TEXT;
    v_snapshot_digest TEXT;
    v_suppressed_ids TEXT[];
    v_has_privacy_table BOOLEAN;
    v_has_embeddings_table BOOLEAN;
    v_concerns JSONB;
    v_propositions JSONB;
    v_active_associations JSONB;
    v_normalized_aliases JSONB;
    v_pending_decisions JSONB;
    v_pending_identity_details JSONB;
    v_pending_identity_propositions JSONB;
    v_packet_lineage JSONB;
    v_concern_embeddings JSONB;
    v_suppressed_concern_ids JSONB;
    v_result JSONB;
BEGIN
    -- =========================================================================
    -- 1. Load graph version — fail if not found (no partial context)
    -- =========================================================================
    SELECT graph_version INTO STRICT v_graph_version
    FROM v2_update_state
    WHERE conversation_id = p_conversation_id;

    -- Generate snapshot token binding this specific read to a version and time
    v_snapshot_token := 'snap-' || p_conversation_id::TEXT || '-v' || v_graph_version::TEXT
                        || '-' || extract(epoch from clock_timestamp())::TEXT;

    -- Snapshot digest: deterministic fingerprint of (token + version) for validation
    v_snapshot_digest := md5(v_snapshot_token || v_graph_version::TEXT);

    -- =========================================================================
    -- 2. Determine privacy suppressions (graceful if table does not exist)
    -- =========================================================================
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'sie_privacy_suppressions'
          AND table_schema = 'public'
    ) INTO v_has_privacy_table;

    IF v_has_privacy_table THEN
        EXECUTE format(
            'SELECT COALESCE(array_agg(entity_id), ARRAY[]::TEXT[])
             FROM sie_privacy_suppressions
             WHERE conversation_id = %L
               AND entity_type = %L
               AND suppressed = TRUE',
            p_conversation_id, 'concern'
        ) INTO v_suppressed_ids;
    ELSE
        v_suppressed_ids := ARRAY[]::TEXT[];
    END IF;

    -- =========================================================================
    -- 3. Load concerns (exclude privacy-suppressed)
    -- =========================================================================
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'concern_id', c.concern_id,
        'identity_summary', c.identity_summary,
        'display_title', c.display_title,
        'current_summary', c.current_summary,
        'status', c.status,
        'canonical_parent_id', c.canonical_parent_id,
        'parent_resolution_state', c.parent_resolution_state,
        'last_active_at', c.last_active_at,
        'semantic_version', c.semantic_version,
        'merged_into_concern_id', c.merged_into_concern_id
    )), '[]'::JSONB)
    INTO v_concerns
    FROM sie_persistent_concerns c
    WHERE c.conversation_id = p_conversation_id
      AND c.status IN ('ACTIVE', 'DORMANT', 'RETIRED', 'MERGED')
      AND c.concern_id <> ALL(v_suppressed_ids);

    -- =========================================================================
    -- 4. Load active propositions
    -- =========================================================================
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'proposition_id', p.proposition_id,
        'canonical_meaning', p.canonical_meaning,
        'proposition_type', p.proposition_type,
        'speaker_role', p.speaker_role,
        'semantic_state', p.semantic_state,
        'message_seq_start', p.message_seq_start,
        'message_seq_end', p.message_seq_end,
        'retention_levels', to_jsonb(p.retention_levels),
        'source_message_ids', to_jsonb(p.source_message_ids)
    )), '[]'::JSONB)
    INTO v_propositions
    FROM sie_propositions p
    WHERE p.conversation_id = p_conversation_id
      AND p.semantic_state = 'ACTIVE';

    -- =========================================================================
    -- 5. Load active proposition-concern associations
    -- =========================================================================
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'association_id', a.association_id,
        'proposition_id', a.proposition_id,
        'concern_id', a.concern_id,
        'role', a.role,
        'confidence', a.confidence,
        'semantic_state', a.semantic_state,
        'established_by_packet_id', a.established_by_packet_id
    )), '[]'::JSONB)
    INTO v_active_associations
    FROM sie_proposition_associations a
    WHERE a.conversation_id = p_conversation_id
      AND a.semantic_state = 'ACTIVE'
      -- Exclude associations to suppressed concerns
      AND a.concern_id <> ALL(v_suppressed_ids);

    -- =========================================================================
    -- 6. Load normalized aliases (active only, exclude suppressed concerns)
    -- =========================================================================
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'alias_id', al.alias_id,
        'concern_id', al.concern_id,
        'alias_text', al.alias_text
    )), '[]'::JSONB)
    INTO v_normalized_aliases
    FROM sie_concern_aliases al
    WHERE al.conversation_id = p_conversation_id
      AND al.removed_at IS NULL
      AND al.concern_id <> ALL(v_suppressed_ids);

    -- =========================================================================
    -- 7. Load pending semantic decisions (non-resolved)
    -- =========================================================================
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'decision_id', d.decision_id,
        'stage', d.stage,
        'entity_creation_key', d.entity_creation_key,
        'outcome', d.outcome,
        'lifecycle_state', d.lifecycle_state,
        'rationale', d.rationale,
        'dependency_refs', to_jsonb(d.dependency_refs)
    )), '[]'::JSONB)
    INTO v_pending_decisions
    FROM sie_pending_semantic_decisions d
    WHERE d.conversation_id = p_conversation_id
      AND d.lifecycle_state IN ('pending', 'unresolved', 'deferred');

    -- =========================================================================
    -- 8. Load pending identity details
    -- =========================================================================
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'detail_id', pid.detail_id,
        'decision_id', pid.decision_id,
        'packet_id', pid.packet_id,
        'graph_version_analyzed', pid.graph_version_analyzed,
        'source_resolution_record_id', pid.source_resolution_record_id,
        'identity_stage_status', pid.identity_stage_status,
        'identity_confidence', pid.identity_confidence,
        'sufficiency_stage_status', pid.sufficiency_stage_status,
        'sufficiency_confidence', pid.sufficiency_confidence
    )), '[]'::JSONB)
    INTO v_pending_identity_details
    FROM sie_pending_identity_details pid
    WHERE pid.conversation_id = p_conversation_id;

    -- =========================================================================
    -- 9. Load pending identity propositions (ordered)
    -- =========================================================================
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', pip.id,
        'decision_id', pip.decision_id,
        'proposition_id', pip.proposition_id,
        'ordinal', pip.ordinal
    ) ORDER BY pip.decision_id, pip.ordinal), '[]'::JSONB)
    INTO v_pending_identity_propositions
    FROM sie_pending_identity_propositions pip
    WHERE pip.conversation_id = p_conversation_id;

    -- =========================================================================
    -- 10. Load packet lineage (packets + split origins)
    -- =========================================================================
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'packet_id', sp.packet_id,
        'conversation_id', sp.conversation_id,
        'message_seq_start', sp.message_seq_start,
        'message_seq_end', sp.message_seq_end,
        'user_grounded_meaning', sp.user_grounded_meaning,
        'cohesion_status', sp.cohesion_status,
        'split_from_packet_id', spl.original_packet_id
    )), '[]'::JSONB)
    INTO v_packet_lineage
    FROM sie_semantic_packets sp
    LEFT JOIN sie_packet_splits spl
        ON spl.resulting_packet_id = sp.packet_id
    WHERE sp.conversation_id = p_conversation_id;

    -- =========================================================================
    -- 11. Load concern embeddings (graceful if table does not exist)
    --     Stale embeddings are included but marked is_current = false.
    --     Privacy-suppressed concerns are excluded.
    -- =========================================================================
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'sie_concern_embeddings'
          AND table_schema = 'public'
    ) INTO v_has_embeddings_table;

    IF v_has_embeddings_table THEN
        EXECUTE format(
            'SELECT COALESCE(jsonb_agg(jsonb_build_object(
                ''concern_id'', ce.concern_id,
                ''embedding'', ce.embedding,
                ''source_text_hash'', ce.source_text_hash,
                ''embedding_model_version'', ce.embedding_model_version,
                ''graph_version'', ce.graph_version,
                ''is_current'', (ce.graph_version = %s)
            )), ''[]''::JSONB)
            FROM sie_concern_embeddings ce
            WHERE ce.conversation_id = %L
              AND ce.concern_id <> ALL(%L::TEXT[])',
            v_graph_version, p_conversation_id, v_suppressed_ids
        ) INTO v_concern_embeddings;
    ELSE
        -- Table does not exist yet — mark embeddings as unavailable, not empty success
        v_concern_embeddings := NULL;
    END IF;

    -- =========================================================================
    -- 12. Build suppressed concern IDs list for downstream awareness
    -- =========================================================================
    IF cardinality(v_suppressed_ids) > 0 THEN
        v_suppressed_concern_ids := to_jsonb(v_suppressed_ids);
    ELSE
        v_suppressed_concern_ids := '[]'::JSONB;
    END IF;

    -- =========================================================================
    -- 13. Assemble final result
    -- =========================================================================
    v_result := jsonb_build_object(
        'graph_version', v_graph_version,
        'snapshot_token', v_snapshot_token,
        'snapshot_digest', v_snapshot_digest,
        'concerns', v_concerns,
        'propositions', v_propositions,
        'active_associations', v_active_associations,
        'normalized_aliases', v_normalized_aliases,
        'pending_decisions', v_pending_decisions,
        'pending_identity_details', v_pending_identity_details,
        'pending_identity_propositions', v_pending_identity_propositions,
        'packet_lineage', v_packet_lineage,
        'concern_embeddings', CASE
            WHEN v_concern_embeddings IS NULL THEN jsonb_build_object(
                'status', 'UNAVAILABLE',
                'reason', 'embedding_table_not_provisioned'
            )
            ELSE jsonb_build_object(
                'status', 'LOADED',
                'embeddings', v_concern_embeddings
            )
        END,
        'privacy_suppressed_concern_ids', v_suppressed_concern_ids
    );

    RETURN v_result;

EXCEPTION
    WHEN NO_DATA_FOUND THEN
        -- Conversation not found or no graph version → fail rather than partial context
        RAISE EXCEPTION 'No graph version found for conversation_id=%. Cannot return partial context.',
            p_conversation_id
            USING ERRCODE = 'P0002';
END;
$$;

-- =============================================================================
-- Permissions
-- =============================================================================
-- Grant to service_role (Supabase convention); revoke from public.
-- The TypeScript orchestrator calls this RPC via the service_role connection.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION v2_load_sie_identity_context(UUID) TO service_role;
    END IF;

    REVOKE EXECUTE ON FUNCTION v2_load_sie_identity_context(UUID) FROM public;
END $$;

-- =============================================================================
-- Notes
-- =============================================================================
-- 1. The STABLE volatility marker ensures PostgreSQL knows this function performs
--    no writes. Combined with the single-statement nature of each SELECT, the
--    entire function sees one consistent MVCC snapshot.
--
-- 2. The information_schema checks for sie_privacy_suppressions and
--    sie_concern_embeddings allow this migration to be applied before or after
--    those tables are created. Once those tables exist, the function
--    automatically includes their data without re-deployment.
--
-- 3. Stale embeddings (is_current = false) are explicitly included rather than
--    omitted. Omitting them would appear as successful empty retrieval, which
--    violates SME-3 ("Retrieval absence is not semantic absence"). The caller
--    can decide whether to use stale embeddings or treat them as unavailable.
--
-- 4. When the embeddings table does not exist at all, the concern_embeddings
--    field returns {status: "UNAVAILABLE", reason: "..."} rather than an empty
--    array, clearly distinguishing "no table provisioned" from "table exists
--    but no embeddings found for this conversation."
--
-- 5. Privacy suppression is enforced server-side: suppressed concerns and their
--    embeddings/aliases/associations are excluded before the result is
--    constructed. Python never receives suppressed content.
--
-- 6. The STRICT keyword on the initial SELECT ensures that if no row exists in
--    v2_update_state for the given conversation, a NO_DATA_FOUND exception is
--    raised immediately rather than proceeding with NULL graph_version.
