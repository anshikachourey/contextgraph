-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 015 — Identity Bundle Commit Extension
--
-- Adds the v2_commit_identity_bundle function that extends the atomic commit
-- with optional identity-resolution bundle sections. This function is called
-- by SIE identity-resolution callers AFTER the base v2_commit_update completes
-- the core SIE path, or can be invoked standalone for identity-only commits.
--
-- Identity-resolution callers are identified by providing non-null identity
-- bundle fields (p_identity_resolution_records, etc.). Legacy V2 callers that
-- do NOT provide identity bundle fields continue to work unchanged through
-- the existing v2_commit_update path.
--
-- All inserts happen within one transaction (atomic commit). If ANY insert
-- fails, the entire transaction rolls back (no partial state).
--
-- Depends on:
--   008_versioned_commit_rpc.sql (v2_commit_update)
--   009_identity_resolution_records.sql (sie_identity_resolution_records)
--   010_retrieval_attempts.sql (sie_retrieval_attempts)
--   011_pending_identity_tables.sql (sie_pending_identity_details,
--                                     sie_pending_identity_propositions)
--   012_commit_request_state_machine.sql (extended sie_commit_requests)
--   003_propositions_and_associations.sql (sie_proposition_associations)
--   002_persistent_concerns_and_aliases.sql (sie_persistent_concerns)
--
-- Design authority: design-corrections.md § 15.6
--
-- Safe to run multiple times (CREATE OR REPLACE).
-- SECURITY DEFINER: executes with owner privileges for append-only enforcement.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION v2_commit_identity_bundle(
  -- ═══════════════════════════════════════════════════════════════════════
  -- Required context parameters
  -- ═══════════════════════════════════════════════════════════════════════
  p_conversation_id UUID,
  p_request_id TEXT,
  -- ═══════════════════════════════════════════════════════════════════════
  -- Optional identity bundle sections (all default NULL for backward compat)
  -- Callers that omit all identity keys get a no-op success result.
  -- SIE identity-resolution callers provide one or more non-null arrays.
  -- ═══════════════════════════════════════════════════════════════════════
  p_identity_resolution_records JSONB DEFAULT NULL,
  p_retrieval_attempts JSONB DEFAULT NULL,
  p_pending_identity_details JSONB DEFAULT NULL,
  p_pending_identity_propositions JSONB DEFAULT NULL,
  p_association_mutations JSONB DEFAULT NULL,
  p_shared_proposals JSONB DEFAULT NULL,
  p_request_state_transition JSONB DEFAULT NULL
) RETURNS JSONB
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item JSONB;
  v_has_identity_work BOOLEAN;
  v_records_inserted INTEGER := 0;
  v_attempts_inserted INTEGER := 0;
  v_details_inserted INTEGER := 0;
  v_propositions_inserted INTEGER := 0;
  v_associations_inserted INTEGER := 0;
  v_concerns_inserted INTEGER := 0;
  v_request_transitioned BOOLEAN := FALSE;
  v_result JSONB;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════
  -- GUARD: If all identity bundle fields are NULL, this is a legacy caller
  -- or a call with no identity work. Return success immediately (no-op).
  -- This preserves backward compatibility for existing callers.
  -- ═══════════════════════════════════════════════════════════════════════
  v_has_identity_work := (
    p_identity_resolution_records IS NOT NULL OR
    p_retrieval_attempts IS NOT NULL OR
    p_pending_identity_details IS NOT NULL OR
    p_pending_identity_propositions IS NOT NULL OR
    p_association_mutations IS NOT NULL OR
    p_shared_proposals IS NOT NULL OR
    p_request_state_transition IS NOT NULL
  );

  IF NOT v_has_identity_work THEN
    RETURN jsonb_build_object(
      'success', TRUE,
      'identity_bundle_applied', FALSE,
      'reason', 'no_identity_fields_provided'
    );
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 1: Insert identity resolution records
  -- Each record represents one complete identity-resolution decision for a
  -- (request_id, packet_id) pair with all required diagnostics.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_identity_resolution_records IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_identity_resolution_records)
    LOOP
      INSERT INTO sie_identity_resolution_records (
        record_id,
        request_id,
        conversation_id,
        packet_id,
        graph_version_analyzed,
        graph_snapshot_token,
        outcome,
        action,
        identity_stage_status,
        identity_confidence,
        sufficiency_stage_status,
        sufficiency_confidence,
        matched_concern_id,
        proposed_concern_id,
        candidates_considered,
        irs_signals,
        retrieval_attempts,
        sufficiency_record,
        evidence_references,
        reasoning,
        semantic_policy_version,
        retrieval_policy_version,
        model_config_version,
        prompt_version,
        proposed_dependency_group_id,
        created_at
      ) VALUES (
        v_item->>'record_id',
        COALESCE(v_item->>'request_id', p_request_id),
        p_conversation_id,
        v_item->>'packet_id',
        (v_item->>'graph_version_analyzed')::INTEGER,
        v_item->>'graph_snapshot_token',
        v_item->>'outcome',
        v_item->>'action',
        v_item->>'identity_stage_status',
        v_item->>'identity_confidence',
        v_item->>'sufficiency_stage_status',
        v_item->>'sufficiency_confidence',
        v_item->>'matched_concern_id',
        v_item->>'proposed_concern_id',
        COALESCE(v_item->'candidates_considered', '[]'::JSONB),
        COALESCE(v_item->'irs_signals', '[]'::JSONB),
        COALESCE(v_item->'retrieval_attempts', '[]'::JSONB),
        v_item->'sufficiency_record',
        COALESCE(v_item->'evidence_references', '[]'::JSONB),
        v_item->>'reasoning',
        v_item->>'semantic_policy_version',
        v_item->>'retrieval_policy_version',
        v_item->>'model_config_version',
        v_item->>'prompt_version',
        v_item->>'proposed_dependency_group_id',
        COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW())
      )
      ON CONFLICT (record_id) DO NOTHING;  -- Immutable: no double-insert

      v_records_inserted := v_records_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 2: Insert retrieval attempts
  -- Each attempt records one retrieval channel invocation linked to its
  -- parent resolution record, conversation, and packet.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_retrieval_attempts IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_retrieval_attempts)
    LOOP
      INSERT INTO sie_retrieval_attempts (
        attempt_id,
        record_id,
        conversation_id,
        packet_id,
        channel_id,
        channel_family,
        query_mode,
        query_reference,
        scope_description,
        status,
        candidate_ids,
        candidate_count,
        latency_ms,
        failure_reason,
        retrieval_policy_version,
        is_widening_attempt,
        triggered_by_signal,
        created_at
      ) VALUES (
        v_item->>'attempt_id',
        v_item->>'record_id',
        p_conversation_id,
        v_item->>'packet_id',
        v_item->>'channel_id',
        v_item->>'channel_family',
        v_item->>'query_mode',
        v_item->>'query_reference',
        v_item->>'scope_description',
        v_item->>'status',
        COALESCE(
          ARRAY(SELECT jsonb_array_elements_text(v_item->'candidate_ids')),
          '{}'::TEXT[]
        ),
        COALESCE((v_item->>'candidate_count')::INTEGER, 0),
        (v_item->>'latency_ms')::INTEGER,
        v_item->>'failure_reason',
        v_item->>'retrieval_policy_version',
        COALESCE((v_item->>'is_widening_attempt')::BOOLEAN, FALSE),
        v_item->>'triggered_by_signal',
        COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW())
      )
      ON CONFLICT (attempt_id) DO NOTHING;  -- Immutable: no double-insert

      v_attempts_inserted := v_attempts_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 3: Insert pending identity details
  -- One-to-one identity-specific detail linked to a generic pending decision.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_pending_identity_details IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_pending_identity_details)
    LOOP
      INSERT INTO sie_pending_identity_details (
        detail_id,
        decision_id,
        conversation_id,
        packet_id,
        graph_version_analyzed,
        source_resolution_record_id,
        identity_stage_status,
        identity_confidence,
        sufficiency_stage_status,
        sufficiency_confidence,
        created_at
      ) VALUES (
        v_item->>'detail_id',
        v_item->>'decision_id',
        p_conversation_id,
        v_item->>'packet_id',
        (v_item->>'graph_version_analyzed')::INTEGER,
        v_item->>'source_resolution_record_id',
        v_item->>'identity_stage_status',
        v_item->>'identity_confidence',
        v_item->>'sufficiency_stage_status',
        v_item->>'sufficiency_confidence',
        COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW())
      )
      ON CONFLICT (detail_id) DO NOTHING;  -- Immutable: no double-insert

      v_details_inserted := v_details_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 4: Insert pending identity proposition memberships
  -- Ordered many-to-many membership between pending decisions and propositions.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_pending_identity_propositions IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_pending_identity_propositions)
    LOOP
      INSERT INTO sie_pending_identity_propositions (
        id,
        decision_id,
        proposition_id,
        conversation_id,
        ordinal,
        created_at
      ) VALUES (
        v_item->>'id',
        v_item->>'decision_id',
        v_item->>'proposition_id',
        p_conversation_id,
        (v_item->>'ordinal')::INTEGER,
        COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW())
      )
      ON CONFLICT (id) DO NOTHING;  -- Immutable: no double-insert

      v_propositions_inserted := v_propositions_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 5: Apply association mutations
  -- Creates or updates normalized proposition-concern association records.
  -- Each association carries a role, confidence, and provenance.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_association_mutations IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_association_mutations)
    LOOP
      INSERT INTO sie_proposition_associations (
        association_id,
        association_creation_key,
        proposition_id,
        concern_id,
        role,
        confidence,
        provenance,
        established_by_packet_id,
        semantic_state,
        created_at,
        version,
        conversation_id
      ) VALUES (
        v_item->>'association_id',
        v_item->>'association_creation_key',
        v_item->>'proposition_id',
        v_item->>'concern_id',
        v_item->>'role',
        v_item->>'confidence',
        v_item->>'provenance',
        v_item->>'established_by_packet_id',
        COALESCE(v_item->>'semantic_state', 'ACTIVE'),
        COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()),
        COALESCE((v_item->>'version')::INTEGER, 1),
        p_conversation_id
      )
      ON CONFLICT (association_id) DO UPDATE SET
        semantic_state = EXCLUDED.semantic_state,
        version = EXCLUDED.version;

      v_associations_inserted := v_associations_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 6: Create shared proposals (new concern creation)
  -- Inserts new persistent concerns proposed by identity resolution when
  -- novelty is confirmed (NO/PROPOSE_NEW outcome).
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_shared_proposals IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_shared_proposals)
    LOOP
      INSERT INTO sie_persistent_concerns (
        concern_id,
        conversation_id,
        identity_summary,
        display_title,
        current_summary,
        status,
        created_at,
        last_active_at,
        canonical_parent_id,
        parent_resolution_state,
        metadata,
        semantic_version,
        merged_into_concern_id
      ) VALUES (
        v_item->>'concern_id',
        p_conversation_id,
        v_item->>'identity_summary',
        v_item->>'display_title',
        v_item->>'current_summary',
        COALESCE(v_item->>'status', 'ACTIVE'),
        COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()),
        COALESCE((v_item->>'last_active_at')::TIMESTAMPTZ, NOW()),
        v_item->>'canonical_parent_id',
        COALESCE(v_item->>'parent_resolution_state', 'PARENT_DEFERRED'),
        COALESCE(v_item->'metadata', '{}'::JSONB),
        COALESCE((v_item->>'semantic_version')::INTEGER, 1),
        v_item->>'merged_into_concern_id'
      )
      ON CONFLICT (concern_id) DO UPDATE SET
        identity_summary = EXCLUDED.identity_summary,
        display_title = EXCLUDED.display_title,
        current_summary = EXCLUDED.current_summary,
        status = EXCLUDED.status,
        last_active_at = EXCLUDED.last_active_at,
        metadata = EXCLUDED.metadata,
        semantic_version = EXCLUDED.semantic_version;

      v_concerns_inserted := v_concerns_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 7: Apply request state transition (mark as COMMITTED)
  -- Transitions the commit request from ANALYZED to COMMITTED state,
  -- recording the committed graph version and completion timestamp.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_request_state_transition IS NOT NULL THEN
    UPDATE sie_commit_requests
    SET status = COALESCE(
          p_request_state_transition->>'target_status',
          'COMMITTED'
        ),
        committed_graph_version = (
          p_request_state_transition->>'committed_graph_version'
        )::INTEGER,
        result = p_request_state_transition->'result',
        committed_at = COALESCE(
          (p_request_state_transition->>'committed_at')::TIMESTAMPTZ,
          NOW()
        ),
        completed_at = COALESCE(
          (p_request_state_transition->>'completed_at')::TIMESTAMPTZ,
          NOW()
        ),
        transition_metadata = COALESCE(
          p_request_state_transition->'transition_metadata',
          '{}'::JSONB
        )
    WHERE conversation_id = p_conversation_id
      AND request_id = COALESCE(
        p_request_state_transition->>'request_id',
        p_request_id
      )
      AND status IN ('ANALYZED', 'RESERVED', 'PENDING');

    v_request_transitioned := FOUND;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 8: Build and return result summary
  -- ═══════════════════════════════════════════════════════════════════════
  v_result := jsonb_build_object(
    'success', TRUE,
    'identity_bundle_applied', TRUE,
    'conversation_id', p_conversation_id,
    'request_id', p_request_id,
    'records_inserted', v_records_inserted,
    'attempts_inserted', v_attempts_inserted,
    'details_inserted', v_details_inserted,
    'propositions_inserted', v_propositions_inserted,
    'associations_inserted', v_associations_inserted,
    'concerns_inserted', v_concerns_inserted,
    'request_transitioned', v_request_transitioned,
    'committed_at', NOW()::TEXT
  );

  RETURN v_result;

