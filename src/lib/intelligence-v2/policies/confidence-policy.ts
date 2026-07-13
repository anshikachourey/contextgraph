/**
 * Confidence Policy — Abstention and Uncertainty.
 *
 * The system must be allowed to abstain.
 * Faithful incompleteness is better than confident fabrication.
 */

// ─── Confidence Thresholds ──────────────────────────────────────────────────

/**
 * When confidence falls below these thresholds, the system abstains
 * rather than making a potentially wrong decision.
 */
export const CONFIDENCE_THRESHOLDS = {
  /** Below this: proposition kept as provisional, not acted upon */
  proposition_actionable: 0.5,

  /** Below this: thread membership deferred */
  thread_membership: 0.4,

  /** Below this: object not formed (propositions remain unattached) */
  object_formation: 0.5,

  /** Below this: relationship proposed but inactive */
  relationship_activation: 0.5,

  /** Below this: hierarchy placement unresolved (object becomes temporary root) */
  hierarchy_placement: 0.6,

  /** Above this: may select primary parent from multiple candidates */
  primary_parent_selection: 0.8,
} as const;

// ─── Abstention Rules ───────────────────────────────────────────────────────

/**
 * How each layer handles low confidence:
 */
export const ABSTENTION_BEHAVIORS = {
  proposition: "Keep provisional — included in derivation but flagged",
  thread_membership: "Defer assignment — proposition remains unattached until more evidence",
  object_formation: "Keep nascent — do not show in graph until developing",
  relationship: "Proposed but inactive — not used for hierarchy derivation",
  hierarchy_placement: "Separate root or unresolved placement",
} as const;

// ─── The Core Principle ─────────────────────────────────────────────────────

/**
 * It is always preferable to:
 * - Have an incomplete graph with faithful content
 * - Over a complete graph with invented content
 *
 * The system should never:
 * - Fabricate connections to fill gaps
 * - Invent objects to ensure the graph has content
 * - Force hierarchy to achieve visual completeness
 * - Create relationships to make the graph "look connected"
 *
 * Empty space in the graph is honest.
 * Hallucinated connections are harmful.
 */
export const CORE_PRINCIPLE =
  "Faithful incompleteness is always preferable to confident fabrication.";
