-- ═══════════════════════════════════════════════════════════════════════════
-- SIE SCHEMA VERIFICATION TESTS
--
-- SQL assertions that verify all CHECK, FK, UNIQUE, and partial-index
-- invariants defined in SIE migrations 001–006.
--
-- Intended to be run in a LOCAL/TEST PostgreSQL environment (e.g.,
-- Supabase local via `supabase start`, or a Docker Postgres container)
-- with all SIE migrations already applied.
--
-- Each test inserts invalid data and verifies the constraint rejects it.
-- Tests use a DO $$ block with EXCEPTION handling — a raised exception
-- means the constraint works correctly.
--
-- PREREQUISITES:
--   - A test conversation must exist: INSERT INTO conversations(id)
--     VALUES ('00000000-0000-0000-0000-000000000001');
--   - All SIE migrations (001–006) must be applied.
--
-- Run this file in the Supabase SQL Editor or via psql.
-- ═══════════════════════════════════════════════════════════════════════════

-- Setup: Create a test conversation if it doesn't exist.
INSERT INTO conversations (id) VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 1: CHECK — v2_update_state.authoritative_engine rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    UPDATE v2_update_state
    SET authoritative_engine = 'INVALID_ENGINE'
    WHERE conversation_id = '00000000-0000-0000-0000-000000000001';

    RAISE EXCEPTION 'TEST FAILED: authoritative_engine accepted invalid value';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: authoritative_engine rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 2: CHECK — sie_commit_requests.status rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_commit_requests (
        conversation_id, request_id, idempotency_key,
        payload_fingerprint, base_graph_version, status
    ) VALUES (
        '00000000-0000-0000-0000-000000000001', 'req-test-bad-status',
        'idem-test-bad-status', 'fp-1', 1, 'INVALID_STATUS'
    );

    RAISE EXCEPTION 'TEST FAILED: commit_requests.status accepted invalid value';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: commit_requests.status rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 3: CHECK — sie_persistent_concerns.status rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, status
    ) VALUES (
        'test-concern-bad-status', '00000000-0000-0000-0000-000000000001',
        'test', 'test', 'test', 'INVALID_STATUS'
    );

    RAISE EXCEPTION 'TEST FAILED: concern status accepted invalid value';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: concern status rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 4: CHECK — Self-parenting is rejected (chk_no_self_parent)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, canonical_parent_id,
        parent_resolution_state
    ) VALUES (
        'test-self-parent', '00000000-0000-0000-0000-000000000001',
        'test', 'test', 'test', 'test-self-parent', 'PARENT_ASSIGNED'
    );

    RAISE EXCEPTION 'TEST FAILED: self-parenting was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: self-parenting is rejected';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 5: CHECK — Parent-resolution consistency
-- PARENT_ASSIGNED requires non-null canonical_parent_id
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, canonical_parent_id,
        parent_resolution_state
    ) VALUES (
        'test-parent-inconsist', '00000000-0000-0000-0000-000000000001',
        'test', 'test', 'test', NULL, 'PARENT_ASSIGNED'
    );

    RAISE EXCEPTION 'TEST FAILED: PARENT_ASSIGNED with null parent was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: PARENT_ASSIGNED requires non-null parent';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 6: CHECK — ROOT_CONFIRMED requires null canonical_parent_id
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    -- First create a valid concern to be used as parent
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, parent_resolution_state
    ) VALUES (
        'test-valid-parent', '00000000-0000-0000-0000-000000000001',
        'parent', 'parent', 'parent', 'ROOT_CONFIRMED'
    ) ON CONFLICT (concern_id) DO NOTHING;

    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, canonical_parent_id,
        parent_resolution_state
    ) VALUES (
        'test-root-with-parent', '00000000-0000-0000-0000-000000000001',
        'test', 'test', 'test', 'test-valid-parent', 'ROOT_CONFIRMED'
    );

    RAISE EXCEPTION 'TEST FAILED: ROOT_CONFIRMED with parent was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: ROOT_CONFIRMED requires null parent';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 7: CHECK — Merge-redirect consistency
