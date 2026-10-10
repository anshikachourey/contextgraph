/**
 * Calibration store integration tests (Tasks 10.1–10.3).
 *
 * These test the store's persistence semantics against a MOCKED Supabase client.
 * An in-memory fake models the `similarity_calibration` singleton row plus the
 * `chk_similarity_calibration_range` CHECK constraint, so we exercise:
 *   - 10.1 upsert → single row, replace-in-place (Reqs 9.1, 9.2)
 *   - 10.2 DB range/order constraint rejection (Req 9.6)
 *   - 10.3 persist-failure leaves the previous row unchanged and surfaces (Reqs 9.8, 3.2, 4.4)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveCalibration, getStoredCalibration } from "./calibration";
import type { CalibrationResult } from "@/src/lib/calibration/threshold-calibration";

// ─── Supabase mock ──────────────────────────────────────────────────────────

const mockFrom = vi.fn();

// getStoredCalibration falls back (no injected client) to the legacy bridge via
// resolveDbClient; loadAllNodeEmbeddings/saveCalibration use the guarded
// service-role factory directly. Mock BOTH providers to the same fake table.
vi.mock("@/src/lib/supabase/legacy-service-role", () => ({
  createServerSupabaseClient: () => ({ from: mockFrom }),
}));

vi.mock("@/src/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

// ─── In-memory singleton store + range constraint ────────────────────────────

type Row = Record<string, unknown>;

/** Holds at most one 'global' row, keyed by id, modelling the singleton table. */
class FakeCalibrationTable {
  private rows = new Map<string, Row>();

  /** Total row count — used to assert the singleton invariant. */
  get size(): number {
    return this.rows.size;
  }

  seed(row: Row): void {
    this.rows.set(row.id as string, { ...row });
  }

