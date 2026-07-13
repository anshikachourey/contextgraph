/**
 * Thread Policy — Domain-Independent Rules.
 *
 * Defines when messages belong to the same thread
 * and when a new thread must be created.
 */

import type { Thread } from "../schemas";

// ─── Thread Membership Rules ────────────────────────────────────────────────

/**
 * A message/proposition belongs to an existing thread ONLY when it:
 * 1. Continues the same subject (not just domain)
 * 2. Answers or develops an open question within the thread
 * 3. Adds evidence or an example to the thread's subject
 * 4. Clarifies or corrects something within the thread
 * 5. Resumes a previously dormant thread (explicit return)
 */
export const THREAD_INCLUSION_CRITERIA = [
  "continues_same_subject",
  "answers_open_question",
  "adds_evidence_or_example",
  "clarifies_or_corrects",
  "explicit_resumption",
] as const;

/**
 * Create a new thread when:
 * 1. A new independent subject appears
 * 2. The communicative goal changes (from discussing to requesting)
 * 3. The user starts a separate task
 * 4. A tangent becomes semantically independent
 * 5. Branch ancestry requires separation
 */
export const THREAD_CREATION_CRITERIA = [
  "new_independent_subject",
  "communicative_goal_change",
  "separate_task_initiated",
  "tangent_became_independent",
  "branch_separation",
] as const;

// ─── Insufficient Evidence for Same-Thread ──────────────────────────────────

/**
 * These conditions are NOT sufficient for thread membership:
 * - Temporal adjacency alone
 * - Shared emotional tone
 * - Shared broad domain ("both about health", "both about work")
 * - Same conversation
 * - Same speaker
 */
export const INSUFFICIENT_FOR_THREAD_MEMBERSHIP = [
  "temporal_adjacency_only",
  "shared_emotional_tone_only",
  "shared_broad_domain_only",
  "same_conversation_only",
  "same_speaker_only",
] as const;

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a thread against policy rules.
 */
export function validateThread(thread: Thread): string[] {
  const violations: string[] = [];

  // Rule 1: Thread must have a subject
  if (!thread.subject || thread.subject.trim().length < 5) {
    violations.push("Thread must have a concise, expressible subject");
  }

  // Rule 2: Thread must reference at least one utterance
  if (thread.utteranceIds.length === 0) {
    violations.push("Thread must contain at least one utterance");
  }

  // Rule 3: Subject must be a single coherent topic (heuristic: no "and" joining unrelated concepts)
  // This is a soft check — the LLM decides ambiguous cases

  return violations;
}

/**
 * The subject coherence test:
 * A thread's subject should be expressible as ONE concise sentence.
 * If it requires "and" to join two unrelated concepts, it should be two threads.
 *
 * Good subjects:
 * - "anxiety and physical symptoms"  (related — anxiety causes symptoms)
 * - "foods that help skin"
 * - "whether the parents were hurt"
 *
 * Bad subjects (should be split):
 * - "anxiety and song translation" (unrelated)
 * - "career planning and skincare" (unrelated)
 * - "coding bug and dinner plans" (unrelated)
 */
export const SUBJECT_COHERENCE_PRINCIPLE =
  "A thread subject must represent ONE coherent topic. " +
  "If two concepts share no propositional relationship, they are separate threads.";
