/**
 * V2 Layer 2: Thread Formation.
 *
 * Groups utterances into subject-coherent threads using proposition context.
 * Temporal adjacency is weak evidence; subject coherence is required.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";
import type { Utterance, Proposition, Thread, ThreadStatus } from "./schemas";

export interface ThreadDiagnostics {
  rawCount: number;
  rejectedCount: number;
  rejectionReasons: string[];
}

export interface ThreadResult {
  threads: Thread[];
  diagnostics: ThreadDiagnostics;
}

/**
 * Form threads from utterances and their propositions.
 * Never silently fails — throws on LLM errors.
 */
export async function formThreads(
  utterances: Utterance[],
  propositions: Proposition[],
): Promise<ThreadResult> {
  const diag: ThreadDiagnostics = { rawCount: 0, rejectedCount: 0, rejectionReasons: [] };

  if (utterances.length === 0) return { threads: [], diagnostics: diag };

  // Build proposition-by-utterance lookup
  const propsByUtterance = new Map<string, Proposition[]>();
  for (const p of propositions) {
    for (const uid of p.sourceUtteranceIds) {
      const existing = propsByUtterance.get(uid) ?? [];
      existing.push(p);
      propsByUtterance.set(uid, existing);
    }
  }

  const activeUtterances = utterances.filter((u) => !u.tombstoned);
  const formatted = activeUtterances
    .map((u) => {
      const props = propsByUtterance.get(u.utteranceId) ?? [];
      const propList = props.length > 0 ? ` [${props.map((p) => p.propositionId).join(", ")}]` : "";
      return `[${u.temporalPosition}] ${u.author.toUpperCase()} (${u.utteranceId.slice(0, 8)}): ${u.rawContent.slice(0, 150)}${propList}`;
    })
    .join("\n");

  const result = await complete({
    model: NODE_MODEL,
    messages: [
      { role: "system", content: THREAD_PROMPT },
      { role: "user", content: `Utterances:\n${formatted}\n\nGroup ALL utterances into threads. Return JSON array only.` },
    ],
    temperature: 0.2,
    maxTokens: 2500,
  });

  const parsed = parseJsonFromLLM(result.content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Thread formation returned non-array: ${typeof parsed}`);
  }

  diag.rawCount = parsed.length;

  const threads: Thread[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i] as Record<string, unknown>;
    if (!t.subject || (typeof t.subject === "string" && t.subject.trim().length === 0)) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`thread-${i}: empty subject`);
      continue;
    }

    // Resolve utterance ID prefixes to full IDs
    const resolvedIds = Array.isArray(t.utteranceIds)
      ? (t.utteranceIds as string[]).map((prefix) => {
          const match = utterances.find((u) => u.utteranceId.startsWith(prefix));
          return match?.utteranceId ?? prefix;
        })
      : [];

    if (resolvedIds.length === 0) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`thread-${i}: no utterances`);
      continue;
    }

    // Collect proposition IDs deterministically from utterance membership
    const threadPropIds = resolvedIds.flatMap((uid) =>
      (propsByUtterance.get(uid) ?? []).map((p) => p.propositionId),
    );

    threads.push({
      threadId: `thread-${i}`,
      utteranceIds: resolvedIds,
      propositionIds: [...new Set(threadPropIds)],
      subject: (t.subject as string).trim(),
      branchId: null,
      originThreadId: typeof t.originThreadId === "string" ? t.originThreadId : null,
      divergenceUtteranceId: null,
      status: (t.status as ThreadStatus) ?? "active",
    });
  }

  return { threads, diagnostics: diag };
}

const THREAD_PROMPT = `Group conversation utterances into subject-coherent threads.

A thread is a contiguous sequence of messages about the same subject or communicative goal.
Topic shifts create new threads even when messages are consecutive.

RULES:
- Temporal adjacency alone does NOT make a thread — subject coherence is required.
- A shift in communicative goal (e.g., from exploring feelings to requesting a translation) starts a new thread.
- Return to a previous topic starts a new thread (set originThreadId to the earlier thread's ID).
- Short acknowledgements ("ok", "thanks") belong to the thread they respond to.
- Every utterance must appear in exactly one thread.
- Do not merge different subjects under a broad umbrella concept.
- Do not split a single coherent discussion across multiple threads without reason.

Thread status:
- "active": ongoing discussion
- "completed": question answered or task done
- "abandoned": topic dropped without resolution

Return JSON array:
[{
  "utteranceIds": ["<first 8 chars of utterance_id>", ...],
  "subject": "<specific subject — one phrase>",
  "status": "active" | "completed" | "abandoned",
  "originThreadId": "<thread ID if resuming a previous topic, else null>"
}]`;
