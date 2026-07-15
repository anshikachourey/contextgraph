/**
 * Decide the primary object action for new propositions.
 * This is the critical semantic decision: extend vs create.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";
import type { Proposition, ConversationalObject } from "../schemas";
import type { ObjectDecision, RetrievedContext } from "./schemas";

/**
 * Decide what to do with new propositions relative to existing objects.
 */
export async function decideObjectAction(
  newPropositions: Proposition[],
  context: RetrievedContext,
): Promise<{ decision: ObjectDecision; llmCalls: number }> {
  // Format new propositions
  const newPropsFormatted = newPropositions.map((p) =>
    `[${p.propositionId}] (${p.authoredBy}, ${p.provenance}) "${p.normalizedContent}"`,
  ).join("\n");

  // Format retrieved objects compactly
  const allContextObjects = getUniqueObjects(context);
  const objectsFormatted = allContextObjects.map((o) =>
    `[${o.objectId}] ${o.objectType} (${o.status}): "${o.title}" — ${o.description} [${o.propositionIds.length} props]`,
  ).join("\n");

  const userContent = `NEW PROPOSITIONS:
${newPropsFormatted}

EXISTING OBJECTS IN CONTEXT:
${objectsFormatted || "(no existing objects)"}

Decide: does the new content belong to an existing object, or is it a genuinely new entity?`;

  const result = await complete({
    model: NODE_MODEL,
    messages: [
      { role: "system", content: DECISION_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.1,
    maxTokens: 1000,
  });

  try {
    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown>;
    const decision: ObjectDecision = {
      action: normalizeAction(parsed.action as string),
      targetObjectId: (parsed.targetObjectId as string) ?? null,
      newObjectDraft: parsed.newObjectDraft
        ? {
            objectType: ((parsed.newObjectDraft as Record<string, unknown>).objectType as string) ?? "unresolved",
            title: ((parsed.newObjectDraft as Record<string, unknown>).title as string) ?? "",
            description: ((parsed.newObjectDraft as Record<string, unknown>).description as string) ?? "",
          }
        : null,
      supportingNewPropositionIds: Array.isArray(parsed.supportingNewPropositionIds)
        ? (parsed.supportingNewPropositionIds as string[])
        : newPropositions.map((p) => p.propositionId),
      relevantExistingPropositionIds: Array.isArray(parsed.relevantExistingPropositionIds)
        ? (parsed.relevantExistingPropositionIds as string[])
        : [],
      lifecycleTransition: (parsed.lifecycleTransition as string) ?? null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      explanation: (parsed.explanation as string) ?? "",
    };

    return { decision, llmCalls: 1 };
  } catch {
    // Fallback: if parse fails, default to extend most relevant object or create
    const fallback: ObjectDecision = {
      action: allContextObjects.length > 0 ? "extend_object" : "create_object",
      targetObjectId: allContextObjects[0]?.objectId ?? null,
      newObjectDraft: allContextObjects.length === 0 ? { objectType: "unresolved", title: newPropositions[0]?.normalizedContent.slice(0, 50) ?? "New entity", description: "" } : null,
      supportingNewPropositionIds: newPropositions.map((p) => p.propositionId),
      relevantExistingPropositionIds: [],
      lifecycleTransition: null,
      confidence: 0.3,
      explanation: "Fallback decision — LLM parse failed",
    };
    return { decision: fallback, llmCalls: 1 };
  }
}

function getUniqueObjects(context: RetrievedContext): ConversationalObject[] {
  const seen = new Set<string>();
  const result: ConversationalObject[] = [];
  for (const o of [...context.recentObjects, ...context.semanticNeighbors.map((s) => s.object), ...context.unresolvedInquiries]) {
    if (!seen.has(o.objectId)) {
      seen.add(o.objectId);
      result.push(o);
    }
  }
  return result;
}

function normalizeAction(raw: string): ObjectDecision["action"] {
  const valid: ObjectDecision["action"][] = ["extend_object", "revise_object", "resolve_object", "reopen_object", "contradict_object", "add_evidence", "create_object", "defer", "discard"];
  return valid.includes(raw as ObjectDecision["action"]) ? (raw as ObjectDecision["action"]) : "defer";
}

const DECISION_PROMPT = `You are deciding how new propositions relate to existing conversational objects.

For each group of new propositions, make exactly ONE decision:

ACTIONS:
- extend_object: Same entity is developing. The new content continues/deepens it.
- revise_object: The user's understanding materially changed.
- resolve_object: An inquiry/task/problem reached a supported resolution.
- reopen_object: A previously resolved object became active again.
- contradict_object: New content conflicts with existing object state.
- add_evidence: New material supports the object without changing it.
- create_object: A genuinely new entity that doesn't belong inside any existing object.
- defer: Insufficient evidence to decide.
- discard: No durable graph value.

DECISION TESTS:
1. Identity test: Is this still about the same central question/entity?
2. Substitutability test: Would separating it make either incomplete?
3. Navigation test: Would a user want to find this separately?
4. Lifecycle test: Is this a state change within the entity, not a new entity?

DEFAULT TO EXTENDING when the new content continues the same inquiry, problem, or discussion.
CREATE ONLY when genuinely unrelated subject matter appears.

Return JSON object:
{
  "action": "<action>",
  "targetObjectId": "<existing object ID if extending/revising/resolving, null if creating>",
  "newObjectDraft": {"objectType":"<type>","title":"<title>","description":"<desc>"} or null,
  "supportingNewPropositionIds": ["<new prop IDs>"],
  "relevantExistingPropositionIds": ["<existing prop IDs that connect to new content>"],
  "lifecycleTransition": "<e.g. developing→stable, or null>",
  "confidence": <0-1>,
  "explanation": "<why this action, citing identity/substitutability/navigation/lifecycle tests>"
}`;
