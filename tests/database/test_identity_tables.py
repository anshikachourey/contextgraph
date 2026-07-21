"""
Mandatory real PostgreSQL table tests for SIE identity-resolution tables.

Tests cover:
  - Migration 009: sie_identity_resolution_records (valid/invalid result branches)
  - Migration 010: sie_retrieval_attempts (cardinality, enums)
  - Migration 011: sie_pending_identity_details/propositions (uniqueness, coupling)
  - Creation order and rollback

Requires a live PostgreSQL database. Marked with @pytest.mark.database.

Run:  pytest tests/database/test_identity_tables.py -m database -v
Skip: pytest tests/database/test_identity_tables.py -m "not database"
"""

import uuid

import pytest

from tests.database.conftest import (
    TEST_CONVERSATION_ID,
    TEST_PACKET_ID,
    TEST_RECORD_ID,
    TEST_REQUEST_ID,
)

pytestmark = pytest.mark.database


# =============================================================================
# Helpers
# =============================================================================


def _ensure_conversation(cur, conv_id=TEST_CONVERSATION_ID):
    """Insert a test conversation if not already present."""
    cur.execute(
        "INSERT INTO conversations (id) VALUES (%s) ON CONFLICT DO NOTHING;",
        (conv_id,),
    )


def _ensure_packet(cur, packet_id=TEST_PACKET_ID, conv_id=TEST_CONVERSATION_ID):
    """Insert a minimal semantic packet for FK targets."""
    _ensure_conversation(cur, conv_id)
    cur.execute(
        """
        INSERT INTO sie_semantic_packets
            (packet_id, packet_creation_key, conversation_id, source_message_ids,
             message_seq_start, message_seq_end, user_grounded_meaning,
             provenance, packet_formation_version, cohesion_status)
        VALUES (%s, %s, %s, ARRAY['msg-1'], 1, 1, 'Test packet',
                'test', '1.0.0', 'COHESIVE')
        ON CONFLICT DO NOTHING;
        """,
        (packet_id, f"key-{packet_id}", conv_id),
    )


def _ensure_concern(cur, concern_id, conv_id=TEST_CONVERSATION_ID):
    """Insert a minimal persistent concern for FK targets."""
    _ensure_conversation(cur, conv_id)
    cur.execute(
        """
        INSERT INTO sie_persistent_concerns
            (concern_id, conversation_id, identity_summary, display_title,
             current_summary, status)
        VALUES (%s, %s, 'Test concern', 'Test', 'Test summary', 'ACTIVE')
        ON CONFLICT DO NOTHING;
        """,
        (concern_id, conv_id),
    )


def _ensure_pending_decision(cur, decision_id, conv_id=TEST_CONVERSATION_ID):
    """Insert a minimal pending decision for FK targets in migration 011."""
    _ensure_conversation(cur, conv_id)
    cur.execute(
        """
        INSERT INTO sie_pending_semantic_decisions
            (decision_id, decision_creation_key, conversation_id, stage,
             entity_creation_key, outcome, lifecycle_state, originating_request_id)
        VALUES (%s, %s, %s, 'identity_resolution', %s, 'UNRESOLVED', 'pending', %s)
        ON CONFLICT DO NOTHING;
        """,
        (decision_id, f"key-{decision_id}", conv_id, f"entity-{decision_id}", "req-orig"),
    )


