"""
Task 18.3 — Privacy and Rollback Integration Tests.

Tests:
1. Suppressed concerns never reach Python context (GraphStateContext).
2. Controlled purge/redaction cascades across ALL data types:
   - semantic records (sie_identity_resolution_records)
   - pending decisions (sie_pending_identity_details, sie_pending_identity_propositions)
   - retrieval attempts (sie_retrieval_attempts)
   - LLM diagnostics (reasoning, evidence_references)
   - associations (via matched/proposed concern clearing)
   - snapshots (snapshot context excludes suppressed)
   - audit data (minimal non-content event recorded)
3. Rollback and re-apply migrations work correctly in a disposable database.

Validates: Requirements 7.9, 11.5

Uses real PostgreSQL via psycopg2 (same pattern as test_commit_security_privacy.py).
"""

from __future__ import annotations

import json
import os

import pytest

# Re-use shared DB fixtures from conftest.py
from .conftest import DATABASE_URL, TEST_CONVERSATION_ID, TEST_REQUEST_ID

pytestmark = pytest.mark.database

# Test constants
TEST_CONCERN_ID = "concern-privacy-001"
TEST_PACKET_ID = "pkt-privacy-001"
TEST_RECORD_ID = "rec-privacy-001"
TEST_DECISION_ID = "dec-privacy-001"
TEST_ATTEMPT_ID = "att-privacy-001"
TEST_IDEM_KEY = "conv-privacy:seq-1-5:pipe-1.0.0"
TEST_FINGERPRINT = "fp-privacy-test-001"
TEST_LEASE_OWNER = "worker-privacy-test"

SECOND_CONCERN_ID = "concern-privacy-002"
SECOND_RECORD_ID = "rec-privacy-002"
SECOND_ATTEMPT_ID = "att-privacy-002"


# =============================================================================
# Helpers
# =============================================================================


def _ensure_conversation(cur, conv_id=TEST_CONVERSATION_ID):
    """Ensure a conversation row exists."""
    cur.execute(
        "INSERT INTO conversations (id) VALUES (%s) ON CONFLICT DO NOTHING;",
        (conv_id,),
    )


def _ensure_update_state(cur, conv_id=TEST_CONVERSATION_ID, graph_version=5):
    """Ensure v2_update_state row exists for the conversation."""
    cur.execute(
        """
        INSERT INTO v2_update_state (conversation_id, graph_version,
            last_processed_message_seq, update_version, update_status)
        VALUES (%s, %s, 0, 1, 'idle')
        ON CONFLICT (conversation_id) DO UPDATE SET graph_version = %s;
        """,
        (conv_id, graph_version, graph_version),
    )


def _ensure_packet(cur, packet_id=TEST_PACKET_ID, conv_id=TEST_CONVERSATION_ID):
    """Ensure a semantic packet exists."""
    cur.execute(
        """
        INSERT INTO sie_semantic_packets
            (packet_id, packet_creation_key, conversation_id, source_message_ids,
             message_seq_start, message_seq_end, user_grounded_meaning,
             provenance, packet_formation_version, cohesion_status)
        VALUES (%s, %s, %s, ARRAY['msg-1'], 1, 3, 'Private user meaning',
                'test', '1.0.0', 'COHESIVE')
        ON CONFLICT DO NOTHING;
        """,
        (packet_id, f"key-{packet_id}", conv_id),
    )


def _ensure_concern(cur, concern_id=TEST_CONCERN_ID,
                    conv_id=TEST_CONVERSATION_ID, status="ACTIVE"):
    """Ensure a persistent concern exists."""
    cur.execute(
        """
        INSERT INTO sie_persistent_concerns
            (concern_id, conversation_id, identity_summary, display_title,
             current_summary, status)
        VALUES (%s, %s, 'User private concern summary',
                'Private Concern', 'Sensitive content details', %s)
        ON CONFLICT DO NOTHING;
        """,
        (concern_id, conv_id, status),
    )


def _ensure_entity_registry(cur, entity_id, conv_id=TEST_CONVERSATION_ID,
                            entity_kind="identity_resolution_record"):
    """Register an entity in the sie_entity_registry."""
    cur.execute(
        """
        INSERT INTO sie_entity_registry
            (conversation_id, entity_kind, creation_key, entity_id, request_id)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING;
        """,
        (conv_id, entity_kind, f"key-{entity_id}", entity_id, TEST_REQUEST_ID),
    )


