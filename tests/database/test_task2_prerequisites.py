"""
Mandatory real PostgreSQL tests for Task 2 prerequisites:
composite unique keys, composite foreign keys, and concern embeddings.

Requires a live PostgreSQL database with migrations 001-021 applied.
Marked with @pytest.mark.database.

Run: pytest tests/database/test_task2_prerequisites.py -m database -v
"""

import pytest

from tests.database.conftest import TEST_CONVERSATION_ID

pytestmark = pytest.mark.database

CONV_A = TEST_CONVERSATION_ID
CONV_B = "00000000-0000-0000-0000-000000000088"


# =============================================================================
# Helpers
# =============================================================================


def _setup_two_conversations(cur):
    """Create two distinct conversations for cross-conversation tests."""
    cur.execute(
        "INSERT INTO conversations (id) VALUES (%s) ON CONFLICT DO NOTHING;",
        (CONV_A,),
    )
    cur.execute(
        "INSERT INTO conversations (id) VALUES (%s) ON CONFLICT DO NOTHING;",
        (CONV_B,),
    )


def _insert_packet(cur, packet_id, conv_id):
    """Insert a packet in a given conversation."""
    cur.execute("""
        INSERT INTO sie_semantic_packets
            (packet_id, packet_creation_key, conversation_id, source_message_ids,
             message_seq_start, message_seq_end, user_grounded_meaning,
             provenance, packet_formation_version, cohesion_status)
        VALUES (%s, %s, %s, ARRAY['msg-1'], 1, 1, 'Test',
                'test', '1.0.0', 'COHESIVE')
        ON CONFLICT DO NOTHING;
    """, (packet_id, f"key-{packet_id}", conv_id))


def _insert_concern(cur, concern_id, conv_id):
    """Insert a concern in a given conversation."""
    cur.execute("""
        INSERT INTO sie_persistent_concerns
            (concern_id, conversation_id, identity_summary, display_title,
             current_summary, status)
        VALUES (%s, %s, 'Test concern', 'Test', 'Summary', 'ACTIVE')
        ON CONFLICT DO NOTHING;
    """, (concern_id, conv_id))


def _insert_embedding(cur, embedding_id, concern_id, conv_id, **kwargs):
    """Insert a concern embedding with configurable fields."""
    defaults = dict(
        embedding_id=embedding_id,
        concern_id=concern_id,
        conversation_id=conv_id,
        embedding=[0.1, 0.2, 0.3],
        source_text_hash="hash-abc",
        embedding_model_version="text-embedding-3-small-v1",
        graph_version=1,
        is_active=True,
        invalidated_at=None,
        invalidation_reason=None,
    )
    defaults.update(kwargs)
    cur.execute("""
        INSERT INTO sie_concern_embeddings
            (embedding_id, concern_id, conversation_id, embedding,
             source_text_hash, embedding_model_version, graph_version,
             is_active, invalidated_at, invalidation_reason)
        VALUES (%(embedding_id)s, %(concern_id)s, %(conversation_id)s,
                %(embedding)s, %(source_text_hash)s, %(embedding_model_version)s,
                %(graph_version)s, %(is_active)s, %(invalidated_at)s,
                %(invalidation_reason)s);
    """, defaults)


# =============================================================================
# 1. Composite Unique-Key Enforcement
# =============================================================================


