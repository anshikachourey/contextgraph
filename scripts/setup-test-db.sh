#!/usr/bin/env bash
# ============================================================================
# SIE Test Database Bootstrap
#
# Creates a disposable local PostgreSQL database with all required roles,
# base infrastructure, and SIE migrations applied. Designed to be run before
# executing the mandatory real-PostgreSQL test suite.
#
# Prerequisites:
#   - PostgreSQL running locally (default port 5432)
#   - createdb/dropdb/psql available in PATH
#   - Current user has superuser or createdb privileges
#
# Usage:
#   ./scripts/setup-test-db.sh           # Create and migrate
#   ./scripts/setup-test-db.sh --drop    # Drop only
#   ./scripts/setup-test-db.sh --reset   # Drop + recreate
#
# Environment variables:
#   TEST_DB_NAME     Database name (default: contextgraph_test)
#   TEST_DB_HOST     Host (default: localhost)
#   TEST_DB_PORT     Port (default: 5432)
#   TEST_DB_USER     User (default: current OS user)
# ============================================================================

set -euo pipefail

DB_NAME="${TEST_DB_NAME:-contextgraph_test}"
DB_HOST="${TEST_DB_HOST:-localhost}"
DB_PORT="${TEST_DB_PORT:-5432}"
DB_USER="${TEST_DB_USER:-$(whoami)}"
PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER"
MIGRATIONS_DIR="$(cd "$(dirname "$0")/../docs/migrations/sie" && pwd)"

drop_db() {
    echo "Dropping database '$DB_NAME' if exists..."
    dropdb --if-exists -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
}

create_db() {
    echo "Creating database '$DB_NAME'..."
    createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"

    echo "Creating base infrastructure..."
    $PSQL -d "$DB_NAME" -v ON_ERROR_STOP=1 -q <<'SQL'
-- Base tables expected by SIE migrations
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v2_update_state (
    conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
    last_processed_message_seq BIGINT NOT NULL DEFAULT 0,
    update_status TEXT NOT NULL DEFAULT 'idle',
    update_version INTEGER NOT NULL DEFAULT 0,
    graph_version INTEGER NOT NULL DEFAULT 1,
    pending_since TIMESTAMPTZ,
    last_update_error TEXT,
    update_failed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v2_graph_snapshots (
    conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
    graph_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    status TEXT NOT NULL DEFAULT 'ready',
    diagnostics JSONB DEFAULT '{}'::JSONB,
    last_processed_message_seq BIGINT DEFAULT 0,
    graph_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supabase-compatible roles (required by RLS policies and GRANTs)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
        CREATE ROLE authenticated;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
        CREATE ROLE anon;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
        CREATE ROLE service_role;
    END IF;
END $$;
SQL

    echo "Applying SIE migrations..."
    for f in \
        "$MIGRATIONS_DIR"/001_*.sql \
        "$MIGRATIONS_DIR"/002_*.sql \
        "$MIGRATIONS_DIR"/003_*.sql \
        "$MIGRATIONS_DIR"/004_*.sql \
        "$MIGRATIONS_DIR"/005_*.sql \
        "$MIGRATIONS_DIR"/006_*.sql \
        "$MIGRATIONS_DIR"/008_*.sql \
        "$MIGRATIONS_DIR"/009_*.sql \
        "$MIGRATIONS_DIR"/010_*.sql \
        "$MIGRATIONS_DIR"/011_*.sql \
        "$MIGRATIONS_DIR"/012_*.sql \
        "$MIGRATIONS_DIR"/013_*.sql \
        "$MIGRATIONS_DIR"/014_*.sql \
        "$MIGRATIONS_DIR"/015_*.sql \
        "$MIGRATIONS_DIR"/016_*.sql \
        "$MIGRATIONS_DIR"/017_*.sql \
        "$MIGRATIONS_DIR"/018_*.sql \
        "$MIGRATIONS_DIR"/020_*.sql \
        "$MIGRATIONS_DIR"/021_*.sql; do
        echo "  Applying $(basename "$f")..."
        $PSQL -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$f"
    done

    echo ""
    echo "=== Test database '$DB_NAME' ready ==="
    echo ""
    echo "Run tests with:"
    echo "  TEST_DATABASE_URL=\"postgresql://$DB_USER@$DB_HOST:$DB_PORT/$DB_NAME\" \\"
    echo "    ml-service/venv/bin/python -m pytest tests/database/ -v"
}

case "${1:-}" in
    --drop)
        drop_db
        ;;
    --reset)
        drop_db
        create_db
        ;;
    *)
        create_db
        ;;
esac
