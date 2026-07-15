/**
 * V2 Layer 4: Bounded Relationship Classification.
 *
 * Candidate pairs are identified via embedding similarity + structural heuristics.
 * Pairs are classified in small batches to avoid oversized LLM responses.
 * One batch failure does not crash the pipeline.
 */

import { complete, embed } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonArrayFromLLM } from "./json-parse";
import type {
  ConversationalObject, Proposition, Relationship, RelationType, RelationFamily, VisualClass,
} from "./schemas";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CandidatePair {
  pairId: string;
  sourceId: string;
  targetId: string;
  reason: string; // why this pair is a candidate
}

export interface BatchDiagnostic {
  batchIndex: number;
  pairCount: number;
  attempts: number;
  rawResponseLength: number;
  parseSucceeded: boolean;
  acceptedCount: number;
  rejectedCount: number;
  abstainedCount: number;
  error: string | null;
}

export interface CandidateDiagnostics {
  totalObjects: number;
  theoreticalAllPairs: number;
  semanticCandidates: number;
  structuralCandidates: number;
  deduplicatedCandidatePairs: number;
  excludedPairs: number;
}

export interface RelationshipDiagnostics {
  candidates: CandidateDiagnostics;
  batchDiagnostics: BatchDiagnostic[];
  totalAccepted: number;
  totalRejected: number;
  totalAbstained: number;
  acceptedByType: Record<string, number>;
  rejectedReasons: string[];
}

export interface RelationshipResult {
  relationships: Relationship[];
  diagnostics: RelationshipDiagnostics;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TOP_K = 5;
const PAIRS_PER_BATCH = 8;
const SIMILARITY_THRESHOLD = 0.3;

const STRUCTURAL_TYPES: RelationType[] = [
  "child_of", "tangent_from", "diverged_from", "branch_from",
  "continued_from", "merged_from", "split_from",
];

// ─── Public API ─────────────────────────────────────────────────────────────

export async function generateRelationships(
  objects: ConversationalObject[],
  propositions: Proposition[],
): Promise<RelationshipResult> {
  const diag: RelationshipDiagnostics = {
    candidates: { totalObjects: 0, theoreticalAllPairs: 0, semanticCandidates: 0, structuralCandidates: 0, deduplicatedCandidatePairs: 0, excludedPairs: 0 },
    batchDiagnostics: [],
    totalAccepted: 0,
    totalRejected: 0,
    totalAbstained: 0,
    acceptedByType: {},
    rejectedReasons: [],
  };

  const activeObjects = objects.filter((o) => o.status !== "discarded" && o.objectType !== "noise");
  if (activeObjects.length < 2) return { relationships: [], diagnostics: diag };

  const propMap = new Map(propositions.map((p) => [p.propositionId, p]));
  const validObjectIds = new Set(activeObjects.map((o) => o.objectId));
  const validPropIds = new Set(propositions.map((p) => p.propositionId));

  diag.candidates.totalObjects = activeObjects.length;
  diag.candidates.theoreticalAllPairs = (activeObjects.length * (activeObjects.length - 1)) / 2;

  // Step 1: Build embeddings and find candidates
  const candidates = await findCandidatePairs(activeObjects, propositions, diag);

  // Step 2: Classify in batches
  const batches = buildBatches(candidates, PAIRS_PER_BATCH);
  const allRelationships: Relationship[] = [];
  let globalRelIndex = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchDiag: BatchDiagnostic = {
      batchIndex: batchIdx,
      pairCount: batch.length,
      attempts: 0,
      rawResponseLength: 0,
      parseSucceeded: false,
      acceptedCount: 0,
      rejectedCount: 0,
      abstainedCount: 0,
      error: null,
    };

    const results = await classifyBatch(batch, activeObjects, propositions, batchDiag);

    for (const r of results) {
      if (r.decision === "none" || r.decision === "abstain") {
        if (r.decision === "abstain") batchDiag.abstainedCount++;
        continue;
      }

      // Validate
      const pair = batch.find((p) => p.pairId === r.pairId);
      if (!pair) { batchDiag.rejectedCount++; diag.rejectedReasons.push(`${r.pairId}: unknown pairId`); continue; }
      if (!validObjectIds.has(pair.sourceId) || !validObjectIds.has(pair.targetId)) { batchDiag.rejectedCount++; diag.rejectedReasons.push(`${r.pairId}: invalid object`); continue; }
      if (!r.relationshipType) { batchDiag.rejectedCount++; diag.rejectedReasons.push(`${r.pairId}: no type`); continue; }

      const supportingPropIds = (r.supportingPropositionIds || []).filter((pid: string) => validPropIds.has(pid));
      // Fallback: derive from object propositions
      if (supportingPropIds.length === 0) {
        const srcObj = activeObjects.find((o) => o.objectId === pair.sourceId);
        const tgtObj = activeObjects.find((o) => o.objectId === pair.targetId);
        const srcProps = srcObj?.propositionIds ?? [];
        const tgtProps = tgtObj?.propositionIds ?? [];
        const shared = srcProps.filter((p) => tgtProps.includes(p));
        supportingPropIds.push(...(shared.length > 0 ? shared.slice(0, 3) : srcProps.slice(0, 2)));
      }

      if (supportingPropIds.length === 0) { batchDiag.rejectedCount++; diag.rejectedReasons.push(`${r.pairId}: no evidence`); continue; }

      const type = r.relationshipType as RelationType;
      const family: RelationFamily = STRUCTURAL_TYPES.includes(type) ? "structural" : "semantic";

      allRelationships.push({
        relationshipId: `rel-${globalRelIndex++}`,
        sourceObjectId: pair.sourceId,
        targetObjectId: pair.targetId,
        type,
        family,
        sourcePropositionIds: supportingPropIds,
        provenance: "llm_classified",
        confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.7,
        createdBy: "system",
        status: "proposed",
        visualClass: classifyVisual(type, family),
        explanation: r.explanation ?? "",
      });

      batchDiag.acceptedCount++;
      diag.acceptedByType[type] = (diag.acceptedByType[type] ?? 0) + 1;
    }

    diag.batchDiagnostics.push(batchDiag);
  }

