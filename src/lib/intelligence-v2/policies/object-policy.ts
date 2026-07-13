/**
 * Object Policy — Domain-Independent Rules.
 *
 * Defines when conversational objects should be created,
 * what they must contain, and what is prohibited.
 */

import type { ConversationalObject } from "../schemas";

// ─── Object Creation Criteria ───────────────────────────────────────────────

/**
 * Create an object ONLY when there is a recognizable conversational entity.
 * The entity must be meaningful as a navigational/recall unit.
 */
export const OBJECT_CREATION_CRITERIA = [
  "sustained_inquiry",       // a question explored over multiple exchanges
  "problem_being_solved",    // an identified difficulty being worked through
  "decision_reached",        // a choice made or being evaluated
  "task_or_project",         // something to be done
  "preference_expressed",    // a value or preference articulated
  "plan_formed",             // a sequence of intended actions
  "explanation_given",       // a topic explained
  "insight_crystallized",    // a realization emerged
  "comparison_made",         // alternatives weighed
  "unresolved_concern",      // something left open but important
] as const;

/**
 * Do NOT create an object merely because:
 */
export const INSUFFICIENT_FOR_OBJECT_CREATION = [
  "enough_messages_accumulated",
  "threshold_was_reached",
  "messages_share_vocabulary",
  "llm_can_invent_elegant_summary",
  "system_needs_a_first_node",
  "temporal_proximity",
  "shared_broad_domain",
] as const;

// ─── Title Rules ────────────────────────────────────────────────────────────

/**
 * Object titles must:
 * 1. Name the actual conversational entity
 * 2. Preserve the communicative form (question stays question)
 * 3. Be entailed by source propositions
 * 4. Not be an essay-style conclusion unless the conversation genuinely concluded
 */
export const TITLE_RULES = {
  preserve_questions: "Questions remain as '?' — never silently converted to claims",
  preserve_uncertainty: "Uncertain claims keep their uncertainty markers",
  no_synthesis_beyond_evidence: "Title must not state more than propositions support",
  no_forced_elegance: "Faithful representation over poetic synthesis",
  no_generic_exploring: "Never begin with 'Exploring...' unless that is the literal content",
};

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate an object against policy rules.
 */
export function validateObject(obj: ConversationalObject): string[] {
  const violations: string[] = [];

  // Rule 1: Must have at least one supporting user utterance
  if (obj.supportingUtteranceIds.length === 0 && obj.status !== "discarded") {
    violations.push("Object must trace to at least one user utterance");
  }

  // Rule 2: Must have at least one proposition
  if (obj.propositionIds.length === 0 && obj.status !== "discarded") {
    violations.push("Object must be derived from at least one proposition");
  }

  // Rule 3: Must have at least one thread
  if (obj.threadIds.length === 0 && obj.status !== "discarded") {
    violations.push("Object must belong to at least one thread");
  }

  // Rule 4: Title must not be empty
  if (!obj.title || obj.title.trim().length < 5) {
    violations.push("Object must have a meaningful title");
  }

  // Rule 5: Inquiry objects should have question marks or question phrasing
  if (obj.objectType === "inquiry" && !obj.title.includes("?") && !isQuestionPhrased(obj.title)) {
    violations.push("Inquiry object title should be phrased as a question");
  }

  return violations;
}

function isQuestionPhrased(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    lower.startsWith("whether") ||
    lower.startsWith("how") ||
    lower.startsWith("what") ||
    lower.startsWith("why") ||
    lower.startsWith("when") ||
    lower.startsWith("where") ||
    lower.startsWith("who") ||
    lower.startsWith("can") ||
    lower.startsWith("could") ||
    lower.startsWith("should") ||
    lower.startsWith("is") ||
    lower.startsWith("are") ||
    lower.startsWith("do") ||
    lower.startsWith("does") ||
    lower.startsWith("will")
  );
}