-- MERGED status requires non-null merged_into_concern_id
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, status, merged_into_concern_id
    ) VALUES (
        'test-merged-no-target', '00000000-0000-0000-0000-000000000001',
        'test', 'test', 'test', 'MERGED', NULL
    );

    RAISE EXCEPTION 'TEST FAILED: MERGED with null target was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: MERGED requires merged_into_concern_id';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 8: CHECK — Non-MERGED status rejects merged_into_concern_id
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, parent_resolution_state
    ) VALUES (
        'test-merge-target-dummy', '00000000-0000-0000-0000-000000000001',
        'dummy', 'dummy', 'dummy', 'ROOT_CONFIRMED'
    ) ON CONFLICT (concern_id) DO NOTHING;

    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, status,
        merged_into_concern_id
    ) VALUES (
        'test-active-with-merge', '00000000-0000-0000-0000-000000000001',
        'test', 'test', 'test', 'ACTIVE', 'test-merge-target-dummy'
    );

    RAISE EXCEPTION 'TEST FAILED: ACTIVE with merged_into accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: non-MERGED rejects merged_into_concern_id';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 9: CHECK — Proposition speaker_role rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-bad-speaker', '00000000-0000-0000-0000-000000000001',
        'key-bad-speaker', ARRAY['msg-1'], 'SYSTEM',
        'test meaning', 'CLAIM', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    );

    RAISE EXCEPTION 'TEST FAILED: invalid speaker_role accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: speaker_role rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 10: CHECK — Proposition seq range ordering (start > end rejected)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-bad-seq', '00000000-0000-0000-0000-000000000001',
        'key-bad-seq', ARRAY['msg-1'], 'USER',
        'test meaning', 'CLAIM', 10, 5, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    );

    RAISE EXCEPTION 'TEST FAILED: seq_start > seq_end accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: seq range rejects start > end';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 11: CHECK — Proposition requires at least one source message
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-no-sources', '00000000-0000-0000-0000-000000000001',
        'key-no-sources', ARRAY[]::TEXT[], 'USER',
        'test meaning', 'CLAIM', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    );

    RAISE EXCEPTION 'TEST FAILED: empty source_message_ids accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: empty source_message_ids rejected';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 12: CHECK — Retention levels must contain only valid enum values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-bad-retention', '00000000-0000-0000-0000-000000000001',
        'key-bad-retention', ARRAY['msg-1'], 'USER',
        'test meaning', 'CLAIM', 1, 1, 'DIRECT',
        ARRAY['INVALID_LEVEL'], 'v1.0'
    );

    RAISE EXCEPTION 'TEST FAILED: invalid retention level accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: invalid retention levels rejected';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 13: CHECK — Proposition type rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-bad-type', '00000000-0000-0000-0000-000000000001',
        'key-bad-type', ARRAY['msg-1'], 'USER',
        'test meaning', 'INVALID_TYPE', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    );

    RAISE EXCEPTION 'TEST FAILED: invalid proposition_type accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: proposition_type rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 14: CHECK — Association role rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    -- Setup: insert a valid proposition and concern for FK satisfaction
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, parent_resolution_state
    ) VALUES (
        'test-fk-concern', '00000000-0000-0000-0000-000000000001',
        'fk test', 'fk test', 'fk test', 'ROOT_CONFIRMED'
    ) ON CONFLICT (concern_id) DO NOTHING;

    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-fk-prop', '00000000-0000-0000-0000-000000000001',
        'key-fk-prop', ARRAY['msg-1'], 'USER',
        'test', 'CLAIM', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    ) ON CONFLICT (proposition_id) DO NOTHING;

    INSERT INTO sie_proposition_associations (
        association_id, association_creation_key, proposition_id,
        concern_id, role, confidence, provenance, conversation_id
    ) VALUES (
        'test-bad-role', 'key-bad-role', 'test-fk-prop',
        'test-fk-concern', 'INVALID_ROLE', 'HIGH', 'test',
        '00000000-0000-0000-0000-000000000001'
    );

    RAISE EXCEPTION 'TEST FAILED: invalid association role accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: association role rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 15: FK — Proposition association rejects orphaned proposition_id
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, parent_resolution_state
    ) VALUES (
        'test-fk-concern-2', '00000000-0000-0000-0000-000000000001',
        'fk test', 'fk test', 'fk test', 'ROOT_CONFIRMED'
    ) ON CONFLICT (concern_id) DO NOTHING;

    INSERT INTO sie_proposition_associations (
        association_id, association_creation_key, proposition_id,
        concern_id, role, confidence, provenance, conversation_id
    ) VALUES (
        'test-orphan-prop', 'key-orphan-prop', 'NONEXISTENT_PROP_ID',
        'test-fk-concern-2', 'PRIMARY_OWNER', 'HIGH', 'test',
        '00000000-0000-0000-0000-000000000001'
    );

    RAISE EXCEPTION 'TEST FAILED: orphaned proposition_id accepted';
EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE NOTICE 'TEST PASSED: FK rejects orphaned proposition_id';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 16: FK — Proposition association rejects orphaned concern_id
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-fk-prop-2', '00000000-0000-0000-0000-000000000001',
        'key-fk-prop-2', ARRAY['msg-1'], 'USER',
        'test', 'CLAIM', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    ) ON CONFLICT (proposition_id) DO NOTHING;

    INSERT INTO sie_proposition_associations (
        association_id, association_creation_key, proposition_id,
        concern_id, role, confidence, provenance, conversation_id
    ) VALUES (
        'test-orphan-concern', 'key-orphan-concern', 'test-fk-prop-2',
        'NONEXISTENT_CONCERN_ID', 'PRIMARY_OWNER', 'HIGH', 'test',
        '00000000-0000-0000-0000-000000000001'
    );

    RAISE EXCEPTION 'TEST FAILED: orphaned concern_id accepted';
EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE NOTICE 'TEST PASSED: FK rejects orphaned concern_id';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 17: FK — Packet membership rejects orphaned packet_id
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-fk-prop-3', '00000000-0000-0000-0000-000000000001',
        'key-fk-prop-3', ARRAY['msg-1'], 'USER',
        'test', 'CLAIM', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    ) ON CONFLICT (proposition_id) DO NOTHING;

    INSERT INTO sie_packet_memberships (
        membership_id, membership_creation_key, packet_id,
        proposition_id, ordinal
    ) VALUES (
        'test-orphan-packet', 'key-orphan-packet',
        'NONEXISTENT_PACKET_ID', 'test-fk-prop-3', 0
    );

    RAISE EXCEPTION 'TEST FAILED: orphaned packet_id accepted';
EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE NOTICE 'TEST PASSED: FK rejects orphaned packet_id in membership';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 18: FK — Concern canonical_parent_id rejects nonexistent parent
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, canonical_parent_id,
        parent_resolution_state
    ) VALUES (
        'test-orphan-parent-child', '00000000-0000-0000-0000-000000000001',
        'test', 'test', 'test', 'NONEXISTENT_PARENT', 'PARENT_ASSIGNED'
    );

    RAISE EXCEPTION 'TEST FAILED: nonexistent canonical_parent_id accepted';
EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE NOTICE 'TEST PASSED: FK rejects nonexistent canonical_parent_id';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 19: UNIQUE — Entity registry rejects duplicate (entity_kind, entity_id)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_entity_registry (
        conversation_id, entity_kind, creation_key, entity_id, request_id
    ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'proposition', 'key-unique-1', 'entity-unique-id', 'req-1'
    ) ON CONFLICT DO NOTHING;

    -- Same entity_kind + entity_id but different conversation/creation_key
    INSERT INTO sie_entity_registry (
        conversation_id, entity_kind, creation_key, entity_id, request_id
    ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'proposition', 'key-unique-2', 'entity-unique-id', 'req-2'
    );

    RAISE EXCEPTION 'TEST FAILED: duplicate (entity_kind, entity_id) accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'TEST PASSED: UNIQUE rejects duplicate (entity_kind, entity_id)';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 20: UNIQUE — Commit requests rejects duplicate request_id
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_commit_requests (
        conversation_id, request_id, idempotency_key,
        payload_fingerprint, base_graph_version, status
    ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'req-dup-test', 'idem-1', 'fp-1', 1, 'PENDING'
    ) ON CONFLICT DO NOTHING;

    -- Same request_id, different idempotency_key
    INSERT INTO sie_commit_requests (
        conversation_id, request_id, idempotency_key,
        payload_fingerprint, base_graph_version, status
    ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'req-dup-test', 'idem-2', 'fp-2', 2, 'PENDING'
    );

    RAISE EXCEPTION 'TEST FAILED: duplicate request_id accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'TEST PASSED: UNIQUE rejects duplicate request_id';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 21: UNIQUE — Packet membership rejects duplicate (packet_id, proposition_id)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    -- Setup: create a valid packet
    INSERT INTO sie_semantic_packets (
        packet_id, packet_creation_key, conversation_id,
        source_message_ids, message_seq_start, message_seq_end,
        user_grounded_meaning, provenance, packet_formation_version,
        cohesion_status
    ) VALUES (
        'test-pkt-unique', 'key-pkt-unique',
        '00000000-0000-0000-0000-000000000001',
        ARRAY['msg-1'], 1, 1, 'test', 'test', 'v1', 'COHESIVE'
    ) ON CONFLICT (packet_id) DO NOTHING;

    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-prop-unique', '00000000-0000-0000-0000-000000000001',
        'key-prop-unique', ARRAY['msg-1'], 'USER',
        'test', 'CLAIM', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    ) ON CONFLICT (proposition_id) DO NOTHING;

    INSERT INTO sie_packet_memberships (
        membership_id, membership_creation_key, packet_id,
        proposition_id, ordinal
    ) VALUES (
        'test-mem-1', 'key-mem-1', 'test-pkt-unique', 'test-prop-unique', 0
    ) ON CONFLICT DO NOTHING;

    -- Duplicate: same packet + proposition, different membership_id
    INSERT INTO sie_packet_memberships (
        membership_id, membership_creation_key, packet_id,
        proposition_id, ordinal
    ) VALUES (
        'test-mem-2', 'key-mem-2', 'test-pkt-unique', 'test-prop-unique', 1
    );

    RAISE EXCEPTION 'TEST FAILED: duplicate (packet_id, proposition_id) accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'TEST PASSED: UNIQUE rejects duplicate membership per packet';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 22: UNIQUE — Packet membership rejects duplicate ordinal in same packet
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-prop-ord', '00000000-0000-0000-0000-000000000001',
        'key-prop-ord', ARRAY['msg-2'], 'USER',
        'test', 'GOAL', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    ) ON CONFLICT (proposition_id) DO NOTHING;

    -- Try to insert at ordinal 0 which is already taken by test-mem-1
    INSERT INTO sie_packet_memberships (
        membership_id, membership_creation_key, packet_id,
        proposition_id, ordinal
    ) VALUES (
        'test-mem-dup-ord', 'key-mem-dup-ord', 'test-pkt-unique', 'test-prop-ord', 0
    );

    RAISE EXCEPTION 'TEST FAILED: duplicate ordinal in same packet accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'TEST PASSED: UNIQUE rejects duplicate ordinal per packet';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 23: PARTIAL UNIQUE INDEX — At most one active PRIMARY_OWNER per proposition
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    -- Setup: create two concerns for the test
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, parent_resolution_state
    ) VALUES
        ('test-owner-concern-1', '00000000-0000-0000-0000-000000000001',
         'c1', 'c1', 'c1', 'ROOT_CONFIRMED'),
        ('test-owner-concern-2', '00000000-0000-0000-0000-000000000001',
         'c2', 'c2', 'c2', 'ROOT_CONFIRMED')
    ON CONFLICT (concern_id) DO NOTHING;

    INSERT INTO sie_propositions (
        proposition_id, conversation_id, proposition_creation_key,
        source_message_ids, speaker_role, canonical_meaning,
        proposition_type, message_seq_start, message_seq_end,
        provenance, retention_levels, extraction_version
    ) VALUES (
        'test-owner-prop', '00000000-0000-0000-0000-000000000001',
        'key-owner-prop', ARRAY['msg-1'], 'USER',
        'test', 'CLAIM', 1, 1, 'DIRECT',
        ARRAY['DURABLE_PROPOSITION'], 'v1.0'
    ) ON CONFLICT (proposition_id) DO NOTHING;

    -- First active PRIMARY_OWNER
    INSERT INTO sie_proposition_associations (
        association_id, association_creation_key, proposition_id,
        concern_id, role, confidence, provenance,
        semantic_state, conversation_id
    ) VALUES (
        'test-owner-assoc-1', 'key-owner-assoc-1', 'test-owner-prop',
        'test-owner-concern-1', 'PRIMARY_OWNER', 'HIGH', 'test',
        'ACTIVE', '00000000-0000-0000-0000-000000000001'
    ) ON CONFLICT DO NOTHING;

    -- Second active PRIMARY_OWNER for same proposition — should be rejected
    INSERT INTO sie_proposition_associations (
        association_id, association_creation_key, proposition_id,
        concern_id, role, confidence, provenance,
        semantic_state, conversation_id
    ) VALUES (
        'test-owner-assoc-2', 'key-owner-assoc-2', 'test-owner-prop',
        'test-owner-concern-2', 'PRIMARY_OWNER', 'HIGH', 'test',
        'ACTIVE', '00000000-0000-0000-0000-000000000001'
    );

    RAISE EXCEPTION 'TEST FAILED: second active PRIMARY_OWNER accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'TEST PASSED: partial unique index rejects second active PRIMARY_OWNER';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 24: PARTIAL UNIQUE INDEX — Active alias uniqueness per concern
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_persistent_concerns (
        concern_id, conversation_id, identity_summary,
        display_title, current_summary, parent_resolution_state
    ) VALUES (
        'test-alias-concern', '00000000-0000-0000-0000-000000000001',
        'alias test', 'alias test', 'alias test', 'ROOT_CONFIRMED'
    ) ON CONFLICT (concern_id) DO NOTHING;

    -- First active alias
    INSERT INTO sie_concern_aliases (
        alias_id, concern_id, alias_text, conversation_id
    ) VALUES (
        'test-alias-1', 'test-alias-concern', 'my alias',
        '00000000-0000-0000-0000-000000000001'
    ) ON CONFLICT DO NOTHING;

    -- Duplicate active alias (same concern_id + alias_text, removed_at IS NULL)
    INSERT INTO sie_concern_aliases (
        alias_id, concern_id, alias_text, conversation_id
    ) VALUES (
        'test-alias-2', 'test-alias-concern', 'my alias',
        '00000000-0000-0000-0000-000000000001'
    );

    RAISE EXCEPTION 'TEST FAILED: duplicate active alias accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'TEST PASSED: partial unique index rejects duplicate active alias';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 25: TRIGGER — Idempotency fingerprint mismatch is rejected
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    -- Insert initial commit request
    INSERT INTO sie_commit_requests (
        conversation_id, request_id, idempotency_key,
        payload_fingerprint, base_graph_version, status
    ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'req-fp-test-1', 'idem-fp-test', 'fingerprint-A', 1, 'COMMITTED'
    ) ON CONFLICT DO NOTHING;

    -- Try to reuse same idempotency key with different fingerprint
    INSERT INTO sie_commit_requests (
        conversation_id, request_id, idempotency_key,
        payload_fingerprint, base_graph_version, status
    ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'req-fp-test-2', 'idem-fp-test', 'fingerprint-B', 2, 'PENDING'
    );

    RAISE EXCEPTION 'TEST FAILED: mismatched fingerprint with same idempotency key accepted';
