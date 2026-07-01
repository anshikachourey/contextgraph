/**
 * Node Evolution Engine — configurable thresholds.
 *
 * These control when the engine suggests graph structure changes.
 * All values are cosine similarity scores in [0, 1].
 */

/**
 * Minimum similarity between an unlinked message window and a node
 * for an "extend_node" suggestion. Messages scoring above this
 * are probably continuing an existing topic.
 */
export const EXTEND_SUGGEST_THRESHOLD = 0.65;

/**
 * Minimum pairwise similarity between two nodes to suggest merging.
 * Very high — only near-duplicates should trigger this.
 */
export const MERGE_THRESHOLD = 0.80;

/**
 * Minimum number of related nodes to suggest a parent topic.
 * A parent only makes sense when 3+ siblings exist.
 */
export const PARENT_MIN_CLUSTER_SIZE = 3;

/**
 * Minimum average pairwise similarity among sibling nodes
 * to qualify as children of a common parent topic.
 */
export const PARENT_INTRA_SIMILARITY = 0.60;

/**
 * Number of consecutive unlinked messages to group into one window
 * for extend_node comparison.
 */
export const EXTEND_WINDOW_SIZE = 4;
