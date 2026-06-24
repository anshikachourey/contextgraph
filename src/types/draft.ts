import type { ChatMessage } from "./message";

/**
 * An AI-prepared node draft. Lives only in client state —
 * not persisted until the user explicitly approves.
 */
export type AiDraft = {
  title: string;
  summary: string;
  /** The messages the AI based its suggestion on. */
  candidateMessages: ChatMessage[];
};
