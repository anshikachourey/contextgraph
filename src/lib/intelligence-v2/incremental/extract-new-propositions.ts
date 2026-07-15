/**
 * Extract propositions from new utterances only.
 * Reuses the same extraction logic but processes only unprocessed messages.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonArrayFromLLM } from "../json-parse";
import type { Utterance, Proposition, PropositionType, PropositionProvenance, PropositionStatus } from "../schemas";

const VALID_TYPES: PropositionType[] = ["claim", "question", "preference", "intent", "decision", "emotional_state", "example", "request"];
const VALID_PROVENANCE: PropositionProvenance[] = ["direct", "paraphrase", "interpretation", "inference"];

/**
 * Extract propositions from new utterances.
 * Returns propositions with IDs starting from `startIndex`.
 */
export async function extractNewPropositions(
  newUtterances: Utterance[],
  allUtterances: Utterance[],
  startIndex: number,
): Promise<{ propositions: Proposition[]; llmCalls: number }> {
  if (newUtterances.length === 0) return { propositions: [], llmCalls: 0 };

  const formatted = newUtterances.map((u) =>
    `[${u.utteranceId.slice(0, 8)}] ${u.author.toUpperCase()}: ${u.rawContent}`,
  ).join("\n\n");

  const result = await complete({
    model: NODE_MODEL,
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: `Utterances:\n${formatted}\n\nExtract ALL propositions. Return JSON array only.` },
    ],
    temperature: 0.2,
    maxTokens: 2000,
  });

  const parsed = parseJsonArrayFromLLM(result.content);
  if (!parsed.success) return { propositions: [], llmCalls: 1 };

  const propositions: Proposition[] = parsed.data
    .filter((p) => p.normalizedContent && p.propositionType)
    .map((p, i) => {
      const sourceIds = Array.isArray(p.sourceUtteranceIds)
        ? (p.sourceUtteranceIds as string[]).map((prefix) => {
            const match = allUtterances.find((u) => u.utteranceId.startsWith(prefix as string));
            return match?.utteranceId ?? (prefix as string);
          })
        : [];

      const rawType = (p.propositionType as string) ?? "claim";
      const propositionType = VALID_TYPES.includes(rawType as PropositionType) ? (rawType as PropositionType) : "claim";
      const rawProv = (p.provenance as string) ?? "direct";
      const provenance = VALID_PROVENANCE.includes(rawProv as PropositionProvenance) ? (rawProv as PropositionProvenance) : "direct";

      return {
        propositionId: `prop-${startIndex + i}`,
        propositionType,
        normalizedContent: (p.normalizedContent as string) ?? "",
        sourceUtteranceIds: sourceIds,
        authoredBy: (p.authoredBy === "assistant" ? "assistant" : "user") as "user" | "assistant",
        provenance,
        confirmedByUser: false,
        confidence: typeof p.confidence === "number" ? Math.min(1, Math.max(0, p.confidence)) : 0.7,
        status: "active" as PropositionStatus,
        supersedesPropositionId: null,
      };
    });

  return { propositions, llmCalls: 1 };
}

const EXTRACT_PROMPT = `Extract atomic propositions from conversation utterances.
Types: claim, question, preference, intent, decision, emotional_state, example, request
Return JSON array only:
[{"propositionType":"<type>","normalizedContent":"<statement>","sourceUtteranceIds":["<first 8 chars>"],"authoredBy":"user"|"assistant","provenance":"direct"|"paraphrase"|"interpretation"|"inference","confidence":<0-1>}]`;
