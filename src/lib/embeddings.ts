import OpenAI from "openai";
import type { ChatMessage } from "@/src/types/message";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// text-embedding-3-small: 1536 dimensions, fast, cheap, good quality.
// Switching to text-embedding-3-large later requires re-embedding all nodes
// because dimensions differ — document that decision before changing.
const EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Generate an embedding vector for the given text.
 * Returns a number[] of length 1536.
 * Throws on API failure — callers decide whether to surface or swallow.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  return response.data[0].embedding;
}

/**
 * Generate a concise bullet-point evidence summary from linked messages.
 * This represents what the conversation actually said about this node's topic.
 * Throws on API failure — caller soft-fails by setting evidence_summary to null.
 */
export async function generateEvidenceSummary(
  messages: ChatMessage[],
): Promise<string> {
  const formatted = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You extract the key factual points from a set of conversation messages.
Return 2–4 concise bullet points (starting with "•") that capture the most important claims, decisions, or insights discussed.
Do not repeat the topic label. Do not use headers. Plain text only. Max 300 characters total.`,
      },
      {
        role: "user",
        content: `Here are the messages:\n\n${formatted}\n\nExtract the key points as bullet points.`,
      },
    ],
    temperature: 0.3,
    max_tokens: 200,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned empty evidence summary");
  return raw.trim();
}

/**
 * Build the structured text that gets embedded for a context node.
 * Uses all three signals: title, summary, and evidence from linked messages.
 * Falls back gracefully if evidence_summary is absent.
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

/**
 * Maximum character length for text passed to the embedding model.
 * OpenAI text-embedding-3-small has an 8192 token limit.
 * At ~4 chars/token, 7000 chars is a safe ceiling (~1750 tokens).
 */
const MAX_EMBEDDING_CHARS = 7000;

/** Number of messages to take from the start and end of a cluster. */
const HEAD_MESSAGES = 3;
const TAIL_MESSAGES = 3;

/**
 * Build bounded representative text from a cluster of messages.
 *
 * Strategy for long clusters:
 * - Include the first HEAD_MESSAGES (opening context)
 * - Include the last TAIL_MESSAGES (most recent development)
 * - Skip middle messages if the cluster is too large
 * - Truncate to MAX_EMBEDDING_CHARS
 *
 * This captures the semantic "bookends" of a topic — what it started
 * with and where it ended up — which is what similarity comparison needs.
 */
export function buildClusterEmbeddingText(messages: ChatMessage[]): string {
  const formatMsg = (m: ChatMessage) =>
    `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;

  let selectedMessages: ChatMessage[];

  if (messages.length <= HEAD_MESSAGES + TAIL_MESSAGES) {
    // Short cluster — use all messages
    selectedMessages = messages;
  } else {
    // Long cluster — take head + tail
    const head = messages.slice(0, HEAD_MESSAGES);
    const tail = messages.slice(-TAIL_MESSAGES);
    selectedMessages = [...head, ...tail];
  }

  let text = selectedMessages.map(formatMsg).join("\n");

  // Hard truncate if still over limit
  if (text.length > MAX_EMBEDDING_CHARS) {
    text = text.slice(0, MAX_EMBEDDING_CHARS);
  }

  return text;
}
