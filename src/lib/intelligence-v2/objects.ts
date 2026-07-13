/**
 * V2 Layer 3: Object Formation.
 *
 * Forms navigable graph objects from propositions and threads.
 * Objects are the primary graph units — questions, insights, decisions, etc.
 * Every object must trace to specific propositions that justify its existence.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";
import type { Proposition, Thread, ConversationalObject, ObjectType, ObjectMaturity, ObjectStatus } from "./schemas";

export interface ObjectDiagnostics {
  rawCount: number;
  rejectedCount: number;
  rejectionReasons: string[];
}

export interface ObjectResult {
  objects: ConversationalObject[];
  diagnostics: ObjectDiagnostics;
}

/**
 * Form objects from propositions grouped by threads.
 * Never silently fails — throws on LLM errors.
 */
export async function formObjects(
  propositions: Proposition[],
  threads: Thread[],
): Promise<ObjectResult> {
  const diag: ObjectDiagnostics = { rawCount: 0, rejectedCount: 0, rejectionReasons: [] };

  if (threads.length === 0) return { objects: [], diagnostics: diag };

  const realPropIds = new Set(propositions.map((p) => p.propositionId));

  // Build prompt showing threads with their real proposition IDs and content
  const threadDescriptions = threads.map((t) => {
    const threadProps = propositions.filter((p) => t.propositionIds.includes(p.propositionId));
    const userDirect = threadProps.filter((p) => p.authoredBy === "user" && (p.provenance === "direct" || p.provenance === "paraphrase"));
    const assistantCtx = threadProps.filter((p) => p.authoredBy === "assistant");

    return `Thread [${t.threadId}]: "${t.subject}"
  User propositions: ${userDirect.map((p) => `[${p.propositionId}] "${p.normalizedContent}"`).join("; ") || "(none)"}
  Assistant context: ${assistantCtx.map((p) => `[${p.propositionId}] "${p.normalizedContent}"`).join("; ") || "(none)"}`;
  }).join("\n\n");

  const result = await complete({
    model: NODE_MODEL,
    messages: [
      { role: "system", content: OBJECT_PROMPT },
      { role: "user", content: `Threads and propositions:\n${threadDescriptions}\n\nForm objects. Return JSON array only.` },
    ],
    temperature: 0.2,
    maxTokens: 3000,
  });

  const parsed = parseJsonFromLLM(result.content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Object formation returned non-array: ${typeof parsed}`);
  }

  diag.rawCount = parsed.length;
  const realThreadIds = new Set(threads.map((t) => t.threadId));
  const objects: ConversationalObject[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i] as Record<string, unknown>;
    if (!o.objectType || !o.title) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`obj-${i}: missing type or title`);
      continue;
    }

    const objectId = `obj-${i}`;

    // Validate thread IDs
    const rawThreadIds = Array.isArray(o.threadIds) ? (o.threadIds as string[]) : [];
    const tIds = rawThreadIds.filter((tid) => realThreadIds.has(tid));

    // Validate proposition IDs — only keep real ones
    const rawPropIds = Array.isArray(o.propositionIds) ? (o.propositionIds as string[]) : [];
    const propIds = rawPropIds.filter((pid) => realPropIds.has(pid));

    // If no valid propositions were returned, reject the object
    if (propIds.length === 0) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`${objectId} "${(o.title as string).slice(0, 40)}": no valid propositionIds`);
      continue;
    }

    // Derive supporting utterances from the specific propositions assigned to this object
    const supportingProps = propositions.filter(
      (p) => propIds.includes(p.propositionId) && p.authoredBy === "user" &&
        (p.provenance === "direct" || p.provenance === "paraphrase"),
    );
    const supportingUtteranceIds = [...new Set(supportingProps.flatMap((p) => p.sourceUtteranceIds))];

    const contextProps = propositions.filter(
      (p) => propIds.includes(p.propositionId) && p.authoredBy === "assistant",
    );
    const contextualAssistantUtteranceIds = [...new Set(contextProps.flatMap((p) => p.sourceUtteranceIds))];

    objects.push({
      objectId,
      objectType: (o.objectType as ObjectType) ?? "unresolved",
      title: (o.title as string) ?? "",
      description: (o.description as string) ?? "",
      propositionIds: propIds,
      threadIds: tIds,
      supportingUtteranceIds,
      contextualAssistantUtteranceIds,
      maturity: (o.maturity as ObjectMaturity) ?? "nascent",
      status: (o.status as ObjectStatus) ?? "active",
      provenanceSummary: (o.provenanceSummary as string) ?? "",
    });
  }

  return { objects, diagnostics: diag };
}

const OBJECT_PROMPT = `Form conversational objects from threads and their propositions.

Each object is a coherent navigable entity: an inquiry, insight, problem, task, decision, etc.

TITLE RULES:
- Faithfully represent what the conversation contains
- Questions remain as questions (e.g., "Was this decision selfish?")
- Do NOT synthesize poetic or thesis-like titles
- Do NOT combine unrelated threads into one object
- Do NOT compress a multi-step journey into one conclusion

PROVENANCE RULES — CRITICAL:
- propositionIds MUST contain exact IDs from the input (e.g., prop-0, prop-1, prop-5)
- Only include propositions that directly support this specific object
- Do NOT include every proposition from a thread — only those relevant to this object
- Every object MUST have at least one valid propositionId
- threadIds MUST use exact thread IDs from the input

Object types: inquiry, insight, problem, task, project, goal, decision, preference, explanation, plan, comparison, unresolved, noise

Return JSON array:
[{
  "objectType": "<type>",
  "title": "<faithful representation>",
  "description": "<1-2 sentences>",
  "propositionIds": ["prop-0", "prop-3"],
  "threadIds": ["thread-0"],
  "maturity": "nascent" | "developing" | "stable",
  "status": "active" | "resolved" | "deferred" | "discarded",
  "provenanceSummary": "<which propositions support this>"
}]`;