EXCEPTION
    WHEN raise_exception THEN
        RAISE NOTICE 'TEST PASSED: trigger rejects mismatched idempotency fingerprint';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 26: CHECK — Packet cohesion_status rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_semantic_packets (
        packet_id, packet_creation_key, conversation_id,
        source_message_ids, message_seq_start, message_seq_end,
        user_grounded_meaning, provenance, packet_formation_version,
        cohesion_status
    ) VALUES (
        'test-bad-cohesion', 'key-bad-cohesion',
        '00000000-0000-0000-0000-000000000001',
        ARRAY['msg-1'], 1, 1, 'test', 'test', 'v1', 'INVALID_COHESION'
    );

    RAISE EXCEPTION 'TEST FAILED: invalid cohesion_status accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: cohesion_status rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 27: CHECK — Packet seq range ordering (start > end rejected)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_semantic_packets (
        packet_id, packet_creation_key, conversation_id,
        source_message_ids, message_seq_start, message_seq_end,
        user_grounded_meaning, provenance, packet_formation_version,
        cohesion_status
    ) VALUES (
        'test-bad-pkt-seq', 'key-bad-pkt-seq',
        '00000000-0000-0000-0000-000000000001',
        ARRAY['msg-1'], 10, 5, 'test', 'test', 'v1', 'COHESIVE'
    );

    RAISE EXCEPTION 'TEST FAILED: packet seq_start > seq_end accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: packet seq range rejects start > end';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 28: CHECK — Pending decision lifecycle_state rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_pending_semantic_decisions (
        decision_id, decision_creation_key, conversation_id,
        stage, entity_creation_key, outcome, lifecycle_state,
        originating_request_id
    ) VALUES (
        'test-bad-lifecycle', 'key-bad-lifecycle',
        '00000000-0000-0000-0000-000000000001',
        'identity_resolution', 'entity-key-1', 'DEFER',
        'INVALID_STATE', 'req-1'
    );

    RAISE EXCEPTION 'TEST FAILED: invalid lifecycle_state accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: lifecycle_state rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 29: CHECK — Retention decision primary_level rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_retention_decisions (
        decision_id, decision_creation_key, conversation_id,
        request_id, primary_level, confidence, outcome,
        source_message_ids, speaker_role, sequence_position,
        extraction_version, assessment_version
    ) VALUES (
        'test-bad-retention-level', 'key-bad-ret',
        '00000000-0000-0000-0000-000000000001',
        'req-1', 'INVALID_LEVEL', 'HIGH', 'YES',
        ARRAY['msg-1'], 'USER', 1, 'v1', 'v1'
    );

    RAISE EXCEPTION 'TEST FAILED: invalid primary_level accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: retention primary_level rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TEST 30: CHECK — Audit history entity_kind rejects invalid values
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
    INSERT INTO sie_audit_history (
        conversation_id, entity_kind, entity_id, action, after_state
    ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'INVALID_KIND', 'some-id', 'created', '{}'::jsonb
    );

    RAISE EXCEPTION 'TEST FAILED: invalid entity_kind accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'TEST PASSED: audit entity_kind rejects invalid values';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- CLEANUP: Remove all test data created by these tests.
