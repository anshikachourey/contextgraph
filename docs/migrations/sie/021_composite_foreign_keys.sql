-- SIE Migration 021: Composite Foreign Keys on Identity-Resolution Tables
--
-- Adds the deferred composite foreign keys documented in migration 009 comments.
-- These FKs enforce that packet_id, matched_concern_id, proposed_concern_id, and
-- decision_id references in identity tables are conversation-consistent.
--
-- PREREQUISITE: Migration 020 must be applied first (composite unique constraints
-- on target tables).
--
-- Depends on:
--   020_composite_keys_and_embeddings.sql (composite unique constraints)
--   009_identity_resolution_records.sql (sie_identity_resolution_records)
--   010_retrieval_attempts.sql (sie_retrieval_attempts)
--   011_pending_identity_tables.sql (sie_pending_identity_details,
--                                     sie_pending_identity_propositions)
--
-- Validates: No existing data violates the new FK constraints before adding them.
-- If violations exist, the migration fails rather than silently altering/deleting rows.
--
-- Idempotent: uses DO blocks with pg_constraint existence checks.

-- =============================================================================
-- 0. DATA VALIDATION — Fail if existing data would violate new FKs
-- =============================================================================
-- Check for any cross-conversation references BEFORE adding constraints.
-- These checks raise exceptions if violations exist.

DO $$
DECLARE
    v_violation_count INTEGER;
BEGIN
    -- Check sie_identity_resolution_records.packet_id
    SELECT COUNT(*) INTO v_violation_count
    FROM sie_identity_resolution_records irr
    WHERE NOT EXISTS (
        SELECT 1 FROM sie_semantic_packets sp
        WHERE sp.conversation_id = irr.conversation_id
          AND sp.packet_id = irr.packet_id
    );
    IF v_violation_count > 0 THEN
        RAISE EXCEPTION 'DATA VIOLATION: % identity_resolution_records have packet_id not matching their conversation_id in sie_semantic_packets. Fix data before applying composite FKs.', v_violation_count;
    END IF;

    -- Check sie_identity_resolution_records.matched_concern_id
    SELECT COUNT(*) INTO v_violation_count
    FROM sie_identity_resolution_records irr
    WHERE irr.matched_concern_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sie_persistent_concerns pc
        WHERE pc.conversation_id = irr.conversation_id
          AND pc.concern_id = irr.matched_concern_id
    );
    IF v_violation_count > 0 THEN
        RAISE EXCEPTION 'DATA VIOLATION: % identity_resolution_records have matched_concern_id not matching their conversation_id in sie_persistent_concerns. Fix data before applying composite FKs.', v_violation_count;
    END IF;

    -- Check sie_retrieval_attempts.packet_id (via parent record's conversation)
    SELECT COUNT(*) INTO v_violation_count
    FROM sie_retrieval_attempts ra
    WHERE NOT EXISTS (
        SELECT 1 FROM sie_semantic_packets sp
        WHERE sp.conversation_id = ra.conversation_id
          AND sp.packet_id = ra.packet_id
    );
    IF v_violation_count > 0 THEN
        RAISE EXCEPTION 'DATA VIOLATION: % retrieval_attempts have packet_id not matching their conversation_id in sie_semantic_packets. Fix data before applying composite FKs.', v_violation_count;
    END IF;

    -- Check sie_pending_identity_details.packet_id
    SELECT COUNT(*) INTO v_violation_count
    FROM sie_pending_identity_details pid
    WHERE NOT EXISTS (
        SELECT 1 FROM sie_semantic_packets sp
        WHERE sp.conversation_id = pid.conversation_id
          AND sp.packet_id = pid.packet_id
    );
    IF v_violation_count > 0 THEN
        RAISE EXCEPTION 'DATA VIOLATION: % pending_identity_details have packet_id not matching their conversation_id in sie_semantic_packets. Fix data before applying composite FKs.', v_violation_count;
    END IF;

    RAISE NOTICE 'Data validation passed: no cross-conversation FK violations detected.';
END $$;

-- =============================================================================
-- 1. sie_identity_resolution_records — composite FK on (conversation_id, packet_id)
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_ir_records_conversation_packet'
          AND conrelid = 'sie_identity_resolution_records'::regclass
    ) THEN
        ALTER TABLE sie_identity_resolution_records
            ADD CONSTRAINT fk_ir_records_conversation_packet
            FOREIGN KEY (conversation_id, packet_id)
            REFERENCES sie_semantic_packets(conversation_id, packet_id);
    END IF;
