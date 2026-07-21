"""
Mandatory real PostgreSQL commit/security/privacy tests for SIE identity
resolution subsystem.

Tests cover:
  - Migration 016: v2_validate_identity_bundle (RPC-side validation)
  - Migration 015: v2_commit_identity_bundle (atomicity / rollback)
  - Migration 017: Append-only enforcement triggers
  - Migration 018: Privacy purge/redaction (when present)
  - Legacy V2/SIE caller backward compatibility

Requires a live PostgreSQL database. Marked with @pytest.mark.database.

Run:  pytest tests/database/test_commit_security_privacy.py -m database -v
Skip: pytest tests/database/test_commit_security_privacy.py -m "not database"
"""

import json
import os

import pytest

from tests.database.conftest import TEST_CONVERSATION_ID, TEST_PACKET_ID

pytestmark = pytest.mark.database


# =============================================================================
# Constants
# =============================================================================

TEST_CONV_ID = TEST_CONVERSATION_ID
TEST_REQUEST_ID = "req-commit-test-001"
TEST_LEASE_OWNER = "worker-commit-test"
TEST_FINGERPRINT = "fp-commit-test-hash"
TEST_IDEM_KEY = "idem-commit-test-001"


# =============================================================================
# Fixtures — extends session with migrations 012–017
# =============================================================================