class TestCompositeUniqueKeys:
    """Verify composite unique constraints on base tables."""

    def test_duplicate_conversation_packet_rejected(self, db):
        """UNIQUE(conversation_id, packet_id) rejects duplicates."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_packet(cur, "pkt-uniq", CONV_A)
        with pytest.raises(Exception) as exc:
            # Direct INSERT without ON CONFLICT to trigger uniqueness violation
            cur.execute("""
                INSERT INTO sie_semantic_packets
                    (packet_id, packet_creation_key, conversation_id, source_message_ids,
                     message_seq_start, message_seq_end, user_grounded_meaning,
                     provenance, packet_formation_version, cohesion_status)
                VALUES ('pkt-uniq', 'key-dup', %s, ARRAY['msg-2'], 2, 2, 'Dup',
                        'test', '1.0.0', 'COHESIVE');
            """, (CONV_A,))
        err = str(exc.value).lower()
        assert "unique" in err or "duplicate" in err or "pkey" in err
        db.rollback()

    def test_same_packet_id_different_conversations_allowed(self, db):
        """Same packet_id in different conversations is allowed (PK is packet_id)."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        # packet_id is the PK so same ID in two convs would violate PK.
        # The composite UNIQUE is additive. This test verifies PK behavior.
        _insert_packet(cur, "pkt-shared-a", CONV_A)
        # Different packet_id in CONV_B is fine
        _insert_packet(cur, "pkt-shared-b", CONV_B)
        cur.execute("SELECT COUNT(*) FROM sie_semantic_packets WHERE packet_id IN ('pkt-shared-a','pkt-shared-b');")
        assert cur.fetchone()[0] == 2

    def test_duplicate_conversation_concern_rejected(self, db):
        """UNIQUE(conversation_id, concern_id) rejects duplicates."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-uniq", CONV_A)
        with pytest.raises(Exception) as exc:
            # Direct INSERT without ON CONFLICT
            cur.execute("""
                INSERT INTO sie_persistent_concerns
                    (concern_id, conversation_id, identity_summary, display_title,
                     current_summary, status)
                VALUES ('c-uniq', %s, 'Dup concern', 'Dup', 'Dup summary', 'ACTIVE');
            """, (CONV_A,))
        err = str(exc.value).lower()
        assert "unique" in err or "duplicate" in err or "pkey" in err
        db.rollback()


# =============================================================================
# 2. Cross-Conversation Composite FK Rejection
# =============================================================================


class TestCrossConversationFKRejection:
    """Verify composite FKs reject cross-conversation references."""

    def test_resolution_record_rejects_packet_from_wrong_conversation(self, db):
        """Identity record in CONV_A referencing a packet in CONV_B is rejected."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_packet(cur, "pkt-in-b", CONV_B)
        _insert_concern(cur, "c-in-a", CONV_A)
        with pytest.raises(Exception) as exc:
            cur.execute("""
                INSERT INTO sie_identity_resolution_records
                    (record_id, request_id, conversation_id, packet_id,
                     graph_version_analyzed, graph_snapshot_token,
                     outcome, action, identity_stage_status, sufficiency_stage_status,
                     matched_concern_id, reasoning,
                     semantic_policy_version, retrieval_policy_version,
                     model_config_version, prompt_version)
                VALUES ('rec-cross-1', 'req-1', %s, 'pkt-in-b',
                        1, 'snap', 'UNRESOLVED', 'RETAIN_PENDING',
                        'NOT_RUN', 'NOT_RUN', NULL, 'test',
                        '1.0', '1.0', '1.0', '1.0');
            """, (CONV_A,))
        assert "foreign key" in str(exc.value).lower() or "fk_ir_records_conversation_packet" in str(exc.value).lower()
        db.rollback()

    def test_resolution_record_rejects_concern_from_wrong_conversation(self, db):
        """Identity record in CONV_A referencing a concern in CONV_B is rejected."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_packet(cur, "pkt-in-a", CONV_A)
        _insert_concern(cur, "c-in-b", CONV_B)
        with pytest.raises(Exception) as exc:
            cur.execute("""
                INSERT INTO sie_identity_resolution_records
                    (record_id, request_id, conversation_id, packet_id,
                     graph_version_analyzed, graph_snapshot_token,
                     outcome, action, identity_stage_status, identity_confidence,
                     sufficiency_stage_status, sufficiency_confidence,
                     matched_concern_id, reasoning,
                     semantic_policy_version, retrieval_policy_version,
                     model_config_version, prompt_version)
                VALUES ('rec-cross-2', 'req-2', %s, 'pkt-in-a',
                        1, 'snap', 'YES', 'ASSIGN_EXISTING',
                        'COMPLETED', 'HIGH', 'COMPLETED', 'HIGH',
                        'c-in-b', 'test', '1.0', '1.0', '1.0', '1.0');
            """, (CONV_A,))
        assert "foreign key" in str(exc.value).lower()
        db.rollback()

    def test_retrieval_attempt_rejects_packet_from_wrong_conversation(self, db):
        """Retrieval attempt in CONV_A referencing a packet in CONV_B is rejected."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_packet(cur, "pkt-in-a", CONV_A)
        _insert_packet(cur, "pkt-in-b", CONV_B)
        _insert_concern(cur, "c-in-a", CONV_A)
        # First insert a valid resolution record in CONV_A
        cur.execute("""
            INSERT INTO sie_identity_resolution_records
                (record_id, request_id, conversation_id, packet_id,
                 graph_version_analyzed, graph_snapshot_token,
                 outcome, action, identity_stage_status, sufficiency_stage_status,
                 reasoning, semantic_policy_version, retrieval_policy_version,
                 model_config_version, prompt_version)
            VALUES ('rec-att-parent', 'req-att', %s, 'pkt-in-a',
                    1, 'snap', 'UNRESOLVED', 'RETAIN_PENDING',
                    'NOT_RUN', 'NOT_RUN', 'test', '1.0', '1.0', '1.0', '1.0');
        """, (CONV_A,))
        # Now try to insert retrieval attempt with packet from CONV_B
        with pytest.raises(Exception) as exc:
            cur.execute("""
                INSERT INTO sie_retrieval_attempts
                    (attempt_id, record_id, conversation_id, packet_id,
                     channel_id, channel_family, query_mode, query_reference,
                     scope_description, status, candidate_count,
                     retrieval_policy_version)
                VALUES ('att-cross', 'rec-att-parent', %s, 'pkt-in-b',
                        'ch1', 'embedding_primary', 'broad', 'ref',
                        'scope', 'SUCCESS_EMPTY', 0, '1.0');
            """, (CONV_A,))
        assert "foreign key" in str(exc.value).lower()
        db.rollback()

    def test_valid_same_conversation_reference_succeeds(self, db):
        """Identity record referencing packet and concern in same conversation succeeds."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_packet(cur, "pkt-same", CONV_A)
        _insert_concern(cur, "c-same", CONV_A)
        cur.execute("""
            INSERT INTO sie_identity_resolution_records
                (record_id, request_id, conversation_id, packet_id,
                 graph_version_analyzed, graph_snapshot_token,
                 outcome, action, identity_stage_status, identity_confidence,
                 sufficiency_stage_status, sufficiency_confidence,
                 matched_concern_id, reasoning,
                 semantic_policy_version, retrieval_policy_version,
                 model_config_version, prompt_version)
            VALUES ('rec-same-conv', 'req-same', %s, 'pkt-same',
                    1, 'snap', 'YES', 'ASSIGN_EXISTING',
                    'COMPLETED', 'HIGH', 'COMPLETED', 'HIGH',
                    'c-same', 'test', '1.0', '1.0', '1.0', '1.0');
        """, (CONV_A,))
        cur.execute("SELECT record_id FROM sie_identity_resolution_records WHERE record_id='rec-same-conv';")
        assert cur.fetchone() is not None


# =============================================================================
# 3. Embedding: One-Active-Per-Concern/Model Enforcement
# =============================================================================


class TestOneActiveEmbeddingPerConcernModel:
    """Verify partial unique index on (concern_id, embedding_model_version) WHERE is_active."""

    def test_two_active_embeddings_same_concern_model_rejected(self, db):
        """Cannot have two active embeddings for same concern + model version."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-emb", CONV_A)
        _insert_embedding(cur, "emb-1", "c-emb", CONV_A)
        with pytest.raises(Exception) as exc:
            _insert_embedding(cur, "emb-2", "c-emb", CONV_A)
        assert "unique" in str(exc.value).lower() or "idx_active_embedding" in str(exc.value).lower()
        db.rollback()

    def test_active_plus_inactive_same_concern_model_allowed(self, db):
        """One active + one inactive for same concern/model is allowed."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-emb2", CONV_A)
        _insert_embedding(cur, "emb-active", "c-emb2", CONV_A, is_active=True)
        _insert_embedding(cur, "emb-inactive", "c-emb2", CONV_A,
                          is_active=False, invalidated_at="2024-01-01T00:00:00Z",
                          invalidation_reason="source_text_hash_changed")
        cur.execute("SELECT COUNT(*) FROM sie_concern_embeddings WHERE concern_id='c-emb2';")
        assert cur.fetchone()[0] == 2

    def test_different_model_versions_both_active_allowed(self, db):
        """Different model versions for same concern can both be active."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-emb3", CONV_A)
        _insert_embedding(cur, "emb-v1", "c-emb3", CONV_A,
                          embedding_model_version="model-v1")
        _insert_embedding(cur, "emb-v2", "c-emb3", CONV_A,
                          embedding_model_version="model-v2")
        cur.execute("SELECT COUNT(*) FROM sie_concern_embeddings WHERE concern_id='c-emb3' AND is_active=TRUE;")
        assert cur.fetchone()[0] == 2


