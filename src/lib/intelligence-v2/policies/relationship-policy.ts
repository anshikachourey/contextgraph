/**
 * Relationship Policy — Domain-Independent Rules.
 *
 * Defines semantic tests for each relationship type
 * and what is prohibited.
 */

import type { Relationship } from "../schemas";

// ─── Semantic Tests for Each Relationship Type ──────────────────────────────

/**
 * Each relationship type has a specific semantic test.
 * The test must be satisfiable by citing propositions from both objects.
 */
export const RELATIONSHIP_SEMANTIC_TESTS = {
  child_of: "B is a narrower subtopic, component, or specialization of A. Removing A would make B lose its broader context.",
  answers: "B directly resolves or partially resolves an inquiry expressed in A.",
  raises_question: "B introduces a genuine unresolved question about A.",
  elaborates: "B adds detail to A without changing the central subject.",
  evidence_for: "B provides concrete support for a claim made in A.",
  example_of: "B is a concrete instance of the abstract concept in A.",
  reframes: "B interprets the same issue as A through a materially different lens.",
  contrasts_with: "B meaningfully opposes or differs from A on a specific point.",
  leads_to: "A logically or causally produces B, and this causality is explicitly supported by conversation evidence.",
  tangent_from: "B originates during A but pursues a different goal or subject.",
  diverged_from: "B becomes an independent topic after A in the linear conversation. Weak temporal link only.",
  continued_from: "B resumes an earlier dormant object A.",
  branch_from: "B exists because of explicit message-level branching from A.",
  merged_from: "B was intentionally produced by combining A and other objects.",
} as const;

// ─── Prohibitions ───────────────────────────────────────────────────────────

/**
 * Relationship prohibitions (deterministic, non-negotiable):
 */
export const RELATIONSHIP_PROHIBITIONS = [
  "child_of_from_mere_chronology",       // Temporal sequence ≠ parent-child
  "relationship_from_shared_vocabulary",  // Word overlap ≠ semantic connection
  "collapse_separate_roots",             // Broad umbrella ≠ hierarchy
  "infer_causality_from_sequence",       // "A then B" ≠ "A caused B"
  "bridge_without_proposition_support",  // Cross-tree links need evidence
  "diverged_from_as_child",             // diverged_from is NOT child_of
] as const;

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a relationship against policy rules.
 */
export function validateRelationship(rel: Relationship): string[] {
  const violations: string[] = [];

  // Rule 1: Must reference two different objects
  if (rel.sourceObjectId === rel.targetObjectId) {
    violations.push("Self-referential relationship");
  }

  // Rule 2: Must have a non-empty explanation
  if (!rel.explanation || rel.explanation.trim().length < 5) {
    violations.push("Relationship must have a meaningful explanation citing evidence");
  }

  // Rule 3: diverged_from must have visualClass "weak" or "structural"
  if (rel.type === "diverged_from" && rel.visualClass === "semantic") {
    violations.push("diverged_from should not be classified as normal semantic — it is a weak structural link");
  }

  // Rule 4: Confidence must be in range
  if (rel.confidence < 0 || rel.confidence > 1) {
    violations.push("Confidence must be between 0 and 1");
  }

  return violations;
}

/**
 * Check if a proposed child_of relationship is valid.
 * Returns false if it violates the semantic test.
 */
export function isValidChildOf(
  childDescription: string,
  parentDescription: string,
): boolean {
  // The child must be about a narrower aspect of the parent.
  // This is a structural check — the LLM determines semantics,
  // but the validator can catch obvious violations.

  // If the child and parent have no vocabulary overlap beyond common words,
  // child_of is suspicious (should be diverged_from or separate root)
  const commonWords = new Set(["the", "a", "an", "is", "are", "was", "were", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "that", "this", "it"]);

  const parentWords = new Set(parentDescription.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !commonWords.has(w)));
  const childWords = new Set(childDescription.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !commonWords.has(w)));

  const overlap = [...childWords].filter((w) => parentWords.has(w));

  // If zero content-word overlap, child_of is highly suspect
  // This is a SOFT check — the LLM may still override with good reasoning
  return overlap.length > 0;
}
