/**
 * GraphIntelligenceEngine v1 — Configuration.
 */

/** Messages per window for segment boundary detection. */
export const WINDOW_SIZE = 3;

/** Similarity drop to detect a segment boundary. */
export const BOUNDARY_THRESHOLD = 0.72;

/** Match above this → extend existing node silently. */
export const EXTEND_THRESHOLD = 0.70;

/** Match above this → accumulate into existing candidate. */
export const CANDIDATE_MATCH_THRESHOLD = 0.60;

/** Confidence above this → materialize candidate into node. */
export const MATERIALIZE_THRESHOLD = 0.72;

/** Minimum messages across all segments to materialize. */
export const MIN_EVIDENCE_MESSAGES = 4;

/** Edge similarity threshold. */
export const EDGE_THRESHOLD = 0.70;

/** Confidence weights (sum = 1.0). */
export const WEIGHTS = {
  coherence: 0.30,
  distinctiveness: 0.30,
  recurrence: 0.20,
  quality: 0.20,
};

/** Message length thresholds for quality scoring. */
export const TRIVIAL_MAX_CHARS = 20;
export const SUBSTANTIVE_MIN_CHARS = 80;
