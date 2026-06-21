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
