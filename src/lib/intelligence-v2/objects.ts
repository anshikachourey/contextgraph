/**
 * V2 Layer 3: Object Formation — Thread-Local Generation.
 *
 * Each thread is processed independently. Large threads are windowed.
 * The LLM returns minimal drafts; provenance is derived deterministically.
 * One thread failure does not zero the entire object layer.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonArrayFromLLM } from "./json-parse";
import type { Proposition, Thread, ConversationalObject, ObjectType, ObjectMaturity, ObjectStatus } from "./schemas";

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

/** Maximum propositions per LLM window to avoid oversized responses. */
const MAX_PROPS_PER_WINDOW = 40;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Form objects from propositions grouped by threads.
 * Each thread is processed independently. Never crashes on one thread failure.
 */
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

  // Process each thread independently
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

    // Window propositions by temporal order (source utterance position)
    const windows = buildPropositionWindows(threadProps, MAX_PROPS_PER_WINDOW);
    threadDiag.windowCount = windows.length;

    // Generate drafts for each window
    const allDrafts: ObjectDraft[] = [];
    let threadFailed = false;

    for (const window of windows) {
      const result = await generateDraftsForWindow(window, thread, threadDiag);
      if (result === null) {
        // Window failed — mark but continue with other windows
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

    // Validate drafts and build full objects
    for (const draft of allDrafts) {
      // Validate propositionIds
      const validPropIds = draft.propositionIds.filter((pid) => realPropIds.has(pid));

      if (validPropIds.length === 0) {
        threadDiag.rejectedObjectCount++;
        threadDiag.rejectionReasons.push(
          `"${draft.title.slice(0, 40)}": no valid propositionIds (raw: [${draft.propositionIds.join(", ")}])`,
        );
        continue;
      }

      // Reject thesis-like synthesis: title must not introduce unsupported claims
      if (isSynthesisTitle(draft.title, validPropIds, propMap)) {
        threadDiag.rejectedObjectCount++;
        threadDiag.rejectionReasons.push(
          `"${draft.title.slice(0, 40)}": unsupported synthesis — title introduces claims not in propositions`,
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

      const objectId = `obj-${globalObjectIndex}`;
      globalObjectIndex++;

      const objectType = normalizeObjectType(draft.objectType);

      allObjects.push({
        objectId,
        objectType,
        title: draft.title,
        description: draft.description,
        propositionIds: validPropIds,
        threadIds: [thread.threadId],
        supportingUtteranceIds,
        contextualAssistantUtteranceIds,
        maturity: deriveMaturiy(validPropIds.length),
        status: "active",
        provenanceSummary: `Derived from ${validPropIds.length} propositions in ${thread.threadId}`,
      });

      threadDiag.acceptedObjectCount++;
    }

    threadDiag.elapsedMs = Date.now() - threadStart;
    diag.threadDiagnostics.push(threadDiag);
  }

  // Compute unassigned propositions
  const assignedPropIds = new Set(allObjects.flatMap((o) => o.propositionIds));
  diag.unassignedPropositionCount = propositions.filter((p) => !assignedPropIds.has(p.propositionId)).length;

  diag.totalAcceptedObjects = allObjects.length;
  diag.totalRejectedDrafts = diag.threadDiagnostics.reduce((sum, t) => sum + t.rejectedObjectCount, 0);
  diag.returnPath = `RETURN_D: ${allObjects.length} objects from ${threads.length} threads. Failed threads: [${diag.failedThreads.join(", ")}]`;

  return { objects: allObjects, diagnostics: diag };
}

// ─── Window Builder ─────────────────────────────────────────────────────────

/**
 * Split propositions into bounded windows preserving temporal order.
 * Groups by source utterance first, then splits at MAX_PROPS_PER_WINDOW boundaries.
 */
function buildPropositionWindows(props: Proposition[], maxPerWindow: number): Proposition[][] {
  if (props.length <= maxPerWindow) return [props];

  // Sort by first source utterance ID to maintain temporal order
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

// ─── LLM Draft Generation ───────────────────────────────────────────────────

async function generateDraftsForWindow(
  props: Proposition[],
  thread: Thread,
  threadDiag: ThreadObjectDiagnostic,
): Promise<ObjectDraft[] | null> {
  const formatted = formatPropositionsForPrompt(props);
  const userContent = `Thread: "${thread.subject}"\n\nPropositions:\n${formatted}\n\nForm object drafts. Return JSON array only.`;

  // Attempt 1
  threadDiag.attempts++;
  const result1 = await callLLMForDrafts(userContent);
  threadDiag.rawResponseLength += result1.rawLength;

  if (result1.drafts !== null) {
    return result1.drafts;
  }

  // Attempt 2: retry with repair prompt
  threadDiag.attempts++;
  const result2 = await callLLMForDraftsRetry(userContent, result1.rawText);
  threadDiag.rawResponseLength += result2.rawLength;

  if (result2.drafts !== null) {
    return result2.drafts;
  }

  threadDiag.rejectionReasons.push(`parse failed after 2 attempts: ${result2.error}`);
  return null;
}

function formatPropositionsForPrompt(props: Proposition[]): string {
  return props.map((p) => {
    const author = p.authoredBy === "user" ? "USER" : "ASST";
    const prov = p.provenance;
    return `[${p.propositionId}] (${author}, ${prov}) "${p.normalizedContent}"`;
  }).join("\n");
}

interface DraftParseResult {
  drafts: ObjectDraft[] | null;
  rawText: string;
  rawLength: number;
  error: string | null;
}

async function callLLMForDrafts(userContent: string): Promise<DraftParseResult> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        { role: "system", content: DRAFT_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      maxTokens: 2000,
    });

    const rawText = result.content;
    const parsed = parseJsonArrayFromLLM(rawText);
    if (parsed.success) {
      const drafts = parseToDrafts(parsed.data);
      return { drafts, rawText, rawLength: rawText.length, error: null };
    }
    return { drafts: null, rawText, rawLength: rawText.length, error: parsed.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { drafts: null, rawText: "", rawLength: 0, error: msg };
  }
}

async function callLLMForDraftsRetry(userContent: string, failedResponse: string): Promise<DraftParseResult> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        { role: "system", content: DRAFT_RETRY_PROMPT },
        { role: "user", content: `Original request:\n${userContent}\n\nYour previous response was malformed JSON. Return ONLY a valid JSON array of object drafts. No markdown. No commentary.` },
      ],
      temperature: 0.1,
      maxTokens: 2000,
    });

    const rawText = result.content;
    const parsed = parseJsonArrayFromLLM(rawText);
    if (parsed.success) {
      const drafts = parseToDrafts(parsed.data);
      return { drafts, rawText, rawLength: rawText.length, error: null };
    }
    return { drafts: null, rawText, rawLength: rawText.length, error: parsed.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { drafts: null, rawText: "", rawLength: 0, error: msg };
  }
}