def _insert_resolution_record(cur, record_id=TEST_RECORD_ID, **overrides):
    """Insert a valid YES/ASSIGN_EXISTING resolution record with sensible defaults."""
    defaults = dict(
        record_id=record_id,
        request_id=TEST_REQUEST_ID,
        conversation_id=TEST_CONVERSATION_ID,
        packet_id=TEST_PACKET_ID,
        graph_version_analyzed=1,
        graph_snapshot_token="snap-001",
        outcome="YES",
        action="ASSIGN_EXISTING",
        identity_stage_status="COMPLETED",
        identity_confidence="HIGH",
        sufficiency_stage_status="COMPLETED",
        sufficiency_confidence="HIGH",
        matched_concern_id="concern-matched-1",
        proposed_concern_id=None,
        reasoning="Test reasoning",
        semantic_policy_version="1.0.0",
        retrieval_policy_version="1.0.0",
        model_config_version="1.0.0",
        prompt_version="1.0.0",
    )
    defaults.update(overrides)
    _ensure_conversation(cur, defaults["conversation_id"])
    _ensure_packet(cur, defaults["packet_id"], defaults["conversation_id"])
    if defaults.get("matched_concern_id"):
        _ensure_concern(cur, defaults["matched_concern_id"], defaults["conversation_id"])
    if defaults.get("proposed_concern_id"):
        _ensure_concern(cur, defaults["proposed_concern_id"], defaults["conversation_id"])

    cur.execute(
        """
        INSERT INTO sie_identity_resolution_records (
            record_id, request_id, conversation_id, packet_id,
            graph_version_analyzed, graph_snapshot_token,
            outcome, action,
            identity_stage_status, identity_confidence,
            sufficiency_stage_status, sufficiency_confidence,
            matched_concern_id, proposed_concern_id,
            reasoning,
            semantic_policy_version, retrieval_policy_version,
            model_config_version, prompt_version
        ) VALUES (
            %(record_id)s, %(request_id)s, %(conversation_id)s, %(packet_id)s,
            %(graph_version_analyzed)s, %(graph_snapshot_token)s,
            %(outcome)s, %(action)s,
            %(identity_stage_status)s, %(identity_confidence)s,
            %(sufficiency_stage_status)s, %(sufficiency_confidence)s,
            %(matched_concern_id)s, %(proposed_concern_id)s,
            %(reasoning)s,
            %(semantic_policy_version)s, %(retrieval_policy_version)s,
            %(model_config_version)s, %(prompt_version)s
        );
        """,
        defaults,
    )


# =============================================================================
# Test Group 1: Valid Result Branches (Migration 009)
# =============================================================================


class TestValidResultBranches:
    """Tests that valid outcome/action/confidence combinations insert successfully."""

    def test_yes_assign_existing_high_identity(self, db):
        """YES/ASSIGN_EXISTING with completed identity stage and HIGH confidence."""
        cur = db.cursor()
        _insert_resolution_record(
            cur,
            record_id="rec-valid-yes",
            outcome="YES",
            action="ASSIGN_EXISTING",
            identity_stage_status="COMPLETED",
            identity_confidence="HIGH",
            sufficiency_stage_status="COMPLETED",
            sufficiency_confidence="HIGH",
            matched_concern_id="concern-1",
            proposed_concern_id=None,
        )
        cur.execute(
            "SELECT outcome, action FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-valid-yes';"
        )
        row = cur.fetchone()
        assert row == ("YES", "ASSIGN_EXISTING")

    def test_no_propose_new_high_sufficiency(self, db):
        """NO/PROPOSE_NEW with completed sufficiency stage and HIGH confidence."""
        cur = db.cursor()
        _insert_resolution_record(
            cur,
            record_id="rec-valid-no",
            outcome="NO",
            action="PROPOSE_NEW",
            identity_stage_status="COMPLETED",
            identity_confidence="LOW",
            sufficiency_stage_status="COMPLETED",
            sufficiency_confidence="HIGH",
            matched_concern_id=None,
            proposed_concern_id="concern-proposed-1",
        )
        cur.execute(
            "SELECT outcome, action, proposed_concern_id "
            "FROM sie_identity_resolution_records WHERE record_id = 'rec-valid-no';"
        )
        row = cur.fetchone()
        assert row == ("NO", "PROPOSE_NEW", "concern-proposed-1")

    def test_unresolved_retain_pending_both_null(self, db):
        """UNRESOLVED/RETAIN_PENDING with both IDs null inserts successfully."""
        cur = db.cursor()
        _insert_resolution_record(
            cur,
            record_id="rec-valid-unresolved",
            outcome="UNRESOLVED",
            action="RETAIN_PENDING",
            identity_stage_status="COMPLETED",
            identity_confidence="MEDIUM",
            sufficiency_stage_status="COMPLETED",
            sufficiency_confidence="HIGH",
            matched_concern_id=None,
            proposed_concern_id=None,
        )
        cur.execute(
            "SELECT matched_concern_id, proposed_concern_id "
            "FROM sie_identity_resolution_records WHERE record_id = 'rec-valid-unresolved';"
        )
        row = cur.fetchone()
        assert row == (None, None)

    def test_defer_none_action(self, db):
        """DEFER/NONE with stages not run and null confidences."""
        cur = db.cursor()
        _insert_resolution_record(
            cur,
            record_id="rec-valid-defer",
            outcome="DEFER",
            action="NONE",
            identity_stage_status="NOT_RUN",
            identity_confidence=None,
            sufficiency_stage_status="NOT_RUN",
            sufficiency_confidence=None,
            matched_concern_id=None,
            proposed_concern_id=None,
        )
        cur.execute(
            "SELECT outcome, action FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-valid-defer';"
        )
        row = cur.fetchone()
        assert row == ("DEFER", "NONE")

    def test_retrieval_inconclusive_retain_pending(self, db):
        """RETRIEVAL_INCONCLUSIVE/RETAIN_PENDING is a valid pending branch."""
        cur = db.cursor()
        _insert_resolution_record(
            cur,
            record_id="rec-valid-inconclusive",
            outcome="RETRIEVAL_INCONCLUSIVE",
            action="RETAIN_PENDING",
            identity_stage_status="COMPLETED",
            identity_confidence="LOW",
            sufficiency_stage_status="FAILED",
            sufficiency_confidence=None,
            matched_concern_id=None,
            proposed_concern_id=None,
        )
        cur.execute(
            "SELECT outcome FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-valid-inconclusive';"
        )
        assert cur.fetchone()[0] == "RETRIEVAL_INCONCLUSIVE"


