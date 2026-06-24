/**
 * AI Prepared Nodes — configurable parameters.
 *
 * Pipeline order:
 * 1. Embed the recent message window (cheap)
 * 2. Compare against existing node embeddings (free — already stored)
 * 3. Only if no existing node is similar enough → generate title/summary/evidence (expensive)
 *
 * This "suppress first" approach minimizes LLM calls in the common case
 * where the conversation stays on a previously-captured topic.
 */

/**
 * Number of assistant responses between draft evaluations.
 * The system only checks whether to prepare a node every N messages.
 * This prevents excessive API calls and notification spam.
 */
export const AI_DRAFT_CHECK_INTERVAL = 4;

/**
 * Number of recent messages to use as the candidate range.
 * These messages are embedded as a single text block for suppression check,
 * and if the draft proceeds, they become the evidence basis for the node.
 */
export const AI_DRAFT_CANDIDATE_WINDOW = 6;

/**
 * If the recent window's embedding scores above this threshold against
 * any existing node's stored embedding, the draft is suppressed.
 * The topic is already covered — no new node needed.
 *
 * This comparison uses the stored node embeddings directly (no regeneration).
 *
 * Tuned down from 0.65 → 0.62 based on early real usage:
 * A window scored 0.6474 against an existing node and was NOT suppressed,
 * which risked creating a near-duplicate. Lowering the threshold catches
 * these borderline cases. Provisional — may adjust further as more data
 * accumulates.
 */
export const DRAFT_SUPPRESS_THRESHOLD = 0.62;
