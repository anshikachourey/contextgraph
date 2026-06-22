import { generateEmbedding } from "./embeddings";
import { cosineSimilarity } from "./cosineSimilarity";
import {
  WINDOW_SIZE,
  SHIFT_THRESHOLD,
  HIGH_CONFIDENCE_SHIFT,
} from "./topicShiftConfig";
import type { ChatMessage } from "@/src/types/message";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TopicShiftResult = {
  /** Position in the message array where the boundary falls (between referenceWindow and currentWindow). */
  boundaryIndex: number;
  /** Cosine similarity between the two windows. Lower = more different. */
  similarity: number;
  /** Confidence that a topic shift occurred. Derived from thresholds. */
  confidence: "high" | "moderate" | "none";
  /** The messages in the reference (prior) window. */
  referenceWindow: ChatMessage[];
  /** The messages in the current (newer) window. */
  currentWindow: ChatMessage[];
};

export type TopicShiftAnalysis = {
  /** All window boundaries analyzed. */
  shifts: TopicShiftResult[];
  /** Only boundaries where confidence is "high" or "moderate". */
  detectedShifts: TopicShiftResult[];
  /** Configuration used for this analysis. */
  config: {
    windowSize: number;
    shiftThreshold: number;
    highConfidenceShift: number;
  };
  /** Total messages analyzed. */
  messageCount: number;
};

// ─── Core logic ─────────────────────────────────────────────────────────────

/**
 * Build embedding text for a window of messages.
 * Concatenates all message contents with role attribution.
 */
function windowToText(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}

function classifyConfidence(similarity: number): TopicShiftResult["confidence"] {
  if (similarity < HIGH_CONFIDENCE_SHIFT) return "high";
  if (similarity < SHIFT_THRESHOLD) return "moderate";
  return "none";
}

/**
 * Analyze a full conversation for topic shifts.
 *
 * Slides two adjacent windows across the message array and compares
 * their embeddings. Each boundary gets a similarity score and a
 * confidence classification.
 *
 * This is a pure analysis function — no side effects, no DB writes,
 * no UI. Callers decide what to do with the results.
 *
 * Requires at least 2 * WINDOW_SIZE messages to produce any results.
 */
export async function detectTopicShifts(
  messages: ChatMessage[],
): Promise<TopicShiftAnalysis> {
  const config = {
    windowSize: WINDOW_SIZE,
    shiftThreshold: SHIFT_THRESHOLD,
    highConfidenceShift: HIGH_CONFIDENCE_SHIFT,
  };

  if (messages.length < 2 * WINDOW_SIZE) {
    return {
      shifts: [],
      detectedShifts: [],
      config,
      messageCount: messages.length,
    };
  }

  const shifts: TopicShiftResult[] = [];

  // Slide windows across the conversation.
  // At each step: referenceWindow = [i..i+WINDOW_SIZE], currentWindow = [i+WINDOW_SIZE..i+2*WINDOW_SIZE]
  // Step by 1 message at a time for granular detection.
  const maxStart = messages.length - 2 * WINDOW_SIZE;

  for (let i = 0; i <= maxStart; i++) {
    const referenceWindow = messages.slice(i, i + WINDOW_SIZE);
    const currentWindow = messages.slice(i + WINDOW_SIZE, i + 2 * WINDOW_SIZE);

    const refText = windowToText(referenceWindow);
    const curText = windowToText(currentWindow);

    // Generate embeddings for both windows
    const [refEmbedding, curEmbedding] = await Promise.all([
      generateEmbedding(refText),
      generateEmbedding(curText),
    ]);

    const similarity = cosineSimilarity(refEmbedding, curEmbedding);
    const confidence = classifyConfidence(similarity);

    shifts.push({
      boundaryIndex: i + WINDOW_SIZE,
      similarity,
      confidence,
      referenceWindow,
      currentWindow,
    });
  }

  const detectedShifts = shifts.filter((s) => s.confidence !== "none");

  return { shifts, detectedShifts, config, messageCount: messages.length };
}

/**
 * Lightweight version: check only the most recent boundary.
 * Useful for real-time detection after each new message pair.
 *
 * Returns null if there aren't enough messages yet.
 */
export async function detectLatestShift(
  messages: ChatMessage[],
): Promise<TopicShiftResult | null> {
  if (messages.length < 2 * WINDOW_SIZE) return null;

  const start = messages.length - 2 * WINDOW_SIZE;
  const referenceWindow = messages.slice(start, start + WINDOW_SIZE);
  const currentWindow = messages.slice(start + WINDOW_SIZE);

  const refText = windowToText(referenceWindow);
  const curText = windowToText(currentWindow);

  const [refEmbedding, curEmbedding] = await Promise.all([
    generateEmbedding(refText),
    generateEmbedding(curText),
  ]);

  const similarity = cosineSimilarity(refEmbedding, curEmbedding);
  const confidence = classifyConfidence(similarity);

  return {
    boundaryIndex: start + WINDOW_SIZE,
    similarity,
    confidence,
    referenceWindow,
    currentWindow,
  };
}
