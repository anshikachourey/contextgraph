/**
 * V2 Layer 3: Object Formation — Entity-Centric Generation.
 *
 * Each thread is processed independently.
 * Step 1: Identify the distinct conversational entities in the thread.
 * Step 2: Assign propositions to those entities.
 * This produces fewer, richer objects that each represent a navigable discussion unit.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonArrayFromLLM } from "./json-parse";
import type { Proposition, Thread, ConversationalObject, ObjectType, ObjectMaturity } from "./schemas";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ObjectDraft {
  objectType: string;
  title: string;
  description: string;
  propositionIds: string[];
}

export interface ThreadObjectDiagnostic {
  threadId: string;
  propositionCount: number;
  windowCount: number;
  attempts: number;
  rawResponseLength: number;
  parsedDraftCount: number;
  acceptedObjectCount: number;
  rejectedObjectCount: number;
  rejectionReasons: string[];
  elapsedMs: number;
}

export interface ObjectDiagnostics {
  inputPropositionCount: number;
  inputThreadCount: number;
  totalAcceptedObjects: number;
  totalRejectedDrafts: number;
  failedThreads: string[];
  unassignedPropositionCount: number;
  threadDiagnostics: ThreadObjectDiagnostic[];
  returnPath: string;
}

export interface ObjectResult {
  objects: ConversationalObject[];
  diagnostics: ObjectDiagnostics;
}

/**
 * Maximum propositions shown per LLM call.
 * With entity-first approach, we show all props but in a compact format.
 * For very large threads (>80 props), we split into windows.
 */
const MAX_PROPS_PER_WINDOW = 80;

// ─── Public API ─────────────────────────────────────────────────────────────

export async function formObjects(
  propositions: Proposition[],
  threads: Thread[],
): Promise<ObjectResult> {
  const diag: ObjectDiagnostics = {
    inputPropositionCount: propositions.length,
    inputThreadCount: threads.length,
    totalAcceptedObjects: 0,
    totalRejectedDrafts: 0,
    failedThreads: [],
    unassignedPropositionCount: 0,
    threadDiagnostics: [],
    returnPath: "",
  };

  if (threads.length === 0) {
    diag.returnPath = "RETURN_A: threads.length === 0";
    return { objects: [], diagnostics: diag };
  }

  const realPropIds = new Set(propositions.map((p) => p.propositionId));
  const propMap = new Map(propositions.map((p) => [p.propositionId, p]));
  const allObjects: ConversationalObject[] = [];
  let globalObjectIndex = 0;

  for (const thread of threads) {
    const threadStart = Date.now();
    const threadProps = propositions.filter((p) => thread.propositionIds.includes(p.propositionId));

    const threadDiag: ThreadObjectDiagnostic = {
      threadId: thread.threadId,
      propositionCount: threadProps.length,
      windowCount: 0,
      attempts: 0,
      rawResponseLength: 0,
      parsedDraftCount: 0,
      acceptedObjectCount: 0,
      rejectedObjectCount: 0,
      rejectionReasons: [],
      elapsedMs: 0,
    };

    if (threadProps.length === 0) {
      threadDiag.elapsedMs = Date.now() - threadStart;
      threadDiag.rejectionReasons.push("no propositions in thread");
      diag.threadDiagnostics.push(threadDiag);
      continue;
    }

    // For manageable threads, generate in one call. For large threads, window.
    const windows = buildPropositionWindows(threadProps, MAX_PROPS_PER_WINDOW);
    threadDiag.windowCount = windows.length;

    const allDrafts: ObjectDraft[] = [];
    let threadFailed = false;

    for (const window of windows) {
      const result = await generateEntitiesForWindow(window, thread, threadDiag);
      if (result === null) {
        threadFailed = true;
      } else {
        allDrafts.push(...result);
      }
    }

    if (allDrafts.length === 0 && threadFailed) {
      diag.failedThreads.push(thread.threadId);
      threadDiag.elapsedMs = Date.now() - threadStart;
      diag.threadDiagnostics.push(threadDiag);
      continue;
    }

    threadDiag.parsedDraftCount = allDrafts.length;

    // Validate and build full objects
    for (const draft of allDrafts) {
      const validPropIds = draft.propositionIds.filter((pid) => realPropIds.has(pid));

      if (validPropIds.length === 0) {
        threadDiag.rejectedObjectCount++;
        threadDiag.rejectionReasons.push(
          `"${draft.title.slice(0, 40)}": no valid propositionIds`,
        );
        continue;
      }

      if (isSynthesisTitle(draft.title, validPropIds, propMap)) {
        threadDiag.rejectedObjectCount++;
        threadDiag.rejectionReasons.push(
          `"${draft.title.slice(0, 40)}": unsupported synthesis`,
        );
        continue;
      }

      // Derive provenance deterministically
      const supportingProps = validPropIds
        .map((pid) => propMap.get(pid)!)
        .filter((p) => p.authoredBy === "user" && (p.provenance === "direct" || p.provenance === "paraphrase"));
      const supportingUtteranceIds = [...new Set(supportingProps.flatMap((p) => p.sourceUtteranceIds))];

      const contextProps = validPropIds
        .map((pid) => propMap.get(pid)!)
        .filter((p) => p.authoredBy === "assistant");
      const contextualAssistantUtteranceIds = [...new Set(contextProps.flatMap((p) => p.sourceUtteranceIds))];

      const objectId = `obj-${globalObjectIndex++}`;

      allObjects.push({
        objectId,
        objectType: normalizeObjectType(draft.objectType),
        title: draft.title,
        description: draft.description,
        propositionIds: validPropIds,
        threadIds: [thread.threadId],
        supportingUtteranceIds,
        contextualAssistantUtteranceIds,
        maturity: deriveMaturity(validPropIds.length),
        status: "active",
        provenanceSummary: `${validPropIds.length} propositions, ${supportingUtteranceIds.length} user utterances`,
      });

      threadDiag.acceptedObjectCount++;
    }

    threadDiag.elapsedMs = Date.now() - threadStart;
    diag.threadDiagnostics.push(threadDiag);
  }

  const assignedPropIds = new Set(allObjects.flatMap((o) => o.propositionIds));
  diag.unassignedPropositionCount = propositions.filter((p) => !assignedPropIds.has(p.propositionId)).length;
  diag.totalAcceptedObjects = allObjects.length;
  diag.totalRejectedDrafts = diag.threadDiagnostics.reduce((sum, t) => sum + t.rejectedObjectCount, 0);
  diag.returnPath = `RETURN_D: ${allObjects.length} objects from ${threads.length} threads. Failed: [${diag.failedThreads.join(", ")}]`;

  return { objects: allObjects, diagnostics: diag };
}

