/**
 * Topic Shift Detection — configurable parameters.
 *
 * These values are provisional. They should be tuned after inspecting
 * real conversations via the /api/debug/topic-shifts endpoint.
 */

/** Number of messages in each comparison window. */
export const WINDOW_SIZE = 4;

/**
 * Cosine similarity below this value between adjacent windows
 * indicates a likely topic shift. Range: [0, 1].
 * Lower = more different topics in the two windows.
 */
export const SHIFT_THRESHOLD = 0.72;

/**
 * Below this score the shift is considered high-confidence —
 * the conversation almost certainly moved to a new topic.
 */
export const HIGH_CONFIDENCE_SHIFT = 0.60;
