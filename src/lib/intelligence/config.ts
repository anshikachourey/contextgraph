/**
 * GraphIntelligenceEngine v2 — Configuration.
 *
 * Exchange-based incremental segmentation.
 */

// ─── Segmentation ───────────────────────────────────────────────────────────

/**
 * Threshold for closing an open segment.
 * If a new exchange embedding has cosine similarity below this
 * versus the open segment's centroid, the segment is closed.
 * Adaptive: early exchanges (1-2) use SEGMENT_CLOSE_THRESHOLD_EARLY.
 */
export const SEGMENT_CLOSE_THRESHOLD = 0.50;

/**
 * More lenient threshold for young segments (≤2 exchanges).
 * The centroid isn't stable yet, so we tolerate more drift.
 */
export const SEGMENT_CLOSE_THRESHOLD_EARLY = 0.40;

// ─── User-message segmentation (primary boundary signal) ────────────────────

/**
 * Threshold for user-message centroid similarity.
 * If new user message vs open segment's user centroid is below this, close.
 */
export const USER_CENTROID_THRESHOLD = 0.50;

/**
 * Threshold for user-message local similarity.
 * If new user message vs the immediately previous user message is below this, close.
 */
export const USER_LOCAL_THRESHOLD = 0.45;

/**
 * Early-segment thresholds (exchangeCount <= 2).
 * More lenient because the centroid isn't stable yet and related
 * topics can score lower on short user messages.
 */
export const USER_CENTROID_THRESHOLD_EARLY = 0.35;
export const USER_LOCAL_THRESHOLD_EARLY = 0.35;

// ─── Routing ────────────────────────────────────────────────────────────────

/** Match above this → extend existing node silently. */
export const EXTEND_THRESHOLD = 0.70;

/** Match above this → accumulate into existing candidate. */
export const CANDIDATE_MATCH_THRESHOLD = 0.60;

/**
 * Minimum coherence between a new segment and an existing candidate's
 * segments to allow accumulation. Prevents drift.
 */
export const ACCUMULATE_COHERENCE_GATE = 0.55;

// ─── Materialization ────────────────────────────────────────────────────────

/** Confidence above this → materialize candidate into node. */
export const MATERIALIZE_THRESHOLD = 0.72;

/** Minimum messages across all segments to materialize. */
export const MIN_EVIDENCE_MESSAGES = 4;

/** Confidence weights (sum = 1.0). */
export const WEIGHTS = {
  coherence: 0.30,
  distinctiveness: 0.30,
  recurrence: 0.20,
  quality: 0.20,
};

// ─── Overly-broad node guardrails ───────────────────────────────────────────

export const MAX_AUTO_NODE_MESSAGES = 8;
export const MAX_AUTO_NODE_SEGMENTS = 3;
export const MIN_COHERENCE_FOR_MATERIALIZATION = 0.65;
export const THRESHOLD_INCREASE_PER_EXTRA_SEGMENT = 0.05;

// ─── Stale Candidate Promotion ──────────────────────────────────────────────

/**
 * Confidence threshold for stale candidate promotion.
 * Lower than MATERIALIZE_THRESHOLD to allow one-off topics through.
 */
export const STALE_PROMOTION_THRESHOLD = 0.68;

/**
 * Number of engine runs a candidate must remain untouched before
 * it qualifies for stale promotion.
 */
export const STALE_PROMOTION_RUNS = 3;

// ─── Edges ──────────────────────────────────────────────────────────────────

/** Edge similarity threshold. */
export const EDGE_THRESHOLD = 0.70;