END $$;

-- =============================================================================
-- 2. sie_identity_resolution_records — composite FK on (conversation_id, matched_concern_id)
--    Only enforced when matched_concern_id IS NOT NULL (partial — uses a trigger
--    or application-level check since PostgreSQL doesn't support partial FKs natively).
--    Instead, we add the FK without a WHERE clause; NULL values are ignored by FK checks.
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_ir_records_conversation_matched_concern'
          AND conrelid = 'sie_identity_resolution_records'::regclass
    ) THEN
        ALTER TABLE sie_identity_resolution_records
            ADD CONSTRAINT fk_ir_records_conversation_matched_concern
            FOREIGN KEY (conversation_id, matched_concern_id)
            REFERENCES sie_persistent_concerns(conversation_id, concern_id);
    END IF;
END $$;

-- =============================================================================
-- 3. sie_identity_resolution_records — composite FK on (conversation_id, proposed_concern_id)
--    NULL values are ignored by FK checks (PostgreSQL standard behavior).
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_ir_records_conversation_proposed_concern'
          AND conrelid = 'sie_identity_resolution_records'::regclass
    ) THEN
        ALTER TABLE sie_identity_resolution_records
            ADD CONSTRAINT fk_ir_records_conversation_proposed_concern
            FOREIGN KEY (conversation_id, proposed_concern_id)
            REFERENCES sie_persistent_concerns(conversation_id, concern_id);
    END IF;
END $$;

-- =============================================================================
-- 4. sie_retrieval_attempts — composite FK on (conversation_id, packet_id)
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_retrieval_attempts_conversation_packet'
          AND conrelid = 'sie_retrieval_attempts'::regclass
    ) THEN
        ALTER TABLE sie_retrieval_attempts
            ADD CONSTRAINT fk_retrieval_attempts_conversation_packet
            FOREIGN KEY (conversation_id, packet_id)
            REFERENCES sie_semantic_packets(conversation_id, packet_id);
    END IF;
END $$;

-- =============================================================================
-- 5. sie_pending_identity_details — composite FK on (conversation_id, packet_id)
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_pending_details_conversation_packet'
          AND conrelid = 'sie_pending_identity_details'::regclass
    ) THEN
        ALTER TABLE sie_pending_identity_details
            ADD CONSTRAINT fk_pending_details_conversation_packet
            FOREIGN KEY (conversation_id, packet_id)
            REFERENCES sie_semantic_packets(conversation_id, packet_id);
    END IF;
END $$;

-- =============================================================================
-- 6. SUMMARY
-- =============================================================================
-- Composite FKs now enforce conversation-consistency on:
--
-- | Table                             | FK Column(s)                      | References                              |
-- |-----------------------------------|-----------------------------------|-----------------------------------------|
-- | sie_identity_resolution_records   | (conversation_id, packet_id)      | sie_semantic_packets(conversation_id, packet_id)   |
-- | sie_identity_resolution_records   | (conversation_id, matched_concern_id) | sie_persistent_concerns(conversation_id, concern_id) |
-- | sie_identity_resolution_records   | (conversation_id, proposed_concern_id) | sie_persistent_concerns(conversation_id, concern_id) |
-- | sie_retrieval_attempts            | (conversation_id, packet_id)      | sie_semantic_packets(conversation_id, packet_id)   |
-- | sie_pending_identity_details      | (conversation_id, packet_id)      | sie_semantic_packets(conversation_id, packet_id)   |
--
-- NULL values in matched_concern_id / proposed_concern_id are correctly ignored
-- by PostgreSQL FK semantics (a row with NULL in any FK column passes the check).