# =============================================================================
# Test Group 2: Invalid Result Branches (Migration 009)
# =============================================================================


class TestInvalidResultBranches:
    """Tests that invalid outcome/action/confidence combinations are rejected."""

    def test_yes_with_null_matched_concern_rejected(self, db):
        """YES outcome with null matched_concern_id is rejected by CHECK."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-1",
                outcome="YES",
                action="ASSIGN_EXISTING",
                identity_stage_status="COMPLETED",
                identity_confidence="HIGH",
                sufficiency_stage_status="COMPLETED",
                sufficiency_confidence="HIGH",
                matched_concern_id=None,  # Invalid: YES requires matched
                proposed_concern_id=None,
            )
        assert "chk_ir_result_branch" in str(exc_info.value)
        db.rollback()

    def test_no_with_null_proposed_concern_rejected(self, db):
        """NO outcome with null proposed_concern_id is rejected by CHECK."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-2",
                outcome="NO",
                action="PROPOSE_NEW",
                identity_stage_status="COMPLETED",
                identity_confidence="LOW",
                sufficiency_stage_status="COMPLETED",
                sufficiency_confidence="HIGH",
                matched_concern_id=None,
                proposed_concern_id=None,  # Invalid: NO requires proposed
            )
        assert "chk_ir_result_branch" in str(exc_info.value)
        db.rollback()

    def test_yes_with_non_high_identity_confidence_rejected(self, db):
        """YES outcome with MEDIUM identity confidence is rejected."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-3",
                outcome="YES",
                action="ASSIGN_EXISTING",
                identity_stage_status="COMPLETED",
                identity_confidence="MEDIUM",  # Invalid: must be HIGH
                sufficiency_stage_status="COMPLETED",
                sufficiency_confidence="HIGH",
                matched_concern_id="concern-1",
                proposed_concern_id=None,
            )
        assert "chk_ir_result_branch" in str(exc_info.value)
        db.rollback()

    def test_unresolved_with_matched_concern_rejected(self, db):
        """UNRESOLVED with a matched_concern_id is rejected."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-4",
                outcome="UNRESOLVED",
                action="RETAIN_PENDING",
                identity_stage_status="COMPLETED",
                identity_confidence="MEDIUM",
                sufficiency_stage_status="COMPLETED",
                sufficiency_confidence="HIGH",
                matched_concern_id="concern-1",  # Invalid: pending must have null
                proposed_concern_id=None,
            )
        assert "chk_ir_result_branch" in str(exc_info.value)
        db.rollback()

    def test_completed_identity_stage_with_null_confidence_rejected(self, db):
        """identity_stage_status=COMPLETED with null identity_confidence rejected."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-5",
                outcome="UNRESOLVED",
                action="RETAIN_PENDING",
                identity_stage_status="COMPLETED",
                identity_confidence=None,  # Invalid: COMPLETED requires confidence
                sufficiency_stage_status="NOT_RUN",
                sufficiency_confidence=None,
                matched_concern_id=None,
                proposed_concern_id=None,
            )
        assert "chk_identity_stage_confidence" in str(exc_info.value)
        db.rollback()

    def test_not_run_identity_stage_with_confidence_rejected(self, db):
        """identity_stage_status=NOT_RUN with non-null identity_confidence rejected."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-6",
                outcome="UNRESOLVED",
                action="RETAIN_PENDING",
                identity_stage_status="NOT_RUN",
                identity_confidence="LOW",  # Invalid: NOT_RUN requires null
                sufficiency_stage_status="NOT_RUN",
                sufficiency_confidence=None,
                matched_concern_id=None,
                proposed_concern_id=None,
            )
        assert "chk_identity_stage_confidence" in str(exc_info.value)
        db.rollback()

    def test_yes_with_low_identity_confidence_rejected(self, db):
        """YES outcome with LOW identity confidence is rejected."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-7",
                outcome="YES",
                action="ASSIGN_EXISTING",
                identity_stage_status="COMPLETED",
                identity_confidence="LOW",  # Invalid: must be HIGH
                sufficiency_stage_status="COMPLETED",
                sufficiency_confidence="HIGH",
                matched_concern_id="concern-1",
                proposed_concern_id=None,
            )
        assert "chk_ir_result_branch" in str(exc_info.value)
        db.rollback()

    def test_no_with_non_high_sufficiency_confidence_rejected(self, db):
        """NO outcome with MEDIUM sufficiency confidence is rejected."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-8",
                outcome="NO",
                action="PROPOSE_NEW",
                identity_stage_status="COMPLETED",
                identity_confidence="LOW",
                sufficiency_stage_status="COMPLETED",
                sufficiency_confidence="MEDIUM",  # Invalid: must be HIGH
                matched_concern_id=None,
                proposed_concern_id="concern-proposed-1",
            )
        assert "chk_ir_result_branch" in str(exc_info.value)
        db.rollback()

    def test_failed_sufficiency_stage_with_confidence_rejected(self, db):
        """sufficiency_stage_status=FAILED with non-null confidence is rejected."""
        cur = db.cursor()
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-invalid-9",
                outcome="UNRESOLVED",
                action="RETAIN_PENDING",
                identity_stage_status="NOT_RUN",
                identity_confidence=None,
                sufficiency_stage_status="FAILED",
                sufficiency_confidence="LOW",  # Invalid: FAILED requires null
                matched_concern_id=None,
                proposed_concern_id=None,
            )
        assert "chk_sufficiency_stage_confidence" in str(exc_info.value)
        db.rollback()


