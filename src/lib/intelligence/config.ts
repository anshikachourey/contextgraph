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

// ─── Overly-broad node guardrails ───────────────────────────────────────────

/**
 * Maximum messages a candidate can accumulate before materialization is blocked.
 * A candidate with more messages than this is too broad — it's a parent theme,
 * not a focused topic node.
 */
export const MAX_AUTO_NODE_MESSAGES = 8;

/**
 * Maximum segments a candidate can have before the threshold tightens.
 * More segments = more chances the topic has drifted.
 */
export const MAX_AUTO_NODE_SEGMENTS = 3;

/**
 * Minimum avg pairwise segment similarity required for materialization.
 * This is a HARD GATE — even if the weighted confidence score is high,
 * a candidate with low internal coherence cannot materialize as one node.
 * Justified by observation: focused topics have internal sim ≥ 0.70,
 * broad mixed topics drop to 0.50–0.55.
 */
export const MIN_COHERENCE_FOR_MATERIALIZATION = 0.65;

/**
 * For each segment beyond MAX_AUTO_NODE_SEGMENTS, the materialization
 * threshold increases by this amount. Makes it progressively harder
 * for large candidates to materialize.
 */
export const THRESHOLD_INCREASE_PER_EXTRA_SEGMENT = 0.05;
