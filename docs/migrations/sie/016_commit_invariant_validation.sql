-- ═══════════════════════════════════════════════════════════════════════════
-- SIE MIGRATION 016 — Commit Invariant Validation
--
-- Creates v2_validate_identity_bundle(...) — a pre-mutation validation gate
-- called within v2_commit_identity_bundle BEFORE any inserts occur.
--
-- Enforces:
--   1. Lease ownership (active, unexpired, matching caller)
--   2. Payload fingerprint consistency
--   3. Graph version freshness (graph_version_analyzed)
--   4. Entity-registry determinism (all record_ids registered)
--   5. Composite conversation ownership (packets, concerns belong to conversation)
--   6. Cross-field result invariants (outcome/action/confidence combinations)
--   7. Association uniqueness
--
-- Rejects the entire transaction on any violation. Does NOT impose the new
-- lease/fingerprint contract on legacy V2 callers — only SIE identity-
-- resolution callers providing identity bundle fields are validated.
--
-- Depends on:
--   001_authoritative_engine_and_idempotency.sql (sie_entity_registry, sie_commit_requests)
--   008_versioned_commit_rpc.sql (v2_commit_update, v2_update_state)
--   009_identity_resolution_records.sql (sie_identity_resolution_records)
--   012_commit_request_state_machine.sql (extended sie_commit_requests)
--   015_commit_identity_bundle.sql (v2_commit_identity_bundle)
--
-- Design authority: design-corrections.md § 15.6, tasks.md § 5.2
--
-- Safe to run multiple times (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. VALIDATION FUNCTION: v2_validate_identity_bundle
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION v2_validate_identity_bundle(
  p_conversation_id UUID,
  p_request_id TEXT,
  p_lease_owner TEXT DEFAULT NULL,
  p_payload_fingerprint_hash TEXT DEFAULT NULL,
  p_graph_version_analyzed INTEGER DEFAULT NULL,
  p_identity_resolution_records JSONB DEFAULT NULL,
  p_retrieval_attempts JSONB DEFAULT NULL,
  p_association_mutations JSONB DEFAULT NULL,
  p_shared_proposals JSONB DEFAULT NULL
) RETURNS JSONB
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_violations JSONB := '[]'::JSONB;
  v_item JSONB;
  v_request_status TEXT;
  v_request_lease_owner TEXT;
  v_request_lease_expires TIMESTAMPTZ;
  v_stored_fingerprint TEXT;
  v_current_graph_version INTEGER;
  v_record_id TEXT;
  v_entity_exists BOOLEAN;
  v_entity_kind TEXT;
  v_packet_id TEXT;
  v_concern_id TEXT;
  v_packet_exists BOOLEAN;
  v_concern_exists BOOLEAN;
  v_outcome TEXT;
  v_action TEXT;
  v_identity_stage TEXT;
  v_identity_conf TEXT;
  v_sufficiency_stage TEXT;
  v_sufficiency_conf TEXT;
  v_matched TEXT;
  v_proposed TEXT;
  v_assoc_key TEXT;
  v_assoc_keys TEXT[] := '{}';
BEGIN

  -- ═══════════════════════════════════════════════════════════════════════
  -- VALIDATION 1: Lease Ownership
  -- Check that p_request_id has status IN ('RESERVED', 'ANALYZED'),
  -- the lease_owner matches the caller, and the lease has not expired.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_lease_owner IS NOT NULL THEN
    SELECT status, lease_owner, lease_expires_at
      INTO v_request_status, v_request_lease_owner, v_request_lease_expires
      FROM sie_commit_requests
      WHERE conversation_id = p_conversation_id
        AND request_id = p_request_id;

    IF NOT FOUND THEN
      v_violations := v_violations || jsonb_build_object(
        'code', 'LEASE_NOT_FOUND',
        'message', format('No commit request found for request_id %s in conversation %s',
                          p_request_id, p_conversation_id)
      );
    ELSE
      -- Status must be RESERVED or ANALYZED
      IF v_request_status NOT IN ('RESERVED', 'ANALYZED') THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'LEASE_INVALID_STATUS',
          'message', format('Request %s has status %s; expected RESERVED or ANALYZED',
                            p_request_id, v_request_status)
        );
      END IF;

      -- Lease owner must match
      IF v_request_lease_owner IS NULL OR v_request_lease_owner <> p_lease_owner THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'LEASE_OWNER_MISMATCH',
          'message', format('Lease owner mismatch for request %s: expected %s, found %s',
                            p_request_id, p_lease_owner,
                            COALESCE(v_request_lease_owner, 'NULL'))
        );
      END IF;

      -- Lease must not be expired
      IF v_request_lease_expires IS NOT NULL AND v_request_lease_expires < NOW() THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'LEASE_EXPIRED',
          'message', format('Lease for request %s expired at %s',
                            p_request_id, v_request_lease_expires::TEXT)
        );
      END IF;
    END IF;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- VALIDATION 2: Payload Fingerprint
  -- p_payload_fingerprint_hash must match the stored fingerprint for this
  -- request (prevents stale or tampered payloads).
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_payload_fingerprint_hash IS NOT NULL THEN
    SELECT payload_fingerprint_hash
      INTO v_stored_fingerprint
      FROM sie_commit_requests
      WHERE conversation_id = p_conversation_id
        AND request_id = p_request_id;

    IF FOUND AND v_stored_fingerprint IS NOT NULL
       AND v_stored_fingerprint <> p_payload_fingerprint_hash THEN
      v_violations := v_violations || jsonb_build_object(
        'code', 'FINGERPRINT_MISMATCH',
        'message', format('Payload fingerprint mismatch for request %s: stored %s, provided %s',
                          p_request_id, v_stored_fingerprint, p_payload_fingerprint_hash)
      );
    END IF;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- VALIDATION 3: Graph Version Analyzed (staleness check)
  -- The graph_version_analyzed in the resolution records must match the
  -- current graph version in v2_update_state. Rejects stale analysis.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_graph_version_analyzed IS NOT NULL THEN
    SELECT update_version
      INTO v_current_graph_version
      FROM v2_update_state
      WHERE conversation_id = p_conversation_id;

    IF FOUND AND v_current_graph_version <> p_graph_version_analyzed THEN
      v_violations := v_violations || jsonb_build_object(
        'code', 'GRAPH_VERSION_STALE',
        'message', format(
          'Graph version analyzed (%s) does not match current version (%s) for conversation %s',
          p_graph_version_analyzed, v_current_graph_version, p_conversation_id)
      );
    END IF;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- VALIDATION 4: Entity-Registry Determinism
  -- Every record_id in identity_resolution_records must exist in
  -- sie_entity_registry with matching entity_kind.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_identity_resolution_records IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_identity_resolution_records)
    LOOP
      v_record_id := v_item->>'record_id';

      IF v_record_id IS NOT NULL THEN
        SELECT EXISTS(
          SELECT 1 FROM sie_entity_registry
          WHERE conversation_id = p_conversation_id
            AND entity_kind = 'identity_resolution_record'
            AND entity_id = v_record_id
        ) INTO v_entity_exists;

        IF NOT v_entity_exists THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'ENTITY_NOT_REGISTERED',
            'message', format(
              'Resolution record_id %s not found in entity registry for conversation %s',
              v_record_id, p_conversation_id)
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- VALIDATION 5: Composite Conversation Ownership
  -- Every packet_id and concern_id referenced in the bundle must belong
  -- to p_conversation_id. Prevents cross-conversation references.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_identity_resolution_records IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_identity_resolution_records)
    LOOP
      -- Validate packet_id belongs to this conversation
      v_packet_id := v_item->>'packet_id';
      IF v_packet_id IS NOT NULL THEN
        SELECT EXISTS(
          SELECT 1 FROM sie_semantic_packets
          WHERE packet_id = v_packet_id
            AND conversation_id = p_conversation_id
        ) INTO v_packet_exists;

        IF NOT v_packet_exists THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'PACKET_CONVERSATION_MISMATCH',
            'message', format(
              'Packet %s does not belong to conversation %s',
              v_packet_id, p_conversation_id)
          );
        END IF;
      END IF;

      -- Validate matched_concern_id belongs to this conversation
      v_concern_id := v_item->>'matched_concern_id';
      IF v_concern_id IS NOT NULL THEN
        SELECT EXISTS(
          SELECT 1 FROM sie_persistent_concerns
          WHERE concern_id = v_concern_id
            AND conversation_id = p_conversation_id
        ) INTO v_concern_exists;

        IF NOT v_concern_exists THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'CONCERN_CONVERSATION_MISMATCH',
            'message', format(
              'Matched concern %s does not belong to conversation %s',
              v_concern_id, p_conversation_id)
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Also validate concern ownership for shared proposals
  IF p_shared_proposals IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_shared_proposals)
    LOOP
      -- For new proposals, we validate that any canonical_parent_id belongs
      -- to this conversation if specified
      v_concern_id := v_item->>'canonical_parent_id';
      IF v_concern_id IS NOT NULL THEN
        SELECT EXISTS(
          SELECT 1 FROM sie_persistent_concerns
          WHERE concern_id = v_concern_id
            AND conversation_id = p_conversation_id
        ) INTO v_concern_exists;

        IF NOT v_concern_exists THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'PROPOSAL_PARENT_CONVERSATION_MISMATCH',
            'message', format(
              'Proposed canonical parent %s does not belong to conversation %s',
              v_concern_id, p_conversation_id)
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Validate association concern_ids belong to conversation
  IF p_association_mutations IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_association_mutations)
    LOOP
      v_concern_id := v_item->>'concern_id';
      IF v_concern_id IS NOT NULL THEN
        -- For associations referencing existing concerns, validate ownership.
        -- New concerns being created in the same transaction (shared_proposals)
        -- won't exist yet, so we check if it's in shared_proposals first.
        SELECT EXISTS(
          SELECT 1 FROM sie_persistent_concerns
          WHERE concern_id = v_concern_id
            AND conversation_id = p_conversation_id
        ) INTO v_concern_exists;

        -- If not in existing concerns, check if it's a proposal in this bundle
        IF NOT v_concern_exists AND p_shared_proposals IS NOT NULL THEN
          SELECT EXISTS(
            SELECT 1 FROM jsonb_array_elements(p_shared_proposals) AS sp
            WHERE sp->>'concern_id' = v_concern_id
          ) INTO v_concern_exists;
        END IF;

        IF NOT v_concern_exists THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'ASSOCIATION_CONCERN_MISMATCH',
            'message', format(
              'Association references concern %s not in conversation %s or bundle proposals',
              v_concern_id, p_conversation_id)
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- VALIDATION 6: Cross-Field Result Invariants
  -- Same CHECK constraints as the table (outcome/action/confidence combos)
  -- done pre-insert to provide better error messages.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_identity_resolution_records IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_identity_resolution_records)
    LOOP
      v_outcome := v_item->>'outcome';
      v_action := v_item->>'action';
      v_identity_stage := v_item->>'identity_stage_status';
      v_identity_conf := v_item->>'identity_confidence';
      v_sufficiency_stage := v_item->>'sufficiency_stage_status';
      v_sufficiency_conf := v_item->>'sufficiency_confidence';
      v_matched := v_item->>'matched_concern_id';
      v_proposed := v_item->>'proposed_concern_id';

      -- Check valid outcome values
      IF v_outcome NOT IN ('YES', 'NO', 'UNRESOLVED', 'DEFER',
                           'RETRIEVAL_INCONCLUSIVE', 'REQUIRES_VALIDATION') THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'INVALID_OUTCOME',
          'message', format('Invalid outcome "%s" in record %s',
                            v_outcome, v_item->>'record_id')
        );
        CONTINUE;
      END IF;

      -- Check valid action values
      IF v_action NOT IN ('ASSIGN_EXISTING', 'PROPOSE_NEW', 'RETAIN_PENDING', 'NONE') THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'INVALID_ACTION',
          'message', format('Invalid action "%s" in record %s',
                            v_action, v_item->>'record_id')
        );
        CONTINUE;
      END IF;

      -- Branch 1: YES/ASSIGN_EXISTING
      IF v_outcome = 'YES' THEN
        IF v_action <> 'ASSIGN_EXISTING' THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format('outcome=YES requires action=ASSIGN_EXISTING, got %s in record %s',
                              v_action, v_item->>'record_id')
          );
        END IF;
        IF v_identity_stage <> 'COMPLETED' OR v_identity_conf <> 'HIGH' THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format(
              'outcome=YES requires identity_stage=COMPLETED+HIGH, got %s/%s in record %s',
              v_identity_stage, COALESCE(v_identity_conf, 'NULL'), v_item->>'record_id')
          );
        END IF;
        IF v_matched IS NULL THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format('outcome=YES requires matched_concern_id in record %s',
                              v_item->>'record_id')
          );
        END IF;
        IF v_proposed IS NOT NULL THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format('outcome=YES must not have proposed_concern_id in record %s',
                              v_item->>'record_id')
          );
        END IF;
      END IF;

      -- Branch 2: NO/PROPOSE_NEW
      IF v_outcome = 'NO' THEN
        IF v_action <> 'PROPOSE_NEW' THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format('outcome=NO requires action=PROPOSE_NEW, got %s in record %s',
                              v_action, v_item->>'record_id')
          );
        END IF;
        IF v_sufficiency_stage <> 'COMPLETED' OR v_sufficiency_conf <> 'HIGH' THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format(
              'outcome=NO requires sufficiency_stage=COMPLETED+HIGH, got %s/%s in record %s',
              v_sufficiency_stage, COALESCE(v_sufficiency_conf, 'NULL'), v_item->>'record_id')
          );
        END IF;
        IF v_proposed IS NULL THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format('outcome=NO requires proposed_concern_id in record %s',
                              v_item->>'record_id')
          );
        END IF;
        IF v_matched IS NOT NULL THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format('outcome=NO must not have matched_concern_id in record %s',
                              v_item->>'record_id')
          );
        END IF;
      END IF;

      -- Branch 3: Pending/deferred outcomes
      IF v_outcome IN ('UNRESOLVED', 'DEFER', 'RETRIEVAL_INCONCLUSIVE', 'REQUIRES_VALIDATION') THEN
        IF v_action NOT IN ('RETAIN_PENDING', 'NONE') THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format(
              'outcome=%s requires action IN (RETAIN_PENDING, NONE), got %s in record %s',
              v_outcome, v_action, v_item->>'record_id')
          );
        END IF;
        IF v_matched IS NOT NULL OR v_proposed IS NOT NULL THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'RESULT_BRANCH_VIOLATION',
            'message', format(
              'outcome=%s must not have matched or proposed concern in record %s',
              v_outcome, v_item->>'record_id')
          );
        END IF;
      END IF;

      -- Stage-status / confidence coupling
      IF v_identity_stage = 'COMPLETED' AND v_identity_conf IS NULL THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'STAGE_CONFIDENCE_VIOLATION',
          'message', format(
            'identity_stage=COMPLETED requires non-null confidence in record %s',
            v_item->>'record_id')
        );
      END IF;
      IF v_identity_stage IN ('NOT_RUN', 'FAILED') AND v_identity_conf IS NOT NULL THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'STAGE_CONFIDENCE_VIOLATION',
          'message', format(
            'identity_stage=%s requires null confidence, got %s in record %s',
            v_identity_stage, v_identity_conf, v_item->>'record_id')
        );
      END IF;
      IF v_sufficiency_stage = 'COMPLETED' AND v_sufficiency_conf IS NULL THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'STAGE_CONFIDENCE_VIOLATION',
          'message', format(
            'sufficiency_stage=COMPLETED requires non-null confidence in record %s',
            v_item->>'record_id')
        );
      END IF;
      IF v_sufficiency_stage IN ('NOT_RUN', 'FAILED') AND v_sufficiency_conf IS NOT NULL THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'STAGE_CONFIDENCE_VIOLATION',
          'message', format(
            'sufficiency_stage=%s requires null confidence, got %s in record %s',
            v_sufficiency_stage, v_sufficiency_conf, v_item->>'record_id')
        );
      END IF;

      -- Confidence band values check
      IF v_identity_conf IS NOT NULL AND v_identity_conf NOT IN ('HIGH', 'MEDIUM', 'LOW') THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'INVALID_CONFIDENCE',
          'message', format('Invalid identity_confidence "%s" in record %s',
                            v_identity_conf, v_item->>'record_id')
        );
      END IF;
      IF v_sufficiency_conf IS NOT NULL AND v_sufficiency_conf NOT IN ('HIGH', 'MEDIUM', 'LOW') THEN
        v_violations := v_violations || jsonb_build_object(
          'code', 'INVALID_CONFIDENCE',
          'message', format('Invalid sufficiency_confidence "%s" in record %s',
                            v_sufficiency_conf, v_item->>'record_id')
        );
      END IF;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- VALIDATION 7: Association Uniqueness
  -- No duplicate association_creation_key within the same bundle.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_association_mutations IS NOT NULL THEN
    v_assoc_keys := '{}';
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_association_mutations)
    LOOP
      v_assoc_key := v_item->>'association_creation_key';
      IF v_assoc_key IS NOT NULL THEN
        IF v_assoc_key = ANY(v_assoc_keys) THEN
          v_violations := v_violations || jsonb_build_object(
            'code', 'DUPLICATE_ASSOCIATION_KEY',
            'message', format(
              'Duplicate association_creation_key "%s" in bundle for conversation %s',
              v_assoc_key, p_conversation_id)
          );
        ELSE
          v_assoc_keys := array_append(v_assoc_keys, v_assoc_key);
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- RETURN RESULT
  -- ═══════════════════════════════════════════════════════════════════════
  IF jsonb_array_length(v_violations) = 0 THEN
    RETURN jsonb_build_object('valid', TRUE);
  ELSE
    RETURN jsonb_build_object('valid', FALSE, 'violations', v_violations);
  END IF;

