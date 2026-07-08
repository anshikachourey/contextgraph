/**
 * Three-Layer Materialization Pipeline.
 *
 * Ensures nodes are only created when a durable insight has crystallized,
 * not merely because enough messages accumulated.
 *
 * Layer 1: Conversation State Classifier (exploring/developing/concluded)
 * Layer 2: Insight Detector (has a specific realization emerged?)
 * Layer 3: Insight-Seeded Generation (use the insight as node seed)
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";
import { debugLog, infoLog } from "./logger";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Force materialization after this many engine runs without a conclusion */
export const MAX_LAYER_WAIT = 20;

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConversationState = "exploring" | "developing" | "concluded";

export interface Layer1Result {
  state: ConversationState;
  reason: string;
}

export interface Layer2Result {
  hasInsight: boolean;
  insightStatement: string | null;
  confidence: number;
  reason: string;
}

export interface PipelineResult {
  shouldMaterialize: boolean;
  layer1: Layer1Result;
  layer2: Layer2Result | null;
  insightSeed: string | null;
  forcedByMaxWait: boolean;
}

// ─── Layer 1: Conversation State Classifier ─────────────────────────────────

export async function classifyConversationState(
  formattedMessages: string,
): Promise<Layer1Result> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        {
          role: "system",
          content: `You classify conversation states. Given a conversation excerpt, determine whether the ideas are:

- "exploring": still generating possibilities, asking questions, wandering between topics, comparing options. No clear direction yet.
- "developing": ideas are forming, the person is working toward something, but hasn't reached a clear conclusion yet.
- "concluded": a specific insight, realization, stable takeaway, or decision has crystallized. The person has arrived somewhere.

Return JSON:
{ "state": "exploring" | "developing" | "concluded", "reason": "<one sentence>" }`,
        },
        {
          role: "user",
          content: `Classify this conversation state:\n\n${formattedMessages}\n\nReturn JSON only.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 100,
    });

    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown> | null;
    if (parsed && typeof parsed.state === "string" && typeof parsed.reason === "string") {
      const state = parsed.state as string;
      if (state === "exploring" || state === "developing" || state === "concluded") {
        return { state, reason: parsed.reason as string };
      }
    }
    // Default to developing if parsing fails
    return { state: "developing", reason: "Could not classify — defaulting to developing" };
  } catch {
    return { state: "developing", reason: "Classification failed — defaulting to developing" };
  }
}

// ─── Layer 2: Insight Detector ──────────────────────────────────────────────

export async function detectInsight(
  formattedMessages: string,
): Promise<Layer2Result> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        {
          role: "system",
          content: `You detect whether a conversation has produced a specific, durable insight worth remembering independently.

An insight is:
- A realization or conclusion the person arrived at
- Something they would want to recall months later without rereading the conversation
- A belief, principle, understanding, or decision that crystallized

NOT an insight:
- A topic that was discussed
- A question that was asked
- An idea still being explored
- A summary of what happened

Return JSON:
{
  "hasInsight": true | false,
  "insightStatement": "<one sentence capturing the insight — null if none>",
  "confidence": <0.0 to 1.0>,
  "reason": "<why you believe an insight has or has not emerged>"
}`,
        },
        {
          role: "user",
          content: `Has a durable insight emerged from this conversation?\n\n${formattedMessages}\n\nReturn JSON only.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 200,
    });

    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown> | null;
    if (
      parsed &&
      typeof parsed.hasInsight === "boolean" &&
      typeof parsed.reason === "string"
    ) {
      return {
        hasInsight: parsed.hasInsight,
        insightStatement: typeof parsed.insightStatement === "string" ? parsed.insightStatement : null,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        reason: parsed.reason as string,
      };
    }
    return { hasInsight: false, insightStatement: null, confidence: 0, reason: "Detection failed" };
  } catch {
    return { hasInsight: false, insightStatement: null, confidence: 0, reason: "Detection error" };
  }
}

// ─── Full Pipeline ──────────────────────────────────────────────────────────

/**
 * Run the three-layer materialization pipeline.
 *
 * @param formattedMessages — The conversation messages for the candidate segment
 * @param runsSinceCreation — How many engine runs since this candidate was created
 * @returns PipelineResult with decision + diagnostics
 */
export async function evaluateMaterializationReadiness(
  formattedMessages: string,
  runsSinceCreation: number,
): Promise<PipelineResult> {
  // Force materialization if candidate has waited too long
  if (runsSinceCreation >= MAX_LAYER_WAIT) {
    infoLog("[materialization-pipeline] Forced by MAX_LAYER_WAIT", { runsSinceCreation });
    return {
      shouldMaterialize: true,
      layer1: { state: "concluded", reason: `Forced after ${runsSinceCreation} runs (MAX_LAYER_WAIT=${MAX_LAYER_WAIT})` },
      layer2: { hasInsight: true, insightStatement: null, confidence: 0.5, reason: "Forced by max wait" },
      insightSeed: null,
      forcedByMaxWait: true,
    };
  }

  // Layer 1: Classify conversation state
  const layer1 = await classifyConversationState(formattedMessages);
  debugLog("[materialization-pipeline] Layer 1", layer1);

  if (layer1.state === "exploring") {
    return {
      shouldMaterialize: false,
      layer1,
      layer2: null,
      insightSeed: null,
      forcedByMaxWait: false,
    };
  }

  // Layer 2: Detect insight (only if developing or concluded)
  const layer2 = await detectInsight(formattedMessages);
  debugLog("[materialization-pipeline] Layer 2", layer2);

  if (!layer2.hasInsight) {
    return {
      shouldMaterialize: false,
      layer1,
      layer2,
      insightSeed: null,
      forcedByMaxWait: false,
    };
  }

  // Layer 3: Ready to materialize — pass insight as seed
  infoLog("[materialization-pipeline] Insight crystallized", {
    state: layer1.state,
    insight: layer2.insightStatement,
    confidence: layer2.confidence,
  });

  return {
    shouldMaterialize: true,
    layer1,
    layer2,
    insightSeed: layer2.insightStatement,
    forcedByMaxWait: false,
  };
}
