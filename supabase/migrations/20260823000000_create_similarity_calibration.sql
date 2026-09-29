-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Create similarity_calibration table
--
-- Stores GLOBAL, explicitly-triggered calibration of the main edge similarity
-- thresholds (STRONGLY_RELATED_THRESHOLD, POSSIBLY_RELATED_THRESHOLD).
--
-- Design (per decision log):
--   - GLOBAL scope: a single active row (id = 'global'). No per-workspace rows.
--   - Recompute is EXPLICITLY TRIGGERED only (never on user requests / no schedule).
--   - Values are derived offline from the score distribution of existing node
--     embeddings. If the distribution does not clearly justify a new threshold
--     (not separable), calibration is NOT applied and the code falls back to the
--     compile-time constants. `is_applied = false` records that fallback.
--   - No user labels / no confirmed-rejected feedback are involved.
--
-- This table only ever holds calibration OUTPUT + provenance. It does not store
-- embeddings, user data, or per-pair scores.
--
-- Idempotent: uses IF NOT EXISTS / safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS similarity_calibration (
    -- Single global row. Fixed id keeps this a singleton.
    id                      TEXT PRIMARY KEY DEFAULT 'global',

    -- Calibrated threshold values actually in effect. When is_applied = false
    -- these mirror the fallback constants (the calibration was rejected).
    strongly_related        DOUBLE PRECISION NOT NULL,
    possibly_related        DOUBLE PRECISION NOT NULL,

    -- Whether the last run produced a data-justified threshold (true) or fell
    -- back to the compile-time constants because the data was inconclusive.
    is_applied              BOOLEAN NOT NULL DEFAULT false,

    -- Provenance / diagnostics from the last run (why it did or didn't apply).
    sample_pair_count       INTEGER NOT NULL DEFAULT 0,
    node_count              INTEGER NOT NULL DEFAULT 0,
    bimodality_coefficient  DOUBLE PRECISION,
    valley_score            DOUBLE PRECISION,
    reason                  TEXT,

    computed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guard: the fixed singleton id.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_similarity_calibration_singleton'
    ) THEN
        ALTER TABLE similarity_calibration
        ADD CONSTRAINT chk_similarity_calibration_singleton
        CHECK (id = 'global');
    END IF;
END $$;

-- Guard: thresholds stay in [0, 1] and strongly >= possibly.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_similarity_calibration_range'
    ) THEN
        ALTER TABLE similarity_calibration
        ADD CONSTRAINT chk_similarity_calibration_range
        CHECK (
            strongly_related >= 0 AND strongly_related <= 1
            AND possibly_related >= 0 AND possibly_related <= 1
            AND strongly_related >= possibly_related
        );
    END IF;
END $$;

COMMENT ON TABLE similarity_calibration IS
  'Global, explicitly-triggered calibration of edge similarity thresholds derived from node-embedding score distribution. Falls back to code constants when data is inconclusive (is_applied=false). No user labels involved.';
