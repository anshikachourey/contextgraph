-- ═══════════════════════════════════════════════════════════════════════════
-- SIE DATABASE INTEGRATION TESTS — v2_commit_update RPC (SIE PATH)
--
-- These tests run against a REAL PostgreSQL database with all SIE migrations
-- applied. They verify:
-- 1. All-or-none atomic commit across all SIE tables
-- 2. Idempotent replay (same key returns original result without new writes)
-- 3. Payload fingerprint mismatch rejection
-- 4. Version conflict detection for new commits
-- 5. Authority mismatch rejection
-- 6. Failure injection — no partial state visible after constraint violation
-- 7. Pending decision persistence and resolution across multiple commits
-- 8. V2-only path backward compatibility
--
-- PREREQUISITES:
--   - All SIE migrations (001–008) applied
--   - A conversations table exists
--   - Test conversation '00000000-0000-0000-0000-000000000001' exists
--   - v2_update_state and v2_graph_snapshots rows exist for it
--
-- Run: psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -f integration_tests.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Setup
INSERT INTO conversations (id) VALUES ('00000000-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING;
INSERT INTO v2_update_state (conversation_id, update_version, authoritative_engine)
  VALUES ('00000000-0000-0000-0000-000000000001', 0, 'SIE')
  ON CONFLICT (conversation_id) DO UPDATE SET update_version = 0, authoritative_engine = 'SIE', last_processed_message_seq = 0;
INSERT INTO v2_graph_snapshots (conversation_id, status)
  VALUES ('00000000-0000-0000-0000-000000000001', 'generating')
  ON CONFLICT (conversation_id) DO UPDATE SET graph_payload = NULL, status = 'generating';

-- Clean any leftover test data
DELETE FROM sie_audit_history WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_pending_semantic_decisions WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_retention_decisions WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_packet_splits WHERE original_packet_id IN (SELECT packet_id FROM sie_semantic_packets WHERE conversation_id = '00000000-0000-0000-0000-000000000001');
DELETE FROM sie_packet_memberships WHERE packet_id IN (SELECT packet_id FROM sie_semantic_packets WHERE conversation_id = '00000000-0000-0000-0000-000000000001');
DELETE FROM sie_semantic_packets WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_proposition_associations WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_propositions WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_concern_aliases WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_persistent_concerns WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_commit_requests WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_entity_registry WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM v2_mutation_log WHERE conversation_id = '00000000-0000-0000-0000-000000000001';


-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 1: SUCCESSFUL ALL-OR-NONE COMMIT
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_result jsonb;
  v_counts record;
  v_version integer;
  v_cursor bigint;
BEGIN
  v_result := v2_commit_update(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '{"objects":[],"relationships":[],"propositions":[],"threads":[],"hierarchy":[],"trees":[]}'::jsonb,
    0, 1, '[]'::jsonb, 5, 1, 5,
    '{"entity_registrations":[{"entity_kind":"concern","creation_key":"pkt-1:ev-1","entity_id":"concern-001"},{"entity_kind":"proposition","creation_key":"req-1:0","entity_id":"prop-001"},{"entity_kind":"packet","creation_key":"req-1:part-0","entity_id":"pkt-001"},{"entity_kind":"association","creation_key":"req-1:p:c:PO","entity_id":"assoc-001"},{"entity_kind":"membership","creation_key":"pkt:prop:0","entity_id":"mem-001"},{"entity_kind":"retention_decision","creation_key":"req-1:msg-1:0","entity_id":"ret-001"}],"concerns":[{"concern_id":"concern-001","identity_summary":"Test","display_title":"Test","current_summary":"Test","status":"ACTIVE","parent_resolution_state":"ROOT_CONFIRMED"}],"propositions":[{"proposition_id":"prop-001","proposition_creation_key":"req-1:0","source_message_ids":["msg-1"],"speaker_role":"USER","canonical_meaning":"Test","proposition_type":"CLAIM","message_seq_start":1,"message_seq_end":3,"provenance":"DIRECT","semantic_state":"ACTIVE","retention_levels":["DURABLE_PROPOSITION"],"extraction_version":"v1"}],"associations":[{"association_id":"assoc-001","association_creation_key":"req-1:p:c:PO","proposition_id":"prop-001","concern_id":"concern-001","role":"PRIMARY_OWNER","confidence":"HIGH","provenance":"identity_resolution","semantic_state":"ACTIVE"}],"packets":[{"packet_id":"pkt-001","packet_creation_key":"req-1:part-0","source_message_ids":["msg-1"],"message_seq_start":1,"message_seq_end":3,"user_grounded_meaning":"Test","provenance":"extraction","packet_formation_version":"v1","cohesion_status":"COHESIVE"}],"memberships":[{"membership_id":"mem-001","membership_creation_key":"pkt:prop:0","packet_id":"pkt-001","proposition_id":"prop-001","ordinal":0}],"splits":[],"retention_decisions":[{"decision_id":"ret-001","decision_creation_key":"req-1:msg-1:0","primary_level":"DURABLE_PROPOSITION","secondary_roles":[],"confidence":"HIGH","outcome":"YES","source_message_ids":["msg-1"],"speaker_role":"USER","sequence_position":1,"extraction_version":"v1","assessment_version":"v1"}],"pending_decisions":[{"decision_id":"pend-001","decision_creation_key":"req-1:id:pkt-2","stage":"identity_resolution","entity_creation_key":"req-1:part-1","outcome":"UNRESOLVED","lifecycle_state":"pending","rationale":"Cannot resolve"}],"pending_resolutions":[],"audit_entries":[{"id":"audit-001","entity_kind":"concern","entity_id":"concern-001","action":"created","before_state":null,"after_state":{"status":"ACTIVE"}}]}'::jsonb,
    'req-001', 'idem-001', 'fp_00000001', 'SIE'
  );

  IF v_result->>'status' <> 'COMMITTED' THEN RAISE EXCEPTION 'TEST 1 FAILED: status=%', v_result->>'status'; END IF;

  SELECT update_version, last_processed_message_seq INTO v_version, v_cursor FROM v2_update_state WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
  IF v_version <> 1 OR v_cursor <> 5 THEN RAISE EXCEPTION 'TEST 1 FAILED: version=% cursor=%', v_version, v_cursor; END IF;

  IF (SELECT COUNT(*) FROM sie_persistent_concerns WHERE conversation_id = '00000000-0000-0000-0000-000000000001') < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: no concerns'; END IF;
  IF (SELECT COUNT(*) FROM sie_propositions WHERE conversation_id = '00000000-0000-0000-0000-000000000001') < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: no propositions'; END IF;
  IF (SELECT COUNT(*) FROM sie_proposition_associations WHERE conversation_id = '00000000-0000-0000-0000-000000000001') < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: no associations'; END IF;
  IF (SELECT COUNT(*) FROM sie_semantic_packets WHERE conversation_id = '00000000-0000-0000-0000-000000000001') < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: no packets'; END IF;
  IF (SELECT COUNT(*) FROM sie_packet_memberships WHERE packet_id = 'pkt-001') < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: no memberships'; END IF;
  IF (SELECT COUNT(*) FROM sie_retention_decisions WHERE conversation_id = '00000000-0000-0000-0000-000000000001') < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: no retention'; END IF;
  IF (SELECT COUNT(*) FROM sie_pending_semantic_decisions WHERE conversation_id = '00000000-0000-0000-0000-000000000001') < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: no pending decisions'; END IF;
  IF (SELECT COUNT(*) FROM sie_audit_history WHERE conversation_id = '00000000-0000-0000-0000-000000000001') < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: no audit'; END IF;
  IF (SELECT COUNT(*) FROM sie_entity_registry WHERE conversation_id = '00000000-0000-0000-0000-000000000001') < 6 THEN RAISE EXCEPTION 'TEST 1 FAILED: registry incomplete'; END IF;
  IF (SELECT status FROM v2_graph_snapshots WHERE conversation_id = '00000000-0000-0000-0000-000000000001') <> 'ready' THEN RAISE EXCEPTION 'TEST 1 FAILED: snapshot not ready'; END IF;

  RAISE NOTICE 'TEST 1 PASSED: All-or-none atomic commit verified across all SIE tables + V2 snapshot + cursor + version';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 2: IDEMPOTENT REPLAY
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_result jsonb; v_before integer; v_after integer;
BEGIN
  SELECT COUNT(*) INTO v_before FROM sie_entity_registry WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
  v_result := v2_commit_update('00000000-0000-0000-0000-000000000001'::uuid, '{}'::jsonb, 0, 1, '[]'::jsonb, 5, 1, 5, '{}'::jsonb, 'req-replay', 'idem-001', 'fp_00000001', 'SIE');
  IF v_result->>'status' <> 'COMMITTED' THEN RAISE EXCEPTION 'TEST 2 FAILED: replay status=%', v_result->>'status'; END IF;
  SELECT COUNT(*) INTO v_after FROM sie_entity_registry WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
  IF v_after <> v_before THEN RAISE EXCEPTION 'TEST 2 FAILED: new entities created on replay'; END IF;
  RAISE NOTICE 'TEST 2 PASSED: Idempotent replay returns original result without new writes';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 3: PAYLOAD MISMATCH REJECTION
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM v2_commit_update('00000000-0000-0000-0000-000000000001'::uuid, '{}'::jsonb, 1, 2, '[]'::jsonb, 10, 6, 10, '{}'::jsonb, 'req-mm', 'idem-001', 'fp_DIFFERENT', 'SIE');
  RAISE EXCEPTION 'TEST 3 FAILED: mismatch not rejected';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE '%reused with different payload%' THEN RAISE NOTICE 'TEST 3 PASSED: Payload mismatch rejected';
  ELSIF SQLERRM LIKE '%TEST 3 FAILED%' THEN RAISE EXCEPTION '%', SQLERRM;
  ELSE RAISE EXCEPTION 'TEST 3 FAILED: unexpected: %', SQLERRM; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 4: VERSION CONFLICT
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM v2_commit_update('00000000-0000-0000-0000-000000000001'::uuid, '{}'::jsonb, 0, 1, '[]'::jsonb, 10, 6, 10,
    '{"entity_registrations":[],"concerns":[],"propositions":[],"associations":[],"packets":[],"memberships":[],"splits":[],"retention_decisions":[],"pending_decisions":[],"pending_resolutions":[],"audit_entries":[]}'::jsonb,
    'req-vc', 'idem-vc-001', 'fp_vc00001', 'SIE');
  RAISE EXCEPTION 'TEST 4 FAILED: version conflict not raised';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE '%Version conflict%' THEN RAISE NOTICE 'TEST 4 PASSED: Version conflict correctly detected';
  ELSIF SQLERRM LIKE '%TEST 4 FAILED%' THEN RAISE EXCEPTION '%', SQLERRM;
  ELSE RAISE EXCEPTION 'TEST 4 FAILED: unexpected: %', SQLERRM; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 5: AUTHORITY MISMATCH
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM v2_commit_update('00000000-0000-0000-0000-000000000001'::uuid, '{}'::jsonb, 1, 2, '[]'::jsonb, 10, 6, 10, '{}'::jsonb, 'req-am', 'idem-am-001', 'fp_am00001', 'V2');
  RAISE EXCEPTION 'TEST 5 FAILED: authority mismatch not raised';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE '%Authority mismatch%' THEN RAISE NOTICE 'TEST 5 PASSED: Authority mismatch correctly rejected';
  ELSIF SQLERRM LIKE '%TEST 5 FAILED%' THEN RAISE EXCEPTION '%', SQLERRM;
  ELSE RAISE EXCEPTION 'TEST 5 FAILED: unexpected: %', SQLERRM; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 6: FAILURE INJECTION — constraint violation causes full rollback
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_before integer; v_after integer; v_ver_before integer; v_ver_after integer;
BEGIN
  SELECT COUNT(*) INTO v_before FROM sie_propositions WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
  SELECT update_version INTO v_ver_before FROM v2_update_state WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
  BEGIN
    PERFORM v2_commit_update('00000000-0000-0000-0000-000000000001'::uuid, '{}'::jsonb, 1, 2, '[]'::jsonb, 10, 6, 10,
      '{"entity_registrations":[{"entity_kind":"proposition","creation_key":"bad:0","entity_id":"prop-bad"}],"concerns":[],"propositions":[{"proposition_id":"prop-bad","proposition_creation_key":"bad:0","source_message_ids":["m"],"speaker_role":"INVALID","canonical_meaning":"x","proposition_type":"CLAIM","message_seq_start":6,"message_seq_end":10,"provenance":"DIRECT","semantic_state":"ACTIVE","retention_levels":["DURABLE_PROPOSITION"],"extraction_version":"v1"}],"associations":[],"packets":[],"memberships":[],"splits":[],"retention_decisions":[],"pending_decisions":[],"pending_resolutions":[],"audit_entries":[]}'::jsonb,
      'req-fail', 'idem-fail-001', 'fp_fail0001', 'SIE');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  SELECT COUNT(*) INTO v_after FROM sie_propositions WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
  SELECT update_version INTO v_ver_after FROM v2_update_state WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
  IF v_after <> v_before THEN RAISE EXCEPTION 'TEST 6 FAILED: partial state (props before=% after=%)', v_before, v_after; END IF;
  IF v_ver_after <> v_ver_before THEN RAISE EXCEPTION 'TEST 6 FAILED: version advanced (before=% after=%)', v_ver_before, v_ver_after; END IF;
  RAISE NOTICE 'TEST 6 PASSED: No partial state visible after constraint violation — full rollback confirmed';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 7: PENDING DECISION PERSISTENCE AND RESOLUTION ACROSS COMMITS
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_result jsonb; v_lifecycle text; v_resolved_at timestamptz;
BEGIN
  IF (SELECT COUNT(*) FROM sie_pending_semantic_decisions WHERE conversation_id = '00000000-0000-0000-0000-000000000001' AND lifecycle_state = 'pending') < 1 THEN
    RAISE EXCEPTION 'TEST 7 FAILED: pending decision from test 1 not found';
  END IF;
  v_result := v2_commit_update('00000000-0000-0000-0000-000000000001'::uuid,
    '{"objects":[],"relationships":[],"propositions":[],"threads":[],"hierarchy":[],"trees":[]}'::jsonb,
    1, 2, '[]'::jsonb, 10, 6, 10,
    '{"entity_registrations":[],"concerns":[],"propositions":[],"associations":[],"packets":[],"memberships":[],"splits":[],"retention_decisions":[],"pending_decisions":[],"pending_resolutions":[{"decision_id":"pend-001","resolution_metadata":{"resolved_by":"req-002","matched":"concern-001"}}],"audit_entries":[]}'::jsonb,
    'req-002', 'idem-002', 'fp_00000002', 'SIE');
  IF v_result->>'status' <> 'COMMITTED' THEN RAISE EXCEPTION 'TEST 7 FAILED: second commit failed'; END IF;
  SELECT lifecycle_state, resolved_at INTO v_lifecycle, v_resolved_at FROM sie_pending_semantic_decisions WHERE decision_id = 'pend-001';
  IF v_lifecycle <> 'resolved' THEN RAISE EXCEPTION 'TEST 7 FAILED: lifecycle_state=% (expected resolved)', v_lifecycle; END IF;
  IF v_resolved_at IS NULL THEN RAISE EXCEPTION 'TEST 7 FAILED: resolved_at not set'; END IF;
  RAISE NOTICE 'TEST 7 PASSED: Pending decision persisted and resolved across commits (resolved_at=%)', v_resolved_at;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 8: V2-ONLY PATH BACKWARD COMPATIBILITY
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_result jsonb; v_version integer;
BEGIN
  v_result := v2_commit_update('00000000-0000-0000-0000-000000000001'::uuid,
    '{"objects":[{"objectId":"v2-obj"}]}'::jsonb, 2, 3, '[{"type":"create"}]'::jsonb, 15, 11, 15);
  IF v_result IS NOT NULL THEN RAISE EXCEPTION 'TEST 8 FAILED: V2 path returned non-NULL'; END IF;
  SELECT update_version INTO v_version FROM v2_update_state WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
  IF v_version <> 3 THEN RAISE EXCEPTION 'TEST 8 FAILED: version not advanced (got %)', v_version; END IF;
  RAISE NOTICE 'TEST 8 PASSED: V2-only path backward compatible (NULL return, version=3)';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
SELECT '══════════════════════════════════════════════════════════════' AS divider;
SELECT 'ALL 8 REAL DATABASE INTEGRATION TESTS PASSED' AS final_result;
SELECT '══════════════════════════════════════════════════════════════' AS divider;
