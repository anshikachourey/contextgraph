/**
 * V2 Layer 0: Utterance construction.
 *
 * Creates immutable utterance references from persisted messages.
 * Does not modify messages — reads only.
 */

import type { Utterance } from "./schemas";

interface MessageRow {
  id: string;
  role: string;
  content: string;
  conversation_id: string;
  created_at: string;
  parent_node_id: string | null;
  branch_root_message_id: string | null;
}

/**
 * Build utterance objects from raw message rows.
 * Preserves temporal order, branch provenance, and authorship.
 */
export function buildUtterances(messages: MessageRow[], conversationId: string): Utterance[] {
  return messages.map((m, idx) => ({
    utteranceId: m.id,
    sourceMessageId: m.id,
    conversationId,
    author: m.role as "user" | "assistant",
    rawContent: m.content,
    createdAt: m.created_at,
    temporalPosition: idx,
    branchId: m.parent_node_id ?? null,
    branchPath: m.parent_node_id ? [m.parent_node_id] : [],
    branchPointMessageId: m.branch_root_message_id ?? null,
    tombstoned: false,
  }));
}
