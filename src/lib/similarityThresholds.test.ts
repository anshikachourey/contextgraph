import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import {
  getEdgeThresholds,
  isValidStoredThresholds,
  DEFAULT_EDGE_THRESHOLDS,
  CALIBRATION_READ_TIMEOUT_MS,
  type EdgeThresholds,
} from "./similarityThresholds";
import type { StoredCalibration } from "./db/calibration";

// The accessor lazily does `await import("./db/calibration")` and calls
// `getStoredCalibration()`. Mock that module so we can drive every possible
// store-read outcome (no row, applied row, reverted row, thrown error).
vi.mock("./db/calibration", () => ({
  getStoredCalibration: vi.fn(),
}));

// Import the mocked function so we can program its behavior per-run.
import { getStoredCalibration } from "./db/calibration";

const mockGetStoredCalibration = vi.mocked(getStoredCalibration);

// ─── Store-read outcome model ────────────────────────────────────────────────
//
// The four outcomes the Calibration_Store read can produce, per the design's
// Property 7 generator spec: `null`, an applied row, a reverted row, and a
// throwing stub. Each outcome carries whether it should resolve to the stored
// applied values or to DEFAULT_EDGE_THRESHOLDS.

type Outcome =
  | { kind: "null" }
  | { kind: "applied"; row: StoredCalibration }
  | { kind: "reverted"; row: StoredCalibration }
  | { kind: "error" };

/** A valid numeric similarity value in [0, 1]. */
const scoreArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/** Applied stored rows: correctly ordered thresholds, isApplied true. */
const appliedRowArb: fc.Arbitrary<StoredCalibration> = fc
  .tuple(scoreArb, scoreArb)
  .map(([a, b]) => {
    const possiblyRelated = Math.min(a, b);
    const stronglyRelated = Math.max(a, b);
    return {
      stronglyRelated,
      possiblyRelated,
      isApplied: true,
      reason: "applied",
      computedAt: new Date(0).toISOString(),
    } satisfies StoredCalibration;
  });

/** Reverted stored rows mirror the constants and have isApplied false. */
const revertedRowArb: fc.Arbitrary<StoredCalibration> = fc
  .constant(null)
  .map(() => ({
    stronglyRelated: DEFAULT_EDGE_THRESHOLDS.stronglyRelated,
    possiblyRelated: DEFAULT_EDGE_THRESHOLDS.possiblyRelated,
    isApplied: false,
    reason: "reverted",
    computedAt: new Date(0).toISOString(),
  }) satisfies StoredCalibration);

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.constant<Outcome>({ kind: "null" }),
  appliedRowArb.map<Outcome>((row) => ({ kind: "applied", row })),
  revertedRowArb.map<Outcome>((row) => ({ kind: "reverted", row })),
  fc.constant<Outcome>({ kind: "error" }),
);

/** Program the mocked store read to reflect a given outcome. */
function applyOutcome(outcome: Outcome): void {
  mockGetStoredCalibration.mockReset();
  switch (outcome.kind) {
    case "null":
      mockGetStoredCalibration.mockResolvedValue(null);
      break;
    case "applied":
    case "reverted":
      mockGetStoredCalibration.mockResolvedValue(outcome.row);
      break;
    case "error":
      mockGetStoredCalibration.mockRejectedValue(new Error("store read failed"));
      break;
  }
}

function isValidEdgeThresholds(t: EdgeThresholds): boolean {
  return (
    typeof t.stronglyRelated === "number" &&
    Number.isFinite(t.stronglyRelated) &&
    typeof t.possiblyRelated === "number" &&
    Number.isFinite(t.possiblyRelated) &&
    typeof t.calibrated === "boolean"
  );
}

// ─── Property-based tests ─────────────────────────────────────────────────────

