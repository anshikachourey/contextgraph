"""
Shared fixtures for real PostgreSQL database tests.

These tests require a live PostgreSQL database with all SIE migrations applied.
They are marked with @pytest.mark.database so they can be skipped in environments
without a database available.

Setup:
    # One-time bootstrap (creates DB, roles, applies all migrations):
    ./scripts/setup-test-db.sh

    # Or reset an existing test DB:
    ./scripts/setup-test-db.sh --reset

Usage:
    # Run all database tests:
    TEST_DATABASE_URL="postgresql://<user>@localhost:5432/contextgraph_test" \
        ml-service/venv/bin/python -m pytest tests/database/ -v

    # Skip database tests:
    pytest tests/database/ -m "not database"

Environment variables:
    TEST_DATABASE_URL: PostgreSQL connection string for a disposable test database.
                      Default: postgresql://postgres:postgres@localhost:5432/contextgraph_test

Dependencies (declared in ml-service/requirements.txt):
    - psycopg2-binary>=2.9.9
    - pytest-asyncio>=0.23.0
"""

import os

import pytest

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/contextgraph_test",
)


def _get_connection():
    """Get a psycopg2 connection to the test database."""
    try:
        import psycopg2

        return psycopg2.connect(DATABASE_URL)
    except ImportError:
        pytest.skip("psycopg2 not installed — skipping real PostgreSQL tests")
    except Exception as e:
        pytest.skip(f"Cannot connect to test database: {e}")


@pytest.fixture(scope="session")
def db_connection():
    """Session-scoped database connection.

    Creates prerequisite tables (conversations, sie_entity_registry, etc.)
    needed by the identity tables, then applies all three identity migrations.
    Tears down in reverse order after the session.
    """
    conn = _get_connection()
    conn.autocommit = True
    cur = conn.cursor()

    # --- Prerequisite scaffolding ---
    # Minimal conversations table expected by FK references
    cur.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    """)

    # Minimal sie_entity_registry (referenced in comments, not FK'd)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_entity_registry (
            conversation_id UUID NOT NULL,
            entity_kind TEXT NOT NULL,
            creation_key TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            PRIMARY KEY (conversation_id, entity_kind, creation_key)
        );
    """)

    # Minimal sie_persistent_concerns
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_persistent_concerns (
            concern_id TEXT PRIMARY KEY,
            conversation_id UUID NOT NULL REFERENCES conversations(id),
            identity_summary TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ACTIVE'
        );
    """)

    # Minimal sie_semantic_packets
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_semantic_packets (
            packet_id TEXT PRIMARY KEY,
            conversation_id UUID NOT NULL REFERENCES conversations(id)
        );
    """)

    # Minimal sie_pending_semantic_decisions
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sie_pending_semantic_decisions (
            decision_id TEXT PRIMARY KEY,
            decision_creation_key TEXT NOT NULL,
            conversation_id UUID NOT NULL REFERENCES conversations(id),
            stage TEXT NOT NULL,
            entity_creation_key TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN (
                'YES', 'NO', 'UNRESOLVED', 'DEFER',
                'RETRIEVAL_INCONCLUSIVE', 'REQUIRES_VALIDATION'
            )),
            lifecycle_state TEXT NOT NULL DEFAULT 'pending'
                CHECK (lifecycle_state IN ('pending', 'unresolved', 'deferred', 'resolved')),
            originating_request_id TEXT NOT NULL,
            dependency_refs TEXT[] NOT NULL DEFAULT '{}',
            resolution_metadata JSONB,
            rationale TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at TIMESTAMPTZ,
            CONSTRAINT uq_pending_decision_creation_key
                UNIQUE (conversation_id, decision_creation_key)
        );
    """)

    conn.autocommit = False
    yield conn

    # Teardown: no-op. The test database is disposable.
    # Each test uses SAVEPOINT/ROLLBACK for isolation so no cleanup needed.
    conn.rollback()
    conn.close()


@pytest.fixture(scope="session")
def db_with_migrations(db_connection):
    """Apply identity-resolution migrations 009, 010, 011 on top of prerequisites."""
    conn = db_connection
    conn.autocommit = True
    cur = conn.cursor()

    # Check if migrations are already applied
    cur.execute("""
        SELECT EXISTS(
            SELECT 1 FROM pg_tables WHERE tablename = 'sie_identity_resolution_records'
        );
    """)
    if cur.fetchone()[0]:
        # Already applied — skip re-application
        conn.autocommit = False
        yield conn
        return

    migrations_dir = os.path.join(
        os.path.dirname(__file__), "..", "..", "docs", "migrations", "sie"
    )

    for migration_file in [
        "009_identity_resolution_records.sql",
        "010_retrieval_attempts.sql",
        "011_pending_identity_tables.sql",
    ]:
        path = os.path.join(migrations_dir, migration_file)
        with open(path, "r") as f:
            sql = f.read()
        cur.execute(sql)

    conn.autocommit = False
    yield conn


@pytest.fixture()
def db(db_with_migrations):
    """Per-test transactional fixture. Each test runs in a transaction that
    is rolled back after the test, leaving the schema clean for the next test."""
    conn = db_with_migrations
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SAVEPOINT test_start;")
    yield conn
    conn.rollback()


# Shared test data constants
TEST_CONVERSATION_ID = "00000000-0000-0000-0000-000000000099"
TEST_REQUEST_ID = "req-test-001"
TEST_PACKET_ID = "pkt-test-001"
TEST_RECORD_ID = "rec-test-001"