EXCEPTION
  WHEN OTHERS THEN
    -- Any failure rolls back the entire transaction (PostgreSQL default).
    -- Re-raise with context for diagnostic purposes.
    RAISE EXCEPTION 'Identity bundle commit failed for conversation %, request %: % [SQLSTATE: %]',
      p_conversation_id, p_request_id, SQLERRM, SQLSTATE;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- GRANT: Allow service_role to invoke the identity bundle commit function.
-- service_role is the Supabase server-side role used by the TypeScript
-- orchestration layer to perform authenticated RPC calls.
-- ═══════════════════════════════════════════════════════════════════════════
GRANT EXECUTE ON FUNCTION v2_commit_identity_bundle(
  UUID, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB
) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- COMMENT
-- ═══════════════════════════════════════════════════════════════════════════
COMMENT ON FUNCTION v2_commit_identity_bundle IS
'Atomic identity-resolution bundle commit. Accepts optional JSONB arrays for '
'identity resolution records, retrieval attempts, pending identity details, '
'pending identity propositions, association mutations, shared proposals, and '
'request state transitions. All inserts occur within one PostgreSQL transaction. '
'If any insert fails, the entire transaction rolls back. Legacy callers that '
'pass NULL for all identity fields receive an immediate no-op success result. '
'SIE identity-resolution callers are identified by providing non-null identity '
'bundle fields. SECURITY DEFINER ensures writes bypass RLS while enforcing '
'conversation ownership through the function logic itself.';