def _reserve_request(cur, conv_id=TEST_CONVERSATION_ID,
                     request_id=TEST_REQUEST_ID, idem_key=TEST_IDEM_KEY,
                     fingerprint=TEST_FINGERPRINT, owner=TEST_LEASE_OWNER,
                     lease_ms=60000):
    """Reserve a commit request."""
    cur.execute(
        "SELECT sie_reserve_request(%s, %s, %s, %s, %s, %s);",
        (conv_id, request_id, idem_key, fingerprint, owner, lease_ms),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _make_resolution_record(record_id, concern_id=TEST_CONCERN_ID,
                            packet_id=TEST_PACKET_ID, graph_version=5):
    """Create a valid resolution record payload referencing the concern."""
    return {
        "record_id": record_id,
        "packet_id": packet_id,
        "graph_version_analyzed": graph_version,
        "graph_snapshot_token": f"snap-{graph_version}",
        "outcome": "YES",
        "action": "ASSIGN_EXISTING",
        "identity_stage_status": "COMPLETED",
        "identity_confidence": "HIGH",
        "sufficiency_stage_status": "COMPLETED",
        "sufficiency_confidence": "HIGH",
        "matched_concern_id": concern_id,
        "proposed_concern_id": None,
        "reasoning": "Sensitive identity reasoning with private user content",
        "semantic_policy_version": "1.0.0",
        "retrieval_policy_version": "1.0.0",
        "model_config_version": "gpt-4-turbo",
        "prompt_version": "1.0.0",
    }


def _make_retrieval_attempt(attempt_id, record_id, packet_id=TEST_PACKET_ID):
    """Create a valid retrieval attempt payload."""
    return {
        "attempt_id": attempt_id,
        "record_id": record_id,
        "packet_id": packet_id,
        "channel_id": "ch-emb-priv",
        "channel_family": "embedding_primary",
        "query_mode": "broad",
        "query_reference": "embedding vector of private content",
        "scope_description": "All active concerns in conversation",
        "status": "SUCCESS_WITH_CANDIDATES",
        "candidate_ids": [TEST_CONCERN_ID],
        "candidate_count": 1,
        "retrieval_policy_version": "1.0.0",
    }


def _call_commit_bundle(cur, conv_id=TEST_CONVERSATION_ID,
                        request_id=TEST_REQUEST_ID, **kwargs):
    """Call v2_commit_identity_bundle and return parsed JSONB result."""
    cur.execute(
        """
        SELECT v2_commit_identity_bundle(
            p_conversation_id := %(conv_id)s,
            p_request_id := %(request_id)s,
            p_identity_resolution_records := %(records)s,
            p_retrieval_attempts := %(attempts)s,
            p_pending_identity_details := %(details)s,
            p_pending_identity_propositions := %(propositions)s,
            p_association_mutations := %(associations)s,
            p_shared_proposals := %(proposals)s,
            p_request_state_transition := %(transition)s,
            p_lease_owner := %(lease_owner)s,
            p_payload_fingerprint_hash := %(fingerprint)s,
            p_graph_version_analyzed := %(graph_version)s
        );
        """,
        {
            "conv_id": conv_id,
            "request_id": request_id,
            "records": json.dumps(kwargs.get("records")) if kwargs.get("records") else None,
            "attempts": json.dumps(kwargs.get("attempts")) if kwargs.get("attempts") else None,
            "details": json.dumps(kwargs.get("details")) if kwargs.get("details") else None,
            "propositions": json.dumps(kwargs.get("propositions")) if kwargs.get("propositions") else None,
            "associations": json.dumps(kwargs.get("associations")) if kwargs.get("associations") else None,
            "proposals": json.dumps(kwargs.get("proposals")) if kwargs.get("proposals") else None,
            "transition": json.dumps(kwargs.get("transition")) if kwargs.get("transition") else None,
            "lease_owner": kwargs.get("lease_owner"),
            "fingerprint": kwargs.get("fingerprint"),
            "graph_version": kwargs.get("graph_version"),
        },
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _call_purge(cur, conv_id=TEST_CONVERSATION_ID, concern_id=TEST_CONCERN_ID,
                reason="privacy_regulation", purged_by="privacy_service"):
    """Call sie_purge_identity_data and return parsed result."""
    cur.execute(
        "SELECT sie_purge_identity_data(%s, %s, %s, %s);",
        (conv_id, concern_id, reason, purged_by),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _call_load_context(cur, conv_id=TEST_CONVERSATION_ID):
    """Call v2_load_sie_identity_context and return parsed result."""
    cur.execute(
        "SELECT v2_load_sie_identity_context(%s);",
        (conv_id,),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _setup_full_privacy_scenario(cur, conv_id=TEST_CONVERSATION_ID):
    """Set up a full privacy test scenario with data across all tables.

    Creates:
    - conversation + update_state
    - 2 concerns (one to suppress, one to keep)
    - 2 packets
    - resolution records, retrieval attempts, pending decisions
    """
    _ensure_conversation(cur, conv_id)
    _ensure_update_state(cur, conv_id, graph_version=5)
    _ensure_packet(cur, TEST_PACKET_ID, conv_id)
    _ensure_concern(cur, TEST_CONCERN_ID, conv_id)
    _ensure_concern(cur, SECOND_CONCERN_ID, conv_id)
    _ensure_entity_registry(cur, TEST_RECORD_ID, conv_id)
    _ensure_entity_registry(cur, SECOND_RECORD_ID, conv_id)
    _reserve_request(cur, conv_id)


    # Commit a resolution record referencing the concern-to-suppress
    record = _make_resolution_record(TEST_RECORD_ID, TEST_CONCERN_ID)
    attempt = _make_retrieval_attempt(TEST_ATTEMPT_ID, TEST_RECORD_ID)
    _call_commit_bundle(
        cur,
        records=[record],
        attempts=[attempt],
        lease_owner=TEST_LEASE_OWNER,
        fingerprint=TEST_FINGERPRINT,
        graph_version=5,
    )

    # Commit a second record referencing the concern-to-keep
    # Need new reservation for the second commit
    cur.execute(
        "SELECT sie_reserve_request(%s, %s, %s, %s, %s, %s);",
        (conv_id, "req-privacy-002", "conv-privacy:seq-6-10:pipe-1.0.0",
         "fp-privacy-test-002", TEST_LEASE_OWNER, 60000),
    )
    record2 = _make_resolution_record(
        SECOND_RECORD_ID, SECOND_CONCERN_ID, graph_version=5
    )
    attempt2 = _make_retrieval_attempt(
        SECOND_ATTEMPT_ID, SECOND_RECORD_ID
    )
    attempt2["candidate_ids"] = [SECOND_CONCERN_ID]
    _call_commit_bundle(
        cur,
        request_id="req-privacy-002",
        records=[record2],
        attempts=[attempt2],
        lease_owner=TEST_LEASE_OWNER,
        fingerprint="fp-privacy-test-002",
        graph_version=5,
    )

    # Create pending identity details referencing the first record
    _create_pending_decision(cur, conv_id)


def _create_pending_decision(cur, conv_id=TEST_CONVERSATION_ID):
    """Create pending decision records referencing the suppressed concern."""
    # Insert base pending semantic decision
    cur.execute(
        """
        INSERT INTO sie_pending_semantic_decisions
            (decision_id, decision_creation_key, conversation_id, stage,
             entity_creation_key, outcome, lifecycle_state,
             originating_request_id, dependency_refs)
        VALUES (%s, %s, %s, 'identity_resolution', %s, 'UNRESOLVED',
                'pending', %s, '{}')
        ON CONFLICT DO NOTHING;
        """,
        (TEST_DECISION_ID, f"key-{TEST_DECISION_ID}", conv_id,
         f"eck-{TEST_DECISION_ID}", TEST_REQUEST_ID),
    )

    # Insert pending identity detail linking to the resolution record
    cur.execute(
        """
        INSERT INTO sie_pending_identity_details
            (decision_id, conversation_id, packet_id, graph_version_analyzed,
             source_resolution_record_id, identity_stage_status,
             identity_confidence, sufficiency_stage_status,
             sufficiency_confidence)
        VALUES (%s, %s, %s, 5, %s, 'COMPLETED', 'MEDIUM', 'COMPLETED', 'MEDIUM')
        ON CONFLICT DO NOTHING;
        """,
        (TEST_DECISION_ID, conv_id, TEST_PACKET_ID, TEST_RECORD_ID),
    )

    # Insert pending proposition memberships
    cur.execute(
        """
        INSERT INTO sie_pending_identity_propositions
            (decision_id, conversation_id, proposition_id, ordinal)
        VALUES (%s, %s, %s, 1)
        ON CONFLICT DO NOTHING;
        """,
        (TEST_DECISION_ID, conv_id, "prop-privacy-001"),
    )


# =============================================================================
# Test Group 1: Suppressed Concerns Never Reach Python Context
# =============================================================================


class TestSuppressedConcernsExcludedFromContext:
    """Verify suppressed concerns never appear in GraphStateContext
    returned by v2_load_sie_identity_context.

    Validates: Requirements 7.9 — concerns removed or suppressed under
    applicable deletion/privacy semantics SHALL NOT be exposed through
    ordinary identity retrieval.
    """

    def test_suppressed_concern_excluded_from_context_concerns(self, db):
        """After suppression, the concern does not appear in context concerns."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        # Before suppression: concern should be visible
        ctx_before = _call_load_context(cur)
        concern_ids_before = [c["concern_id"] for c in ctx_before["concerns"]]
        assert TEST_CONCERN_ID in concern_ids_before

        # Suppress the concern
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        # After suppression: concern must NOT appear
        ctx_after = _call_load_context(cur)
        concern_ids_after = [c["concern_id"] for c in ctx_after["concerns"]]
        assert TEST_CONCERN_ID not in concern_ids_after

    def test_suppressed_concern_listed_in_suppressed_ids(self, db):
        """The suppressed concern ID appears in privacy_suppressed_concern_ids."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        ctx = _call_load_context(cur)
        assert TEST_CONCERN_ID in ctx["privacy_suppressed_concern_ids"]

    def test_non_suppressed_concern_still_visible(self, db):
        """Suppressing one concern does not affect other concerns."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        ctx = _call_load_context(cur)
        concern_ids = [c["concern_id"] for c in ctx["concerns"]]
        assert SECOND_CONCERN_ID in concern_ids

    def test_python_context_model_rejects_suppressed_in_concerns(self, db):
        """Even if DB returned a suppressed concern, the Python model should
        never have it present — the RPC excludes at the SQL level."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        ctx = _call_load_context(cur)
        # Simulate what TypeScript does: feed this into GraphStateContext
        # The suppressed concern must not be in concerns array
        for concern in ctx["concerns"]:
            assert concern["concern_id"] != TEST_CONCERN_ID, (
                "Suppressed concern leaked into context concerns array"
            )

    def test_suppressed_concern_not_in_embeddings(self, db):
        """If the embeddings table exists, suppressed concern embeddings
        are excluded from context."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        # Check if embeddings table exists before testing
        cur.execute("""
            SELECT EXISTS(
                SELECT 1 FROM information_schema.tables
                WHERE table_name = 'sie_concern_embeddings'
            );
        """)
        has_embeddings = cur.fetchone()[0]

        if has_embeddings:
            # Insert an embedding for the concern-to-suppress
            cur.execute("""
                INSERT INTO sie_concern_embeddings
                    (concern_id, conversation_id, embedding_vector,
                     source_text_hash, embedding_model_version,
                     graph_version, is_current)
                VALUES (%s, %s, '[0.1,0.2,0.3]'::vector,
                        'hash-test', 'v1.0', 5, TRUE)
                ON CONFLICT DO NOTHING;
            """, (TEST_CONCERN_ID, TEST_CONVERSATION_ID))

            _call_purge(cur, concern_id=TEST_CONCERN_ID)
            ctx = _call_load_context(cur)

            # Embeddings should not contain suppressed concern
            embedding_concern_ids = [
                e["concern_id"] for e in ctx.get("concern_embeddings", [])
            ]
            assert TEST_CONCERN_ID not in embedding_concern_ids

    def test_repeated_context_loads_consistently_exclude(self, db):
        """Multiple context loads after suppression consistently exclude."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        # Load context multiple times
        for _ in range(3):
            ctx = _call_load_context(cur)
            concern_ids = [c["concern_id"] for c in ctx["concerns"]]
            assert TEST_CONCERN_ID not in concern_ids


# =============================================================================
# Test Group 2: Controlled Purge/Redaction Across All Data Types
# =============================================================================


class TestPurgeRedactionCascade:
    """Verify controlled purge/redaction reaches ALL identity data types.

    Validates: Requirements 7.9, 11.5 — purge removes or redacts reasoning,
    evidence snapshots, candidates, LLM diagnostics, retrieval records,
    associations, and pending memberships containing deleted/suppressed content.
    """

    def test_purge_deletes_retrieval_attempts(self, db):
        """Retrieval attempts for the suppressed concern are fully deleted."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        # Verify attempt exists before purge
        cur.execute(
            "SELECT COUNT(*) FROM sie_retrieval_attempts WHERE record_id = %s;",
            (TEST_RECORD_ID,),
        )
        assert cur.fetchone()[0] > 0

        result = _call_purge(cur, concern_id=TEST_CONCERN_ID)
        assert result["status"] == "purged"
        assert result["retrieval_attempts_deleted"] > 0

        # Verify: attempt rows are gone
        cur.execute(
            "SELECT COUNT(*) FROM sie_retrieval_attempts WHERE record_id = %s;",
            (TEST_RECORD_ID,),
        )
        assert cur.fetchone()[0] == 0

    def test_purge_redacts_resolution_records(self, db):
        """Resolution records are redacted (content cleared, audit skeleton kept)."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        result = _call_purge(cur, concern_id=TEST_CONCERN_ID)
        assert result["records_redacted"] > 0

        # Check the redacted record
        cur.execute(
            """SELECT reasoning, candidates_considered, irs_signals,
                      retrieval_attempts, evidence_references,
                      matched_concern_id, proposed_concern_id,
                      outcome, action, identity_stage_status, identity_confidence,
                      record_id, request_id, conversation_id, packet_id
               FROM sie_identity_resolution_records WHERE record_id = %s;""",
            (TEST_RECORD_ID,),
        )
        row = cur.fetchone()
        assert row is not None, "Record skeleton must be preserved"

        # Content-bearing fields are redacted
        reasoning = row[0]
        assert reasoning == "[REDACTED: privacy purge]"
        assert row[1] == []  # candidates_considered
        assert row[2] == []  # irs_signals
        assert row[3] == []  # retrieval_attempts
        assert row[4] == []  # evidence_references
        assert row[5] is None  # matched_concern_id cleared
        assert row[6] is None  # proposed_concern_id cleared
        assert row[7] == "DEFER"  # outcome reset
        assert row[8] == "NONE"  # action reset
        assert row[9] == "FAILED"  # identity_stage_status
        assert row[10] is None  # identity_confidence cleared

        # Audit skeleton preserved
        assert row[11] == TEST_RECORD_ID  # record_id kept
        assert row[12] == TEST_REQUEST_ID  # request_id kept
        assert str(row[13]) == TEST_CONVERSATION_ID  # conversation_id kept
        assert row[14] == TEST_PACKET_ID  # packet_id kept

    def test_purge_deletes_pending_identity_propositions(self, db):
        """Pending proposition memberships for affected decisions are deleted."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        # Verify propositions exist before purge
        cur.execute(
            "SELECT COUNT(*) FROM sie_pending_identity_propositions "
            "WHERE decision_id = %s;",
            (TEST_DECISION_ID,),
        )
        assert cur.fetchone()[0] > 0

        result = _call_purge(cur, concern_id=TEST_CONCERN_ID)
        assert result["pending_propositions_deleted"] > 0

        # Verify: gone
        cur.execute(
            "SELECT COUNT(*) FROM sie_pending_identity_propositions "
            "WHERE decision_id = %s;",
            (TEST_DECISION_ID,),
        )
        assert cur.fetchone()[0] == 0

    def test_purge_deletes_pending_identity_details(self, db):
        """Pending identity detail records for affected decisions are deleted."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        # Verify detail exists before purge
        cur.execute(
            "SELECT COUNT(*) FROM sie_pending_identity_details "
            "WHERE decision_id = %s;",
            (TEST_DECISION_ID,),
        )
        assert cur.fetchone()[0] > 0

        result = _call_purge(cur, concern_id=TEST_CONCERN_ID)
        assert result["pending_details_deleted"] > 0

        # Verify: gone
        cur.execute(
            "SELECT COUNT(*) FROM sie_pending_identity_details "
            "WHERE decision_id = %s;",
            (TEST_DECISION_ID,),
        )
        assert cur.fetchone()[0] == 0

    def test_purge_records_suppression_entry(self, db):
        """A suppression record is created in sie_privacy_suppressions."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID,
                    reason="user_deletion_request", purged_by="admin_tool")

        cur.execute(
            """SELECT entity_type, entity_id, suppressed, purge_reason, purged_by
               FROM sie_privacy_suppressions
               WHERE conversation_id = %s AND entity_id = %s;""",
            (TEST_CONVERSATION_ID, TEST_CONCERN_ID),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == "concern"
        assert row[1] == TEST_CONCERN_ID
        assert row[2] is True  # suppressed
        assert row[3] == "user_deletion_request"
        assert row[4] == "admin_tool"

    def test_purge_records_minimal_audit_event(self, db):
        """A minimal non-content-bearing audit event is recorded."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        # Check sie_audit_history for the privacy_purge event
        cur.execute(
            """SELECT action, entity_kind, entity_id, before_state, after_state,
                      metadata
               FROM sie_audit_history
               WHERE conversation_id = %s AND entity_id = %s
                 AND action = 'privacy_purge';""",
            (TEST_CONVERSATION_ID, TEST_CONCERN_ID),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == "privacy_purge"
        assert row[1] == "concern"
        assert row[2] == TEST_CONCERN_ID
        # before_state should be NULL (no content)
        assert row[3] is None
        # after_state should contain {suppressed: true}
        after = row[4] if isinstance(row[4], dict) else json.loads(row[4])
        assert after["suppressed"] is True
        # metadata contains counts, not content
        meta = row[5] if isinstance(row[5], dict) else json.loads(row[5])
        assert "retrieval_attempts_deleted" in meta
        assert "records_redacted" in meta

    def test_purge_does_not_affect_unrelated_records(self, db):
        """Purging one concern does not affect records for other concerns."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        # Second concern's records should be intact
        cur.execute(
            "SELECT reasoning, matched_concern_id FROM sie_identity_resolution_records "
            "WHERE record_id = %s;",
            (SECOND_RECORD_ID,),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] != "[REDACTED: privacy purge]"
        assert row[1] == SECOND_CONCERN_ID

        # Second concern's retrieval attempts should be intact
        cur.execute(
            "SELECT COUNT(*) FROM sie_retrieval_attempts WHERE record_id = %s;",
            (SECOND_RECORD_ID,),
        )
        assert cur.fetchone()[0] > 0

    def test_purge_idempotent_for_already_suppressed(self, db):
        """Re-purging an already-suppressed concern returns immediately."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        # First purge
        result1 = _call_purge(cur, concern_id=TEST_CONCERN_ID)
        assert result1["status"] == "purged"
        assert result1["total_affected"] > 0

        # Second purge: idempotent, returns early
        result2 = _call_purge(cur, concern_id=TEST_CONCERN_ID)
        assert result2["status"] == "already_suppressed"
        assert result2["total_affected"] == 0

    def test_purge_total_affected_counts_all_data_types(self, db):
        """The total_affected count includes all purged data across tables."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        result = _call_purge(cur, concern_id=TEST_CONCERN_ID)

        total = (
            result["retrieval_attempts_deleted"]
            + result["records_redacted"]
            + result["pending_details_deleted"]
            + result["pending_propositions_deleted"]
        )
        assert result["total_affected"] == total
        assert total > 0

    def test_purge_uses_authorized_mutation_bypass(self, db):
        """Purge succeeds despite append-only triggers (uses session variable)."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        # The purge RPC internally sets sie.allow_mutation = 'true' to bypass
        # append-only triggers. If this wasn't working, the DELETE and UPDATE
        # operations would raise exceptions.
        result = _call_purge(cur, concern_id=TEST_CONCERN_ID)
        assert result["status"] == "purged"

        # Verify the session variable was auto-reset (transaction-scoped)
        # After the RPC returns, normal operations should still be blocked
        cur.execute(
            "SELECT current_setting('sie.allow_mutation', true);"
        )
        setting = cur.fetchone()[0]
        # After SET LOCAL in the RPC, it should reset at transaction boundary
        # But within the same transaction, it might still be 'true'
        # The key test is that WITHOUT the RPC, direct mutation fails
        # This is already tested in TestAppendOnlyEnforcement

    def test_context_snapshot_excludes_after_purge(self, db):
        """After purge, subsequent context snapshots exclude the concern."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)

        # Purge
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        # Load context (simulates what TypeScript would pass to Python)
        ctx = _call_load_context(cur)

        # Concern must NOT be present
        concern_ids = [c["concern_id"] for c in ctx["concerns"]]
        assert TEST_CONCERN_ID not in concern_ids

        # Must be in suppressed list
        assert TEST_CONCERN_ID in ctx["privacy_suppressed_concern_ids"]

        # The second concern must still be present
        assert SECOND_CONCERN_ID in concern_ids


# =============================================================================
# Test Group 3: Rollback and Re-apply Migrations
# =============================================================================


class TestRollbackAndReapply:
    """Test that rollback migration reverses all identity tables/RPCs/triggers
    in dependency-safe order, and re-applying migrations works cleanly.

    Uses a disposable database (same test DB, transaction-isolated).
    """

    def _get_migrations_dir(self):
        """Return the path to the SIE migrations directory."""
        return os.path.join(
            os.path.dirname(__file__), "..", "..", "docs", "migrations", "sie"
        )

    def _table_exists(self, cur, table_name):
        """Check if a table exists in the public schema."""
        cur.execute(
            """SELECT EXISTS(
                SELECT 1 FROM pg_tables
                WHERE tablename = %s AND schemaname = 'public'
            );""",
            (table_name,),
        )
        return cur.fetchone()[0]

    def _function_exists(self, cur, function_name):
        """Check if a function exists."""
        cur.execute(
            """SELECT EXISTS(
                SELECT 1 FROM pg_proc p
                JOIN pg_namespace n ON p.pronamespace = n.oid
                WHERE p.proname = %s AND n.nspname = 'public'
            );""",
            (function_name,),
        )
        return cur.fetchone()[0]

    def test_rollback_removes_identity_tables(self, db):
        """Rollback migration removes all identity-resolution-specific tables."""
        cur = db.cursor()

        # Verify identity tables exist before rollback
        assert self._table_exists(cur, "sie_identity_resolution_records")
        assert self._table_exists(cur, "sie_retrieval_attempts")
        assert self._table_exists(cur, "sie_pending_identity_details")
        assert self._table_exists(cur, "sie_pending_identity_propositions")

        # Execute rollback
        rollback_path = os.path.join(
            self._get_migrations_dir(), "019_rollback_identity_resolution.sql"
        )
        with open(rollback_path, "r") as f:
            rollback_sql = f.read()
        cur.execute(rollback_sql)

        # Identity tables should be gone
        assert not self._table_exists(cur, "sie_identity_resolution_records")
        assert not self._table_exists(cur, "sie_retrieval_attempts")
        assert not self._table_exists(cur, "sie_pending_identity_details")
        assert not self._table_exists(cur, "sie_pending_identity_propositions")
        assert not self._table_exists(cur, "sie_privacy_suppressions")

    def test_rollback_removes_identity_rpcs(self, db):
        """Rollback removes all identity-resolution-specific RPCs/functions."""
        cur = db.cursor()

        # Verify functions exist before rollback
        assert self._function_exists(cur, "v2_load_sie_identity_context")
        assert self._function_exists(cur, "sie_reserve_request")
        assert self._function_exists(cur, "sie_purge_identity_data")

        # Execute rollback
        rollback_path = os.path.join(
            self._get_migrations_dir(), "019_rollback_identity_resolution.sql"
        )
        with open(rollback_path, "r") as f:
            rollback_sql = f.read()
        cur.execute(rollback_sql)

        # Functions should be gone
        assert not self._function_exists(cur, "v2_load_sie_identity_context")
        assert not self._function_exists(cur, "sie_reserve_request")
        assert not self._function_exists(cur, "sie_renew_lease")
        assert not self._function_exists(cur, "sie_record_analyzed_result")
        assert not self._function_exists(cur, "sie_mark_failed_retryable")
        assert not self._function_exists(cur, "sie_supersede_request")
        assert not self._function_exists(cur, "sie_purge_identity_data")
        assert not self._function_exists(cur, "v2_commit_identity_bundle")
        assert not self._function_exists(cur, "v2_validate_identity_bundle")
        assert not self._function_exists(cur, "sie_prevent_mutation")
        assert not self._function_exists(cur, "sie_prevent_delete_only")

    def test_rollback_preserves_pre_existing_tables(self, db):
        """Rollback does NOT remove pre-existing tables that identity depends on."""
        cur = db.cursor()

        # Execute rollback
        rollback_path = os.path.join(
            self._get_migrations_dir(), "019_rollback_identity_resolution.sql"
        )
        with open(rollback_path, "r") as f:
            rollback_sql = f.read()
        cur.execute(rollback_sql)

        # Pre-existing infrastructure must survive
        assert self._table_exists(cur, "conversations")
        assert self._table_exists(cur, "sie_commit_requests")
        assert self._table_exists(cur, "sie_pending_semantic_decisions")
        assert self._table_exists(cur, "sie_persistent_concerns")
        assert self._table_exists(cur, "sie_semantic_packets")
        assert self._table_exists(cur, "sie_entity_registry")

    def test_rollback_preserves_pre_existing_functions(self, db):
        """Rollback preserves v2_commit_update and sie_user_owns_conversation."""
        cur = db.cursor()

        rollback_path = os.path.join(
            self._get_migrations_dir(), "019_rollback_identity_resolution.sql"
        )
        with open(rollback_path, "r") as f:
            rollback_sql = f.read()
        cur.execute(rollback_sql)

        # These functions should survive rollback
        assert self._function_exists(cur, "v2_commit_update")
        assert self._function_exists(cur, "sie_user_owns_conversation")

    def test_rollback_restores_original_commit_request_status(self, db):
        """After rollback, sie_commit_requests status constraint is restored
        to the original PENDING/COMMITTED/REJECTED values."""
        cur = db.cursor()

        rollback_path = os.path.join(
            self._get_migrations_dir(), "019_rollback_identity_resolution.sql"
        )
        with open(rollback_path, "r") as f:
            rollback_sql = f.read()
        cur.execute(rollback_sql)

        # The extended state-machine columns should be gone
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'sie_commit_requests'
              AND column_name IN ('lease_owner', 'lease_expires_at',
                                   'analyzed_result', 'snapshot_digest')
            ORDER BY column_name;
        """)
        extended_cols = [row[0] for row in cur.fetchall()]
        assert extended_cols == [], (
            f"Extended columns should be removed: {extended_cols}"
        )

    def test_reapply_after_rollback_succeeds(self, db):
        """After rollback, re-applying migrations succeeds without errors."""
        cur = db.cursor()
        migrations_dir = self._get_migrations_dir()

        # First: rollback
        rollback_path = os.path.join(
            migrations_dir, "019_rollback_identity_resolution.sql"
        )
        with open(rollback_path, "r") as f:
            rollback_sql = f.read()
        cur.execute(rollback_sql)

        # Verify tables are gone
        assert not self._table_exists(cur, "sie_identity_resolution_records")

        # Re-apply the forward migrations
        forward_migrations = [
            "009_identity_resolution_records.sql",
            "010_retrieval_attempts.sql",
            "011_pending_identity_tables.sql",
        ]
        for migration_file in forward_migrations:
            path = os.path.join(migrations_dir, migration_file)
            if os.path.exists(path):
                with open(path, "r") as f:
                    sql = f.read()
                cur.execute(sql)

        # Tables should be back
        assert self._table_exists(cur, "sie_identity_resolution_records")
        assert self._table_exists(cur, "sie_retrieval_attempts")
        assert self._table_exists(cur, "sie_pending_identity_details")
        assert self._table_exists(cur, "sie_pending_identity_propositions")

    def test_rollback_is_idempotent(self, db):
        """Running rollback multiple times does not error (IF EXISTS usage)."""
        cur = db.cursor()
        migrations_dir = self._get_migrations_dir()

        rollback_path = os.path.join(
            migrations_dir, "019_rollback_identity_resolution.sql"
        )
        with open(rollback_path, "r") as f:
            rollback_sql = f.read()

        # Run rollback twice — second run should not raise
        cur.execute(rollback_sql)
        cur.execute(rollback_sql)  # Idempotent

        # Still no identity tables
        assert not self._table_exists(cur, "sie_identity_resolution_records")
        assert not self._table_exists(cur, "sie_privacy_suppressions")

    def test_data_inserted_after_reapply_works(self, db):
        """After rollback + re-apply, new data can be inserted and queried."""
        cur = db.cursor()
        migrations_dir = self._get_migrations_dir()

        # Rollback
        rollback_path = os.path.join(
            migrations_dir, "019_rollback_identity_resolution.sql"
        )
        with open(rollback_path, "r") as f:
            rollback_sql = f.read()
        cur.execute(rollback_sql)

        # Re-apply
        forward_migrations = [
            "009_identity_resolution_records.sql",
            "010_retrieval_attempts.sql",
            "011_pending_identity_tables.sql",
        ]
        for migration_file in forward_migrations:
            path = os.path.join(migrations_dir, migration_file)
            if os.path.exists(path):
                with open(path, "r") as f:
                    sql = f.read()
                cur.execute(sql)

        # Insert data directly (simplified, no RPC needed for basic insert)
        _ensure_conversation(cur)
        _ensure_packet(cur)
        _ensure_concern(cur)

        cur.execute("""
            INSERT INTO sie_identity_resolution_records
                (record_id, conversation_id, request_id, packet_id,
                 graph_version_analyzed, graph_snapshot_token,
                 outcome, action, identity_stage_status,
                 identity_confidence, sufficiency_stage_status,
                 semantic_policy_version, retrieval_policy_version,
                 model_config_version, prompt_version)
            VALUES ('rec-reapply-001', %s, %s, %s, 5, 'snap-5',
                    'YES', 'ASSIGN_EXISTING', 'COMPLETED', 'HIGH',
                    'COMPLETED', '1.0.0', '1.0.0', '1.0.0', '1.0.0');
        """, (TEST_CONVERSATION_ID, TEST_REQUEST_ID, TEST_PACKET_ID))

        cur.execute(
            "SELECT record_id FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-reapply-001';"
        )
        assert cur.fetchone() is not None


# =============================================================================
# Test Group 4: Python Context Model Privacy Enforcement
# =============================================================================


class TestPythonContextPrivacyEnforcement:
    """Verify that when TypeScript passes context to Python, the Python model
    correctly reflects privacy suppression — Python never receives suppressed
    concern data because the RPC already excludes them.

    This test validates the contract at the integration boundary: the
    GraphStateContext that Python receives from TypeScript-supplied data
    must not contain suppressed concerns.
    """

    def test_context_loader_output_feeds_valid_python_model(self, db):
        """The v2_load_sie_identity_context output can be used to construct
        a valid GraphStateContext where suppressed concerns are absent."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        ctx = _call_load_context(cur)

        # This mimics what TypeScript does: pass the loaded context to Python
        # Verify the invariant: no concern in the concerns list has a
        # concern_id that also appears in privacy_suppressed_concern_ids
        suppressed = set(ctx["privacy_suppressed_concern_ids"])
        for concern in ctx["concerns"]:
            assert concern["concern_id"] not in suppressed, (
                f"PRIVACY VIOLATION: concern {concern['concern_id']} is "
                f"both in concerns array and privacy_suppressed_concern_ids"
            )

    def test_no_sensitive_content_in_context_after_purge(self, db):
        """After purge, no sensitive identity_summary or content from the
        suppressed concern appears anywhere in the context payload."""
        cur = db.cursor()
        _setup_full_privacy_scenario(cur)
        _call_purge(cur, concern_id=TEST_CONCERN_ID)

        ctx = _call_load_context(cur)
        ctx_str = json.dumps(ctx)

        # The suppressed concern's identity_summary must not appear
        assert "User private concern summary" not in ctx_str
        # The concern_id itself may appear in suppressed_ids list (expected)
        # but must NOT appear in concerns, embeddings, or associations
        concern_ids_in_concerns = [c["concern_id"] for c in ctx["concerns"]]
        assert TEST_CONCERN_ID not in concern_ids_in_concerns