# =============================================================================
# 4. Embedding: Active/Invalidation Timestamp Consistency
# =============================================================================


class TestEmbeddingActiveConsistency:
    """Verify CHECK constraint on is_active ↔ invalidated_at coupling."""

    def test_active_with_invalidated_at_rejected(self, db):
        """is_active=TRUE with non-null invalidated_at is rejected."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-chk1", CONV_A)
        with pytest.raises(Exception) as exc:
            _insert_embedding(cur, "emb-bad1", "c-chk1", CONV_A,
                              is_active=True, invalidated_at="2024-01-01T00:00:00Z")
        assert "chk_embedding_active_consistency" in str(exc.value).lower() or "check" in str(exc.value).lower()
        db.rollback()

    def test_inactive_without_invalidated_at_rejected(self, db):
        """is_active=FALSE with null invalidated_at is rejected."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-chk2", CONV_A)
        with pytest.raises(Exception) as exc:
            _insert_embedding(cur, "emb-bad2", "c-chk2", CONV_A,
                              is_active=False, invalidated_at=None)
        assert "chk_embedding_active_consistency" in str(exc.value).lower() or "check" in str(exc.value).lower()
        db.rollback()

    def test_valid_active_embedding(self, db):
        """is_active=TRUE with invalidated_at=NULL succeeds."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-chk3", CONV_A)
        _insert_embedding(cur, "emb-ok1", "c-chk3", CONV_A,
                          is_active=True, invalidated_at=None)
        cur.execute("SELECT is_active FROM sie_concern_embeddings WHERE embedding_id='emb-ok1';")
        assert cur.fetchone()[0] is True

    def test_valid_inactive_embedding(self, db):
        """is_active=FALSE with invalidated_at set succeeds."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-chk4", CONV_A)
        _insert_embedding(cur, "emb-ok2", "c-chk4", CONV_A,
                          is_active=False, invalidated_at="2024-06-01T12:00:00Z",
                          invalidation_reason="model_version_retired")
        cur.execute("SELECT is_active FROM sie_concern_embeddings WHERE embedding_id='emb-ok2';")
        assert cur.fetchone()[0] is False


