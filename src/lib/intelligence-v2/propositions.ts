/**
 * V2 Layer 1: Proposition Extraction.
 *
 * Extracts atomic claims, questions, preferences, and intents
 * from utterances with explicit provenance.
 * Batches long conversations. Assigns deterministic IDs after LLM parsing.
 *
 * Resilient: one malformed batch does not crash the pipeline.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonArrayFromLLM } from "./json-parse";
import { validateProposition } from "./policies/proposition-policy";
import type { Utterance, Proposition, PropositionType, PropositionProvenance, PropositionStatus } from "./schemas";

const VALID_TYPES: PropositionType[] = [
  "claim", "question", "preference", "intent",
  "decision", "emotional_state", "example", "request",
];

const VALID_PROVENANCE: PropositionProvenance[] = ["direct", "paraphrase", "interpretation", "inference"];

/**
 * Conservative batch size.
 * Each utterance can produce 3-8 propositions (~100-200 tokens each in output).
 * With 3000 input chars we get ~4-6 utterances per batch → ~20-40 propositions → ~2000-3000 output tokens.
 * This stays well within maxTokens=4000.
 */
const MAX_BATCH_CHARS = 3000;

export interface BatchDiagnostic {
  batchIndex: number;
  utteranceIds: string[];
  inputCharCount: number;
  attempts: number;
  rawResponseLength: number;
  parseSucceeded: boolean;
  acceptedCount: number;
  rejectedCount: number;
  error: string | null;
  rawResponseOnFailure: string | null;
  elapsedMs: number;
}

export interface PropositionDiagnostics {
  batchCount: number;
  rawCount: number;
  rejectedCount: number;
  rejectionReasons: string[];
  batchDiagnostics: BatchDiagnostic[];
}

export interface PropositionResult {
  propositions: Proposition[];
  diagnostics: PropositionDiagnostics;
}

/**
 * Extract propositions from utterances. Batches when needed.
 * Returns structured result with diagnostics — never silently fails.
 * One malformed batch does not crash the pipeline.
 */
export async function extractPropositions(utterances: Utterance[]): Promise<PropositionResult> {
  const diag: PropositionDiagnostics = {
    batchCount: 0,
    rawCount: 0,
    rejectedCount: 0,
    rejectionReasons: [],
    batchDiagnostics: [],
  };

  if (utterances.length === 0) return { propositions: [], diagnostics: diag };

  const activeUtterances = utterances.filter((u) => !u.tombstoned);
  if (activeUtterances.length === 0) return { propositions: [], diagnostics: diag };

  const batches = buildBatches(activeUtterances, MAX_BATCH_CHARS);
  diag.batchCount = batches.length;

  const allRaw: Proposition[] = [];
  let globalIndex = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchStart = Date.now();
    const batchUtteranceIds = batch.map((u) => u.utteranceId);
    const inputCharCount = batch.map(formatUtterance).join("\n\n").length;

    const batchDiag: BatchDiagnostic = {
      batchIndex: batchIdx,
      utteranceIds: batchUtteranceIds,
      inputCharCount,
      attempts: 0,
      rawResponseLength: 0,
      parseSucceeded: false,
      acceptedCount: 0,
      rejectedCount: 0,
      error: null,
      rawResponseOnFailure: null,
      elapsedMs: 0,
    };

    const batchResult = await extractBatchWithRetry(batch, activeUtterances, batchIdx, batchDiag);

    batchDiag.elapsedMs = Date.now() - batchStart;

    if (batchResult !== null) {
      batchDiag.parseSucceeded = true;
      batchDiag.acceptedCount = batchResult.length;

      // Assign canonical IDs only after successful parse
      for (let i = 0; i < batchResult.length; i++) {
        batchResult[i].propositionId = `prop-${globalIndex + i}`;
      }

      globalIndex += batchResult.length;
      diag.rawCount += batchResult.length;
      allRaw.push(...batchResult);
    } else {
      // Batch failed after retries — record but continue
      diag.rejectedCount++;
      diag.rejectionReasons.push(`batch-${batchIdx}: parse failed after retries — ${batchDiag.error}`);
    }

    diag.batchDiagnostics.push(batchDiag);
  }

  // Policy validation
  const validated: Proposition[] = [];
  for (const prop of allRaw) {
    const violations = validateProposition(prop);
    if (violations.length === 0) {
      validated.push(prop);
    } else {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`${prop.propositionId}: ${violations[0]}`);
    }
  }

  return { propositions: validated, diagnostics: diag };
}

