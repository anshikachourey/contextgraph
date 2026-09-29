/**
 * Provisional similarity thresholds — calibrated from early debug data.
 *
 * Observed ranges (first real test, 4 nodes):
 *   Related nodes:   0.65 – 0.75
 *   Unrelated nodes: 0.42 – 0.52
 *
 * These values are NOT final. They will be adjusted as more nodes are
 * created and score distributions stabilize. Do not use them for
 * production edge creation without further validation.
 */

/** Pairs at or above this score are considered strongly related. */
export const STRONGLY_RELATED_THRESHOLD = 0.7;

/** Pairs at or above this score (but below STRONGLY_RELATED) are possibly related. */
export const POSSIBLY_RELATED_THRESHOLD = 0.6;

export type EdgeThresholds = {
  stronglyRelated: number;
  possiblyRelated: number;
  /** true if a data-calibrated value is in effect; false = compile-time defaults. */
  calibrated: boolean;
};

/** The compile-time defaults, used as the fallback whenever calibration is
 *  absent or was rejected as not-data-justified. */
export const DEFAULT_EDGE_THRESHOLDS: EdgeThresholds = {
  stronglyRelated: STRONGLY_RELATED_THRESHOLD,
  possiblyRelated: POSSIBLY_RELATED_THRESHOLD,
  calibrated: false,
};

/** Maximum time to wait for a Calibration_Store read before abandoning it and
 *  falling back to the compile-time constants (Req 2.5). */
export const CALIBRATION_READ_TIMEOUT_MS = 500;

/** Distinct sentinel used to signal that the store read exceeded the timeout,
 *  so the accessor can log a message distinguishable from a generic read
 *  failure. */
const CALIBRATION_READ_TIMEOUT = Symbol("calibration-read-timeout");

/**
 * Validate the applied threshold values read from the Calibration_Store before
 * they are trusted by the Edge_Suggestion_Flow (Req 2.6).
 *
 * The DB CHECK constraint guards writes, but the read path does its own
 * independent validation so a missing, malformed, or out-of-range value can
 * never be returned as-is. Returns true only when both thresholds are:
 *   - present (not null/undefined),
 *   - finite numbers,
 *   - within the valid [0, 1] range, and
 *   - correctly ordered (stronglyRelated >= possiblyRelated).
 */
export function isValidStoredThresholds(
  stronglyRelated: unknown,
  possiblyRelated: unknown,
): boolean {
  if (typeof stronglyRelated !== "number" || typeof possiblyRelated !== "number") {
    return false;
  }
  if (!Number.isFinite(stronglyRelated) || !Number.isFinite(possiblyRelated)) {
    return false;
  }
  if (stronglyRelated < 0 || stronglyRelated > 1) return false;
  if (possiblyRelated < 0 || possiblyRelated > 1) return false;
  if (stronglyRelated < possiblyRelated) return false;
  return true;
}

/**
 * Resolve the edge similarity thresholds currently in effect.
 *
 * Reads the global calibration row (server-side). Falls back to the compile-time
 * constants when no calibration exists, calibration was rejected (is_applied
 * false), or the read fails for any reason. This is the single accessor callers
 * should use so behavior stays identical unless a calibration was explicitly
 * applied.
 *
 * Server-only: imports the service-role Supabase client transitively.
 */
export async function getEdgeThresholds(): Promise<EdgeThresholds> {
  try {
    // Lazy import to keep this module usable in pure/sync contexts and tests
    // without pulling in the server Supabase client.
    const { getStoredCalibration } = await import("./db/calibration");

    // Race the store read against a 500 ms timeout so a slow read can never
    // block the Edge_Suggestion_Flow. On timeout we abandon the read and fall
    // back to the compile-time constants (Req 2.5).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof CALIBRATION_READ_TIMEOUT>((resolve) => {
      timer = setTimeout(
        () => resolve(CALIBRATION_READ_TIMEOUT),
        CALIBRATION_READ_TIMEOUT_MS,
      );
    });

    let stored: Awaited<ReturnType<typeof getStoredCalibration>> | typeof CALIBRATION_READ_TIMEOUT;
    try {
      stored = await Promise.race([getStoredCalibration(), timeout]);
    } finally {
      // Always clear the timer to avoid dangling handles.
      if (timer !== undefined) clearTimeout(timer);
    }

    if (stored === CALIBRATION_READ_TIMEOUT) {
      console.error("[thresholds] Calibration read timed out; using defaults");
      return DEFAULT_EDGE_THRESHOLDS;
    }

    if (stored && stored.isApplied) {
      // Independently validate the stored values before trusting them. A
      // missing, malformed, or out-of-range value falls back to the
      // compile-time constants with a distinct log (Req 2.6).
      if (!isValidStoredThresholds(stored.stronglyRelated, stored.possiblyRelated)) {
        console.error(
          "[thresholds] Invalid Calibration_Store value; using defaults:",
          { stronglyRelated: stored.stronglyRelated, possiblyRelated: stored.possiblyRelated },
        );
        return DEFAULT_EDGE_THRESHOLDS;
      }

      return {
        stronglyRelated: stored.stronglyRelated,
        possiblyRelated: stored.possiblyRelated,
        calibrated: true,
      };
    }
  } catch (err) {
    console.error("[thresholds] Calibration read failed; using defaults:", err);
  }
  return DEFAULT_EDGE_THRESHOLDS;
}