  diag.totalAccepted = allRelationships.length;
  diag.totalRejected = diag.batchDiagnostics.reduce((s, b) => s + b.rejectedCount, 0);
  diag.totalAbstained = diag.batchDiagnostics.reduce((s, b) => s + b.abstainedCount, 0);

  return { relationships: allRelationships, diagnostics: diag };
}

// ─── Candidate Retrieval ────────────────────────────────────────────────────

async function findCandidatePairs(
  objects: ConversationalObject[],
  propositions: Proposition[],
  diag: RelationshipDiagnostics,
): Promise<CandidatePair[]> {
  // Build embedding text per object
  const embTexts = objects.map((o) => {
    const props = o.propositionIds.slice(0, 3).map((pid) => {
      const p = propositions.find((pr) => pr.propositionId === pid);
      return p ? p.normalizedContent : "";
    }).join(". ");
    return `${o.objectType}: ${o.title}. ${o.description}. ${props}`;
  });

  // Generate embeddings
  const embeddings: number[][] = [];
  for (const text of embTexts) {
    try {
      const emb = await embed(text);
      embeddings.push(emb);
    } catch {
      embeddings.push([]);
    }
  }

  const pairSet = new Set<string>();
  const candidates: CandidatePair[] = [];

  // Semantic candidates via embedding similarity (top-K per object)
  for (let i = 0; i < objects.length; i++) {
    if (embeddings[i].length === 0) continue;
    const similarities: Array<{ idx: number; sim: number }> = [];
    for (let j = 0; j < objects.length; j++) {
      if (i === j || embeddings[j].length === 0) continue;
      const sim = cosineSim(embeddings[i], embeddings[j]);
      if (sim >= SIMILARITY_THRESHOLD) similarities.push({ idx: j, sim });
    }
    similarities.sort((a, b) => b.sim - a.sim);
    for (const { idx } of similarities.slice(0, TOP_K)) {
      const key = canonicalPairKey(objects[i].objectId, objects[idx].objectId);
      if (!pairSet.has(key)) {
        pairSet.add(key);
        candidates.push({ pairId: `pair-${candidates.length}`, sourceId: objects[i].objectId, targetId: objects[idx].objectId, reason: "semantic_similarity" });
        diag.candidates.semanticCandidates++;
      }
    }
  }

  // Structural candidates: same-thread objects within ±5 positional window
  const threadGroups = new Map<string, string[]>();
  for (const o of objects) {
    for (const tid of o.threadIds) {
      const group = threadGroups.get(tid) ?? [];
      group.push(o.objectId);
      threadGroups.set(tid, group);
    }
  }
  const STRUCTURAL_WINDOW = 5;
  for (const [, group] of threadGroups) {
    for (let i = 0; i < group.length; i++) {
      const windowEnd = Math.min(i + STRUCTURAL_WINDOW, group.length - 1);
      for (let j = i + 1; j <= windowEnd; j++) {
        const key = canonicalPairKey(group[i], group[j]);
        if (!pairSet.has(key)) {
          pairSet.add(key);
          candidates.push({ pairId: `pair-${candidates.length}`, sourceId: group[i], targetId: group[j], reason: "same_thread" });
          diag.candidates.structuralCandidates++;
        }
      }
    }
  }

  // Structural candidates: shared propositions
  for (let i = 0; i < objects.length; i++) {
    const propsI = new Set(objects[i].propositionIds);
    for (let j = i + 1; j < objects.length; j++) {
      if (objects[j].propositionIds.some((p) => propsI.has(p))) {
        const key = canonicalPairKey(objects[i].objectId, objects[j].objectId);
        if (!pairSet.has(key)) {
          pairSet.add(key);
          candidates.push({ pairId: `pair-${candidates.length}`, sourceId: objects[i].objectId, targetId: objects[j].objectId, reason: "shared_propositions" });
          diag.candidates.structuralCandidates++;
        }
      }
    }
  }

  diag.candidates.deduplicatedCandidatePairs = candidates.length;
  diag.candidates.excludedPairs = diag.candidates.theoreticalAllPairs - candidates.length;

  return candidates;
}

function canonicalPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Batch Classification ───────────────────────────────────────────────────

function buildBatches(candidates: CandidatePair[], batchSize: number): CandidatePair[][] {
  const batches: CandidatePair[][] = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }
  return batches;
}

interface ClassificationResult {
  pairId: string;
  decision: "relationship" | "none" | "abstain";
  relationshipType?: string;
  supportingPropositionIds?: string[];
  confidence?: number;
  explanation?: string;
}

async function classifyBatch(
  batch: CandidatePair[],
  objects: ConversationalObject[],
  propositions: Proposition[],
  batchDiag: BatchDiagnostic,
): Promise<ClassificationResult[]> {
  const objMap = new Map(objects.map((o) => [o.objectId, o]));
  const propMap = new Map(propositions.map((p) => [p.propositionId, p]));

  const pairsFormatted = batch.map((pair) => {
    const src = objMap.get(pair.sourceId)!;
    const tgt = objMap.get(pair.targetId)!;
    const srcProps = src.propositionIds.slice(0, 3).map((pid) => {
      const p = propMap.get(pid);
      return p ? `${pid}: "${p.normalizedContent}"` : pid;
    }).join("; ");
    const tgtProps = tgt.propositionIds.slice(0, 3).map((pid) => {
      const p = propMap.get(pid);
      return p ? `${pid}: "${p.normalizedContent}"` : pid;
    }).join("; ");

    return `[${pair.pairId}]
  Source: [${src.objectId}] ${src.objectType}: "${src.title}" — Props: ${srcProps}
  Target: [${tgt.objectId}] ${tgt.objectType}: "${tgt.title}" — Props: ${tgtProps}
  Thread context: source=${src.threadIds.join(",")}, target=${tgt.threadIds.join(",")}`;
  }).join("\n\n");

  // Attempt 1
  batchDiag.attempts = 1;
  let result = await callClassifyLLM(pairsFormatted);
  batchDiag.rawResponseLength = result.rawLength;

  if (result.parsed !== null) {
    batchDiag.parseSucceeded = true;
    return result.parsed;
  }

  // Retry
  batchDiag.attempts = 2;
  result = await callClassifyLLMRetry(pairsFormatted);
  batchDiag.rawResponseLength += result.rawLength;

  if (result.parsed !== null) {
    batchDiag.parseSucceeded = true;
    return result.parsed;
  }

  batchDiag.error = result.error;
  return [];
}

