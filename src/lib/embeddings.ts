/**
 * Embedding and evidence summary utilities.
 *
 * Delegates to src/lib/ai/ for all provider-specific operations.
 * This file provides domain-specific helpers (text construction, truncation).
 */

import { embed as aiEmbed, generateEvidenceSummary as aiEvidenceSummary } from "@/src/lib/ai";
import type { ChatMessage } from "@/src/types/message";

/**
 * Generate an embedding vector for the given text.
 * Returns a number[] (dimension depends on configured model).
 * Throws on API failure — callers decide whether to surface or swallow.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  return aiEmbed(text);
}

/**
 * Generate a concise bullet-point evidence summary from linked messages.
 * Throws on API failure — caller soft-fails by setting evidence_summary to null.
 */
export async function generateEvidenceSummary(
  messages: ChatMessage[],
): Promise<string> {
  const formatted = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const result = await aiEvidenceSummary(formatted);
  if (!result) throw new Error("AI returned empty evidence summary");
  return result;
}

/**
 * Build the structured text that gets embedded for a context node.
 * Uses all three signals: title, summary, and evidence from linked messages.
 */
export function buildNodeEmbeddingText(
  title: string,
  summary: string,
  evidenceSummary: string | null,
): string {
  const parts: string[] = [`Title:\n${title}`];

  if (summary.trim()) {
    parts.push(`Summary:\n${summary.trim()}`);
  }

  if (evidenceSummary && evidenceSummary.trim()) {
    parts.push(`Evidence:\n${evidenceSummary.trim()}`);
  }

  return parts.join("\n\n");
}

// ─── Bounded embedding text for clusters ──────────────────────────────────────

const MAX_EMBEDDING_CHARS = 7000;
const HEAD_MESSAGES = 3;
const TAIL_MESSAGES = 3;

/**
 * Build bounded representative text from a cluster of messages.
 */
export function buildClusterEmbeddingText(messages: ChatMessage[]): string {
  const formatMsg = (m: ChatMessage) =>
    `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;

  let selectedMessages: ChatMessage[];

  if (messages.length <= HEAD_MESSAGES + TAIL_MESSAGES) {
    selectedMessages = messages;
  } else {
    const head = messages.slice(0, HEAD_MESSAGES);
    const tail = messages.slice(-TAIL_MESSAGES);
    selectedMessages = [...head, ...tail];
  }

  let text = selectedMessages.map(formatMsg).join("\n");
  if (text.length > MAX_EMBEDDING_CHARS) {
    text = text.slice(0, MAX_EMBEDDING_CHARS);
  }

  return text;
}
