/**
 * Debug-gated, explicitly-triggered similarity threshold calibration.
 *
 *   GET  → report the currently stored calibration (or "using defaults").
 *   POST → recompute from all node embeddings, persist the result, and return it.
 *
 * Recompute happens ONLY on an explicit POST here — never on user requests,
 * never on a schedule. If the score distribution does not clearly justify a new
 * threshold, the result is `applied: false` and the effective thresholds remain
 * the compile-time constants (revert-to-safe behavior).
 *
 * No user labels / no confirmed-rejected feedback are involved — calibration is
 * derived purely from the geometry of existing node embeddings.
 */

import { NextResponse } from "next/server";
import { requireDebugAccess } from "@/src/lib/auth/debug";
import {
  calibrateThresholds,
} from "@/src/lib/calibration/threshold-calibration";
import {
  loadAllNodeEmbeddings,
  saveCalibration,
  getStoredCalibration,
} from "@/src/lib/db/calibration";
import { DEFAULT_EDGE_THRESHOLDS } from "@/src/lib/similarityThresholds";

/**
 * Upper bound on the recompute compute path (load → calibrate). The calibration
 * engine is O(n^2) over embedded nodes, so a pathological dataset could run long.
 * If the compute does not finish within this bound we abort and return a timeout
 * error WITHOUT persisting anything, leaving the previously stored row unchanged.
 */
const CALIBRATION_COMPUTE_TIMEOUT_MS = 30_000;

/** Sentinel used to distinguish a timeout from other rejected promises. */
const CALIBRATION_TIMEOUT = Symbol("calibration-timeout");

/**
 * Explicitly reject a recognized-but-unsupported HTTP verb.
 *
 * Next.js 16 would otherwise return a framework-default `405 Method Not Allowed`
 * for any verb without an exported handler (see the route-handlers guide:
 * `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS` are the
 * supported methods, and an unsupported method yields a 405). That default
 * fires *before* our Debug_Access_Guard, which would leak the existence of this
 * debug route to unauthorized callers. So we export the other verbs explicitly
 * and run the guard first — an unauthorized caller still gets the guard's denial
 * (404), and an authorized caller gets an explicit "invalid request" 405 without
 * ever reaching the Calibration_Engine or Calibration_Store.
 */
async function rejectUnsupportedVerb(): Promise<NextResponse> {
  const denied = await requireDebugAccess();
  if (denied) return denied;

  return NextResponse.json({ error: "Invalid request" }, { status: 405 });
}

export async function GET(): Promise<NextResponse> {
  const denied = await requireDebugAccess();
  if (denied) return denied;

  // A failed report read must never surface as an unhandled 500. Per Reqs 1.6 /
  // 10.3, if the Calibration_Store read fails, report that the Compile_Time_Constants
  // are in effect (calibrated: false) and log the read failure, mirroring the
  // fail-safe behavior of the Threshold_Accessor.
  let stored: Awaited<ReturnType<typeof getStoredCalibration>>;
  try {
    stored = await getStoredCalibration();
  } catch (err) {
    console.error(
      "[calibrate-thresholds] Calibration read failed; reporting defaults in effect.",
      err,
    );
    return NextResponse.json({
      status: "read-error",
      effective: {
        ...DEFAULT_EDGE_THRESHOLDS,
        calibrated: false,
      },
      message:
        "Failed to read stored calibration; compile-time defaults are in effect.",
    });
  }

  if (!stored) {
    return NextResponse.json({
      status: "no-calibration",
      effective: DEFAULT_EDGE_THRESHOLDS,
      message: "No calibration computed yet; using compile-time defaults.",
    });
  }

  return NextResponse.json({
    status: stored.isApplied ? "applied" : "reverted-to-defaults",
    effective: {
      stronglyRelated: stored.stronglyRelated,
      possiblyRelated: stored.possiblyRelated,
      calibrated: stored.isApplied,
    },
    reason: stored.reason,
    computedAt: stored.computedAt,
  });
}

export async function POST(): Promise<NextResponse> {
  const denied = await requireDebugAccess();
  if (denied) return denied;

  try {
    // Race the expensive load + calibrate portion against a 30 s bound. Only the
    // compute is raced (not the save) so that a timeout can never leave a
    // partially-computed result persisted — saveCalibration runs only when the
    // compute finished within the bound. On timeout the previously stored row is
    // left untouched.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof CALIBRATION_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(CALIBRATION_TIMEOUT), CALIBRATION_COMPUTE_TIMEOUT_MS);
    });

    let result;
    try {
      const computed = await Promise.race([
        (async () => {
          const nodes = await loadAllNodeEmbeddings();
          return calibrateThresholds(nodes);
        })(),
        timeout,
      ]);

      if (computed === CALIBRATION_TIMEOUT) {
        console.error(
          `[calibrate-thresholds] Calibration timed out after ${CALIBRATION_COMPUTE_TIMEOUT_MS} ms; stored calibration left unchanged.`,
        );
        return NextResponse.json(
          { error: "Calibration timed out" },
          { status: 504 },
        );
      }

      result = computed;
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Persist regardless of applied/reverted so the decision + provenance are
    // auditable. When reverted, stored values mirror the fallback constants.
    await saveCalibration(result);

    return NextResponse.json({
      status: result.applied ? "applied" : "reverted-to-defaults",
      applied: result.applied,
      thresholds: {
        stronglyRelated: result.stronglyRelated,
        possiblyRelated: result.possiblyRelated,
      },
      diagnostics: {
        nodeCount: result.nodeCount,
        samplePairCount: result.samplePairCount,
        bimodalityCoefficient: result.bimodalityCoefficient,
        valleyScore: result.valleyScore,
      },
      reason: result.reason,
    });
  } catch (err) {
    console.error("[calibrate-thresholds] Calibration failed:", err);
    return NextResponse.json(
      { error: "Calibration failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * Recognized-but-unsupported verbs. Only GET (report) and POST (recompute) are
 * valid operations for this endpoint. Each of the following runs the
 * Debug_Access_Guard first, then returns an explicit invalid-request response
 * without invoking calibrateThresholds / loadAllNodeEmbeddings / saveCalibration.
 */
export async function PUT(): Promise<NextResponse> {
  return rejectUnsupportedVerb();
}

export async function PATCH(): Promise<NextResponse> {
  return rejectUnsupportedVerb();
}

export async function DELETE(): Promise<NextResponse> {
  return rejectUnsupportedVerb();
}

export async function HEAD(): Promise<NextResponse> {
  return rejectUnsupportedVerb();
}

export async function OPTIONS(): Promise<NextResponse> {
  return rejectUnsupportedVerb();
}