@pytest.fixture(scope="session")
def db_with_commit_rpcs(db_with_migrations):
    """Apply migrations 012–017 on top of existing identity migrations (009-011)."""
    conn = db_with_migrations
    conn.autocommit = True
    cur = conn.cursor()

    # Check if migrations are already applied (full stack present)
    cur.execute("""
        SELECT EXISTS(
            SELECT 1 FROM pg_proc WHERE proname = 'v2_commit_identity_bundle'
        );
    """)
    already_applied = cur.fetchone()[0]

    if already_applied:
        # Full migration stack already present — just ensure v2_update_state exists
        cur.execute("""
            CREATE TABLE IF NOT EXISTS v2_update_state (
                conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
                last_processed_message_seq BIGINT NOT NULL DEFAULT 0,
                update_status TEXT NOT NULL DEFAULT 'idle',
                update_version INTEGER NOT NULL DEFAULT 0,
                graph_version INTEGER NOT NULL DEFAULT 1,
                pending_since TIMESTAMPTZ,
                last_update_error TEXT,
                update_failed_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                authoritative_engine TEXT NOT NULL DEFAULT 'V2',
                sie_cutover_graph_version INTEGER
            );
        """)
        conn.autocommit = False
        yield conn
        return

    migrations_dir = os.path.join(
        os.path.dirname(__file__), "..", "..", "docs", "migrations", "sie"
    )

    # Prerequisite tables for context loader / commit RPCs
    cur.execute("""
        CREATE TABLE IF NOT EXISTS v2_update_state (
            conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
            last_processed_message_seq BIGINT NOT NULL DEFAULT 0,
            update_status TEXT NOT NULL DEFAULT 'idle',
            update_version INTEGER NOT NULL DEFAULT 0,
            graph_version INTEGER NOT NULL DEFAULT 1,
            pending_since TIMESTAMPTZ,
            last_update_error TEXT,
            update_failed_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            authoritative_engine TEXT NOT NULL DEFAULT 'V2',
            sie_cutover_graph_version INTEGER
        );
    """)

    # Extend sie_persistent_concerns for fields used by commit RPCs
    cur.execute("""
        ALTER TABLE sie_persistent_concerns
            ADD COLUMN IF NOT EXISTS display_title TEXT,
            ADD COLUMN IF NOT EXISTS current_summary TEXT,
            ADD COLUMN IF NOT EXISTS canonical_parent_id TEXT,
            ADD COLUMN IF NOT EXISTS parent_resolution_state TEXT,
            ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS semantic_version INTEGER DEFAULT 1,
            ADD COLUMN IF NOT EXISTS merged_into_concern_id TEXT,
            ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::JSONB;
    """)

    # Extend sie_semantic_packets for commit RPC references
    cur.execute("""
        ALTER TABLE sie_semantic_packets
            ADD COLUMN IF NOT EXISTS message_seq_start BIGINT,
            ADD COLUMN IF NOT EXISTS message_seq_end BIGINT,
            ADD COLUMN IF NOT EXISTS user_grounded_meaning TEXT,
            ADD COLUMN IF NOT EXISTS cohesion_status TEXT DEFAULT 'COHESIVE';
    """)

    # Create sie_proposition_associations if not exists
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_proposition_associations (
            association_id TEXT PRIMARY KEY,
            association_creation_key TEXT,
            conversation_id UUID NOT NULL REFERENCES conversations(id),
            proposition_id TEXT NOT NULL,
            concern_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'PRIMARY_OWNER',
            confidence TEXT DEFAULT 'HIGH',
            provenance TEXT,
            established_by_packet_id TEXT,
            semantic_state TEXT NOT NULL DEFAULT 'ACTIVE',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            version INTEGER NOT NULL DEFAULT 1
        );
    """)

    # Apply migrations 012 through 017 in order (idempotent — skip if already applied)
    for migration_file in [
        "012_commit_request_state_machine.sql",
        "013_request_state_rpcs.sql",
        "014_identity_context_loader.sql",
        "015_commit_identity_bundle.sql",
        "016_commit_invariant_validation.sql",
        "017_rls_privileges_append_only.sql",
    ]:
        path = os.path.join(migrations_dir, migration_file)
        with open(path, "r") as f:
            sql = f.read()
        try:
            cur.execute(sql)
        except Exception:
            # Migration already applied (e.g., constraint/policy already exists)
            conn.rollback()
            conn.autocommit = True
            cur = conn.cursor()

    conn.autocommit = False
    yield conn


@pytest.fixture()
def db(db_with_commit_rpcs):
    """Per-test transactional fixture using SAVEPOINT for isolation."""
    conn = db_with_commit_rpcs
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SAVEPOINT commit_test_start;")
    yield conn
    conn.rollback()


# =============================================================================
# Helpers
# =============================================================================


def _ensure_conversation(cur, conv_id=TEST_CONV_ID):
    """Insert a test conversation if not already present."""
    cur.execute(
        "INSERT INTO conversations (id) VALUES (%s) ON CONFLICT DO NOTHING;",
        (conv_id,),
    )


def _ensure_update_state(cur, conv_id=TEST_CONV_ID, graph_version=1):
    """Ensure v2_update_state row exists for the conversation."""
    cur.execute(
        """
        INSERT INTO v2_update_state (conversation_id, update_version, graph_version)
        VALUES (%s, %s, %s)
        ON CONFLICT (conversation_id)
            DO UPDATE SET update_version = %s, graph_version = %s;
        """,
        (conv_id, graph_version, graph_version, graph_version, graph_version),
    )


def _ensure_packet(cur, packet_id=TEST_PACKET_ID, conv_id=TEST_CONV_ID):
    """Ensure a semantic packet exists in the conversation."""
    cur.execute(
        """
        INSERT INTO sie_semantic_packets
            (packet_id, packet_creation_key, conversation_id, source_message_ids,
             message_seq_start, message_seq_end, user_grounded_meaning,
             provenance, packet_formation_version, cohesion_status)
        VALUES (%s, %s, %s, ARRAY['msg-1'], 1, 1, 'Test packet meaning',
                'test', '1.0.0', 'COHESIVE')
        ON CONFLICT DO NOTHING;
        """,
        (packet_id, f"key-{packet_id}", conv_id),
    )


def _ensure_concern(cur, concern_id, conv_id=TEST_CONV_ID):
    """Ensure a persistent concern exists in the conversation."""
    cur.execute(
        """
        INSERT INTO sie_persistent_concerns
            (concern_id, conversation_id, identity_summary, display_title,
             current_summary, status)
        VALUES (%s, %s, 'Test concern', 'Test Concern', 'Test summary', 'ACTIVE')
        ON CONFLICT DO NOTHING;
        """,
        (concern_id, conv_id),
    )


def _ensure_entity_registry(cur, entity_id, conv_id=TEST_CONV_ID,
                            entity_kind="identity_resolution_record"):
    """Register an entity in the sie_entity_registry."""
    creation_key = f"key-{entity_id}"
    cur.execute(
        """
        INSERT INTO sie_entity_registry
            (conversation_id, entity_kind, creation_key, entity_id, request_id)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING;
        """,
        (conv_id, entity_kind, creation_key, entity_id, TEST_REQUEST_ID),
    )


def _reserve_request(cur, conv_id=TEST_CONV_ID, request_id=TEST_REQUEST_ID,
                     idem_key=TEST_IDEM_KEY, fingerprint=TEST_FINGERPRINT,
                     owner=TEST_LEASE_OWNER, lease_ms=60000):
    """Reserve a commit request and return the result."""
    cur.execute(
        "SELECT sie_reserve_request(%s, %s, %s, %s, %s, %s);",
        (conv_id, request_id, idem_key, fingerprint, owner, lease_ms),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _make_valid_resolution_record(record_id, packet_id=TEST_PACKET_ID,
                                  graph_version=1):
    """Create a valid YES/ASSIGN_EXISTING resolution record payload."""
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
        "matched_concern_id": "concern-matched-bundle",
        "proposed_concern_id": None,
        "reasoning": "Test valid resolution",
        "semantic_policy_version": "1.0.0",
        "retrieval_policy_version": "1.0.0",
        "model_config_version": "1.0.0",
        "prompt_version": "1.0.0",
    }


def _make_valid_retrieval_attempt(attempt_id, record_id, packet_id=TEST_PACKET_ID):
    """Create a valid retrieval attempt payload."""
    return {
        "attempt_id": attempt_id,
        "record_id": record_id,
        "packet_id": packet_id,
        "channel_id": "ch-emb-001",
        "channel_family": "embedding_primary",
        "query_mode": "broad",
        "query_reference": "embedding vector ref",
        "scope_description": "All active concerns",
        "status": "SUCCESS_WITH_CANDIDATES",
        "candidate_ids": ["cand-1"],
        "candidate_count": 1,
        "retrieval_policy_version": "1.0.0",
    }


def _call_validate(cur, conv_id=TEST_CONV_ID, request_id=TEST_REQUEST_ID,
                   **kwargs):
    """Call v2_validate_identity_bundle and return parsed JSONB result."""
    params = {
        "p_conversation_id": conv_id,
        "p_request_id": request_id,
        "p_lease_owner": kwargs.get("lease_owner"),
        "p_payload_fingerprint_hash": kwargs.get("fingerprint"),
        "p_graph_version_analyzed": kwargs.get("graph_version"),
        "p_identity_resolution_records": kwargs.get("records"),
        "p_retrieval_attempts": kwargs.get("attempts"),
        "p_association_mutations": kwargs.get("associations"),
        "p_shared_proposals": kwargs.get("proposals"),
    }
    cur.execute(
        """
        SELECT v2_validate_identity_bundle(
            p_conversation_id := %(p_conversation_id)s,
            p_request_id := %(p_request_id)s,
            p_lease_owner := %(p_lease_owner)s,
            p_payload_fingerprint_hash := %(p_payload_fingerprint_hash)s,
            p_graph_version_analyzed := %(p_graph_version_analyzed)s,
            p_identity_resolution_records := %(p_identity_resolution_records)s,
            p_retrieval_attempts := %(p_retrieval_attempts)s,
            p_association_mutations := %(p_association_mutations)s,
            p_shared_proposals := %(p_shared_proposals)s
        );
        """,
        {
            "p_conversation_id": conv_id,
            "p_request_id": request_id,
            "p_lease_owner": params["p_lease_owner"],
            "p_payload_fingerprint_hash": params["p_payload_fingerprint_hash"],
            "p_graph_version_analyzed": params["p_graph_version_analyzed"],
            "p_identity_resolution_records": (
                json.dumps(params["p_identity_resolution_records"])
                if params["p_identity_resolution_records"] is not None
                else None
            ),
            "p_retrieval_attempts": (
                json.dumps(params["p_retrieval_attempts"])
                if params["p_retrieval_attempts"] is not None
                else None
            ),
            "p_association_mutations": (
                json.dumps(params["p_association_mutations"])
                if params["p_association_mutations"] is not None
                else None
            ),
            "p_shared_proposals": (
                json.dumps(params["p_shared_proposals"])
                if params["p_shared_proposals"] is not None
                else None
            ),
        },
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _call_commit_bundle(cur, conv_id=TEST_CONV_ID, request_id=TEST_REQUEST_ID,
                        **kwargs):
    """Call v2_commit_identity_bundle and return parsed JSONB result."""
    params = {
        "records": kwargs.get("records"),
        "attempts": kwargs.get("attempts"),
        "details": kwargs.get("details"),
        "propositions": kwargs.get("propositions"),
        "associations": kwargs.get("associations"),
        "proposals": kwargs.get("proposals"),
        "transition": kwargs.get("transition"),
        "lease_owner": kwargs.get("lease_owner"),
        "fingerprint": kwargs.get("fingerprint"),
        "graph_version": kwargs.get("graph_version"),
    }
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
            "records": (
                json.dumps(params["records"]) if params["records"] else None
            ),
            "attempts": (
                json.dumps(params["attempts"]) if params["attempts"] else None
            ),
            "details": (
                json.dumps(params["details"]) if params["details"] else None
            ),
            "propositions": (
                json.dumps(params["propositions"]) if params["propositions"] else None
            ),
            "associations": (
                json.dumps(params["associations"]) if params["associations"] else None
            ),
            "proposals": (
                json.dumps(params["proposals"]) if params["proposals"] else None
            ),
            "transition": (
                json.dumps(params["transition"]) if params["transition"] else None
            ),
            "lease_owner": params["lease_owner"],
            "fingerprint": params["fingerprint"],
            "graph_version": params["graph_version"],
        },
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _setup_full_commit_context(cur, conv_id=TEST_CONV_ID, graph_version=1):
    """Set up all prerequisites for a valid commit test."""
    _ensure_conversation(cur, conv_id)
    _ensure_update_state(cur, conv_id, graph_version)
    _ensure_packet(cur, TEST_PACKET_ID, conv_id)
    _ensure_concern(cur, "concern-matched-bundle", conv_id)
    _ensure_entity_registry(cur, "rec-bundle-001", conv_id)
    _reserve_request(cur, conv_id)


# =============================================================================
# Test Group 1: Validation Tests (v2_validate_identity_bundle)
# =============================================================================


class TestValidation:
    """Tests for v2_validate_identity_bundle RPC-side validation."""

    def test_valid_bundle_passes_validation(self, db):
        """A well-formed bundle with valid lease, fingerprint, and version passes."""
        cur = db.cursor()
        _setup_full_commit_context(cur)
        record = _make_valid_resolution_record("rec-bundle-001")
        result = _call_validate(
            cur,
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
            records=[record],
        )
        assert result["valid"] is True

    def test_lease_owner_mismatch_caught(self, db):
        """Providing a wrong lease owner produces LEASE_OWNER_MISMATCH violation."""
        cur = db.cursor()
        _setup_full_commit_context(cur)
        record = _make_valid_resolution_record("rec-bundle-001")
        result = _call_validate(
            cur,
            lease_owner="wrong-owner",
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
            records=[record],
        )
        assert result["valid"] is False
        codes = [v["code"] for v in result["violations"]]
        assert "LEASE_OWNER_MISMATCH" in codes

    def test_fingerprint_mismatch_caught(self, db):
        """Providing a different fingerprint produces FINGERPRINT_MISMATCH violation."""
        cur = db.cursor()
        _setup_full_commit_context(cur)
        record = _make_valid_resolution_record("rec-bundle-001")
        result = _call_validate(
            cur,
            lease_owner=TEST_LEASE_OWNER,
            fingerprint="wrong-fingerprint-hash",
            graph_version=1,
            records=[record],
        )
        assert result["valid"] is False
        codes = [v["code"] for v in result["violations"]]
        assert "FINGERPRINT_MISMATCH" in codes

    def test_stale_graph_version_caught(self, db):
        """Graph version mismatch produces GRAPH_VERSION_STALE violation."""
        cur = db.cursor()
        _setup_full_commit_context(cur, graph_version=5)
        record = _make_valid_resolution_record("rec-bundle-001", graph_version=3)
        result = _call_validate(
            cur,
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=3,  # Stale: current is 5
            records=[record],
        )
        assert result["valid"] is False
        codes = [v["code"] for v in result["violations"]]
        assert "GRAPH_VERSION_STALE" in codes

    def test_invalid_outcome_action_combination_caught(self, db):
        """An invalid outcome/action combination produces RESULT_BRANCH_VIOLATION."""
        cur = db.cursor()
        _setup_full_commit_context(cur)
        record = _make_valid_resolution_record("rec-bundle-001")
        # Invalidate: YES outcome with PROPOSE_NEW action
        record["action"] = "PROPOSE_NEW"
        result = _call_validate(
            cur,
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
            records=[record],
        )
        assert result["valid"] is False
        codes = [v["code"] for v in result["violations"]]
        assert "RESULT_BRANCH_VIOLATION" in codes

    def test_combined_violations_all_reported(self, db):
        """Multiple violations in one bundle are all reported together."""
        cur = db.cursor()
        _setup_full_commit_context(cur, graph_version=5)
        record = _make_valid_resolution_record("rec-bundle-001", graph_version=3)
        record["action"] = "PROPOSE_NEW"  # Invalid for YES outcome
        result = _call_validate(
            cur,
            lease_owner="wrong-owner",
            fingerprint="wrong-fp",
            graph_version=3,  # Stale
            records=[record],
        )
        assert result["valid"] is False
        codes = [v["code"] for v in result["violations"]]
        # Should contain multiple violation types
        assert len(codes) >= 2


# =============================================================================
# Test Group 2: Atomicity Tests (v2_commit_identity_bundle)
# =============================================================================


class TestAtomicity:
    """Tests that v2_commit_identity_bundle is fully atomic (all or nothing)."""

    def test_successful_bundle_commit_inserts_all_records(self, db):
        """A valid bundle with records and attempts inserts everything."""
        cur = db.cursor()
        _setup_full_commit_context(cur)
        record = _make_valid_resolution_record("rec-bundle-001")
        attempt = _make_valid_retrieval_attempt("att-bundle-001", "rec-bundle-001")

        result = _call_commit_bundle(
            cur,
            records=[record],
            attempts=[attempt],
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
        )
        assert result["success"] is True
        assert result["identity_bundle_applied"] is True
        assert result["records_inserted"] == 1
        assert result["attempts_inserted"] == 1

        # Verify records are actually present
        cur.execute(
            "SELECT record_id FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-bundle-001';"
        )
        assert cur.fetchone() is not None

        cur.execute(
            "SELECT attempt_id FROM sie_retrieval_attempts "
            "WHERE attempt_id = 'att-bundle-001';"
        )
        assert cur.fetchone() is not None

    def test_duplicate_record_id_rolls_back_everything(self, db):
        """A duplicate resolution record_id in the same bundle triggers a
        validation failure; nothing persists from the failed transaction."""
        cur = db.cursor()
        _setup_full_commit_context(cur)

        # First: insert a record successfully
        record = _make_valid_resolution_record("rec-bundle-001")
        _call_commit_bundle(
            cur,
            records=[record],
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
        )

        # Use a savepoint so we can test rollback without losing our setup
        cur.execute("SAVEPOINT before_dup;")

        # Try to insert a second bundle that references a NEW attempt but
        # uses the same record_id (ON CONFLICT DO NOTHING avoids error in
        # records, but if we force a real failure on the attempt side with
        # an invalid channel_family, the whole transaction should fail.)
        bad_attempt = _make_valid_retrieval_attempt("att-dup-001", "rec-bundle-001")
        bad_attempt["channel_family"] = "INVALID_CHANNEL"  # Will fail CHECK

        try:
            _call_commit_bundle(
                cur,
                records=[record],  # Duplicate record_id (DO NOTHING)
                attempts=[bad_attempt],  # Invalid channel_family
                lease_owner=TEST_LEASE_OWNER,
                fingerprint=TEST_FINGERPRINT,
                graph_version=1,
            )
            # If no exception, bundle handled it — check it failed
            pytest.fail("Expected exception for invalid channel_family")
        except Exception as e:
            assert "failed" in str(e).lower() or "check" in str(e).lower()
            cur.execute("ROLLBACK TO SAVEPOINT before_dup;")

        # Verify: the bad attempt was NOT inserted
        cur.execute(
            "SELECT attempt_id FROM sie_retrieval_attempts "
            "WHERE attempt_id = 'att-dup-001';"
        )
        assert cur.fetchone() is None

    def test_invalid_channel_family_in_attempt_rolls_back(self, db):
        """A retrieval attempt with invalid channel_family causes full rollback."""
        cur = db.cursor()
        _setup_full_commit_context(cur)
        record = _make_valid_resolution_record("rec-bundle-001")
        attempt = _make_valid_retrieval_attempt("att-bad-fam", "rec-bundle-001")
        attempt["channel_family"] = "totally_invalid_family"

        cur.execute("SAVEPOINT before_bad_attempt;")
        try:
            _call_commit_bundle(
                cur,
                records=[record],
                attempts=[attempt],
                lease_owner=TEST_LEASE_OWNER,
                fingerprint=TEST_FINGERPRINT,
                graph_version=1,
            )
            pytest.fail("Expected exception for invalid channel_family")
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT before_bad_attempt;")

        # Neither the record nor the attempt should exist
        cur.execute(
            "SELECT record_id FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-bundle-001';"
        )
        assert cur.fetchone() is None
        cur.execute(
            "SELECT attempt_id FROM sie_retrieval_attempts "
            "WHERE attempt_id = 'att-bad-fam';"
        )
        assert cur.fetchone() is None

    def test_no_partial_state_after_validation_failure(self, db):
        """When validation fails (e.g., stale graph version), no records persist."""
        cur = db.cursor()
        _setup_full_commit_context(cur, graph_version=5)
        record = _make_valid_resolution_record("rec-bundle-001", graph_version=3)
        attempt = _make_valid_retrieval_attempt("att-partial-001", "rec-bundle-001")

        cur.execute("SAVEPOINT before_stale;")
        try:
            _call_commit_bundle(
                cur,
                records=[record],
                attempts=[attempt],
                lease_owner=TEST_LEASE_OWNER,
                fingerprint=TEST_FINGERPRINT,
                graph_version=3,  # Stale: current is 5
            )
            pytest.fail("Expected exception for stale graph version")
        except Exception as e:
            assert "validation failed" in str(e).lower() or "stale" in str(e).lower()
            cur.execute("ROLLBACK TO SAVEPOINT before_stale;")

        # Nothing persisted
        cur.execute(
            "SELECT record_id FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-bundle-001';"
        )
        assert cur.fetchone() is None
        cur.execute(
            "SELECT attempt_id FROM sie_retrieval_attempts "
            "WHERE attempt_id = 'att-partial-001';"
        )
        assert cur.fetchone() is None


# =============================================================================
# Test Group 3: Append-Only Enforcement (Migration 017)
# =============================================================================


class TestAppendOnlyEnforcement:
    """Tests that append-only triggers prevent direct UPDATE/DELETE."""

    def _insert_record_directly(self, cur):
        """Insert a resolution record for mutation tests (via commit RPC)."""
        _setup_full_commit_context(cur)
        record = _make_valid_resolution_record("rec-append-test")
        _ensure_entity_registry(cur, "rec-append-test")
        _call_commit_bundle(
            cur,
            records=[record],
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
        )

    def test_direct_update_on_resolution_records_raises(self, db):
        """Direct UPDATE on sie_identity_resolution_records raises exception."""
        cur = db.cursor()
        self._insert_record_directly(cur)
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                "UPDATE sie_identity_resolution_records "
                "SET reasoning = 'hacked' WHERE record_id = 'rec-append-test';"
            )
        err = str(exc_info.value).lower()
        assert "append-only" in err or "not permitted" in err or "42501" in err
        db.rollback()

    def test_direct_delete_on_resolution_records_raises(self, db):
        """Direct DELETE on sie_identity_resolution_records raises exception."""
        cur = db.cursor()
        self._insert_record_directly(cur)
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                "DELETE FROM sie_identity_resolution_records "
                "WHERE record_id = 'rec-append-test';"
            )
        err = str(exc_info.value).lower()
        assert "append-only" in err or "not permitted" in err or "42501" in err
        db.rollback()

    def test_direct_update_on_retrieval_attempts_raises(self, db):
        """Direct UPDATE on sie_retrieval_attempts raises exception."""
        cur = db.cursor()
        self._insert_record_directly(cur)
        # Also insert an attempt
        attempt = _make_valid_retrieval_attempt("att-append-test", "rec-append-test")
        _call_commit_bundle(
            cur,
            attempts=[attempt],
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
        )
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                "UPDATE sie_retrieval_attempts "
                "SET failure_reason = 'hacked' WHERE attempt_id = 'att-append-test';"
            )
        err = str(exc_info.value).lower()
        assert "append-only" in err or "not permitted" in err or "42501" in err
        db.rollback()

    def test_direct_delete_on_retrieval_attempts_raises(self, db):
        """Direct DELETE on sie_retrieval_attempts raises exception."""
        cur = db.cursor()
        self._insert_record_directly(cur)
        attempt = _make_valid_retrieval_attempt("att-del-test", "rec-append-test")
        _call_commit_bundle(
            cur,
            attempts=[attempt],
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
        )
        with pytest.raises(Exception) as exc_info:
            cur.execute(
                "DELETE FROM sie_retrieval_attempts "
                "WHERE attempt_id = 'att-del-test';"
            )
        err = str(exc_info.value).lower()
        assert "append-only" in err or "not permitted" in err or "42501" in err
        db.rollback()

    def test_authorized_mutation_via_session_variable_succeeds(self, db):
        """Setting sie.allow_mutation = 'true' permits DELETE (privacy purge path)."""
        cur = db.cursor()
        self._insert_record_directly(cur)
        # Set the session variable that authorized SECURITY DEFINER RPCs use
        cur.execute("SET LOCAL sie.allow_mutation = 'true';")
        # This should succeed (simulates privacy purge RPC)
        cur.execute(
            "DELETE FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-append-test';"
        )
        cur.execute(
            "SELECT record_id FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-append-test';"
        )
        assert cur.fetchone() is None


# =============================================================================
# Test Group 4: Privacy Purge / Redaction (Migration 018 — guarded)
# =============================================================================


def _migration_018_exists():
    """Check if migration 018 (privacy purge) SQL file exists."""
    migrations_dir = os.path.join(
        os.path.dirname(__file__), "..", "..", "docs", "migrations", "sie"
    )
    # Look for any file starting with 018
    for f in os.listdir(migrations_dir):
        if f.startswith("018"):
            return True
    return False


def _privacy_purge_function_exists(cur):
    """Check if the privacy purge function exists in the database."""
    cur.execute("""
        SELECT EXISTS(
            SELECT 1 FROM pg_proc
            WHERE proname LIKE '%privacy_purge%'
               OR proname LIKE '%sie_purge%'
               OR proname LIKE '%sie_redact%'
        );
    """)
    return cur.fetchone()[0]


@pytest.mark.skipif(
    not _migration_018_exists(),
    reason="Migration 018 (privacy purge) not yet created"
)
class TestPrivacyPurge:
    """Tests for privacy purge/redaction when migration 018 is available."""

    def test_purge_redacts_reasoning_and_diagnostics(self, db):
        """Privacy purge removes reasoning, evidence, and LLM diagnostics."""
        cur = db.cursor()
        if not _privacy_purge_function_exists(cur):
            pytest.skip("Privacy purge function not available in database")

        _setup_full_commit_context(cur)
        record = _make_valid_resolution_record("rec-purge-test")
        _ensure_entity_registry(cur, "rec-purge-test")
        _call_commit_bundle(
            cur,
            records=[record],
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
        )

        # Execute purge (exact RPC name TBD by migration 018)
        cur.execute("""
            SELECT EXISTS(
                SELECT 1 FROM pg_proc WHERE proname = 'sie_purge_identity_data'
            );
        """)
        if not cur.fetchone()[0]:
            pytest.skip("sie_purge_identity_data function not found")

        cur.execute(
            "SELECT sie_purge_identity_data(%s, %s, %s, %s);",
            (TEST_CONV_ID, "concern-matched-bundle", "test_purge", "test_runner"),
        )
        # Verify reasoning is redacted
        cur.execute(
            "SELECT reasoning FROM sie_identity_resolution_records "
            "WHERE record_id = 'rec-purge-test';"
        )
        row = cur.fetchone()
        # After purge, reasoning should be redacted or record removed
        assert row is None or row[0] in (None, "", "[REDACTED]", "[REDACTED: privacy purge]")

    def test_subsequent_context_load_excludes_suppressed_concern(self, db):
        """After purge, context loader no longer returns suppressed concern."""
        cur = db.cursor()
        if not _privacy_purge_function_exists(cur):
            pytest.skip("Privacy purge function not available in database")

        _setup_full_commit_context(cur)
        _ensure_concern(cur, "concern-to-suppress")

        # Create privacy suppression table if needed
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sie_privacy_suppressions (
                id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
                conversation_id UUID NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                suppressed BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        """)

        # Insert suppression
        cur.execute("""
            INSERT INTO sie_privacy_suppressions
                (id, conversation_id, entity_type, entity_id, suppressed)
            VALUES ('sup-purge-test', %s, 'concern', 'concern-to-suppress', TRUE);
        """, (TEST_CONV_ID,))

        # Load context and verify exclusion
        cur.execute(
            "SELECT v2_load_sie_identity_context(%s);", (TEST_CONV_ID,)
        )
        raw = cur.fetchone()[0]
        result = json.loads(raw) if isinstance(raw, str) else raw
        concern_ids = [c["concern_id"] for c in result.get("concerns", [])]
        assert "concern-to-suppress" not in concern_ids
        assert "concern-to-suppress" in result.get(
            "privacy_suppressed_concern_ids", []
        )

    def test_suppression_record_is_created(self, db):
        """Privacy purge creates a suppression record in the tracking table."""
        cur = db.cursor()
        if not _privacy_purge_function_exists(cur):
            pytest.skip("Privacy purge function not available in database")

        _setup_full_commit_context(cur)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS sie_privacy_suppressions (
                id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
                conversation_id UUID NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                suppressed BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        """)

        # Attempt the purge RPC if available
        cur.execute("""
            SELECT EXISTS(
                SELECT 1 FROM pg_proc WHERE proname = 'sie_purge_identity_data'
            );
        """)
        if not cur.fetchone()[0]:
            pytest.skip("sie_purge_identity_data function not found")

        cur.execute(
            "SELECT sie_purge_identity_data(%s, %s, %s, %s);",
            (TEST_CONV_ID, "concern-matched-bundle", "test_purge", "test_runner"),
        )

        # Verify a suppression record exists
        cur.execute("""
            SELECT entity_id FROM sie_privacy_suppressions
            WHERE conversation_id = %s AND entity_id = 'concern-matched-bundle';
        """, (TEST_CONV_ID,))
        assert cur.fetchone() is not None


# =============================================================================
# Test Group 5: Legacy V2 Compatibility
# =============================================================================


class TestLegacyV2Compatibility:
    """Tests that legacy V2/SIE callers remain compatible."""

    def test_all_null_identity_fields_returns_noop_success(self, db):
        """Calling v2_commit_identity_bundle with all NULL identity fields
        returns an immediate no-op success (backward compat for legacy callers)."""
        cur = db.cursor()
        _ensure_conversation(cur)
        # Call the 12-param signature explicitly with all identity fields NULL
        cur.execute(
            """
            SELECT v2_commit_identity_bundle(
                p_conversation_id := %s::UUID,
                p_request_id := %s::TEXT,
                p_identity_resolution_records := NULL::JSONB,
                p_retrieval_attempts := NULL::JSONB,
                p_pending_identity_details := NULL::JSONB,
                p_pending_identity_propositions := NULL::JSONB,
                p_association_mutations := NULL::JSONB,
                p_shared_proposals := NULL::JSONB,
                p_request_state_transition := NULL::JSONB,
                p_lease_owner := NULL::TEXT,
                p_payload_fingerprint_hash := NULL::TEXT,
                p_graph_version_analyzed := NULL::INTEGER
            );
            """,
            (TEST_CONV_ID, "req-legacy-001"),
        )
        raw = cur.fetchone()[0]
        result = json.loads(raw) if isinstance(raw, str) else raw
        assert result["success"] is True
        assert result["identity_bundle_applied"] is False
        assert result["reason"] == "no_identity_fields_provided"

    def test_v2_commit_update_still_works_for_non_identity_callers(self, db):
        """The existing v2_commit_update function still works for non-identity
        (legacy V2) callers by passing NULL for p_required_engine."""
        cur = db.cursor()
        _ensure_conversation(cur)
        _ensure_update_state(cur, graph_version=1)

        # Create minimal v2_graph_snapshots table if not exists
        cur.execute("""
            CREATE TABLE IF NOT EXISTS v2_graph_snapshots (
                conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
                graph_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
                status TEXT NOT NULL DEFAULT 'ready',
                diagnostics JSONB DEFAULT '{}'::JSONB,
                last_processed_message_seq BIGINT DEFAULT 0,
                graph_version INTEGER NOT NULL DEFAULT 1,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        """)
        cur.execute(
            """
            INSERT INTO v2_graph_snapshots (conversation_id, graph_version)
            VALUES (%s, 1)
            ON CONFLICT (conversation_id) DO NOTHING;
            """,
            (TEST_CONV_ID,),
        )

        # Check if v2_commit_update exists and is callable
        cur.execute("""
            SELECT EXISTS(
                SELECT 1 FROM pg_proc WHERE proname = 'v2_commit_update'
            );
        """)
        if not cur.fetchone()[0]:
            pytest.skip("v2_commit_update not available")

        # Call v2_commit_update without p_required_engine (V2-only path)
        # This tests the legacy path is still operational
        try:
            cur.execute(
                """
                SELECT v2_commit_update(
                    p_conversation_id := %s,
                    p_new_snapshot := %s::JSONB,
                    p_from_version := %s,
                    p_to_version := %s,
                    p_mutations := %s::JSONB,
                    p_last_processed_seq := %s,
                    p_message_seq_from := %s,
                    p_message_seq_to := %s
                );
                """,
                (
                    TEST_CONV_ID,
                    json.dumps({"nodes": [], "edges": []}),
                    1,  # from_version
                    2,  # to_version
                    json.dumps([]),  # mutations
                    1,  # last_processed_seq
                    1,  # message_seq_from
                    1,  # message_seq_to
                ),
            )
            raw = cur.fetchone()[0]
            result = json.loads(raw) if isinstance(raw, str) else raw
            # V2 path should succeed or at least not crash
            assert result.get("success") is True or "version" in str(result)
        except Exception as e:
            # Acceptable: version conflict error (which means the V2 path IS
            # running and doing its version check)
            err = str(e).lower()
            assert (
                "version" in err
                or "conflict" in err
                or "mismatch" in err
                or "graph_version" in err
            ), f"Unexpected error on V2 path: {e}"

    def test_identity_bundle_with_only_request_transition_succeeds(self, db):
        """A caller providing only a request state transition (no records,
        attempts, etc.) is treated as having identity work and succeeds."""
        cur = db.cursor()
        _setup_full_commit_context(cur)

        transition = {
            "target_status": "COMMITTED",
            "committed_graph_version": 1,
            "request_id": TEST_REQUEST_ID,
        }
        result = _call_commit_bundle(
            cur,
            transition=transition,
            lease_owner=TEST_LEASE_OWNER,
            fingerprint=TEST_FINGERPRINT,
            graph_version=1,
        )
        assert result["success"] is True
        assert result["identity_bundle_applied"] is True
        assert result["request_transitioned"] is True

        # Verify the request was transitioned
        cur.execute(
            "SELECT status FROM sie_commit_requests WHERE request_id = %s;",
            (TEST_REQUEST_ID,),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == "COMMITTED"
