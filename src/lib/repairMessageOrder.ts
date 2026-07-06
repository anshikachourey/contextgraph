/**
 * Canonical message ordering utility.
 *
 * Repairs message sequences that have ordering anomalies
 * (e.g., assistant before its corresponding user message)
 * from conversations with bad created_at timestamps.
 *
 * The canonical order is always: user → assistant → user → assistant → ...
 */

import type { ChatMessage } from "@/src/types/message";

export interface OrderRepairResult {
  canonical: ChatMessage[];
  anomalies: string[];
  wasRepaired: boolean;
}

/**
 * Determine if a message sequence is validly ordered.
 * Valid = starts with user, strictly alternates user/assistant.
 */
export function isValidAlternating(messages: ChatMessage[]): boolean {
  if (messages.length === 0) return true;
  for (let i = 0; i < messages.length; i++) {
    const expectedRole = i % 2 === 0 ? "user" : "assistant";
    if (messages[i].role !== expectedRole) return false;
  }
  return true;
}

/**
 * Repair a message sequence into canonical user→assistant pairs.
 *
 * Strategy:
 * 1. If already valid alternating, return as-is.
 * 2. Otherwise, pair each assistant with the closest preceding unpaired user.
 * 3. Drop orphan assistants that have no preceding user.
 * 4. Keep orphan users (a user without a following assistant is valid at the end).
 */
export function repairMessageOrder(messages: ChatMessage[]): OrderRepairResult {
  if (messages.length === 0) {
    return { canonical: [], anomalies: [], wasRepaired: false };
  }

  // Fast path: already valid
  if (isValidAlternating(messages)) {
    return { canonical: messages, anomalies: [], wasRepaired: false };
  }

  // Repair: pair users with their following assistants
  const anomalies: string[] = [];
  const canonical: ChatMessage[] = [];
  const users: ChatMessage[] = [];
  const assistants: ChatMessage[] = [];

  // Separate into users and assistants preserving their relative order
  for (const m of messages) {
    if (m.role === "user") users.push(m);
    else assistants.push(m);
  }

  // Pair them: user[0] with assistant[0], user[1] with assistant[1], etc.
  const maxPairs = Math.min(users.length, assistants.length);

  for (let i = 0; i < maxPairs; i++) {
    canonical.push(users[i]);
    canonical.push(assistants[i]);
  }

  // Remaining unpaired users at the end (valid — user without response yet)
  for (let i = maxPairs; i < users.length; i++) {
    canonical.push(users[i]);
  }

  // Remaining unpaired assistants are orphans (anomaly)
  for (let i = maxPairs; i < assistants.length; i++) {
    anomalies.push(
      `Orphan assistant dropped: "${assistants[i].content.slice(0, 40)}..." (id: ${assistants[i].id})`,
    );
  }

  // Detect position changes
  for (let i = 0; i < canonical.length; i++) {
    if (i < messages.length && canonical[i].id !== messages[i].id) {
      if (anomalies.length === 0 || !anomalies.some((a) => a.includes("reordered"))) {
        anomalies.push(
          `Messages reordered to enforce user→assistant alternation`,
        );
      }
    }
  }

  return {
    canonical,
    anomalies,
    wasRepaired: anomalies.length > 0,
  };
}
