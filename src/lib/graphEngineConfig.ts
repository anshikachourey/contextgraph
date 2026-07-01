/**
 * Evidence Accumulation Graph Engine v2 — configuration.
 *
 * Philosophy: "Is this an idea worth remembering?"
 * Confidence reflects coherence, distinctiveness, recurrence, and quality —
 * not simply how many segments or messages have accumulated.
 */

// ─── Segment detection ──────────────────────────────────────────────────────

/** Messages per window for segment boundary detection. */
export const SEGMENT_WINDOW_SIZE = 3;

/** Similarity drop threshold between adjacent windows to detect a boundary. */
export const SEGMENT_BOUNDARY_THRESHOLD = 0.72;

// ─── Extend vs accumulate decision ─────────────────────────────────────────

/** If a segment matches an existing node above this, extend silently. */
export const EXTEND_THRESHOLD = 0.70;

/** If a segment matches a candidate above this, accumulate into it. */
export const CANDIDATE_MATCH_THRESHOLD = 0.60;

// ─── Confidence scoring v2 ─────────────────────────────────────────────────

/** Weights for the "idea worth remembering" formula. Sum = 1.0. */
export const CONFIDENCE_WEIGHTS = {
  semanticCoherence: 0.30,
  distinctiveness: 0.30,
  recurrence: 0.20,
  evidenceQuality: 0.20,
};

/**
 * Confidence threshold to materialize a candidate into a visible node.
 * A single exceptionally rich segment CAN cross this if its coherence,
 * distinctiveness, and quality are all high enough.
 */
export const MATERIALIZE_THRESHOLD = 0.72;

/** Minimum total messages across all segments to be eligible. */
export const MIN_EVIDENCE_MESSAGES = 4;

// ─── Evidence quality scoring ───────────────────────────────────────────────

/** Messages ≤ this length are trivial (greetings, acknowledgments). */
export const TRIVIAL_MESSAGE_MAX_CHARS = 20;

/** Messages ≥ this length are considered substantive. */
export const SUBSTANTIVE_MESSAGE_MIN_CHARS = 80;

/** Patterns that indicate trivial/greeting messages. */
export const GREETING_PATTERNS = [
  /^(hi|hello|hey|thanks|ok|sure|yes|no|bye|cool|nice|great|lol|haha|yeah|yep|nope|exactly)\b/i,
];

// ─── Parent discovery ───────────────────────────────────────────────────────

/** Minimum sibling nodes to trigger parent creation. */
export const PARENT_MIN_SIBLINGS = 3;

/** Minimum avg pairwise similarity among siblings. */
export const PARENT_SIMILARITY_THRESHOLD = 0.60;

// ─── Candidate lifecycle ────────────────────────────────────────────────────

/** Discard candidates inactive for this many assistant responses. */
export const CANDIDATE_STALE_THRESHOLD = 20;
