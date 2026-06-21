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