/**
 * Attempt extraction with one retry on parse failure.
 * Returns parsed propositions (without final IDs) or null if both attempts fail.
 */
async function extractBatchWithRetry(
  batch: Utterance[],
  allUtterances: Utterance[],
  batchIdx: number,
  batchDiag: BatchDiagnostic,
): Promise<Omit<Proposition, "propositionId">[] & { propositionId: string }[] | null> {
  const formatted = batch.map(formatUtterance).join("\n\n");

  // Attempt 1: normal extraction
  batchDiag.attempts = 1;
  const firstResult = await callLLMForPropositions(formatted, batchIdx);
  batchDiag.rawResponseLength = firstResult.rawLength;

  if (firstResult.parsed !== null) {
    const props = mapParsedToPropositions(firstResult.parsed, allUtterances);
    return props as Proposition[];
  }

  // First attempt failed — record raw response and retry
  batchDiag.rawResponseOnFailure = firstResult.rawText.slice(0, 2000);
  batchDiag.error = firstResult.error;

  // Attempt 2: retry with repair-oriented prompt
  batchDiag.attempts = 2;
  const retryResult = await callLLMForPropositionsRetry(formatted, batchIdx);
  batchDiag.rawResponseLength = retryResult.rawLength;

  if (retryResult.parsed !== null) {
    batchDiag.error = `first attempt failed (${firstResult.error}), retry succeeded`;
    const props = mapParsedToPropositions(retryResult.parsed, allUtterances);
    return props as Proposition[];
  }

  // Both attempts failed
  batchDiag.error = `both attempts failed — first: ${firstResult.error}, retry: ${retryResult.error}`;
  if (retryResult.rawText) {
    batchDiag.rawResponseOnFailure = retryResult.rawText.slice(0, 2000);
  }
  return null;
}

interface LLMParseResult {
  parsed: Array<Record<string, unknown>> | null;
  rawText: string;
  rawLength: number;
  error: string | null;
}

async function callLLMForPropositions(formatted: string, batchIdx: number): Promise<LLMParseResult> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: `Utterances:\n${formatted}\n\nExtract ALL propositions from EVERY utterance above. Return JSON array only.` },
      ],
      temperature: 0.2,
      maxTokens: 4000,
    });

    const rawText = result.content;
    const rawLength = rawText.length;

    const parseResult = parseJsonArrayFromLLM(rawText);
    if (parseResult.success) {
      return { parsed: parseResult.data, rawText, rawLength, error: null };
    }
    return { parsed: null, rawText, rawLength, error: parseResult.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { parsed: null, rawText: "", rawLength: 0, error: `LLM call failed: ${msg}` };
  }
}

async function callLLMForPropositionsRetry(formatted: string, batchIdx: number): Promise<LLMParseResult> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        { role: "system", content: RETRY_PROMPT },
        { role: "user", content: `Utterances:\n${formatted}\n\nExtract propositions. Return a COMPLETE, valid JSON array. Do not truncate.` },
      ],
      temperature: 0.1,
      maxTokens: 4000,
    });

    const rawText = result.content;
    const rawLength = rawText.length;

    const parseResult = parseJsonArrayFromLLM(rawText);
    if (parseResult.success) {
      return { parsed: parseResult.data, rawText, rawLength, error: null };
    }
    return { parsed: null, rawText, rawLength, error: parseResult.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { parsed: null, rawText: "", rawLength: 0, error: `LLM retry call failed: ${msg}` };
  }
}