interface ClassifyParseResult {
  parsed: ClassificationResult[] | null;
  rawLength: number;
  error: string | null;
}

async function callClassifyLLM(pairsFormatted: string): Promise<ClassifyParseResult> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        { role: "system", content: CLASSIFY_PROMPT },
        { role: "user", content: `Candidate pairs:\n${pairsFormatted}\n\nClassify each pair. Return JSON array only.` },
      ],
      temperature: 0.2,
      maxTokens: 2000,
    });
    const parsed = parseJsonArrayFromLLM(result.content);
    if (parsed.success) return { parsed: parsed.data as unknown as ClassificationResult[], rawLength: result.content.length, error: null };
    return { parsed: null, rawLength: result.content.length, error: parsed.error };
  } catch (e) {
    return { parsed: null, rawLength: 0, error: e instanceof Error ? e.message : "unknown" };
  }
}

async function callClassifyLLMRetry(pairsFormatted: string): Promise<ClassifyParseResult> {
  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        { role: "system", content: CLASSIFY_RETRY_PROMPT },
        { role: "user", content: `Candidate pairs:\n${pairsFormatted}\n\nClassify. Return ONLY valid JSON array.` },
      ],
      temperature: 0.1,
      maxTokens: 2000,
    });
    const parsed = parseJsonArrayFromLLM(result.content);
    if (parsed.success) return { parsed: parsed.data as unknown as ClassificationResult[], rawLength: result.content.length, error: null };
    return { parsed: null, rawLength: result.content.length, error: parsed.error };
  } catch (e) {
    return { parsed: null, rawLength: 0, error: e instanceof Error ? e.message : "unknown" };
  }
}

function classifyVisual(type: RelationType, family: RelationFamily): VisualClass {
  if (family === "manual") return "manual";
  if (type === "diverged_from" || type === "tangent_from") return "weak";
  if (type === "child_of" || type === "branch_from" || type === "merged_from") return "structural";
  return "semantic";
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const CLASSIFY_PROMPT = `Classify relationship candidates between conversational objects.

For each pair, decide if a meaningful relationship exists.

SEMANTIC types: answers, raises_question, supports, evidence_for, example_of, elaborates, reframes, contrasts_with, causes, depends_on, specializes, generalizes, leads_to
STRUCTURAL types: child_of, tangent_from, diverged_from, continued_from

CHILD_OF: source is a narrower sub-aspect of target. Removing target loses context for source.
ELABORATES: source adds detail to target without changing subject.
ANSWERS: source resolves an inquiry in target.

RULES:
- Temporal adjacency alone is NOT evidence for any relationship.
- Chronology alone cannot create child_of.
- If no meaningful relationship exists, return decision: "none".
- If uncertain, return decision: "abstain".
- supportingPropositionIds must cite specific prop IDs from the objects.

Return JSON array using the exact pairId provided:
[{
  "pairId": "<exact pairId>",
  "decision": "relationship" | "none" | "abstain",
  "relationshipType": "<type if decision is relationship>",
  "supportingPropositionIds": ["prop-X"],
  "confidence": <0.0-1.0>,
  "explanation": "<brief evidence>"
}]`;

const CLASSIFY_RETRY_PROMPT = `Return a valid JSON array classifying relationship candidates.
No markdown fences. No commentary. Each entry:
{
  "pairId": "<exact pairId>",
  "decision": "relationship" | "none" | "abstain",
  "relationshipType": "<type or null>",
  "supportingPropositionIds": ["prop-X"],
  "confidence": <0.0-1.0>,
  "explanation": "<brief>"
}
Return ONLY the JSON array:`;