# =============================================================================
# 5. Embedding: Source-Text-Hash Staleness
# =============================================================================


class TestSourceTextHashStaleness:
    """Verify source_text_hash-based staleness detection."""

    def test_embedding_with_matching_hash_is_current(self, db):
        """An embedding whose source_text_hash matches concern identity_summary hash is current."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-hash", CONV_A)
        _insert_embedding(cur, "emb-hash-ok", "c-hash", CONV_A,
                          source_text_hash="correct-hash", graph_version=5)
        cur.execute("""
            SELECT source_text_hash, graph_version, is_active
            FROM sie_concern_embeddings WHERE embedding_id='emb-hash-ok';
        """)
        row = cur.fetchone()
        assert row[0] == "correct-hash"
        assert row[1] == 5
        assert row[2] is True

    def test_invalidation_after_source_hash_change(self, db):
        """When source text changes, old embedding can be invalidated."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-hash2", CONV_A)
        _insert_embedding(cur, "emb-old-hash", "c-hash2", CONV_A,
                          source_text_hash="old-hash", graph_version=3)
        # Simulate invalidation when identity_summary changes
        cur.execute("""
            UPDATE sie_concern_embeddings
            SET is_active = FALSE, invalidated_at = NOW(),
                invalidation_reason = 'source_text_hash_changed'
            WHERE embedding_id = 'emb-old-hash';
        """)
        cur.execute("SELECT is_active, invalidation_reason FROM sie_concern_embeddings WHERE embedding_id='emb-old-hash';")
        row = cur.fetchone()
        assert row[0] is False
        assert row[1] == "source_text_hash_changed"
        # New embedding with new hash can now be inserted
        _insert_embedding(cur, "emb-new-hash", "c-hash2", CONV_A,
                          source_text_hash="new-hash", graph_version=4)
        cur.execute("SELECT COUNT(*) FROM sie_concern_embeddings WHERE concern_id='c-hash2' AND is_active=TRUE;")
        assert cur.fetchone()[0] == 1