END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. REPLACE v2_commit_identity_bundle TO CALL VALIDATION BEFORE MUTATIONS
--
-- This recreates v2_commit_identity_bundle with an added validation step
-- (STEP 0) that calls v2_validate_identity_bundle before any inserts occur.
-- The function rejects the entire transaction on any validation violation.
--
-- Legacy V2 callers (those providing NULL for all identity bundle fields)
-- still get the immediate no-op success without validation, preserving
-- backward compatibility.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION v2_commit_identity_bundle(
  -- Required context parameters
  p_conversation_id UUID,
  p_request_id TEXT,
  -- Optional identity bundle sections
  p_identity_resolution_records JSONB DEFAULT NULL,
  p_retrieval_attempts JSONB DEFAULT NULL,
  p_pending_identity_details JSONB DEFAULT NULL,
  p_pending_identity_propositions JSONB DEFAULT NULL,
  p_association_mutations JSONB DEFAULT NULL,
  p_shared_proposals JSONB DEFAULT NULL,
  p_request_state_transition JSONB DEFAULT NULL,
  -- New: validation context parameters (optional, for SIE identity callers)
  p_lease_owner TEXT DEFAULT NULL,
  p_payload_fingerprint_hash TEXT DEFAULT NULL,
  p_graph_version_analyzed INTEGER DEFAULT NULL
) RETURNS JSONB
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item JSONB;
  v_has_identity_work BOOLEAN;
  v_validation_result JSONB;
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
  -- GUARD: Legacy callers — no identity work means no-op success.
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
  -- STEP 0: PRE-MUTATION INVARIANT VALIDATION
  -- Only SIE identity-resolution callers (those providing identity bundle
  -- fields) are validated. Legacy V2 callers are excluded above.
  -- Validates lease, fingerprint, graph version, entity registry,
  -- conversation ownership, cross-field invariants, and uniqueness.
  -- Rejects the whole transaction on any violation.
  -- ═══════════════════════════════════════════════════════════════════════
  v_validation_result := v2_validate_identity_bundle(
    p_conversation_id := p_conversation_id,
    p_request_id := p_request_id,
    p_lease_owner := p_lease_owner,
    p_payload_fingerprint_hash := p_payload_fingerprint_hash,
    p_graph_version_analyzed := p_graph_version_analyzed,
    p_identity_resolution_records := p_identity_resolution_records,
    p_retrieval_attempts := p_retrieval_attempts,
    p_association_mutations := p_association_mutations,
    p_shared_proposals := p_shared_proposals
  );

  IF NOT (v_validation_result->>'valid')::BOOLEAN THEN
    RAISE EXCEPTION 'Identity bundle validation failed for conversation %, request %: %',
      p_conversation_id, p_request_id, v_validation_result->'violations';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 1: Insert identity resolution records
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_identity_resolution_records IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_identity_resolution_records)
    LOOP
      INSERT INTO sie_identity_resolution_records (
        record_id, request_id, conversation_id, packet_id,
        graph_version_analyzed, graph_snapshot_token,
        outcome, action, identity_stage_status, identity_confidence,
        sufficiency_stage_status, sufficiency_confidence,
        matched_concern_id, proposed_concern_id,
        candidates_considered, irs_signals, retrieval_attempts,
        sufficiency_record, evidence_references, reasoning,
        semantic_policy_version, retrieval_policy_version,
        model_config_version, prompt_version,
        proposed_dependency_group_id, created_at
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
      ON CONFLICT (record_id) DO NOTHING;
      v_records_inserted := v_records_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 2: Insert retrieval attempts
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_retrieval_attempts IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_retrieval_attempts)
    LOOP
      INSERT INTO sie_retrieval_attempts (
        attempt_id, record_id, conversation_id, packet_id,
        channel_id, channel_family, query_mode, query_reference,
        scope_description, status, candidate_ids, candidate_count,
        latency_ms, failure_reason, retrieval_policy_version,
        is_widening_attempt, triggered_by_signal, created_at
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
      ON CONFLICT (attempt_id) DO NOTHING;
      v_attempts_inserted := v_attempts_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 3: Insert pending identity details
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_pending_identity_details IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_pending_identity_details)
    LOOP
      INSERT INTO sie_pending_identity_details (
        detail_id, decision_id, conversation_id, packet_id,
        graph_version_analyzed, source_resolution_record_id,
        identity_stage_status, identity_confidence,
        sufficiency_stage_status, sufficiency_confidence, created_at
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
      ON CONFLICT (detail_id) DO NOTHING;
      v_details_inserted := v_details_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 4: Insert pending identity proposition memberships
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_pending_identity_propositions IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_pending_identity_propositions)
    LOOP
      INSERT INTO sie_pending_identity_propositions (
        id, decision_id, proposition_id, conversation_id, ordinal, created_at
      ) VALUES (
        v_item->>'id',
        v_item->>'decision_id',
        v_item->>'proposition_id',
        p_conversation_id,
        (v_item->>'ordinal')::INTEGER,
        COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW())
      )
      ON CONFLICT (id) DO NOTHING;
      v_propositions_inserted := v_propositions_inserted + 1;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- STEP 5: Apply association mutations
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_association_mutations IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_association_mutations)
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
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_shared_proposals IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_shared_proposals)
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
  -- STEP 7: Apply request state transition
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
    'validation_passed', TRUE,
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
    RAISE EXCEPTION 'Identity bundle commit failed for conversation %, request %: % [SQLSTATE: %]',
      p_conversation_id, p_request_id, SQLERRM, SQLSTATE;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. GRANTS