// ─── Window Builder ─────────────────────────────────────────────────────────

function buildPropositionWindows(props: Proposition[], maxPerWindow: number): Proposition[][] {
  if (props.length <= maxPerWindow) return [props];

  const sorted = [...props].sort((a, b) => {
    const aId = a.sourceUtteranceIds[0] ?? "";
    const bId = b.sourceUtteranceIds[0] ?? "";
    return aId.localeCompare(bId);
  });

  const windows: Proposition[][] = [];
  for (let i = 0; i < sorted.length; i += maxPerWindow) {
    windows.push(sorted.slice(i, i + maxPerWindow));
  }
  return windows;
}

// ─── Entity-Centric LLM Generation ─────────────────────────────────────────

async function generateEntitiesForWindow(
  props: Proposition[],
  thread: Thread,
  threadDiag: ThreadObjectDiagnostic,
): Promise<ObjectDraft[] | null> {
  // Format propositions showing temporal flow — numbered for arc visibility
  const formatted = props.map((p, idx) => {
    const author = p.authoredBy === "user" ? "U" : "A";
    return `${idx + 1}. [${p.propositionId}] ${author}: "${p.normalizedContent}"`;
  }).join("\n");

  const userContent = `Thread: "${thread.subject}"
${props.length} propositions in temporal order.

Read the entire sequence first. Then identify what conversational entities emerged and how they evolved.

Propositions:
${formatted}

Return JSON array of entities. Each entity should capture its full lifecycle.`;

  // Attempt 1
  threadDiag.attempts++;
  const result1 = await callLLM(ENTITY_PROMPT, userContent);
  threadDiag.rawResponseLength += result1.rawLength;

  if (result1.drafts !== null) return result1.drafts;

  // Attempt 2
  threadDiag.attempts++;
  const result2 = await callLLM(ENTITY_RETRY_PROMPT, userContent);
  threadDiag.rawResponseLength += result2.rawLength;

  if (result2.drafts !== null) return result2.drafts;

  threadDiag.rejectionReasons.push(`parse failed: ${result2.error}`);
  return null;
}

interface LLMResult {
  drafts: ObjectDraft[] | null;
  rawText: string;
  rawLength: number;
  error: string | null;
}

async function callLLM(systemPrompt: string, userContent: string): Promise<LLMResult> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      maxTokens: 2500,
    });

    const rawText = result.content;
    const parsed = parseJsonArrayFromLLM(rawText);
    if (parsed.success) {
      const drafts = parsed.data
        .filter((d) => d.objectType && d.title)
        .map((d) => ({
          objectType: (d.objectType as string) ?? "unresolved",
          title: (d.title as string) ?? "",
          description: (d.description as string) ?? "",
          propositionIds: Array.isArray(d.propositionIds) ? (d.propositionIds as string[]) : [],
        }));
      return { drafts, rawText, rawLength: rawText.length, error: null };
    }
    return { drafts: null, rawText, rawLength: rawText.length, error: parsed.error };
  } catch (e) {
    return { drafts: null, rawText: "", rawLength: 0, error: e instanceof Error ? e.message : "unknown" };
  }
}