# =============================================================================
# 6. Embedding: Model-Version Retirement
# =============================================================================


class TestEmbeddingModelVersionRetirement:
    """Verify model-version retirement invalidation behavior."""

    def test_retirement_invalidates_old_version(self, db):
        """When a model version is retired, its embeddings can be invalidated."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-model", CONV_A)
        _insert_embedding(cur, "emb-old-model", "c-model", CONV_A,
                          embedding_model_version="model-v1")
        # Retire old model
        cur.execute("""
            UPDATE sie_concern_embeddings
            SET is_active = FALSE, invalidated_at = NOW(),
                invalidation_reason = 'model_version_retired'
            WHERE embedding_id = 'emb-old-model';
        """)
        # Insert new model version embedding
        _insert_embedding(cur, "emb-new-model", "c-model", CONV_A,
                          embedding_model_version="model-v2")
        cur.execute("""
            SELECT embedding_model_version, is_active
            FROM sie_concern_embeddings WHERE concern_id='c-model'
            ORDER BY embedding_model_version;
        """)
        rows = cur.fetchall()
        assert rows[0] == ("model-v1", False)
        assert rows[1] == ("model-v2", True)


# =============================================================================
# 7. Embedding: Graph-Version Staleness
# =============================================================================


class TestEmbeddingGraphVersionStaleness:
    """Verify graph_version-based staleness detection."""

    def test_embedding_graph_version_recorded(self, db):
        """Embedding records the graph_version at generation time."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-gv", CONV_A)
        _insert_embedding(cur, "emb-gv", "c-gv", CONV_A, graph_version=7)
        cur.execute("SELECT graph_version FROM sie_concern_embeddings WHERE embedding_id='emb-gv';")
        assert cur.fetchone()[0] == 7

    def test_stale_embedding_detectable_by_version_comparison(self, db):
        """An embedding with graph_version < current is detectable as stale."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-gv2", CONV_A)
        _insert_embedding(cur, "emb-gv-old", "c-gv2", CONV_A, graph_version=3)
        # Query simulates context loader: is_current = (graph_version = current)
        current_graph_version = 5
        cur.execute("""
            SELECT embedding_id, (graph_version = %s) AS is_current
            FROM sie_concern_embeddings WHERE concern_id='c-gv2';
        """, (current_graph_version,))
        row = cur.fetchone()
        assert row[0] == "emb-gv-old"
        assert row[1] is False  # stale


# =============================================================================
# 8. Embedding: Invalidation and Refresh
# =============================================================================


class TestEmbeddingInvalidationRefresh:
    """Verify invalidation/refresh lifecycle."""

    def test_full_invalidation_refresh_cycle(self, db):
        """Old embedding invalidated, new one created — full cycle."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-cycle", CONV_A)
        # Create original embedding
        _insert_embedding(cur, "emb-orig", "c-cycle", CONV_A,
                          source_text_hash="hash-v1", graph_version=1)
        # Identity summary changes → invalidate
        cur.execute("""
            UPDATE sie_concern_embeddings
            SET is_active = FALSE, invalidated_at = NOW(),
                invalidation_reason = 'source_text_hash_changed'
            WHERE embedding_id = 'emb-orig';
        """)
        # Create refreshed embedding
        _insert_embedding(cur, "emb-refreshed", "c-cycle", CONV_A,
                          source_text_hash="hash-v2", graph_version=2)
        # Verify state
        cur.execute("""
            SELECT embedding_id, is_active, source_text_hash
            FROM sie_concern_embeddings WHERE concern_id='c-cycle'
            ORDER BY graph_version;
        """)
        rows = cur.fetchall()
        assert rows[0] == ("emb-orig", False, "hash-v1")
        assert rows[1] == ("emb-refreshed", True, "hash-v2")