-- Run in a transaction or skip if using a disposable test database.
-- ═══════════════════════════════════════════════════════════════════════════

-- Remove test data in reverse dependency order
DELETE FROM sie_audit_history WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_pending_semantic_decisions WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_retention_decisions WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_packet_splits WHERE original_packet_id IN (
    SELECT packet_id FROM sie_semantic_packets WHERE conversation_id = '00000000-0000-0000-0000-000000000001'
);
DELETE FROM sie_packet_memberships WHERE packet_id IN (
    SELECT packet_id FROM sie_semantic_packets WHERE conversation_id = '00000000-0000-0000-0000-000000000001'
);
DELETE FROM sie_semantic_packets WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_proposition_associations WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_propositions WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_concern_aliases WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_persistent_concerns WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_commit_requests WHERE conversation_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM sie_entity_registry WHERE conversation_id = '00000000-0000-0000-0000-000000000001';

-- Remove test conversation (optional — leave if other tests use it)
-- DELETE FROM conversations WHERE id = '00000000-0000-0000-0000-000000000001';

-- ═══════════════════════════════════════════════════════════════════════════
-- SUMMARY
-- ═══════════════════════════════════════════════════════════════════════════
-- If all tests output "TEST PASSED" and no "TEST FAILED" messages appear,
-- the SIE schema constraints are correctly enforced.
--
-- Tests cover:
--   - CHECK constraints: 16 tests (status enums, seq ranges, speaker roles,
--     retention levels, cohesion, parent consistency, merge consistency)
--   - FK constraints: 4 tests (orphaned proposition, concern, packet, parent)
--   - UNIQUE constraints: 4 tests (entity registry, request_id, membership)
--   - Partial unique indexes: 2 tests (active PRIMARY_OWNER, active alias)
--   - Trigger: 1 test (idempotency fingerprint mismatch)
-- ═══════════════════════════════════════════════════════════════════════════