function mapParsedToPropositions(
  parsed: Array<Record<string, unknown>>,
  allUtterances: Utterance[],
): Proposition[] {
  return parsed
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

      const rawProvenance = (p.provenance as string) ?? "direct";
      const provenance = VALID_PROVENANCE.includes(rawProvenance as PropositionProvenance) ? (rawProvenance as PropositionProvenance) : "direct";

      const authoredBy = (p.authoredBy === "assistant" ? "assistant" : "user") as "user" | "assistant";

      return {
        propositionId: `prop-pending-${i}`, // Placeholder — canonical ID assigned after batch succeeds
        propositionType,
        normalizedContent: (p.normalizedContent as string) ?? "",
        sourceUtteranceIds: sourceIds,
        authoredBy,
        provenance,
        confirmedByUser: p.confirmedByUser === true,
        confidence: typeof p.confidence === "number" ? Math.min(1, Math.max(0, p.confidence)) : 0.7,
        status: "active" as PropositionStatus,
        supersedesPropositionId: null,
      };
    });
}

function buildBatches(utterances: Utterance[], maxChars: number): Utterance[][] {
  const batches: Utterance[][] = [];
  let current: Utterance[] = [];
  let currentChars = 0;

  for (const u of utterances) {
    const lineLen = formatUtterance(u).length + 2;
    if (currentChars + lineLen > maxChars && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(u);
    currentChars += lineLen;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function formatUtterance(u: Utterance): string {
  return `[${u.utteranceId.slice(0, 8)}] ${u.author.toUpperCase()}: ${u.rawContent}`;
}

const EXTRACTION_PROMPT = `Extract atomic propositions from conversation utterances.

A proposition is the smallest meaningful claim, question, preference, or intent.
One utterance may contain multiple propositions. Extract ALL of them — do not stop early.

Types: claim, question, preference, intent, decision, emotional_state, example, request

PROVENANCE RULES:
- "direct": the attributed party stated this explicitly
- "paraphrase": the attributed party said something equivalent, rephrased for clarity
- "interpretation": one party's reading of the other's meaning (NOT confirmed)
- "inference": derived from context but not directly stated

CRITICAL RULES:
- Assistant interpretations about user emotions, motives, beliefs, or patterns are NOT user propositions.
  Mark them authored_by: "assistant", provenance: "interpretation".
- Only what the USER actually said/asked qualifies as authored_by: "user", provenance: "direct".
- Preserve uncertainty, negation, question form, and conditionality.
- Do not convert questions into claims.
- Do not strip hedging or qualification.

Return a JSON array only — no markdown fences, no commentary:
[{
  "propositionType": "<type>",
  "normalizedContent": "<concise faithful statement>",
  "sourceUtteranceIds": ["<first 8 chars of utterance_id>"],
  "authoredBy": "user" | "assistant",
  "provenance": "direct" | "paraphrase" | "interpretation" | "inference",
  "confirmedByUser": false,
  "confidence": <0.0-1.0>
}]`;

const RETRY_PROMPT = `You are a JSON repair assistant.
Given conversation utterances, extract atomic propositions and return them as a COMPLETE valid JSON array.

CRITICAL: Your response must be a syntactically valid JSON array. Do not truncate. If you cannot fit all propositions, return fewer but ensure the JSON is complete and valid.

Types: claim, question, preference, intent, decision, emotional_state, example, request

Return ONLY a valid JSON array — no markdown, no commentary, no trailing text:
[{
  "propositionType": "<type>",
  "normalizedContent": "<concise faithful statement>",
  "sourceUtteranceIds": ["<first 8 chars of utterance_id>"],
  "authoredBy": "user" | "assistant",
  "provenance": "direct" | "paraphrase" | "interpretation" | "inference",
  "confirmedByUser": false,
  "confidence": <0.0-1.0>
}]`;
