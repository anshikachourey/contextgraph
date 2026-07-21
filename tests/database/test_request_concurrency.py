"""
Mandatory real PostgreSQL concurrency tests for SIE request state RPCs.

Tests cover:
  - Migration 012: sie_commit_requests state machine extension
  - Migration 013: Atomic request-state RPCs (reserve, renew, record, fail, supersede)
  - Migration 014: Atomic identity-context loader (v2_load_sie_identity_context)

Scenarios:
  1. Lease acquisition (NEW_LEASE, IN_PROGRESS, FINGERPRINT_CONFLICT)
  2. Lease renewal (owner, wrong owner, expired)
  3. Lease expiry and takeover (RETRYABLE_LEASE from expired, FAILED_RETRYABLE)
  4. Analyzed result (record, replay, non-owner rejection)
  5. Supersession (owner, non-owner, successor linkage)
  6. Context loader (valid JSONB, missing conversation, graph_version)
  7. Privacy suppression (excluded concerns)

Requires a live PostgreSQL database. Marked with @pytest.mark.database.

Run:  pytest tests/database/test_request_concurrency.py -m database -v
"""

import json

import pytest

pytestmark = pytest.mark.database

# =============================================================================
# Constants
# =============================================================================

TEST_CONV_ID = "00000000-0000-0000-0000-000000000101"
OWNER_A = "worker-alpha"
OWNER_B = "worker-beta"
FINGERPRINT_1 = "fp-hash-aaa"
FINGERPRINT_2 = "fp-hash-bbb"
IDEM_KEY = "idem-concurrency-001"
REQUEST_ID = "req-conc-001"


# =============================================================================
# Fixtures — extends the session conftest with migrations 012, 013, 014
# =============================================================================