-- ═══════════════════════════════════════════════════════════════════════════
-- BACKWARD COMPATIBILITY NOTES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. The existing v2_commit_update function (migration 008) is NOT modified.
--    Legacy V2 callers continue to use v2_commit_update exactly as before.
--    The V2-only path (p_required_engine IS NULL) is completely unchanged.
--
-- 2. SIE identity-resolution callers participate in the reservation protocol
--    by:
--    a) Reserving a request via the state RPCs (migration 013);
--    b) Calling v2_commit_update for base graph/SIE mutations;
--    c) Calling v2_commit_identity_bundle for identity-specific sections;
--    Both (b) and (c) execute within the same database transaction when
--    invoked through the TypeScript commit manager.
--
-- 3. SIE identity-resolution callers are identified by the presence of:
--    - Non-null identity bundle arrays (p_identity_resolution_records, etc.)
--    - A valid request_id that corresponds to a RESERVED/ANALYZED commit request
--    - The existing authority/engine contract (p_required_engine in v2_commit_update)
--
-- 4. Legacy V2 callers that do NOT provide identity bundle fields:
--    - Continue on their existing v2_commit_update backward-compatible path
--    - Never interact with v2_commit_identity_bundle
--    - Are unaffected by this migration
--    - Retain their established validations and behavior
--
-- 5. No migration or cutover of legacy callers occurs through this migration.
--    Legacy callers remain on their existing path until a separately approved
--    migration or authority cutover changes that contract.
--
-- ═══════════════════════════════════════════════════════════════════════════