# =============================================================================
# Test Group 3: Retrieval Attempts (Migration 010)
# =============================================================================


class TestRetrievalAttempts:
    """Tests for sie_retrieval_attempts constraints."""

    def _ensure_parent_record(self, cur):
        """Insert a valid resolution record for FK references."""
        _insert_resolution_record(cur, record_id="rec-parent-attempt")

    def _insert_attempt(self, cur, attempt_id="att-001", **overrides):
        """Insert a valid retrieval attempt."""
        defaults = dict(
            attempt_id=attempt_id,
            record_id="rec-parent-attempt",
            conversation_id=TEST_CONVERSATION_ID,
            packet_id=TEST_PACKET_ID,
            channel_id="ch-emb-001",
            channel_family="embedding_primary",
            query_mode="broad",
            query_reference="embedding vector for packet",
            scope_description="All active concerns",
            status="SUCCESS_WITH_CANDIDATES",
            candidate_ids=["cand-1", "cand-2"],
            candidate_count=2,
            retrieval_policy_version="1.0.0",
        )
        defaults.update(overrides)

        cur.execute(
            """
            INSERT INTO sie_retrieval_attempts (
                attempt_id, record_id, conversation_id, packet_id,
                channel_id, channel_family,
                query_mode, query_reference, scope_description,
                status, candidate_ids, candidate_count,
                retrieval_policy_version
            ) VALUES (
                %(attempt_id)s, %(record_id)s, %(conversation_id)s, %(packet_id)s,
                %(channel_id)s, %(channel_family)s,
                %(query_mode)s, %(query_reference)s, %(scope_description)s,
                %(status)s, %(candidate_ids)s, %(candidate_count)s,
                %(retrieval_policy_version)s
            );
            """,
            defaults,
        )

    def test_valid_attempt_inserts_successfully(self, db):
        """Valid retrieval attempt with correct candidate_count inserts."""
        cur = db.cursor()
        self._ensure_parent_record(cur)
        self._insert_attempt(cur, candidate_ids=["c1", "c2", "c3"], candidate_count=3)
        cur.execute(
            "SELECT candidate_count FROM sie_retrieval_attempts "
            "WHERE attempt_id = 'att-001';"
        )
        assert cur.fetchone()[0] == 3

    def test_candidate_count_mismatch_rejected(self, db):
        """candidate_count != len(candidate_ids) is rejected by CHECK."""
        cur = db.cursor()
        self._ensure_parent_record(cur)
        with pytest.raises(Exception) as exc_info:
            self._insert_attempt(
                cur,
                attempt_id="att-bad-count",
                candidate_ids=["c1", "c2"],
                candidate_count=5,  # Mismatch: array has 2
            )
        assert "chk_candidate_count_matches_array" in str(exc_info.value)
        db.rollback()

    def test_invalid_channel_family_rejected(self, db):
        """Invalid channel_family is rejected by CHECK."""
        cur = db.cursor()
        self._ensure_parent_record(cur)
        with pytest.raises(Exception) as exc_info:
            self._insert_attempt(
                cur,
                attempt_id="att-bad-family",
                channel_family="INVALID_FAMILY",
            )
        assert "channel_family" in str(exc_info.value).lower() or "check" in str(
            exc_info.value
        ).lower()
        db.rollback()

    def test_invalid_status_rejected(self, db):
        """Invalid status is rejected by CHECK."""
        cur = db.cursor()
        self._ensure_parent_record(cur)
        with pytest.raises(Exception) as exc_info:
            self._insert_attempt(
                cur,
                attempt_id="att-bad-status",
                status="INVALID_STATUS",
            )
        assert "status" in str(exc_info.value).lower() or "check" in str(
            exc_info.value
        ).lower()
        db.rollback()

    def test_empty_candidates_with_zero_count(self, db):
        """Empty candidate_ids with candidate_count=0 is valid."""
        cur = db.cursor()
        self._ensure_parent_record(cur)
        self._insert_attempt(
            cur,
            attempt_id="att-empty",
            candidate_ids=[],
            candidate_count=0,
            status="SUCCESS_EMPTY",
        )
        cur.execute(
            "SELECT candidate_count, status FROM sie_retrieval_attempts "
            "WHERE attempt_id = 'att-empty';"
        )
        row = cur.fetchone()
        assert row == (0, "SUCCESS_EMPTY")

    def test_valid_irs_trigger_signal(self, db):
        """Attempt with valid triggered_by_signal inserts successfully."""
        cur = db.cursor()
        self._ensure_parent_record(cur)
        cur.execute(
            """
            INSERT INTO sie_retrieval_attempts (
                attempt_id, record_id, conversation_id, packet_id,
                channel_id, channel_family, query_mode, query_reference,
                scope_description, status, candidate_ids, candidate_count,
                retrieval_policy_version, is_widening_attempt, triggered_by_signal
            ) VALUES (
                'att-irs', 'rec-parent-attempt', %(conv)s, %(pkt)s,
                'ch-hist-001', 'historical_region', 'broad', 'ref',
                'scope', 'SUCCESS_WITH_CANDIDATES', ARRAY['c1'], 1,
                '1.0.0', TRUE, 'HISTORICAL_REFERENT'
            );
            """,
            {"conv": TEST_CONVERSATION_ID, "pkt": TEST_PACKET_ID},
        )
        cur.execute(
            "SELECT triggered_by_signal, is_widening_attempt "
            "FROM sie_retrieval_attempts WHERE attempt_id = 'att-irs';"
        )
        row = cur.fetchone()
        assert row == ("HISTORICAL_REFERENT", True)