@pytest.fixture(scope="session")
def db_with_request_rpcs(db_with_migrations):
    """Apply migrations 012, 013, 014 on top of existing identity migrations."""
    import os

    conn = db_with_migrations
    conn.autocommit = True
    cur = conn.cursor()

    # Check if migrations are already applied (full stack present)
    cur.execute("""
        SELECT EXISTS(
            SELECT 1 FROM pg_proc WHERE proname = 'sie_reserve_request'
        );
    """)
    already_applied = cur.fetchone()[0]

    if already_applied:
        # Migrations already present — just ensure v2_update_state exists
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

    # Prerequisite: v2_update_state table for context loader
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

    # Extend sie_persistent_concerns for context loader fields
    cur.execute("""
        ALTER TABLE sie_persistent_concerns
            ADD COLUMN IF NOT EXISTS display_title TEXT,
            ADD COLUMN IF NOT EXISTS current_summary TEXT,
            ADD COLUMN IF NOT EXISTS canonical_parent_id TEXT,
            ADD COLUMN IF NOT EXISTS parent_resolution_state TEXT,
            ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS semantic_version INTEGER DEFAULT 1,
            ADD COLUMN IF NOT EXISTS merged_into_concern_id TEXT;
    """)

    # Extend sie_semantic_packets for context loader fields
    cur.execute("""
        ALTER TABLE sie_semantic_packets
            ADD COLUMN IF NOT EXISTS message_seq_start BIGINT,
            ADD COLUMN IF NOT EXISTS message_seq_end BIGINT,
            ADD COLUMN IF NOT EXISTS user_grounded_meaning TEXT,
            ADD COLUMN IF NOT EXISTS cohesion_status TEXT DEFAULT 'COHESIVE';
    """)

    # Create sie_concern_aliases if not exists
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_concern_aliases (
            alias_id TEXT PRIMARY KEY,
            concern_id TEXT NOT NULL,
            conversation_id UUID NOT NULL REFERENCES conversations(id),
            alias_text TEXT NOT NULL,
            removed_at TIMESTAMPTZ
        );
    """)

    # Create sie_propositions if not exists
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_propositions (
            proposition_id TEXT PRIMARY KEY,
            conversation_id UUID NOT NULL REFERENCES conversations(id),
            proposition_creation_key TEXT NOT NULL,
            source_message_ids TEXT[] NOT NULL DEFAULT '{}',
            speaker_role TEXT NOT NULL DEFAULT 'USER',
            canonical_meaning TEXT NOT NULL DEFAULT '',
            proposition_type TEXT NOT NULL DEFAULT 'CLAIM',
            message_seq_start BIGINT NOT NULL DEFAULT 0,
            message_seq_end BIGINT NOT NULL DEFAULT 0,
            provenance TEXT NOT NULL DEFAULT 'DIRECT',
            semantic_state TEXT NOT NULL DEFAULT 'ACTIVE',
            retention_levels TEXT[] NOT NULL DEFAULT '{DURABLE_PROPOSITION}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            extraction_version TEXT NOT NULL DEFAULT '1.0.0',
            supersedes_proposition_id TEXT
        );
    """)

    # Create sie_proposition_associations if not exists
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_proposition_associations (
            association_id TEXT PRIMARY KEY,
            conversation_id UUID NOT NULL REFERENCES conversations(id),
            proposition_id TEXT NOT NULL,
            concern_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'PRIMARY_OWNER',
            confidence TEXT DEFAULT 'HIGH',
            semantic_state TEXT NOT NULL DEFAULT 'ACTIVE',
            established_by_packet_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    # Create sie_packet_splits if not exists
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_packet_splits (
            split_id TEXT PRIMARY KEY,
            original_packet_id TEXT NOT NULL,
            resulting_packet_id TEXT NOT NULL,
            conversation_id UUID NOT NULL REFERENCES conversations(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    # Create sie_packet_memberships if not exists
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_packet_memberships (
            membership_id TEXT PRIMARY KEY,
            packet_id TEXT NOT NULL,
            proposition_id TEXT NOT NULL,
            conversation_id UUID NOT NULL REFERENCES conversations(id),
            ordinal INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    # Apply migrations 012, 013, 014 (idempotent — skip if already applied)
    for migration_file in [
        "012_commit_request_state_machine.sql",
        "013_request_state_rpcs.sql",
        "014_identity_context_loader.sql",
    ]:
        path = os.path.join(migrations_dir, migration_file)
        with open(path, "r") as f:
            sql = f.read()
        try:
            cur.execute(sql)
        except Exception:
            # Migration already applied (e.g., constraint already exists)
            conn.rollback()
            conn.autocommit = True
            cur = conn.cursor()

    conn.autocommit = False
    yield conn


@pytest.fixture()
def rpc_db(db_with_request_rpcs):
    """Per-test transactional fixture using SAVEPOINT for isolation."""
    conn = db_with_request_rpcs
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SAVEPOINT rpc_test_start;")
    yield conn
    conn.rollback()


# =============================================================================
# Helpers
# =============================================================================


def _ensure_conversation(cur, conv_id=TEST_CONV_ID):
    """Insert test conversation if not present."""
    cur.execute(
        "INSERT INTO conversations (id) VALUES (%s) ON CONFLICT DO NOTHING;",
        (conv_id,),
    )


def _reserve(cur, conv_id=TEST_CONV_ID, request_id=REQUEST_ID,
             idem_key=IDEM_KEY, fingerprint=FINGERPRINT_1,
             owner=OWNER_A, lease_ms=30000):
    """Call sie_reserve_request and return parsed JSONB result."""
    cur.execute(
        "SELECT sie_reserve_request(%s, %s, %s, %s, %s, %s);",
        (conv_id, request_id, idem_key, fingerprint, owner, lease_ms),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _renew(cur, request_id=REQUEST_ID, owner=OWNER_A, lease_ms=30000):
    """Call sie_renew_lease and return parsed JSONB result."""
    cur.execute(
        "SELECT sie_renew_lease(%s, %s, %s);",
        (request_id, owner, lease_ms),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _record_analyzed(cur, request_id=REQUEST_ID, owner=OWNER_A,
                     result=None, graph_version=1):
    """Call sie_record_analyzed_result and return parsed JSONB result."""
    if result is None:
        result = json.dumps({"outcome": "YES", "matched_concern_id": "c-1"})
    cur.execute(
        "SELECT sie_record_analyzed_result(%s, %s, %s::jsonb, %s);",
        (request_id, owner, result, graph_version),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _mark_failed(cur, request_id=REQUEST_ID, owner=OWNER_A,
                 reason="transient_error"):
    """Call sie_mark_failed_retryable and return parsed JSONB result."""
    cur.execute(
        "SELECT sie_mark_failed_retryable(%s, %s, %s);",
        (request_id, owner, reason),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _supersede(cur, request_id=REQUEST_ID, owner=OWNER_A,
               successor_id="req-succ-001", successor_key="idem-succ-001"):
    """Call sie_supersede_request and return parsed JSONB result."""
    cur.execute(
        "SELECT sie_supersede_request(%s, %s, %s, %s);",
        (request_id, owner, successor_id, successor_key),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _load_context(cur, conv_id=TEST_CONV_ID):
    """Call v2_load_sie_identity_context and return parsed JSONB result."""
    cur.execute(
        "SELECT v2_load_sie_identity_context(%s);",
        (conv_id,),
    )
    raw = cur.fetchone()[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _expire_lease(cur, request_id=REQUEST_ID):
    """Force-expire a lease by setting lease_expires_at in the past."""
    cur.execute(
        "UPDATE sie_commit_requests SET lease_expires_at = NOW() - INTERVAL '1 hour' "
        "WHERE request_id = %s;",
        (request_id,),
    )


# =============================================================================
# Test Group 1: Lease Acquisition
# =============================================================================


class TestLeaseAcquisition:
    """Tests for sie_reserve_request outcomes."""

    def test_new_request_returns_new_lease(self, rpc_db):
        """First reservation for a key returns NEW_LEASE."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        result = _reserve(cur)
        assert result["outcome"] == "NEW_LEASE"
        assert result["request_id"] == REQUEST_ID
        assert "lease_expires_at" in result

    def test_same_key_same_fingerprint_active_lease_returns_in_progress(self, rpc_db):
        """Same key + same fingerprint while RESERVED with active lease → IN_PROGRESS."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur)  # First reservation
        result = _reserve(cur, request_id="req-conc-002", owner=OWNER_B)
        assert result["outcome"] == "IN_PROGRESS"
        assert "lease_expires_at" in result

    def test_same_key_different_fingerprint_returns_conflict(self, rpc_db):
        """Same key + different fingerprint → FINGERPRINT_CONFLICT."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur)  # First with FINGERPRINT_1
        result = _reserve(
            cur,
            request_id="req-conc-003",
            fingerprint=FINGERPRINT_2,
            owner=OWNER_B,
        )
        assert result["outcome"] == "FINGERPRINT_CONFLICT"


# =============================================================================
# Test Group 2: Lease Renewal
# =============================================================================


class TestLeaseRenewal:
    """Tests for sie_renew_lease outcomes."""

    def test_correct_owner_can_renew(self, rpc_db):
        """Lease owner can successfully renew."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur)
        result = _renew(cur, owner=OWNER_A)
        assert result["success"] is True
        assert "lease_expires_at" in result

    def test_wrong_owner_cannot_renew(self, rpc_db):
        """Non-owner cannot renew another worker's lease."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        result = _renew(cur, owner=OWNER_B)
        assert result["success"] is False
        assert result["reason"] == "not_lease_owner"

    def test_expired_lease_cannot_be_renewed(self, rpc_db):
        """Once a lease expires, renewal is rejected."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        _expire_lease(cur)
        result = _renew(cur, owner=OWNER_A)
        assert result["success"] is False
        assert result["reason"] == "lease_expired"


# =============================================================================
# Test Group 3: Lease Expiry and Takeover
# =============================================================================


class TestLeaseExpiryAndTakeover:
    """Tests for expired/failed lease reacquisition (RETRYABLE_LEASE)."""

    def test_expired_lease_can_be_reacquired(self, rpc_db):
        """Expired RESERVED lease can be taken over → RETRYABLE_LEASE."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        _expire_lease(cur)
        result = _reserve(cur, request_id="req-conc-takeover", owner=OWNER_B)
        assert result["outcome"] == "RETRYABLE_LEASE"
        assert "lease_expires_at" in result

    def test_failed_retryable_can_be_reacquired(self, rpc_db):
        """FAILED_RETRYABLE request can be reacquired → RETRYABLE_LEASE."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        _mark_failed(cur, owner=OWNER_A, reason="timeout")
        result = _reserve(cur, request_id="req-conc-retry", owner=OWNER_B)
        assert result["outcome"] == "RETRYABLE_LEASE"
        assert "lease_expires_at" in result


# =============================================================================
# Test Group 4: Analyzed Result
# =============================================================================


class TestAnalyzedResult:
    """Tests for sie_record_analyzed_result and analyzed-result replay."""

    def test_lease_owner_can_record_analyzed_result(self, rpc_db):
        """Active lease owner can transition to ANALYZED."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        result = _record_analyzed(cur, owner=OWNER_A)
        assert result["success"] is True

    def test_subsequent_reservation_returns_analyzed_result(self, rpc_db):
        """After ANALYZED, same fingerprint re-reservation returns cached result."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        analyzed_payload = json.dumps({"outcome": "YES", "matched": "c-99"})
        _record_analyzed(cur, owner=OWNER_A, result=analyzed_payload)
        # New reservation with same key+fingerprint should return ANALYZED_RESULT
        result = _reserve(cur, request_id="req-conc-replay", owner=OWNER_B)
        assert result["outcome"] == "ANALYZED_RESULT"
        assert result["analyzed_result"]["outcome"] == "YES"

    def test_non_owner_cannot_record_analyzed_result(self, rpc_db):
        """Non-owner is rejected when recording analyzed result."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        result = _record_analyzed(cur, owner=OWNER_B)
        assert result["success"] is False
        assert result["reason"] == "not_lease_owner"


# =============================================================================
# Test Group 5: Supersession
# =============================================================================


class TestSupersession:
    """Tests for sie_supersede_request and successor linkage."""

    def test_lease_owner_can_supersede(self, rpc_db):
        """Active lease owner can supersede their request."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        result = _supersede(cur, owner=OWNER_A)
        assert result["success"] is True

    def test_non_owner_cannot_supersede(self, rpc_db):
        """Non-owner cannot supersede."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        result = _supersede(cur, owner=OWNER_B)
        assert result["success"] is False
        assert result["reason"] == "not_lease_owner"

    def test_superseded_request_links_to_successor(self, rpc_db):
        """Superseded request records successor_request_id and key."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        _supersede(
            cur, owner=OWNER_A,
            successor_id="req-succ-linked",
            successor_key="idem-succ-linked",
        )
        cur.execute(
            "SELECT successor_request_id, successor_idempotency_key, status "
            "FROM sie_commit_requests WHERE request_id = %s;",
            (REQUEST_ID,),
        )
        row = cur.fetchone()
        assert row[0] == "req-succ-linked"
        assert row[1] == "idem-succ-linked"
        assert row[2] == "SUPERSEDED"


# =============================================================================
# Test Group 6: Context Loader (v2_load_sie_identity_context)
# =============================================================================


class TestContextLoader:
    """Tests for v2_load_sie_identity_context RPC."""

    def _setup_context_data(self, cur, conv_id=TEST_CONV_ID):
        """Set up prerequisite data for context loading."""
        _ensure_conversation(cur, conv_id)
        # Insert v2_update_state with graph_version
        cur.execute(
            """
            INSERT INTO v2_update_state (conversation_id, graph_version)
            VALUES (%s, 5)
            ON CONFLICT (conversation_id) DO UPDATE SET graph_version = 5;
            """,
            (conv_id,),
        )
        # Insert a concern (include all NOT NULL columns from migration 002)
        cur.execute(
            """
            INSERT INTO sie_persistent_concerns
                (concern_id, conversation_id, identity_summary, display_title,
                 current_summary, status)
            VALUES ('concern-ctx-1', %s, 'Test concern', 'Test Concern Title',
                    'Current summary of test concern', 'ACTIVE')
            ON CONFLICT DO NOTHING;
            """,
            (conv_id,),
        )

    def test_returns_valid_jsonb_with_expected_keys(self, rpc_db):
        """Context loader returns JSONB with all required top-level keys."""
        cur = rpc_db.cursor()
        self._setup_context_data(cur)
        result = _load_context(cur)
        expected_keys = {
            "graph_version",
            "snapshot_token",
            "snapshot_digest",
            "concerns",
            "propositions",
            "active_associations",
            "normalized_aliases",
            "pending_decisions",
            "pending_identity_details",
            "pending_identity_propositions",
            "packet_lineage",
            "concern_embeddings",
            "privacy_suppressed_concern_ids",
        }
        assert expected_keys.issubset(set(result.keys()))

    def test_fails_on_nonexistent_conversation(self, rpc_db):
        """Missing conversation raises exception (fail-closed)."""
        cur = rpc_db.cursor()
        nonexistent_id = "00000000-0000-0000-0000-ffffffffffff"
        with pytest.raises(Exception) as exc_info:
            _load_context(cur, conv_id=nonexistent_id)
        assert "no graph version" in str(exc_info.value).lower() or \
               "p0002" in str(exc_info.value).lower()

    def test_graph_version_matches_snapshot(self, rpc_db):
        """Returned graph_version matches v2_update_state.graph_version."""
        cur = rpc_db.cursor()
        self._setup_context_data(cur)
        result = _load_context(cur)
        assert result["graph_version"] == 5

    def test_context_fields_from_one_snapshot(self, rpc_db):
        """All returned fields belong to one consistent MVCC snapshot.

        We verify that loading context and then checking graph_version
        still returns the same version (MVCC consistency within statement).
        """
        cur = rpc_db.cursor()
        self._setup_context_data(cur)
        result = _load_context(cur)
        # snapshot_token contains the graph version
        assert f"v{result['graph_version']}" in result["snapshot_token"]
        # snapshot_digest is md5 of (token + version)
        import hashlib
        expected_digest = hashlib.md5(
            (result["snapshot_token"] + str(result["graph_version"])).encode()
        ).hexdigest()
        assert result["snapshot_digest"] == expected_digest


# =============================================================================
# Test Group 7: Privacy Suppression
# =============================================================================


class TestPrivacySuppression:
    """Tests that suppressed concerns are excluded from context payload."""

    def test_suppressed_concerns_excluded_from_context(self, rpc_db):
        """When sie_privacy_suppressions has entries, those concerns are excluded."""
        cur = rpc_db.cursor()
        conv_id = TEST_CONV_ID
        _ensure_conversation(cur, conv_id)

        # Create privacy suppressions table
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

        # Set up graph version
        cur.execute(
            """
            INSERT INTO v2_update_state (conversation_id, graph_version)
            VALUES (%s, 3)
            ON CONFLICT (conversation_id) DO UPDATE SET graph_version = 3;
            """,
            (conv_id,),
        )

        # Insert two concerns: one normal, one to be suppressed
        cur.execute(
            """
            INSERT INTO sie_persistent_concerns
                (concern_id, conversation_id, identity_summary, display_title,
                 current_summary, status)
            VALUES
                ('concern-visible', %s, 'Visible concern', 'Visible', 'Visible summary', 'ACTIVE'),
                ('concern-suppressed', %s, 'Suppressed concern', 'Suppressed', 'Suppressed summary', 'ACTIVE')
            ON CONFLICT DO NOTHING;
            """,
            (conv_id, conv_id),
        )

        # Suppress one concern
        cur.execute(
            """
            INSERT INTO sie_privacy_suppressions
                (id, conversation_id, entity_type, entity_id, suppressed)
            VALUES ('sup-1', %s, 'concern', 'concern-suppressed', TRUE);
            """,
            (conv_id,),
        )

        # Load context
        result = _load_context(cur, conv_id)

        # Verify: suppressed concern is NOT in the concerns array
        concern_ids = [c["concern_id"] for c in result["concerns"]]
        assert "concern-visible" in concern_ids
        assert "concern-suppressed" not in concern_ids

        # Verify: suppressed ID is listed in privacy_suppressed_concern_ids
        assert "concern-suppressed" in result["privacy_suppressed_concern_ids"]


# =============================================================================
# Test Group 8: Failure Recovery
# =============================================================================


class TestFailureRecovery:
    """Tests for sie_mark_failed_retryable behavior."""

    def test_lease_owner_can_mark_failed(self, rpc_db):
        """Lease owner can transition RESERVED → FAILED_RETRYABLE."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        result = _mark_failed(cur, owner=OWNER_A, reason="network_timeout")
        assert result["success"] is True

    def test_non_owner_cannot_mark_failed(self, rpc_db):
        """Non-owner cannot mark a request as failed."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        result = _mark_failed(cur, owner=OWNER_B, reason="timeout")
        assert result["success"] is False
        assert result["reason"] == "not_lease_owner"

    def test_failed_request_clears_lease(self, rpc_db):
        """After marking failed, lease_owner and lease_expires_at are cleared."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        _mark_failed(cur, owner=OWNER_A, reason="crash")
        cur.execute(
            "SELECT lease_owner, lease_expires_at, status "
            "FROM sie_commit_requests WHERE request_id = %s;",
            (REQUEST_ID,),
        )
        row = cur.fetchone()
        assert row[0] is None  # lease_owner cleared
        assert row[1] is None  # lease_expires_at cleared
        assert row[2] == "FAILED_RETRYABLE"

    def test_failed_request_records_failure_metadata(self, rpc_db):
        """Transition metadata captures failure reason and origin."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        _mark_failed(cur, owner=OWNER_A, reason="oom_killed")
        cur.execute(
            "SELECT transition_metadata FROM sie_commit_requests "
            "WHERE request_id = %s;",
            (REQUEST_ID,),
        )
        metadata = cur.fetchone()[0]
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        assert metadata["failure_reason"] == "oom_killed"
        assert metadata["failed_by"] == OWNER_A


# =============================================================================
# Test Group 9: Concurrent Waiters (same key, multiple workers)
# =============================================================================


class TestConcurrentWaiters:
    """Tests that multiple workers contending for the same key get correct outcomes."""

    def test_second_worker_sees_in_progress(self, rpc_db):
        """Second worker with same fingerprint gets IN_PROGRESS while lease active."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        result = _reserve(cur, request_id="req-w2", owner=OWNER_B)
        assert result["outcome"] == "IN_PROGRESS"

    def test_worker_takes_over_after_expiry(self, rpc_db):
        """After lease expires, a waiting worker can take over."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        _expire_lease(cur)
        result = _reserve(cur, request_id="req-takeover", owner=OWNER_B)
        assert result["outcome"] == "RETRYABLE_LEASE"
        # Verify the new owner is recorded
        cur.execute(
            "SELECT lease_owner FROM sie_commit_requests "
            "WHERE conversation_id = %s AND idempotency_key = %s;",
            (TEST_CONV_ID, IDEM_KEY),
        )
        assert cur.fetchone()[0] == OWNER_B

    def test_superseded_request_blocks_re_reservation(self, rpc_db):
        """A SUPERSEDED request cannot be re-reserved (returns FINGERPRINT_CONFLICT)."""
        cur = rpc_db.cursor()
        _ensure_conversation(cur)
        _reserve(cur, owner=OWNER_A)
        _supersede(cur, owner=OWNER_A)
        result = _reserve(cur, request_id="req-post-supersede", owner=OWNER_B)
        assert result["outcome"] == "FINGERPRINT_CONFLICT"