function parseToDrafts(raw: Array<Record<string, unknown>>): ObjectDraft[] {
  return raw
    .filter((d) => d.objectType && d.title)
    .map((d) => ({
      objectType: (d.objectType as string) ?? "unresolved",
      title: (d.title as string) ?? "",
      description: (d.description as string) ?? "",
      propositionIds: Array.isArray(d.propositionIds) ? (d.propositionIds as string[]) : [],
    }));
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

function deriveMaturiy(propCount: number): ObjectMaturity {
  if (propCount >= 5) return "stable";
  if (propCount >= 2) return "developing";
  return "nascent";
}

/**
 * Reject titles that introduce unsupported thesis-style claims.
 * A title is synthetic if it uses language not grounded in any of its propositions.
 */
function isSynthesisTitle(
  title: string,
  propIds: string[],
  propMap: Map<string, Proposition>,
): boolean {
  const titleLower = title.toLowerCase();

  // Synthesis markers — language that implies conclusions beyond evidence
  const synthesisPatterns = [
    "deep mutual alignment",
    "profound connection",
    "transformative journey",
    "fundamental truth",
    "core essence",
    "ultimate meaning",
    "deep-rooted",
    "deeply held",
    "reflected deep",
  ];

  for (const pattern of synthesisPatterns) {
    if (titleLower.includes(pattern)) {
      // Check if any proposition actually contains this language
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

const DRAFT_PROMPT = `Form conversational object drafts from the propositions below.

An object is a navigable conversational entity: an inquiry, insight, problem, task, decision, preference, explanation, plan, comparison, or unresolved concern.

RULES:
- Each object must reference specific proposition IDs from the input.
- One thread may produce multiple objects (different sub-topics or inquiries).
- A thread may produce zero objects if propositions are only noise or acknowledgements.
- Faithfully represent conversational function: questions stay questions, tasks stay tasks.
- Do NOT synthesize thesis-like conclusions, diagnoses, or motivational claims.
- Do NOT combine unrelated propositions into one object.
- Titles must name the specific conversational entity, not summarize an essay.

Object types: inquiry, insight, problem, task, project, goal, decision, preference, explanation, plan, comparison, unresolved, noise

Return ONLY a JSON array of drafts:
[{
  "objectType": "<type>",
  "title": "<faithful name for this conversational entity>",
  "description": "<1-2 sentences grounded in the propositions>",
  "propositionIds": ["prop-X", "prop-Y"]
}]`;

const DRAFT_RETRY_PROMPT = `Return a syntactically valid JSON array of conversational object drafts.
Your entire response must be valid JSON. No markdown fences. No commentary. No trailing text.

Each draft:
{
  "objectType": "<type>",
  "title": "<name>",
  "description": "<1-2 sentences>",
  "propositionIds": ["prop-X"]
}

Return ONLY the JSON array:`;
