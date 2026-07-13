/**
 * Lifecycle Policy — Domain-Independent State Transitions.
 *
 * Defines valid state transitions for all semantic units.
 * Transitions must be based on explicit conditions, not vague LLM judgment.
 */

import type { PropositionStatus } from "../schemas";

// ─── Proposition Lifecycle ──────────────────────────────────────────────────

export const PROPOSITION_TRANSITIONS: Record<PropositionStatus, PropositionStatus[]> = {
  active: ["superseded", "retracted", "invalidated"],
  superseded: [],  // terminal — replaced by a newer proposition
  retracted: [],   // terminal — user explicitly took it back
  invalidated: [], // terminal — contradicted by evidence
};

export const PROPOSITION_TRANSITION_CONDITIONS = {
  "active → superseded": "A newer proposition with the same subject replaces this one",
  "active → retracted": "The original author explicitly takes back the claim",
  "active → invalidated": "Subsequent evidence directly contradicts the proposition",
} as const;

// ─── Thread Lifecycle ───────────────────────────────────────────────────────

// ─── Thread Lifecycle ───────────────────────────────────────────────────────

export const THREAD_TRANSITIONS: Record<string, string[]> = {
  active: ["completed", "abandoned", "dormant", "branched", "split"],
  completed: ["active"],
  abandoned: [],
  dormant: ["active"],
  branched: [],
  split: [],
  merged: [],
};

export const THREAD_TRANSITION_CONDITIONS = {
  "active → completed": "Thread subject is fully resolved or conversation moves on definitively",
  "active → dormant": "No new utterances for N turns, but not explicitly abandoned",
  "active → abandoned": "User explicitly drops the topic or it was purely transient",
  "active → branched": "Message-level branch creates separate continuation",
  "active → split": "A single thread is found to contain multiple subjects",
  "dormant → active": "User explicitly returns to this subject",
} as const;

// ─── Object Lifecycle ───────────────────────────────────────────────────────

// ─── Object Lifecycle ───────────────────────────────────────────────────────

export const OBJECT_TRANSITIONS: Record<string, string[]> = {
  nascent: ["developing", "discarded", "deferred"],
  developing: ["stable", "discarded", "deferred", "split", "merged"],
  stable: ["resolved", "deferred", "split", "merged", "archived"],
  resolved: ["active", "archived"],
  deferred: ["active", "discarded"],
  discarded: [],
  split: [],
  merged: [],
  archived: ["active"],
};

export const OBJECT_TRANSITION_CONDITIONS = {
  "nascent → developing": "New propositions strengthen the object beyond initial formation",
  "nascent → discarded": "Content found to be noise or non-substantive",
  "developing → stable": "Conversation moves past; object represents a complete entity",
  "developing → split": "Object found to contain multiple distinct entities",
  "developing → merged": "Object is duplicate of another; absorbed",
  "stable → resolved": "An inquiry is answered, a problem is solved, a task is completed",
  "stable → archived": "No longer actively relevant but preserved for recall",
} as const;

// ─── Relationship Lifecycle ─────────────────────────────────────────────────

export const RELATIONSHIP_TRANSITIONS = {
  proposed: ["validated", "removed"],
  validated: ["active", "removed"],
  active: ["weakened", "reclassified", "removed"],
  weakened: ["active", "removed"],
  reclassified: ["active", "removed"],
  removed: [],  // terminal
} as const;