// ─── Validation Helpers ─────────────────────────────────────────────────────

const VALID_OBJECT_TYPES: ObjectType[] = [
  "inquiry", "insight", "problem", "task", "project",
  "goal", "decision", "preference", "explanation",
  "plan", "comparison", "unresolved", "noise",
];

function normalizeObjectType(raw: string): ObjectType {
  if (VALID_OBJECT_TYPES.includes(raw as ObjectType)) return raw as ObjectType;
  return "unresolved";
}

function deriveMaturity(propCount: number): ObjectMaturity {
  if (propCount >= 8) return "stable";
  if (propCount >= 3) return "developing";
  return "nascent";
}

function isSynthesisTitle(
  title: string,
  propIds: string[],
  propMap: Map<string, Proposition>,
): boolean {
  const titleLower = title.toLowerCase();
  const synthesisPatterns = [
    "deep mutual alignment", "profound connection", "transformative journey",
    "fundamental truth", "core essence", "ultimate meaning",
    "deep-rooted", "deeply held", "reflected deep",
  ];

  for (const pattern of synthesisPatterns) {
    if (titleLower.includes(pattern)) {
      const anyPropHasIt = propIds.some((pid) => {
        const p = propMap.get(pid);
        return p && p.normalizedContent.toLowerCase().includes(pattern);
      });
      if (!anyPropHasIt) return true;
    }
  }
  return false;
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const ENTITY_PROMPT = `You are constructing a map of evolving conversational entities from a thread's propositions.

An entity is ONE coherent thing being discussed — a question being explored, a problem being worked through, an idea developing, a feeling being processed. It evolves as the conversation progresses.

YOUR PROCESS — you must follow this exactly:

Step 1: Read all propositions from start to finish.

Step 2: Walk through them SEQUENTIALLY. For each proposition, ask:
  "Does this CONTINUE, DEEPEN, CHALLENGE, or RESOLVE an entity I've already identified?"
  - If YES → attach it to that existing entity. The entity is evolving.
  - If NO → only then create a new entity.

Creating a new entity is the EXCEPTIONAL case. The default is that a proposition belongs to an existing entity that it develops further.

Step 3: For each entity, determine its type based on what it BECAME:
  - If it started as a question and got explored → inquiry (even if partially answered)
  - If it produced a realization → insight
  - If it identified and worked through a difficulty → problem
  - If it explored a feeling → unresolved or insight
  - If it explained something across exchanges → explanation
  - If options were weighed → comparison or decision

ATTACHMENT RULES — a proposition belongs to an EXISTING entity when it:
  - Directly responds to a question the entity raised
  - Provides evidence for or against a claim in the entity
  - Reframes, deepens, or nuances the entity's central concern
  - Expresses a feeling about the entity's subject
  - Restates or summarizes the entity from a new angle
  - Challenges or revises the entity's direction
  - Partially or fully resolves the entity

A proposition starts a NEW entity ONLY when it:
  - Introduces a genuinely unrelated subject
  - Asks a question that has no connection to any existing entity
  - Begins a separate task or request

CRITICAL:
  - "New turn" does NOT mean "new entity." Most turns continue an existing entity.
  - Assistant restatements, reframes, and probes belong to the entity they engage with.
  - A typical 80-120 proposition thread should produce 4-8 entities.
  - Each entity should span MANY propositions (typically 15-30) and MULTIPLE user utterances.
  - If you find yourself creating an entity with fewer than 5 propositions, reconsider whether it's actually part of a larger entity.

Object types: inquiry, insight, problem, task, project, goal, decision, preference, explanation, plan, comparison, unresolved, noise

Return ONLY a JSON array:
[{
  "objectType": "<type based on what the entity BECAME>",
  "title": "<what this evolving entity IS — name the central concern/question/process>",
  "description": "<how this entity evolved: started as X, deepened through Y, reached state Z>",
  "propositionIds": ["prop-X", "prop-Y", "prop-Z", ...]
}]`;

const ENTITY_RETRY_PROMPT = `Return a valid JSON array of evolving conversational entities.
No markdown. No commentary.
Each entity represents ONE evolving discussion that spans many propositions and multiple utterances.
Default: attach propositions to existing entities. Only create new entities for genuinely unrelated subjects.
Typical: 4-8 entities per thread, each with 15-30 propositions.

[{
  "objectType": "<type>",
  "title": "<central concern>",
  "description": "<how it evolved>",
  "propositionIds": ["prop-X", "prop-Y", ...]
}]`;