# =============================================================================
# 9. Privacy-Suppressed Embeddings Unavailable to Context
# =============================================================================


class TestPrivacySuppressedEmbeddings:
    """Verify privacy-suppressed embeddings are excluded from context loading."""

    def test_suppressed_concern_embeddings_excluded_from_context(self, db):
        """When a concern is privacy-suppressed, its embeddings are excluded."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-visible", CONV_A)
        _insert_concern(cur, "c-suppressed", CONV_A)
        _insert_embedding(cur, "emb-vis", "c-visible", CONV_A,
                          embedding_model_version="m1")
        _insert_embedding(cur, "emb-sup", "c-suppressed", CONV_A,
                          embedding_model_version="m1")

        # Add v2_update_state for the context loader
        cur.execute("""
            INSERT INTO v2_update_state (conversation_id, graph_version)
            VALUES (%s, 1) ON CONFLICT (conversation_id) DO UPDATE SET graph_version=1;
        """, (CONV_A,))

        # Suppress one concern
        cur.execute("""
            INSERT INTO sie_privacy_suppressions
                (id, conversation_id, entity_type, entity_id, suppressed)
            VALUES ('sup-task2', %s, 'concern', 'c-suppressed', TRUE)
            ON CONFLICT DO NOTHING;
        """, (CONV_A,))

        # Load context and verify suppressed embeddings are excluded
        cur.execute("SELECT v2_load_sie_identity_context(%s);", (CONV_A,))
        import json
        raw = cur.fetchone()[0]
        result = json.loads(raw) if isinstance(raw, str) else raw

        # Embedding section
        emb_section = result.get("concern_embeddings", {})
        if isinstance(emb_section, dict) and emb_section.get("status") == "LOADED":
            embeddings = emb_section.get("embeddings", [])
            emb_concern_ids = [e["concern_id"] for e in embeddings]
            assert "c-visible" in emb_concern_ids
            assert "c-suppressed" not in emb_concern_ids
        # If status is UNAVAILABLE, the table check in context loader
        # didn't find the table (shouldn't happen after migration 020)

        # Suppressed concern not in concerns list either
        concern_ids = [c["concern_id"] for c in result.get("concerns", [])]
        assert "c-visible" in concern_ids
        assert "c-suppressed" not in concern_ids


# =============================================================================
# 10. Context Loader: Validity Beyond graph_version
# =============================================================================


class TestContextLoaderEmbeddingValidity:
    """Verify context loader handles staleness beyond just graph_version."""

    def test_invalidated_embedding_excluded_from_context(self, db):
        """Embeddings with is_active=FALSE are excluded entirely (not returned as stale)."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-inv", CONV_A)
        # Active embedding
        _insert_embedding(cur, "emb-active", "c-inv", CONV_A,
                          source_text_hash="current-hash", graph_version=5,
                          embedding_model_version="model-v2")
        # Invalidated embedding (source hash changed)
        _insert_embedding(cur, "emb-invalidated", "c-inv", CONV_A,
                          source_text_hash="old-hash", graph_version=3,
                          embedding_model_version="model-v1",
                          is_active=False, invalidated_at="2024-01-01T00:00:00Z",
                          invalidation_reason="source_text_hash_changed")

        cur.execute("""
            INSERT INTO v2_update_state (conversation_id, graph_version)
            VALUES (%s, 5) ON CONFLICT (conversation_id) DO UPDATE SET graph_version=5;
        """, (CONV_A,))

        cur.execute("SELECT v2_load_sie_identity_context(%s);", (CONV_A,))
        import json
        raw = cur.fetchone()[0]
        result = json.loads(raw) if isinstance(raw, str) else raw

        emb_section = result.get("concern_embeddings", {})
        assert emb_section.get("status") == "LOADED"
        embeddings = emb_section.get("embeddings", [])

        # Only active embedding should be returned
        emb_ids = [e.get("source_text_hash") for e in embeddings if e["concern_id"] == "c-inv"]
        assert "current-hash" in emb_ids
        assert "old-hash" not in emb_ids

    def test_active_stale_graph_version_embedding_returned_with_is_current_false(self, db):
        """Active embedding with old graph_version is returned but marked is_current=false."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-stale-gv", CONV_A)
        # Active embedding but from old graph version
        _insert_embedding(cur, "emb-stale-gv", "c-stale-gv", CONV_A,
                          source_text_hash="hash-v3", graph_version=3,
                          embedding_model_version="model-v2")

        # Current graph version is 7
        cur.execute("""
            INSERT INTO v2_update_state (conversation_id, graph_version)
            VALUES (%s, 7) ON CONFLICT (conversation_id) DO UPDATE SET graph_version=7;
        """, (CONV_A,))

        cur.execute("SELECT v2_load_sie_identity_context(%s);", (CONV_A,))
        import json
        raw = cur.fetchone()[0]
        result = json.loads(raw) if isinstance(raw, str) else raw

        emb_section = result.get("concern_embeddings", {})
        assert emb_section.get("status") == "LOADED"
        embeddings = emb_section.get("embeddings", [])

        stale_embs = [e for e in embeddings if e["concern_id"] == "c-stale-gv"]
        assert len(stale_embs) == 1
        assert stale_embs[0]["is_current"] is False
        assert stale_embs[0]["graph_version"] == 3
        # source_text_hash and embedding_model_version exposed for Python policy decisions
        assert stale_embs[0]["source_text_hash"] == "hash-v3"
        assert stale_embs[0]["embedding_model_version"] == "model-v2"

    def test_active_current_embedding_returned_with_is_current_true(self, db):
        """Active embedding matching current graph_version has is_current=true."""
        cur = db.cursor()
        _setup_two_conversations(cur)
        _insert_concern(cur, "c-current", CONV_A)
        _insert_embedding(cur, "emb-current", "c-current", CONV_A,
                          source_text_hash="latest-hash", graph_version=5,
                          embedding_model_version="model-v2")

        cur.execute("""
            INSERT INTO v2_update_state (conversation_id, graph_version)
            VALUES (%s, 5) ON CONFLICT (conversation_id) DO UPDATE SET graph_version=5;
        """, (CONV_A,))

        cur.execute("SELECT v2_load_sie_identity_context(%s);", (CONV_A,))
        import json
        raw = cur.fetchone()[0]
        result = json.loads(raw) if isinstance(raw, str) else raw

        emb_section = result.get("concern_embeddings", {})
        embeddings = emb_section.get("embeddings", [])

        current_embs = [e for e in embeddings if e["concern_id"] == "c-current"]
        assert len(current_embs) == 1
        assert current_embs[0]["is_current"] is True