describe("getEdgeThresholds — properties (fast-check)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Feature: adaptive-similarity-thresholds, Property 7: The Threshold_Accessor never propagates an error
  // Validates: Requirements 1.6, 2.1, 2.3
  it("Property 7: never rejects and resolves to a valid EdgeThresholds for any store outcome", async () => {
    // Silence the expected error log emitted on the error outcome.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fc.assert(
        fc.asyncProperty(outcomeArb, async (outcome) => {
          applyOutcome(outcome);

          // Must always resolve — never reject.
          const result = await getEdgeThresholds();

          // Always a valid EdgeThresholds value.
          expect(isValidEdgeThresholds(result)).toBe(true);

          if (outcome.kind === "applied") {
            // Applied row → stored values in effect, calibrated true.
            expect(result.stronglyRelated).toBe(outcome.row.stronglyRelated);
            expect(result.possiblyRelated).toBe(outcome.row.possiblyRelated);
            expect(result.calibrated).toBe(true);
          } else {
            // no-row / reverted / error → defaults with calibrated === false.
            expect(result).toEqual(DEFAULT_EDGE_THRESHOLDS);
            expect(result.calibrated).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ─── Read-timeout unit test (Req 2.5) ────────────────────────────────────────
//
// getEdgeThresholds() races getStoredCalibration() against a 500 ms timeout.
// When the store read does not resolve within that window, the accessor must
// abandon the read, log the timeout message, and return the compile-time
// defaults. We drive this deterministically with Vitest fake timers.

describe("getEdgeThresholds — read timeout (Req 2.5)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns defaults and logs the timeout message when the store read exceeds 500 ms", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Mock the store read to resolve only after 1000 ms — past the 500 ms
    // timeout window — so the timeout branch must win the race.
    mockGetStoredCalibration.mockReset();
    mockGetStoredCalibration.mockImplementation(
      () =>
        new Promise<StoredCalibration>((resolve) => {
          setTimeout(
            () =>
              resolve({
                stronglyRelated: 0.9,
                possiblyRelated: 0.8,
                isApplied: true,
                reason: "applied",
                computedAt: new Date(0).toISOString(),
              }),
            1000,
          );
        }),
    );

    // Kick off the accessor without awaiting so we can advance timers while it
    // is mid-flight. advanceTimersByTimeAsync also flushes microtasks between
    // ticks, which lets the dynamic `await import("./db/calibration")` resolve.
    const resultPromise = getEdgeThresholds();

    // Advance far enough to fire the 500 ms timeout timer (but not the 1000 ms
    // store-resolution timer), letting the timeout branch win the race.
    await vi.advanceTimersByTimeAsync(CALIBRATION_READ_TIMEOUT_MS);

    const result = await resultPromise;

    expect(result).toEqual(DEFAULT_EDGE_THRESHOLDS);
    expect(result.calibrated).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/timed out/i),
    );
  });
});

// ─── Stored-value validation unit tests (Req 2.6) ────────────────────────────
//
// Before trusting an applied Calibration_Store row, getEdgeThresholds()
// independently validates the stored thresholds: both must be present, finite
// numbers, within [0, 1], and correctly ordered (stronglyRelated >=
// possiblyRelated). A missing, malformed, or out-of-range value must fall back
// to the compile-time constants and log a distinct "invalid" message. A valid
// applied row must return its stored values with calibrated === true.
//
// Real timers throughout: the mocked store read resolves immediately, so the
// 500 ms race in getEdgeThresholds() settles on the store read before the
// timeout timer ever fires.

/** Build an applied StoredCalibration row with the given threshold fields. */
function appliedRow(
  stronglyRelated: unknown,
  possiblyRelated: unknown,
): StoredCalibration {
  return {
    // Cast because we deliberately feed malformed values in some cases.
    stronglyRelated: stronglyRelated as number,
    possiblyRelated: possiblyRelated as number,
    isApplied: true,
    reason: "applied",
    computedAt: new Date(0).toISOString(),
  };
}

describe("getEdgeThresholds — stored-value validation (Req 2.6)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useRealTimers();
    mockGetStoredCalibration.mockReset();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  const invalidCases: Array<{
    name: string;
    stronglyRelated: unknown;
    possiblyRelated: unknown;
  }> = [
    { name: "missing stronglyRelated (undefined)", stronglyRelated: undefined, possiblyRelated: 0.6 },
    { name: "missing possiblyRelated (null)", stronglyRelated: 0.7, possiblyRelated: null },
    { name: "NaN stronglyRelated", stronglyRelated: NaN, possiblyRelated: 0.6 },
    { name: "NaN possiblyRelated", stronglyRelated: 0.7, possiblyRelated: NaN },
    { name: "Infinity stronglyRelated", stronglyRelated: Infinity, possiblyRelated: 0.6 },
    { name: "-Infinity possiblyRelated", stronglyRelated: 0.7, possiblyRelated: -Infinity },
    { name: "out-of-range stronglyRelated > 1 (1.5)", stronglyRelated: 1.5, possiblyRelated: 0.6 },
    { name: "out-of-range possiblyRelated < 0 (-0.2)", stronglyRelated: 0.7, possiblyRelated: -0.2 },
    { name: "mis-ordered (stronglyRelated < possiblyRelated)", stronglyRelated: 0.5, possiblyRelated: 0.8 },
  ];

  for (const { name, stronglyRelated, possiblyRelated } of invalidCases) {
    it(`returns defaults and logs invalid message for ${name}`, async () => {
      mockGetStoredCalibration.mockResolvedValue(
        appliedRow(stronglyRelated, possiblyRelated),
      );

      const result = await getEdgeThresholds();

      expect(result).toEqual(DEFAULT_EDGE_THRESHOLDS);
      expect(result.calibrated).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringMatching(/invalid/i),
        expect.anything(),
      );
    });
  }

  it("returns stored values with calibrated: true for a valid applied row", async () => {
    mockGetStoredCalibration.mockResolvedValue(appliedRow(0.82, 0.64));

    const result = await getEdgeThresholds();

    expect(result).toEqual({
      stronglyRelated: 0.82,
      possiblyRelated: 0.64,
      calibrated: true,
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid applied row where the thresholds are equal (boundary)", async () => {
    mockGetStoredCalibration.mockResolvedValue(appliedRow(0.7, 0.7));

    const result = await getEdgeThresholds();

    expect(result.stronglyRelated).toBe(0.7);
    expect(result.possiblyRelated).toBe(0.7);
    expect(result.calibrated).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

// ─── isValidStoredThresholds helper unit tests (Req 2.6) ──────────────────────
//
// Direct, fast coverage of the exported pure predicate used by
// getEdgeThresholds() to gate stored applied values.

describe("isValidStoredThresholds (Req 2.6)", () => {
  it("returns true for finite, in-range, correctly-ordered values", () => {
    expect(isValidStoredThresholds(0.82, 0.64)).toBe(true);
    expect(isValidStoredThresholds(0.7, 0.6)).toBe(true);
    expect(isValidStoredThresholds(1, 0)).toBe(true);
    expect(isValidStoredThresholds(0.5, 0.5)).toBe(true); // equal is allowed
  });

  it("returns false for non-number values", () => {
    expect(isValidStoredThresholds(undefined, 0.6)).toBe(false);
    expect(isValidStoredThresholds(0.7, null)).toBe(false);
    expect(isValidStoredThresholds("0.7", 0.6)).toBe(false);
    expect(isValidStoredThresholds(0.7, "0.6")).toBe(false);
  });

  it("returns false for NaN or Infinity", () => {
    expect(isValidStoredThresholds(NaN, 0.6)).toBe(false);
    expect(isValidStoredThresholds(0.7, NaN)).toBe(false);
    expect(isValidStoredThresholds(Infinity, 0.6)).toBe(false);
    expect(isValidStoredThresholds(0.7, -Infinity)).toBe(false);
  });

  it("returns false for out-of-range values", () => {
    expect(isValidStoredThresholds(1.5, 0.6)).toBe(false);
    expect(isValidStoredThresholds(0.7, -0.2)).toBe(false);
    expect(isValidStoredThresholds(-0.1, -0.2)).toBe(false);
  });

  it("returns false for mis-ordered values (stronglyRelated < possiblyRelated)", () => {
    expect(isValidStoredThresholds(0.5, 0.8)).toBe(false);
    expect(isValidStoredThresholds(0.6, 0.7)).toBe(false);
  });
});

// ─── Accessor mapping matrix (Reqs 1.1–1.5, 2.2) ─────────────────────────────
//
// Focused coverage of how getEdgeThresholds() maps each Calibration_Store read
// outcome onto its returned EdgeThresholds. This complements Property 7 (which
// asserts the invariant across random outcomes) by pinning the exact expected
// output for each concrete row shape in the mapping matrix.
//
// Real timers throughout: the mocked store read resolves/rejects immediately,
// so the 500 ms race in getEdgeThresholds() settles before the timeout timer
// ever fires.

describe("getEdgeThresholds — accessor mapping (Reqs 1.1–1.5, 2.2)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useRealTimers();
    mockGetStoredCalibration.mockReset();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  // Req 1.1 (no calibration exists) + Req 1.4 (compile-time defaults in effect)
  it("null store → compile-time defaults with calibrated: false", async () => {
    mockGetStoredCalibration.mockResolvedValue(null);

    const result = await getEdgeThresholds();

    expect(result).toEqual(DEFAULT_EDGE_THRESHOLDS);
    expect(result.calibrated).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  // Req 1.2 (a reverted calibration falls back to defaults)
  it("reverted row (isApplied: false) → compile-time defaults with calibrated: false", async () => {
    mockGetStoredCalibration.mockResolvedValue({
      stronglyRelated: 0.7,
      possiblyRelated: 0.6,
      isApplied: false,
      reason: "reverted",
      computedAt: new Date(0).toISOString(),
    });

    const result = await getEdgeThresholds();

    expect(result).toEqual(DEFAULT_EDGE_THRESHOLDS);
    expect(result.calibrated).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  // Req 1.3 (an applied calibration is in effect) + Req 1.5 (stored values used)
  it("applied row → stored values with calibrated: true", async () => {
    mockGetStoredCalibration.mockResolvedValue({
      stronglyRelated: 0.82,
      possiblyRelated: 0.64,
      isApplied: true,
      reason: "applied",
      computedAt: new Date(0).toISOString(),
    });

    const result = await getEdgeThresholds();

    expect(result).toEqual({
      stronglyRelated: 0.82,
      possiblyRelated: 0.64,
      calibrated: true,
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  // Req 2.2 (a failed store read logs and falls back to defaults)
  it("read failure → logs a read-failure message and returns defaults", async () => {
    mockGetStoredCalibration.mockRejectedValue(new Error("db down"));

    const result = await getEdgeThresholds();

    expect(result).toEqual(DEFAULT_EDGE_THRESHOLDS);
    expect(result.calibrated).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/read failed/i),
      expect.anything(),
    );
  });
});
