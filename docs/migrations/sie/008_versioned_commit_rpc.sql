-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 008 — Backward-Compatible Versioned Commit RPC
--
-- Extends v2_commit_update with optional SIE parameters while keeping every
-- existing V2 caller fully operational. When p_required_engine is NULL,
-- the V2-only path executes unchanged. When non-NULL, the SIE path performs
-- a full atomic commit with authority checks, optimistic locking, idempotency,
-- entity registry verification, and all SIE/V2/audit/cursor writes.
--
-- Depends on:
--   001_authoritative_engine_and_idempotency.sql
--   002_persistent_concerns_and_aliases.sql
--   003_propositions_and_associations.sql
--   004_packets_memberships_and_splits.sql
--   005_retention_pending_decisions_and_audit.sql
--   v2_durable_update_system.sql (original v2_commit_update)
--
-- Safe to run multiple times (CREATE OR REPLACE).
-- Any failure rolls back every SIE, V2, version, audit, pending-decision,
-- and cursor write (single PostgreSQL transaction).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION v2_commit_update(
  -- ═══════════════════════════════════════════════════════════════════════
  -- Original 8 parameters (unchanged for backward compatibility)
  -- ═══════════════════════════════════════════════════════════════════════
  p_conversation_id uuid,
  p_new_snapshot jsonb,
  p_from_version integer,
  p_to_version integer,
  p_mutations jsonb,
  p_last_processed_seq bigint,
  p_message_seq_from bigint,
  p_message_seq_to bigint,
  -- ═══════════════════════════════════════════════════════════════════════
  -- New optional SIE parameters (default NULL for backward compatibility)
  -- ═══════════════════════════════════════════════════════════════════════
  p_sie_commit_bundle jsonb DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_payload_fingerprint text DEFAULT NULL,
  p_required_engine text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  -- Authority and version state
  v_current_version integer;
  v_current_engine text;
  v_current_cursor bigint;
  -- Idempotency replay
  v_existing_result jsonb;
  v_existing_fingerprint text;
  v_existing_status text;
  -- Commit bundle parsing
  v_entity_registrations jsonb;
  v_concerns jsonb;
  v_propositions jsonb;
  v_associations jsonb;
  v_packets jsonb;
  v_memberships jsonb;
  v_splits jsonb;
  v_retention_decisions jsonb;
  v_pending_decisions jsonb;
  v_pending_resolutions jsonb;
  v_audit_entries jsonb;
  -- Loop variables
  v_item jsonb;
  v_commit_result jsonb;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════
  -- V2-ONLY PATH (existing callers — p_required_engine is NULL)
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_required_engine IS NULL THEN
    -- 1. Update snapshot payload + mark ready
    UPDATE v2_graph_snapshots
    SET graph_payload = p_new_snapshot,
        status = 'ready',
        diagnostics = COALESCE(diagnostics, '{}'::jsonb)
          || jsonb_build_object(
            'updateVersion', p_to_version,
            'lastIncrementalUpdate', now()::text,
            'lastIncrementalMutations', jsonb_array_length(p_mutations),
            'lastUpdateError', null,
            'updateFailedAt', null,
            'cursorEstablished', true,
            'needsBaselineRebuild', false
          ),
        updated_at = now()
    WHERE conversation_id = p_conversation_id;

    -- 2. Insert mutation log (idempotent via UNIQUE constraint)
    INSERT INTO v2_mutation_log (
      conversation_id, from_version, to_version, mutations, message_seq_range
    ) VALUES (
      p_conversation_id, p_from_version, p_to_version, p_mutations,
      int8range(p_message_seq_from, p_message_seq_to, '[]')
    ) ON CONFLICT (conversation_id, from_version, to_version) DO NOTHING;

    -- 3. Advance cursor + clear update state
    UPDATE v2_update_state
    SET last_processed_message_seq = p_last_processed_seq,
        update_version = p_to_version,
        update_status = 'idle',
        pending_since = NULL,
        last_update_error = NULL,
        update_failed_at = NULL,
        updated_at = now()
    WHERE conversation_id = p_conversation_id;

    -- Return NULL for V2-only commits (backward compatible: callers ignore return)
    RETURN NULL;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- SIE PATH (p_required_engine is non-NULL)
  -- ═══════════════════════════════════════════════════════════════════════

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 1: Lock row and check authority
  -- ─────────────────────────────────────────────────────────────────────
  SELECT update_version, authoritative_engine, last_processed_message_seq
    INTO v_current_version, v_current_engine, v_current_cursor
    FROM v2_update_state
    WHERE conversation_id = p_conversation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No update state found for conversation %', p_conversation_id;
  END IF;

  IF v_current_engine <> p_required_engine THEN
    RAISE EXCEPTION 'Authority mismatch: expected %, found % for conversation %',
      p_required_engine, v_current_engine, p_conversation_id;
  END IF;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 2: Idempotency check (BEFORE version check)
  -- A committed replay should return immediately regardless of p_from_version.
  -- ─────────────────────────────────────────────────────────────────────
  SELECT result, payload_fingerprint, status
    INTO v_existing_result, v_existing_fingerprint, v_existing_status
    FROM sie_commit_requests
    WHERE conversation_id = p_conversation_id
      AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    -- Same key but different payload: ALWAYS reject regardless of status
    IF v_existing_fingerprint <> p_payload_fingerprint THEN
      RAISE EXCEPTION 'Idempotency key "%" reused with different payload (existing: %, new: %) for conversation %',
        p_idempotency_key, v_existing_fingerprint, p_payload_fingerprint, p_conversation_id;
    END IF;

    -- Already committed: replay the original result without new writes
    IF v_existing_status = 'COMMITTED' AND v_existing_result IS NOT NULL THEN
      RETURN v_existing_result;
    END IF;

    -- PENDING with same fingerprint: a retry of an incomplete commit.
    -- Proceed with the commit (the previous attempt never completed).
    -- Delete the stale PENDING row so we can insert fresh.
    DELETE FROM sie_commit_requests
      WHERE conversation_id = p_conversation_id
        AND idempotency_key = p_idempotency_key;
  END IF;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 3: Optimistic version check (after idempotency — new commits only)
  -- ─────────────────────────────────────────────────────────────────────
  IF v_current_version <> p_from_version THEN
    RAISE EXCEPTION 'Version conflict for conversation %: expected %, found %',
      p_conversation_id, p_from_version, v_current_version;
  END IF;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 4: Record commit request as PENDING
  -- ─────────────────────────────────────────────────────────────────────
  INSERT INTO sie_commit_requests (
    conversation_id, request_id, idempotency_key, payload_fingerprint,
    base_graph_version, status, created_at
  ) VALUES (
    p_conversation_id, p_request_id, p_idempotency_key, p_payload_fingerprint,
    p_from_version, 'PENDING', now()
  );

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 5: Parse the SIE commit bundle
  -- ─────────────────────────────────────────────────────────────────────
  v_entity_registrations := COALESCE(p_sie_commit_bundle->'entity_registrations', '[]'::jsonb);
  v_concerns             := COALESCE(p_sie_commit_bundle->'concerns', '[]'::jsonb);
  v_propositions         := COALESCE(p_sie_commit_bundle->'propositions', '[]'::jsonb);
  v_associations         := COALESCE(p_sie_commit_bundle->'associations', '[]'::jsonb);
  v_packets              := COALESCE(p_sie_commit_bundle->'packets', '[]'::jsonb);
  v_memberships          := COALESCE(p_sie_commit_bundle->'memberships', '[]'::jsonb);
  v_splits               := COALESCE(p_sie_commit_bundle->'splits', '[]'::jsonb);
  v_retention_decisions  := COALESCE(p_sie_commit_bundle->'retention_decisions', '[]'::jsonb);
  v_pending_decisions    := COALESCE(p_sie_commit_bundle->'pending_decisions', '[]'::jsonb);
  v_pending_resolutions  := COALESCE(p_sie_commit_bundle->'pending_resolutions', '[]'::jsonb);
  v_audit_entries        := COALESCE(p_sie_commit_bundle->'audit_entries', '[]'::jsonb);

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 6: Verify/register creation-key mappings (entity registry)
  --
  -- For each registration: if the creation key already exists, verify it
  -- maps to the same entity_id. If it doesn't exist, insert it.
  -- A mismatch raises an exception (rolls back everything).
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_entity_registrations)
  LOOP
    INSERT INTO sie_entity_registry (
      conversation_id, entity_kind, creation_key, entity_id, request_id, created_at
    ) VALUES (
      p_conversation_id,
      v_item->>'entity_kind',
      v_item->>'creation_key',
      v_item->>'entity_id',
      p_request_id,
      now()
    )
    ON CONFLICT (conversation_id, entity_kind, creation_key) DO UPDATE
      SET entity_id = sie_entity_registry.entity_id  -- no-op, keeps existing
    WHERE sie_entity_registry.entity_id = EXCLUDED.entity_id;

    -- If the ON CONFLICT matched but entity_id differs, the UPDATE WHERE clause
    -- prevents modification. Detect this mismatch:
    IF NOT FOUND THEN
      -- Check if the conflict was a genuine mismatch
      PERFORM 1 FROM sie_entity_registry
        WHERE conversation_id = p_conversation_id
          AND entity_kind = v_item->>'entity_kind'
          AND creation_key = v_item->>'creation_key'
          AND entity_id <> v_item->>'entity_id';
      IF FOUND THEN
        RAISE EXCEPTION 'Entity registry conflict: creation key "%" (kind: %) already mapped to a different entity_id for conversation %',
          v_item->>'creation_key', v_item->>'entity_kind', p_conversation_id;
      END IF;
    END IF;
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 7: Apply concern mutations (inserts/upserts)
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_concerns)
  LOOP
    INSERT INTO sie_persistent_concerns (
      concern_id, conversation_id, identity_summary, display_title,
      current_summary, status, created_at, last_active_at,
      canonical_parent_id, parent_resolution_state, metadata,
      semantic_version, merged_into_concern_id
    ) VALUES (
      v_item->>'concern_id',
      p_conversation_id,
      v_item->>'identity_summary',
      v_item->>'display_title',
      v_item->>'current_summary',
      COALESCE(v_item->>'status', 'ACTIVE'),
      COALESCE((v_item->>'created_at')::timestamptz, now()),
      COALESCE((v_item->>'last_active_at')::timestamptz, now()),
      v_item->>'canonical_parent_id',
      COALESCE(v_item->>'parent_resolution_state', 'PARENT_DEFERRED'),
      COALESCE(v_item->'metadata', '{}'::jsonb),
      COALESCE((v_item->>'semantic_version')::integer, 1),
      v_item->>'merged_into_concern_id'
    )
    ON CONFLICT (concern_id) DO UPDATE SET
      identity_summary = EXCLUDED.identity_summary,
      display_title = EXCLUDED.display_title,
      current_summary = EXCLUDED.current_summary,
      status = EXCLUDED.status,
      last_active_at = EXCLUDED.last_active_at,
      canonical_parent_id = EXCLUDED.canonical_parent_id,
      parent_resolution_state = EXCLUDED.parent_resolution_state,
      metadata = EXCLUDED.metadata,
      semantic_version = EXCLUDED.semantic_version,
      merged_into_concern_id = EXCLUDED.merged_into_concern_id;
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 8: Apply proposition mutations
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_propositions)
  LOOP
    INSERT INTO sie_propositions (
      proposition_id, conversation_id, proposition_creation_key,
      source_message_ids, speaker_role, canonical_meaning,
      proposition_type, message_seq_start, message_seq_end,
      provenance, semantic_state, retention_levels,
      created_at, extraction_version, supersedes_proposition_id
    ) VALUES (
      v_item->>'proposition_id',
      p_conversation_id,
      v_item->>'proposition_creation_key',
      ARRAY(SELECT jsonb_array_elements_text(v_item->'source_message_ids')),
      v_item->>'speaker_role',
      v_item->>'canonical_meaning',
      v_item->>'proposition_type',
      (v_item->>'message_seq_start')::bigint,
      (v_item->>'message_seq_end')::bigint,
      v_item->>'provenance',
      COALESCE(v_item->>'semantic_state', 'ACTIVE'),
      ARRAY(SELECT jsonb_array_elements_text(v_item->'retention_levels')),
      COALESCE((v_item->>'created_at')::timestamptz, now()),
      v_item->>'extraction_version',
      v_item->>'supersedes_proposition_id'
    )
    ON CONFLICT (proposition_id) DO UPDATE SET
      semantic_state = EXCLUDED.semantic_state,
      supersedes_proposition_id = EXCLUDED.supersedes_proposition_id;
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 9: Apply association mutations
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_associations)
  LOOP
    INSERT INTO sie_proposition_associations (
      association_id, association_creation_key, proposition_id, concern_id,
      role, confidence, provenance, established_by_packet_id,
      semantic_state, created_at, version, conversation_id
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
      COALESCE((v_item->>'created_at')::timestamptz, now()),
      COALESCE((v_item->>'version')::integer, 1),
      p_conversation_id
    )
    ON CONFLICT (association_id) DO UPDATE SET
      semantic_state = EXCLUDED.semantic_state,
      version = EXCLUDED.version;
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 10: Apply packet mutations
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_packets)
  LOOP
    INSERT INTO sie_semantic_packets (
      packet_id, packet_creation_key, conversation_id,
      source_message_ids, message_seq_start, message_seq_end,
      user_grounded_meaning, assistant_context, continuation_origin,
      provenance, packet_formation_version, cohesion_status, created_at
    ) VALUES (
      v_item->>'packet_id',
      v_item->>'packet_creation_key',
      p_conversation_id,
      ARRAY(SELECT jsonb_array_elements_text(v_item->'source_message_ids')),
      (v_item->>'message_seq_start')::bigint,
      (v_item->>'message_seq_end')::bigint,
      v_item->>'user_grounded_meaning',
      v_item->>'assistant_context',
      v_item->>'continuation_origin',
      v_item->>'provenance',
      v_item->>'packet_formation_version',
      v_item->>'cohesion_status',
      COALESCE((v_item->>'created_at')::timestamptz, now())
    )
    ON CONFLICT (packet_id) DO NOTHING;  -- Packets are immutable once created
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 11: Apply packet membership mutations
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_memberships)
  LOOP
    INSERT INTO sie_packet_memberships (
      membership_id, membership_creation_key, packet_id,
      proposition_id, ordinal, created_at
    ) VALUES (
      v_item->>'membership_id',
      v_item->>'membership_creation_key',
      v_item->>'packet_id',
      v_item->>'proposition_id',
      (v_item->>'ordinal')::integer,
      COALESCE((v_item->>'created_at')::timestamptz, now())
    )
    ON CONFLICT (membership_id) DO NOTHING;  -- Memberships are immutable
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 12: Apply packet split mutations
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_splits)
  LOOP
    INSERT INTO sie_packet_splits (
      split_edge_id, split_event_id, split_creation_key,
      original_packet_id, resulting_packet_id, split_reason, created_at
    ) VALUES (
      v_item->>'split_edge_id',
      v_item->>'split_event_id',
      v_item->>'split_creation_key',
      v_item->>'original_packet_id',
      v_item->>'resulting_packet_id',
      v_item->>'split_reason',
      COALESCE((v_item->>'created_at')::timestamptz, now())
    )
    ON CONFLICT (split_edge_id) DO NOTHING;  -- Splits are immutable
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 13: Apply retention decision mutations
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_retention_decisions)
  LOOP
    INSERT INTO sie_retention_decisions (
      decision_id, decision_creation_key, conversation_id, request_id,
      primary_level, secondary_roles, confidence, outcome,
      source_message_ids, speaker_role, sequence_position,
      extraction_version, assessment_version, rationale, created_at
    ) VALUES (
      v_item->>'decision_id',
      v_item->>'decision_creation_key',
      p_conversation_id,
      p_request_id,
      v_item->>'primary_level',
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_item->'secondary_roles')), '{}'::text[]),
      v_item->>'confidence',
      v_item->>'outcome',
      ARRAY(SELECT jsonb_array_elements_text(v_item->'source_message_ids')),
      v_item->>'speaker_role',
      (v_item->>'sequence_position')::integer,
      v_item->>'extraction_version',
      v_item->>'assessment_version',
      v_item->>'rationale',
      COALESCE((v_item->>'created_at')::timestamptz, now())
    )
    ON CONFLICT (conversation_id, decision_creation_key) DO NOTHING;  -- Immutable decisions
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 14: Persist new pending semantic decisions
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_pending_decisions)
  LOOP
    INSERT INTO sie_pending_semantic_decisions (
      decision_id, decision_creation_key, conversation_id, stage,
      entity_creation_key, outcome, lifecycle_state,
      originating_request_id, dependency_refs, rationale, created_at
    ) VALUES (
      v_item->>'decision_id',
      v_item->>'decision_creation_key',
      p_conversation_id,
      v_item->>'stage',
      v_item->>'entity_creation_key',
      v_item->>'outcome',
      COALESCE(v_item->>'lifecycle_state', 'pending'),
      p_request_id,
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_item->'dependency_refs')), '{}'::text[]),
      v_item->>'rationale',
      COALESCE((v_item->>'created_at')::timestamptz, now())
    )
    ON CONFLICT (conversation_id, decision_creation_key) DO NOTHING;  -- No double-create
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 15: Resolve existing pending decisions
  --
  -- When later processing succeeds, previously pending/unresolved/deferred
  -- decisions are updated to 'resolved' with resolution metadata.
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_pending_resolutions)
  LOOP
    UPDATE sie_pending_semantic_decisions
    SET lifecycle_state = 'resolved',
        resolved_at = now(),
        resolution_metadata = COALESCE(v_item->'resolution_metadata', '{}'::jsonb)
    WHERE conversation_id = p_conversation_id
      AND decision_id = v_item->>'decision_id'
      AND lifecycle_state <> 'resolved';  -- Only resolve non-resolved decisions
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 16: Write audit history entries
  -- ─────────────────────────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_audit_entries)
  LOOP
    INSERT INTO sie_audit_history (
      id, conversation_id, entity_kind, entity_id,
      action, before_state, after_state, request_id, metadata, created_at
    ) VALUES (
      v_item->>'id',
      p_conversation_id,
      v_item->>'entity_kind',
      v_item->>'entity_id',
      v_item->>'action',
      v_item->'before_state',
      v_item->'after_state',
      p_request_id,
      COALESCE(v_item->'metadata', '{}'::jsonb),
      COALESCE((v_item->>'created_at')::timestamptz, now())
    );
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 17: Write V2 projection snapshot
  -- ─────────────────────────────────────────────────────────────────────
  UPDATE v2_graph_snapshots
  SET graph_payload = p_new_snapshot,
      status = 'ready',
      diagnostics = COALESCE(diagnostics, '{}'::jsonb)
        || jsonb_build_object(
          'updateVersion', p_to_version,
          'lastIncrementalUpdate', now()::text,
          'lastIncrementalMutations', jsonb_array_length(COALESCE(p_mutations, '[]'::jsonb)),
          'lastUpdateError', null,
          'updateFailedAt', null,
          'cursorEstablished', true,
          'needsBaselineRebuild', false,
          'sieCommit', true,
          'sieRequestId', p_request_id
        ),
      updated_at = now()
  WHERE conversation_id = p_conversation_id;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 18: Write mutation log
  -- ─────────────────────────────────────────────────────────────────────
  INSERT INTO v2_mutation_log (
    conversation_id, from_version, to_version, mutations, message_seq_range
  ) VALUES (
    p_conversation_id, p_from_version, p_to_version,
    COALESCE(p_mutations, '[]'::jsonb),
    int8range(p_message_seq_from, p_message_seq_to, '[]')
  ) ON CONFLICT (conversation_id, from_version, to_version) DO NOTHING;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 19: Advance graph version and cursor exactly once
  -- ─────────────────────────────────────────────────────────────────────
  UPDATE v2_update_state
  SET last_processed_message_seq = p_last_processed_seq,
      update_version = p_to_version,
      update_status = 'idle',
      pending_since = NULL,
      last_update_error = NULL,
      update_failed_at = NULL,
      updated_at = now()
  WHERE conversation_id = p_conversation_id;

  -- ─────────────────────────────────────────────────────────────────────
  -- STEP 20: Build and record commit result
  -- ─────────────────────────────────────────────────────────────────────
  v_commit_result := jsonb_build_object(
    'graph_version', p_to_version,
    'status', 'COMMITTED',
    'request_id', p_request_id,
    'conversation_id', p_conversation_id,
    'base_graph_version', p_from_version,
    'committed_graph_version', p_to_version,
    'message_seq_range', jsonb_build_array(p_message_seq_from, p_message_seq_to),
    'committed_at', now()::text
  );

  -- Mark commit request as COMMITTED with result
  UPDATE sie_commit_requests
  SET status = 'COMMITTED',
      committed_graph_version = p_to_version,
      result = v_commit_result,
      completed_at = now()
  WHERE conversation_id = p_conversation_id
    AND idempotency_key = p_idempotency_key;

  RETURN v_commit_result;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════
COMMENT ON FUNCTION v2_commit_update IS
'Backward-compatible versioned commit RPC. When p_required_engine is NULL, '
'executes the original V2-only logic. When non-NULL, performs a full atomic '
'SIE commit with authority checks, optimistic version locking, idempotency '
'enforcement, entity registry verification, and all SIE/V2/audit/cursor writes '
'in a single PostgreSQL transaction. Any failure rolls back everything.';
