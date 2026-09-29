/**
 * Integration tests for the debug-gated calibration endpoint
 * (app/api/debug/calibrate-thresholds/route.ts).
 *
 * These tests exercise the route handlers directly (Next.js 16 style:
 * `import { POST } from "./route"` and invoke the handler), mocking the
 * collaborating modules so no real DB / auth / engine work runs.
 *
 * Task 6.2 — recompute timeout: mock the compute path (loadAllNodeEmbeddings)
 * to exceed the 30 s bound and assert the endpoint returns the timeout error
 * response and never persists a calibration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

// ─── Module mocks ──────────────────────────────────────────────────────────
// The route imports its collaborators via the "@/src/lib/..." alias, so the
// mock specifiers must match those exact import paths.

// Debug_Access_Guard: resolve falsy (null) => access granted.
vi.mock("@/src/lib/auth/debug", () => ({
  requireDebugAccess: vi.fn(async () => null),
}));

// Calibration_Store: loadAllNodeEmbeddings is controllable per-test;
// saveCalibration / getStoredCalibration are spies we assert against.
vi.mock("@/src/lib/db/calibration", () => ({
  loadAllNodeEmbeddings: vi.fn(async () => []),
  saveCalibration: vi.fn(async () => {}),
  getStoredCalibration: vi.fn(async () => null),
}));

// Calibration_Engine: pure fn; default returns a benign reverted result.
vi.mock("@/src/lib/calibration/threshold-calibration", () => ({
  calibrateThresholds: vi.fn(() => ({
    applied: false,
    stronglyRelated: 0.7,
    possiblyRelated: 0.6,
    nodeCount: 0,
    samplePairCount: 0,
    bimodalityCoefficient: null,
    valleyScore: null,
    reason: "too few embedded nodes",
  })),
}));

import { GET, POST, PUT, PATCH, DELETE } from "./route";
import { requireDebugAccess } from "@/src/lib/auth/debug";
import {
  loadAllNodeEmbeddings,
  saveCalibration,
  getStoredCalibration,
} from "@/src/lib/db/calibration";
import { calibrateThresholds } from "@/src/lib/calibration/threshold-calibration";

describe("POST /api/debug/calibrate-thresholds — recompute timeout (Reqs 4.3, 4.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default resolved values cleared by clearAllMocks.
    vi.mocked(requireDebugAccess).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a 504 timeout response and never persists when the compute exceeds 30 s", async () => {
    vi.useFakeTimers();

    // Make the awaited load hang past the 30 s compute bound. The endpoint
    // races load+calibrate against CALIBRATION_COMPUTE_TIMEOUT_MS (30_000 ms);
    // a load that resolves only after >30 s trips the timeout branch.
    vi.mocked(loadAllNodeEmbeddings).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([]), 60_000);
        }),
    );

    const responsePromise = POST();

    // Advance past the 30 s timeout so the race resolves to the timeout sentinel.
    await vi.advanceTimersByTimeAsync(30_000);

    const response = await responsePromise;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "Calibration timed out",
    });

    // The compute never finished, so calibrate + persist must not have run.
    expect(calibrateThresholds).not.toHaveBeenCalled();
    expect(saveCalibration).not.toHaveBeenCalled();
  });
});

describe("unrecognized verb rejection (Req 4.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the default resolved value cleared by clearAllMocks:
    // requireDebugAccess → null means access is granted.
    vi.mocked(requireDebugAccess).mockResolvedValue(null);
  });

  // Each recognized-but-unsupported verb runs the Debug_Access_Guard first
  // (granted here), then returns the invalid-request response WITHOUT ever
  // touching the Calibration_Engine or Calibration_Store.
  const handlers: Array<[string, () => Promise<Response>]> = [
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ];

  it.each(handlers)(
    "%s returns 405 invalid-request and never invokes engine/store",
    async (_verb, handler) => {
      const response = await handler();

      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid request",
      });

      // The invalid-request path must short-circuit before any compute/persist.
      expect(calibrateThresholds).not.toHaveBeenCalled();
      expect(loadAllNodeEmbeddings).not.toHaveBeenCalled();
      expect(saveCalibration).not.toHaveBeenCalled();
    },
  );
});

describe("GET read-failure reporting (Reqs 1.6, 10.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the default resolved value cleared by clearAllMocks:
    // requireDebugAccess → null means access is granted.
    vi.mocked(requireDebugAccess).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports compile-time defaults in effect (not a 500) and logs the failure when the Calibration_Store read throws", async () => {
    // Silence + observe the failure log. When the Calibration_Store read
    // throws, the GET handler must NOT surface an unhandled 500; instead it
    // reports that the compile-time constants are in effect (calibrated:
    // false) and logs the read failure — mirroring the fail-safe behavior of
    // the Threshold_Accessor.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(getStoredCalibration).mockRejectedValue(new Error("db down"));

    const response = await GET();

    // Read failure is reported, never a 500.
    expect(response.status).toBe(200);

    const body = await response.json();
    // Effective thresholds are the compile-time defaults with calibrated: false.
    expect(body.effective).toEqual({
      stronglyRelated: 0.7,
      possiblyRelated: 0.6,
      calibrated: false,
    });
    // Status field signals the read error / defaults-in-effect condition.
    expect(body.status).toBe("read-error");

    // The read failure is logged.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/read failed/i),
      expect.anything(),
    );
  });
});

describe("GET report shape (Reqs 4.2, 10.1, 10.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the default resolved value cleared by clearAllMocks:
    // requireDebugAccess → null means access is granted.
    vi.mocked(requireDebugAccess).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports no-calibration + compile-time defaults when no row is stored (Req 10.1)", async () => {
    // No stored Calibration_Result → the endpoint reports that the
    // Compile_Time_Constants are in effect via the "no-calibration" status.
    vi.mocked(getStoredCalibration).mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("no-calibration");
    expect(body.effective).toEqual({
      stronglyRelated: 0.7,
      possiblyRelated: 0.6,
      calibrated: false,
    });
  });

  it("reports the applied thresholds, status, reason, and computedAt when an applied row exists (Reqs 4.2, 10.2)", async () => {
    // An applied Calibration_Result → the endpoint surfaces the calibrated
    // thresholds (calibrated: true), the "applied" status, and the stored
    // provenance (reason + computedAt).
    vi.mocked(getStoredCalibration).mockResolvedValue({
      stronglyRelated: 0.82,
      possiblyRelated: 0.64,
      isApplied: true,
      reason: "Applied ...",
      computedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("applied");
    expect(body.effective).toEqual({
      stronglyRelated: 0.82,
      possiblyRelated: 0.64,
      calibrated: true,
    });
    expect(body.reason).toBe("Applied ...");
    expect(body.computedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reports reverted-to-defaults with calibrated: false when a non-applied row exists (Req 10.2)", async () => {
    // A stored-but-reverted row → status reflects the revert and effective
    // thresholds are flagged calibrated: false.
    vi.mocked(getStoredCalibration).mockResolvedValue({
      stronglyRelated: 0.7,
      possiblyRelated: 0.6,
      isApplied: false,
      reason: "too few embedded nodes",
      computedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("reverted-to-defaults");
    expect(body.effective).toEqual({
      stronglyRelated: 0.7,
      possiblyRelated: 0.6,
      calibrated: false,
    });
  });
});

describe("POST recompute persist (Reqs 3.1, 4.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the default resolved value cleared by clearAllMocks:
    // requireDebugAccess → null means access is granted.
    vi.mocked(requireDebugAccess).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Real timers here: the mocked compute resolves immediately, well under the
  // 30 s bound, so no timer manipulation is needed.
  it("runs the compute path, persists the applied result, and returns status + diagnostics (applied)", async () => {
    const calibrateResult = {
      applied: true,
      stronglyRelated: 0.82,
      possiblyRelated: 0.64,
      nodeCount: 40,
      samplePairCount: 780,
      bimodalityCoefficient: 0.71,
      valleyScore: 0.64,
      reason: "Applied ...",
    };
    vi.mocked(calibrateThresholds).mockReturnValue(calibrateResult);
    vi.mocked(loadAllNodeEmbeddings).mockResolvedValue([
      { id: "n1", embedding: [0.1, 0.2] },
      { id: "n2", embedding: [0.3, 0.4] },
    ]);

    const response = await POST();

    // The compute path ran: load → calibrate → persist.
    expect(loadAllNodeEmbeddings).toHaveBeenCalled();
    expect(calibrateThresholds).toHaveBeenCalled();
    expect(saveCalibration).toHaveBeenCalledTimes(1);
    expect(saveCalibration).toHaveBeenCalledWith(calibrateResult);

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("applied");
    expect(body.applied).toBe(true);
    expect(body.thresholds).toEqual({
      stronglyRelated: 0.82,
      possiblyRelated: 0.64,
    });
    expect(body.diagnostics).toEqual({
      nodeCount: 40,
      samplePairCount: 780,
      bimodalityCoefficient: 0.71,
      valleyScore: 0.64,
    });
    expect(body.reason).toBe("Applied ...");
  });

  it("persists a reverted result regardless and returns reverted-to-defaults status (reverted)", async () => {
    const revertedResult = {
      applied: false,
      stronglyRelated: 0.7,
      possiblyRelated: 0.6,
      nodeCount: 5,
      samplePairCount: 10,
      bimodalityCoefficient: null,
      valleyScore: null,
      reason: "too few embedded nodes",
    };
    vi.mocked(calibrateThresholds).mockReturnValue(revertedResult);
    vi.mocked(loadAllNodeEmbeddings).mockResolvedValue([
      { id: "n1", embedding: [0.1, 0.2] },
    ]);

    const response = await POST();

    // Persisted regardless of the applied/reverted decision (provenance is
    // auditable either way).
    expect(saveCalibration).toHaveBeenCalledTimes(1);
    expect(saveCalibration).toHaveBeenCalledWith(revertedResult);

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("reverted-to-defaults");
    expect(body.applied).toBe(false);
  });
});

describe("endpoint access denial (Req 4.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // When the Debug_Access_Guard is not satisfied, requireDebugAccess resolves a
  // denial NextResponse (truthy). Both handlers run the guard FIRST and return
  // that denial verbatim, never touching the Calibration_Engine or the
  // Calibration_Store.
  it("GET returns the denial response and never reads the stored calibration", async () => {
    const denial = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    vi.mocked(requireDebugAccess).mockResolvedValue(denial);

    const response = await GET();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });

    // The report read must never run when access is denied.
    expect(getStoredCalibration).not.toHaveBeenCalled();
  });

  it("POST returns the denial response and never invokes the engine or store", async () => {
    const denial = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    vi.mocked(requireDebugAccess).mockResolvedValue(denial);

    const response = await POST();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });

    // The recompute path must short-circuit before any compute/persist.
    expect(loadAllNodeEmbeddings).not.toHaveBeenCalled();
    expect(calibrateThresholds).not.toHaveBeenCalled();
    expect(saveCalibration).not.toHaveBeenCalled();
  });
});
