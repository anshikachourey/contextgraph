/**
 * Proposition Policy — Domain-Independent Rules.
 *
 * Defines what constitutes a valid proposition,
 * how provenance is assigned, and what is prohibited.
 */

import type { Proposition } from "../schemas";

// ─── Extraction Rules ───────────────────────────────────────────────────────

/**
 * A proposition should be created when an utterance expresses:
 * claim, question, preference, intention, decision, goal,
 * problem, request, example, emotional_state, correction, confirmation, rejection.
 *
 * A proposition should NOT be created for:
 * - Conversational filler ("ok", "hmm", "lol")
 * - Greetings without substantive content
 * - Pure acknowledgements without new information
 * - Formatting or meta-conversation about the chat interface
 */
export const MINIMUM_SUBSTANTIVE_LENGTH = 10;

/**
 * Provenance assignment rules (deterministic):
 * - "direct": content is authored by the attributed party in their own words
 * - "paraphrase": content restates what the party said in equivalent terms
 * - "interpretation": content is one party's reading of the other's meaning
 * - "inference": content is derived from context but not directly stated
 */
export type ProvenanceRule =
  | "user_said_it" // → direct, authoredBy: user
  | "assistant_said_it" // → direct, authoredBy: assistant
  | "assistant_interprets_user" // → interpretation, authoredBy: assistant
  | "user_confirms_interpretation" // → direct, authoredBy: user (upgrades previous interpretation)
  | "contextual_derivation"; // → inference

// ─── Validation Rules (deterministic, non-negotiable) ───────────────────────

/**
 * Validate a proposition against policy rules.
 * Returns list of violations (empty = valid).
 */
export function validateProposition(prop: Proposition): string[] {
  const violations: string[] = [];

  // Rule 1: User-attributed propositions must have provenance "direct" or "paraphrase"
  if (prop.authoredBy === "user" && prop.provenance === "interpretation") {
    violations.push("User-attributed proposition cannot have provenance 'interpretation' — that is an assistant action");
  }

  // Rule 2: Interpretation propositions must be authored by assistant
  if (prop.provenance === "interpretation" && prop.authoredBy === "user") {
    violations.push("Interpretation provenance requires authoredBy: assistant");
  }

  // Rule 3: Empty content is invalid
  if (!prop.normalizedContent || prop.normalizedContent.trim().length < MINIMUM_SUBSTANTIVE_LENGTH) {
    violations.push("Proposition content is empty or too short to be meaningful");
  }

  // Rule 4: Must reference at least one source utterance
  if (prop.sourceUtteranceIds.length === 0) {
    violations.push("Proposition must trace to at least one source utterance");
  }

  // Rule 5: Superseding requires a target
  if (prop.status === "superseded" && !prop.supersedesPropositionId) {
    // This is a warning, not a hard violation — the system may not yet know what supersedes it
  }

  return violations;
}

// ─── Prohibitions ───────────────────────────────────────────────────────────

/**
 * Things the proposition extractor must NEVER do:
 * 1. Convert assistant interpretation into user proposition
 * 2. Create psychological/causal claims without explicit user support
 * 3. Combine unrelated propositions from different subjects
 * 4. Strip uncertainty, negation, or conditionality
 * 5. Convert a question into a claim
 * 6. Attribute to the user something only the assistant said
 */
export const PROPOSITION_PROHIBITIONS = [
  "assistant_interpretation_as_user_fact",
  "unsupported_psychological_claim",
  "cross_subject_merge",
  "certainty_inflation",
  "question_to_claim_conversion",
  "misattribution",
] as const;