  get(id: string): Row | null {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  /** Optional injected write error (simulates a failing upsert / DB write). */
  writeError: { message: string } | null = null;

  /**
   * Enforce chk_similarity_calibration_range: thresholds must be in [0,1] AND
   * strongly_related >= possibly_related. On violation, return an error and DO
   * NOT mutate the stored row. Otherwise replace-in-place, keyed by id.
   */
  upsert(row: Row): { error: { message: string } | null } {
    if (this.writeError) {
      return { error: this.writeError };
    }
    const strongly = row.strongly_related as number;
    const possibly = row.possibly_related as number;
    const outOfRange =
      strongly < 0 || strongly > 1 || possibly < 0 || possibly > 1;
    const misordered = strongly < possibly;
    if (outOfRange || misordered) {
      return { error: { message: "chk_similarity_calibration_range violation" } };
    }
    this.rows.set(row.id as string, { ...row });
    return { error: null };
  }
}

let table: FakeCalibrationTable;

/**
 * Build a chainable query builder matching the store's usage:
 *   - upsert(row, { onConflict }) — resolves to { error }
 *   - select(cols).eq("id","global").maybeSingle() — resolves to { data, error }
 */
function makeQueryBuilder() {
  const builder: Record<string, unknown> = {};
  let selectedId: string | null = null;

  builder.upsert = vi.fn((row: Row) => Promise.resolve(table.upsert(row)));
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn((col: string, value: string) => {
    if (col === "id") selectedId = value;
    return builder;
  });
  builder.maybeSingle = vi.fn(() =>
    Promise.resolve({ data: selectedId ? table.get(selectedId) : null, error: null }),
  );
  return builder;
}

/** A valid, applied CalibrationResult (strongly >= possibly, both in [0,1]). */
function appliedResult(
  overrides: Partial<CalibrationResult> = {},
): CalibrationResult {
  return {
    applied: true,
    stronglyRelated: 0.82,
    possiblyRelated: 0.61,
    nodeCount: 40,
    samplePairCount: 780,
    bimodalityCoefficient: 0.71,
    valleyScore: 0.61,
    reason: "Applied data-derived thresholds from bimodal distribution valley.",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  table = new FakeCalibrationTable();
  mockFrom.mockImplementation((tableName: string) => {
    expect(tableName).toBe("similarity_calibration");
    return makeQueryBuilder();
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Calibration store persistence", () => {
  // Task 10.1 — Requirements 9.1, 9.2
  describe("singleton / replace-in-place", () => {
    it("saveCalibration upserts and getStoredCalibration yields exactly one row", async () => {
      await saveCalibration(appliedResult());

      expect(table.size).toBe(1);

      const stored = await getStoredCalibration();
      expect(stored).not.toBeNull();
      expect(stored).toEqual({
        stronglyRelated: 0.82,
        possiblyRelated: 0.61,
        isApplied: true,
        reason: "Applied data-derived thresholds from bimodal distribution valley.",
        computedAt: expect.any(String),
      });
    });

    it("a second saveCalibration replaces in place (still exactly one row)", async () => {
      await saveCalibration(appliedResult());
      expect(table.size).toBe(1);

      const second = appliedResult({
        stronglyRelated: 0.9,
        possiblyRelated: 0.55,
        reason: "Recomputed after new data.",
        valleyScore: 0.55,
      });
      await saveCalibration(second);

      // Still a singleton — replaced in place, not appended.
      expect(table.size).toBe(1);

      const stored = await getStoredCalibration();
      expect(stored).not.toBeNull();
      expect(stored?.stronglyRelated).toBe(0.9);
      expect(stored?.possiblyRelated).toBe(0.55);
      expect(stored?.reason).toBe("Recomputed after new data.");
    });
  });

  // Task 10.2 — Requirement 9.6
  describe("DB range/order constraint rejection", () => {
    it("rejects a row where strongly_related < possibly_related", async () => {
      // strongly (0.5) < possibly (0.7) violates chk_similarity_calibration_range.
      const misordered = appliedResult({
        stronglyRelated: 0.5,
        possiblyRelated: 0.7,
      });

      await expect(saveCalibration(misordered)).rejects.toThrow(
        /Failed to save calibration|range/,
      );

      // Nothing was persisted — the constraint rejected the write.
      expect(table.size).toBe(0);
    });
  });

  // Task 10.3 — Requirements 9.8, 3.2, 4.4
  describe("persist-failure leaves previous row unchanged", () => {
    it("surfaces the write error and keeps the previously stored row intact", async () => {
      // Seed a valid applied row (the previously stored calibration).
      const seeded = {
        id: "global",
        strongly_related: 0.82,
        possibly_related: 0.61,
        is_applied: true,
        sample_pair_count: 780,
        node_count: 40,
        bimodality_coefficient: 0.71,
        valley_score: 0.61,
        reason: "Applied data-derived thresholds from bimodal distribution valley.",
        computed_at: "2026-01-01T00:00:00.000Z",
      };
      table.seed(seeded);
      expect(table.size).toBe(1);

      // Next upsert fails (simulated write error).
      table.writeError = { message: "connection reset by peer" };

      const attempt = appliedResult({
        stronglyRelated: 0.95,
        possiblyRelated: 0.5,
        reason: "Attempted recompute that fails to persist.",
      });

      // Failure is surfaced to the caller.
      await expect(saveCalibration(attempt)).rejects.toThrow(
        /Failed to save calibration/,
      );

      // Previous row is unchanged — still exactly one row with the seeded values.
      expect(table.size).toBe(1);

      // Clear the injected error so we can read back the (unchanged) row.
      table.writeError = null;
      const stored = await getStoredCalibration();
      expect(stored).toEqual({
        stronglyRelated: 0.82,
        possiblyRelated: 0.61,
        isApplied: true,
        reason: "Applied data-derived thresholds from bimodal distribution valley.",
        computedAt: "2026-01-01T00:00:00.000Z",
      });
    });
  });
});