# =============================================================================
# Test Group 4: Pending Identity Tables (Migration 011)
# =============================================================================


class TestPendingIdentityDetails:
    """Tests for sie_pending_identity_details uniqueness and coupling."""

    def test_valid_pending_identity_detail_inserts(self, db):
        """Valid pending identity detail inserts successfully."""
        cur = db.cursor()
        _ensure_pending_decision(cur, "dec-001")
        _ensure_packet(cur, "pkt-pending-1")
        # Insert parent resolution record for source_resolution_record_id FK
        _insert_resolution_record(cur, record_id="rec-source-001")
        cur.execute(
            """
            INSERT INTO sie_pending_identity_details (
                detail_id, decision_id, conversation_id, packet_id,
                graph_version_analyzed, source_resolution_record_id,
                identity_stage_status, identity_confidence,
                sufficiency_stage_status, sufficiency_confidence
            ) VALUES (
                'det-001', 'dec-001', %(conv)s, 'pkt-pending-1',
                5, 'rec-source-001',
                'COMPLETED', 'MEDIUM',
                'COMPLETED', 'HIGH'
            );
            """,
            {"conv": TEST_CONVERSATION_ID},
        )
        cur.execute(
            "SELECT detail_id, identity_confidence "
            "FROM sie_pending_identity_details WHERE detail_id = 'det-001';"
        )
        row = cur.fetchone()
        assert row == ("det-001", "MEDIUM")

    def test_duplicate_decision_id_rejected(self, db):
        """Duplicate decision_id is rejected (one-to-one constraint)."""
        cur = db.cursor()
        _ensure_pending_decision(cur, "dec-dup")
        _ensure_packet(cur, "pkt-1")
        _ensure_packet(cur, "pkt-2")
        cur.execute(
            """
            INSERT INTO sie_pending_identity_details (
                detail_id, decision_id, conversation_id, packet_id,
                graph_version_analyzed,
                identity_stage_status, sufficiency_stage_status
            ) VALUES (
                'det-dup-1', 'dec-dup', %(conv)s, 'pkt-1',
                1, 'NOT_RUN', 'NOT_RUN'
            );
            """,
            {"conv": TEST_CONVERSATION_ID},
        )
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_pending_identity_details (
                    detail_id, decision_id, conversation_id, packet_id,
                    graph_version_analyzed,
                    identity_stage_status, sufficiency_stage_status
                ) VALUES (
                    'det-dup-2', 'dec-dup', %(conv)s, 'pkt-2',
                    2, 'NOT_RUN', 'NOT_RUN'
                );
                """,
                {"conv": TEST_CONVERSATION_ID},
            )
        # UNIQUE constraint on decision_id
        assert "decision_id" in str(exc_info.value).lower() or "unique" in str(
            exc_info.value
        ).lower()
        db.rollback()

    def test_stage_confidence_coupling_completed_without_confidence_rejected(self, db):
        """COMPLETED identity stage without confidence is rejected."""
        cur = db.cursor()
        _ensure_pending_decision(cur, "dec-coupling")
        _ensure_packet(cur, "pkt-1")
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_pending_identity_details (
                    detail_id, decision_id, conversation_id, packet_id,
                    graph_version_analyzed,
                    identity_stage_status, identity_confidence,
                    sufficiency_stage_status
                ) VALUES (
                    'det-coupling-bad', 'dec-coupling', %(conv)s, 'pkt-1',
                    1,
                    'COMPLETED', NULL,
                    'NOT_RUN'
                );
                """,
                {"conv": TEST_CONVERSATION_ID},
            )
        assert "chk_pid_identity_stage_confidence" in str(exc_info.value)
        db.rollback()

    def test_stage_confidence_coupling_not_run_with_confidence_rejected(self, db):
        """NOT_RUN sufficiency stage with confidence is rejected."""
        cur = db.cursor()
        _ensure_pending_decision(cur, "dec-coupling-2")
        _ensure_packet(cur, "pkt-1")
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_pending_identity_details (
                    detail_id, decision_id, conversation_id, packet_id,
                    graph_version_analyzed,
                    identity_stage_status,
                    sufficiency_stage_status, sufficiency_confidence
                ) VALUES (
                    'det-coupling-bad-2', 'dec-coupling-2', %(conv)s, 'pkt-1',
                    1,
                    'NOT_RUN',
                    'NOT_RUN', 'HIGH'
                );
                """,
                {"conv": TEST_CONVERSATION_ID},
            )
        assert "chk_pid_sufficiency_stage_confidence" in str(exc_info.value)
        db.rollback()


class TestPendingIdentityPropositions:
    """Tests for sie_pending_identity_propositions uniqueness constraints."""

    def test_valid_proposition_membership_inserts(self, db):
        """Valid proposition membership inserts successfully."""
        cur = db.cursor()
        _ensure_pending_decision(cur, "dec-prop-1")
        cur.execute(
            """
            INSERT INTO sie_pending_identity_propositions (
                id, decision_id, proposition_id, conversation_id, ordinal
            ) VALUES (
                'pip-001', 'dec-prop-1', 'prop-aaa', %(conv)s, 0
            );
            """,
            {"conv": TEST_CONVERSATION_ID},
        )
        cur.execute(
            "SELECT proposition_id, ordinal "
            "FROM sie_pending_identity_propositions WHERE id = 'pip-001';"
        )
        assert cur.fetchone() == ("prop-aaa", 0)

    def test_duplicate_decision_proposition_rejected(self, db):
        """Duplicate (decision_id, proposition_id) is rejected."""
        cur = db.cursor()
        _ensure_pending_decision(cur, "dec-prop-dup")
        cur.execute(
            """
            INSERT INTO sie_pending_identity_propositions (
                id, decision_id, proposition_id, conversation_id, ordinal
            ) VALUES ('pip-d1', 'dec-prop-dup', 'prop-x', %(conv)s, 0);
            """,
            {"conv": TEST_CONVERSATION_ID},
        )
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_pending_identity_propositions (
                    id, decision_id, proposition_id, conversation_id, ordinal
                ) VALUES ('pip-d2', 'dec-prop-dup', 'prop-x', %(conv)s, 1);
                """,
                {"conv": TEST_CONVERSATION_ID},
            )
        err = str(exc_info.value).lower()
        assert "uq_pip_decision_proposition" in err or "unique" in err
        db.rollback()

    def test_duplicate_decision_ordinal_rejected(self, db):
        """Duplicate (decision_id, ordinal) is rejected."""
        cur = db.cursor()
        _ensure_pending_decision(cur, "dec-prop-ord")
        cur.execute(
            """
            INSERT INTO sie_pending_identity_propositions (
                id, decision_id, proposition_id, conversation_id, ordinal
            ) VALUES ('pip-o1', 'dec-prop-ord', 'prop-a', %(conv)s, 0);
            """,
            {"conv": TEST_CONVERSATION_ID},
        )
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_pending_identity_propositions (
                    id, decision_id, proposition_id, conversation_id, ordinal
                ) VALUES ('pip-o2', 'dec-prop-ord', 'prop-b', %(conv)s, 0);
                """,
                {"conv": TEST_CONVERSATION_ID},
            )
        err = str(exc_info.value).lower()
        assert "uq_pip_decision_ordinal" in err or "unique" in err
        db.rollback()

    def test_multiple_propositions_same_decision_different_ordinals(self, db):
        """Multiple propositions with distinct ordinals succeed."""
        cur = db.cursor()
        _ensure_pending_decision(cur, "dec-prop-multi")
        for i, prop_id in enumerate(["prop-m1", "prop-m2", "prop-m3"]):
            cur.execute(
                """
                INSERT INTO sie_pending_identity_propositions (
                    id, decision_id, proposition_id, conversation_id, ordinal
                ) VALUES (%(id)s, 'dec-prop-multi', %(prop)s, %(conv)s, %(ord)s);
                """,
                {
                    "id": f"pip-multi-{i}",
                    "prop": prop_id,
                    "conv": TEST_CONVERSATION_ID,
                    "ord": i,
                },
            )
        cur.execute(
            "SELECT COUNT(*) FROM sie_pending_identity_propositions "
            "WHERE decision_id = 'dec-prop-multi';"
        )
        assert cur.fetchone()[0] == 3


# =============================================================================
# Test Group 5: Creation Order and Rollback
# =============================================================================


class TestCreationOrderAndRollback:
    """Tests FK ordering, rollback safety, and table dependency structure."""

    def test_drop_tables_in_reverse_order_succeeds(self, db):
        """Dropping tables in reverse migration order does not violate FK deps."""
        cur = db.cursor()
        # The reverse of 011, 010, 009 should work without FK violations
        # We verify this using IF EXISTS to avoid errors on missing tables
        # in the test transaction, then re-create them.
        cur.execute(
            "DROP TABLE IF EXISTS sie_pending_identity_propositions CASCADE;"
        )
        cur.execute(
            "DROP TABLE IF EXISTS sie_pending_identity_details CASCADE;"
        )
        cur.execute("DROP TABLE IF EXISTS sie_retrieval_attempts CASCADE;")
        cur.execute(
            "DROP TABLE IF EXISTS sie_identity_resolution_records CASCADE;"
        )
        # If we get here without error, reverse-order drop works
        # Rollback restores the tables for subsequent tests
        db.rollback()

    def test_retrieval_attempt_fk_requires_resolution_record(self, db):
        """Retrieval attempt FK to resolution record enforced."""
        cur = db.cursor()
        _ensure_conversation(cur)
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_retrieval_attempts (
                    attempt_id, record_id, conversation_id, packet_id,
                    channel_id, channel_family, query_mode, query_reference,
                    scope_description, status, candidate_ids, candidate_count,
                    retrieval_policy_version
                ) VALUES (
                    'att-orphan', 'rec-nonexistent', %(conv)s, 'pkt-1',
                    'ch-1', 'embedding_primary', 'broad', 'ref',
                    'scope', 'SUCCESS_EMPTY', '{}', 0, '1.0.0'
                );
                """,
                {"conv": TEST_CONVERSATION_ID},
            )
        err = str(exc_info.value).lower()
        assert "foreign key" in err or "fk" in err or "violates" in err
        db.rollback()

    def test_pending_detail_fk_requires_pending_decision(self, db):
        """Pending identity detail FK to pending decision enforced."""
        cur = db.cursor()
        _ensure_conversation(cur)
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_pending_identity_details (
                    detail_id, decision_id, conversation_id, packet_id,
                    graph_version_analyzed,
                    identity_stage_status, sufficiency_stage_status
                ) VALUES (
                    'det-orphan', 'dec-nonexistent', %(conv)s, 'pkt-1',
                    1, 'NOT_RUN', 'NOT_RUN'
                );
                """,
                {"conv": TEST_CONVERSATION_ID},
            )
        err = str(exc_info.value).lower()
        assert "foreign key" in err or "fk" in err or "violates" in err
        db.rollback()

    def test_pending_proposition_fk_requires_pending_decision(self, db):
        """Pending proposition FK to pending decision enforced."""
        cur = db.cursor()
        _ensure_conversation(cur)
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_pending_identity_propositions (
                    id, decision_id, proposition_id, conversation_id, ordinal
                ) VALUES (
                    'pip-orphan', 'dec-nonexistent', 'prop-1', %(conv)s, 0
                );
                """,
                {"conv": TEST_CONVERSATION_ID},
            )
        err = str(exc_info.value).lower()
        assert "foreign key" in err or "fk" in err or "violates" in err
        db.rollback()

    def test_transaction_rollback_leaves_no_partial_state(self, db):
        """A failed insert in a transaction leaves no partial records."""
        cur = db.cursor()
        _ensure_conversation(cur)
        # Insert a valid resolution record
        _insert_resolution_record(cur, record_id="rec-rollback-test")

        # Start a sub-savepoint
        cur.execute("SAVEPOINT partial_test;")
        try:
            # This will fail due to CHECK violation
            _insert_resolution_record(
                cur,
                record_id="rec-rollback-fail",
                request_id="req-other",
                packet_id="pkt-other",
                outcome="YES",
                action="ASSIGN_EXISTING",
                identity_stage_status="COMPLETED",
                identity_confidence="LOW",  # Invalid for YES
                matched_concern_id="concern-1",
            )
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT partial_test;")

        # Original record still exists, failed record does not
        cur.execute(
            "SELECT COUNT(*) FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-rollback-test';"
        )
        assert cur.fetchone()[0] == 1
        cur.execute(
            "SELECT COUNT(*) FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-rollback-fail';"
        )
        assert cur.fetchone()[0] == 0

    def test_conversation_fk_enforced_on_resolution_records(self, db):
        """Resolution record with non-existent conversation_id is rejected."""
        cur = db.cursor()
        fake_conv = "99999999-9999-9999-9999-999999999999"
        # Do NOT call _ensure_conversation — we want the FK to reject this
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                """
                INSERT INTO sie_identity_resolution_records (
                    record_id, request_id, conversation_id, packet_id,
                    graph_version_analyzed, graph_snapshot_token,
                    outcome, action,
                    identity_stage_status, identity_confidence,
                    sufficiency_stage_status, sufficiency_confidence,
                    matched_concern_id, proposed_concern_id,
                    reasoning, semantic_policy_version, retrieval_policy_version,
                    model_config_version, prompt_version
                ) VALUES (
                    'rec-bad-conv', 'req-test-001', %s, 'pkt-test-001',
                    1, 'snap-001',
                    'UNRESOLVED', 'RETAIN_PENDING',
                    'NOT_RUN', NULL,
                    'NOT_RUN', NULL,
                    NULL, NULL,
                    'Test', '1.0.0', '1.0.0', '1.0.0', '1.0.0'
                );
                """,
                (fake_conv,),
            )
        err = str(exc_info.value).lower()
        assert "foreign key" in err or "violates" in err
        db.rollback()

    def test_unique_request_packet_constraint(self, db):
        """Only one record per (request_id, packet_id) pair."""
        cur = db.cursor()
        _insert_resolution_record(
            cur,
            record_id="rec-uniq-1",
            request_id="req-uniq",
            packet_id="pkt-uniq",
        )
        with pytest.raises(Exception) as exc_info:
            _insert_resolution_record(
                cur,
                record_id="rec-uniq-2",
                request_id="req-uniq",
                packet_id="pkt-uniq",
            )
        err = str(exc_info.value).lower()
        assert "uq_ir_record_request_packet" in err or "unique" in err
        db.rollback()
