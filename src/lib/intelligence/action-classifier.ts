/**
 * Segment Action Classifier.
 *
 * For every frozen segment, classifies what should happen to it.
 * Includes a hard compatibility gate that prevents false cross-topic attachment.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";

export type SegmentAction =
  | "extend_existing_node"
  | "extend_existing_candidate"
  | "create_new_candidate"
  | "attach_as_supporting_evidence"
  | "defer_decision"
  | "discard";

export interface ActionClassification {
  action: SegmentAction;
  targetId: string | null;
  reasoning: string;
}

export interface GraphContext {
  nodes: Array<{ id: string; title: string; summary: string }>;
  candidates: Array<{ id: string; segmentCount: number; messageCount: number; thesis?: string }>;
}

/**
 * Classify what should happen to a frozen segment.
 * Returns action + target. If action is extend/evidence, the caller
 * must still pass the compatibility gate before executing.
 */
export async function classifySegmentAction(
  segmentText: string,
  graphContext: GraphContext,
): Promise<ActionClassification> {
  const nodesFormatted = graphContext.nodes.length > 0
    ? graphContext.nodes.map((n) => `• [${n.id.slice(0, 8)}] "${n.title}" — ${n.summary}`).join("\n")
    : "(no existing nodes)";

  const candidatesFormatted = graphContext.candidates.length > 0
    ? graphContext.candidates.map((c) => `• [${c.id.slice(0, 8)}] ${c.segmentCount} segments, ${c.messageCount} messages${c.thesis ? ` — thesis: "${c.thesis}"` : ""}`).join("\n")
    : "(no active candidates)";

  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        {
          role: "system",
          content: `You decide what should happen to a segment of conversation in a knowledge graph.

EXISTING NODES:
${nodesFormatted}

ACTIVE CANDIDATES (emerging ideas not yet materialized):
${candidatesFormatted}

Choose ONE action:
- "extend_existing_node": this segment DIRECTLY develops the same specific idea as an existing node. Not merely related — the same core proposition.
- "extend_existing_candidate": this DIRECTLY develops the same emerging idea as a candidate. Same proposition, not merely adjacent in time.
- "create_new_candidate": introduces a genuinely new idea that cannot belong to any existing node or candidate.
- "attach_as_supporting_evidence": is a concrete example, anecdote, or evidence that DIRECTLY supports a specific existing idea.
- "defer_decision": insufficient information to determine.
- "discard": small talk, requests (translations, lookups), conversational glue, jokes, or content with no durable ideational value.

CRITICAL RULES:
- Temporal adjacency is NOT evidence of semantic relationship.
- Being in the same conversation is NOT evidence of shared meaning.
- Translation requests, utility requests, and task-oriented messages are almost always "discard."
- Do NOT infer psychological connections the user did not explicitly make.
- If unsure whether content belongs to an existing target, prefer "create_new_candidate" or "discard" over false extension.

Return JSON:
{
  "action": "<one of the six actions>",
  "targetId": "<first 8 chars of target node/candidate id, or null>",
  "reasoning": "<one sentence explaining WHY this content belongs to that target, citing specific shared content>"
}`,
        },
        {
          role: "user",
          content: `SEGMENT:\n${segmentText.slice(0, 3000)}\n\nWhat should happen to this segment? Return JSON only.`,
        },
      ],
      temperature: 0.2,
      maxTokens: 150,
    });

    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown> | null;
    if (parsed && typeof parsed.action === "string") {
      const validActions: SegmentAction[] = [
        "extend_existing_node", "extend_existing_candidate", "create_new_candidate",
        "attach_as_supporting_evidence", "defer_decision", "discard",
      ];
      const action = validActions.includes(parsed.action as SegmentAction)
        ? (parsed.action as SegmentAction)
        : "create_new_candidate";

      let targetId: string | null = null;
      if (typeof parsed.targetId === "string" && parsed.targetId.length >= 6) {
        const prefix = parsed.targetId;
        const matchNode = graphContext.nodes.find((n) => n.id.startsWith(prefix));
        const matchCand = graphContext.candidates.find((c) => c.id.startsWith(prefix));
        targetId = matchNode?.id ?? matchCand?.id ?? null;
      }

      return { action, targetId, reasoning: (parsed.reasoning as string) ?? "" };
    }

    return { action: "defer_decision", targetId: null, reasoning: "Parse failed — deferring" };
  } catch {
    return { action: "defer_decision", targetId: null, reasoning: "API error — deferring" };
  }
}

// ─── Compatibility Gate ─────────────────────────────────────────────────────

export interface CompatibilityResult {
  compatible: boolean;
  sharedIdea: string | null;
  confidence: number;
  reason: string;
}

/**
 * Hard evidence gate: verifies a segment actually shares a concrete proposition
 * with the target before allowing extension.
 *
 * Rules:
 * - Temporal adjacency is not evidence.
 * - Shared emotional tone is not enough.
 * - Must identify a specific proposition present in BOTH texts.
 */
export async function checkTargetCompatibility(
  segmentText: string,
  targetDescription: string,
): Promise<CompatibilityResult> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        {
          role: "system",
          content: `You verify whether a conversation segment shares a concrete, specific idea with a target knowledge node or candidate.

TARGET IDEA:
${targetDescription}

RULES:
- Temporal adjacency is NOT evidence of shared meaning.
- Being in the same conversation is NOT evidence.
- Shared emotional tone alone is NOT enough.
- You must identify a SPECIFIC PROPOSITION that is present in BOTH the target and the segment.
- If you cannot quote or paraphrase content from the segment that directly addresses the target's core idea, return compatible: false.

Return JSON:
{
  "compatible": true | false,
  "sharedIdea": "<the specific shared proposition, or null if none>",
  "confidence": <0.0 to 1.0>,
  "reason": "<why compatible or not — cite specific content>"
}`,
        },
        {
          role: "user",
          content: `SEGMENT:\n${segmentText.slice(0, 2000)}\n\nDoes this segment share a concrete idea with the target? Return JSON only.`,
        },
      ],
      temperature: 0.2,
      maxTokens: 150,
    });

    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown> | null;
    if (parsed && typeof parsed.compatible === "boolean") {
      return {
        compatible: parsed.compatible,
        sharedIdea: typeof parsed.sharedIdea === "string" ? parsed.sharedIdea : null,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        reason: (parsed.reason as string) ?? "",
      };
    }
    // Default: incompatible (fail-safe against hallucination)
    return { compatible: false, sharedIdea: null, confidence: 0, reason: "Parse failed — assuming incompatible" };
  } catch {
    return { compatible: false, sharedIdea: null, confidence: 0, reason: "API error — assuming incompatible" };
  }
}