-- ═══════════════════════════════════════════════════════════════════════════

-- Grant execute on validation function to service_role
GRANT EXECUTE ON FUNCTION v2_validate_identity_bundle(
  UUID, TEXT, TEXT, TEXT, INTEGER, JSONB, JSONB, JSONB, JSONB
) TO service_role;

-- Grant execute on updated commit function to service_role
-- (new signature with additional validation parameters)
GRANT EXECUTE ON FUNCTION v2_commit_identity_bundle(
  UUID, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, TEXT, TEXT, INTEGER
) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON FUNCTION v2_validate_identity_bundle IS
'Pre-mutation invariant validation for SIE identity-resolution bundles. '
'Validates lease ownership, payload fingerprint, graph version freshness, '
'entity-registry determinism, composite conversation ownership, cross-field '
'result invariants (outcome/action/confidence), and association uniqueness. '
'Returns {valid: true} or {valid: false, violations: [...]}. Called by '
'v2_commit_identity_bundle before any inserts. Does NOT apply to legacy '
'V2 callers that omit identity bundle fields.';

COMMENT ON FUNCTION v2_commit_identity_bundle(UUID, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, TEXT, TEXT, INTEGER) IS
'Atomic identity-resolution bundle commit with pre-mutation invariant '
'validation. Accepts optional JSONB arrays for identity resolution records, '
'retrieval attempts, pending identity details, pending identity propositions, '
'association mutations, shared proposals, and request state transitions. '
'SIE identity-resolution callers may additionally provide lease_owner, '
'payload_fingerprint_hash, and graph_version_analyzed for full validation. '
'All inserts occur within one PostgreSQL transaction; any failure rolls back '
'everything. Legacy callers that pass NULL for all identity fields receive '
'an immediate no-op success without validation.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. BACKWARD COMPATIBILITY NOTES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. The existing v2_commit_update function (migration 008) is NOT modified.
--    Legacy V2 callers continue using v2_commit_update exactly as before.
--
-- 2. The v2_commit_identity_bundle function gains three new OPTIONAL parameters
--    (p_lease_owner, p_payload_fingerprint_hash, p_graph_version_analyzed),
--    all defaulting to NULL. Existing callers that use the 9-parameter form
--    remain compatible without code changes.
--
-- 3. The new lease/fingerprint/graph-version contract is enforced ONLY when
--    the caller provides non-null identity bundle fields (indicating an SIE
--    identity-resolution caller). Legacy callers with NULL identity fields
--    exit immediately with the no-op success response, never reaching
--    validation.
--
-- 4. v2_validate_identity_bundle is a standalone helper that can be called
--    independently for testing or dry-run validation without committing.
--
-- 5. Validation parameters are individually optional within the validation
--    function itself: if p_lease_owner is NULL, lease validation is skipped;
--    if p_payload_fingerprint_hash is NULL, fingerprint validation is skipped;
--    if p_graph_version_analyzed is NULL, version staleness is skipped.
--    This allows gradual adoption during the compatibility period.
--
-- 6. Once the compatibility period ends and all callers provide full
--    validation context, the optional behavior can be tightened (e.g.,
--    requiring p_lease_owner for any identity bundle commit).
--
-- ═══════════════════════════════════════════════════════════════════════════
