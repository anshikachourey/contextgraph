/**
 * Object-Granularity Diagnostics.
 *
 * Analyzes the 70 generated objects for potential duplicates, overlap,
 * and granularity issues. Diagnostic only — does not modify objects.
 */

import type { ConversationalObject } from "./schemas";

export interface GranularitySummary {
  objectCount: number;
  objectsPerThread: Record<string, number>;
  singlePropositionObjects: number;
  singleUtteranceObjects: number;
  likelyDuplicatePairs: Array<{ a: string; b: string; titleSimilarity: number }>;
  likelyOverlapPairs: Array<{ a: string; b: string; sharedPropositions: number; overlapRatio: number }>;
  medianPropositionsPerObject: number;
  medianUtterancesPerObject: number;
}

export function computeGranularityDiagnostics(objects: ConversationalObject[]): GranularitySummary {
  const objectsPerThread: Record<string, number> = {};
  let singlePropCount = 0;
  let singleUttCount = 0;

  for (const o of objects) {
    for (const tid of o.threadIds) {
      objectsPerThread[tid] = (objectsPerThread[tid] ?? 0) + 1;
    }
    if (o.propositionIds.length === 1) singlePropCount++;
    if (o.supportingUtteranceIds.length <= 1) singleUttCount++;
  }

  // Proposition counts per object
  const propCounts = objects.map((o) => o.propositionIds.length).sort((a, b) => a - b);
  const uttCounts = objects.map((o) => o.supportingUtteranceIds.length).sort((a, b) => a - b);

  const medianProps = propCounts.length > 0 ? propCounts[Math.floor(propCounts.length / 2)] : 0;
  const medianUtts = uttCounts.length > 0 ? uttCounts[Math.floor(uttCounts.length / 2)] : 0;

  // Title similarity (Jaccard on words)
  const likelyDuplicates: Array<{ a: string; b: string; titleSimilarity: number }> = [];
  const likelyOverlaps: Array<{ a: string; b: string; sharedPropositions: number; overlapRatio: number }> = [];

  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const sim = titleJaccard(objects[i].title, objects[j].title);
      if (sim >= 0.6) {
        likelyDuplicates.push({ a: objects[i].objectId, b: objects[j].objectId, titleSimilarity: Math.round(sim * 100) / 100 });
      }

      const propsI = new Set(objects[i].propositionIds);
      const shared = objects[j].propositionIds.filter((p) => propsI.has(p)).length;
      const minSize = Math.min(objects[i].propositionIds.length, objects[j].propositionIds.length);
      if (shared > 0 && minSize > 0) {
        const ratio = shared / minSize;
        if (ratio >= 0.5) {
          likelyOverlaps.push({ a: objects[i].objectId, b: objects[j].objectId, sharedPropositions: shared, overlapRatio: Math.round(ratio * 100) / 100 });
        }
      }
    }
  }

  return {
    objectCount: objects.length,
    objectsPerThread,
    singlePropositionObjects: singlePropCount,
    singleUtteranceObjects: singleUttCount,
    likelyDuplicatePairs: likelyDuplicates.slice(0, 20),
    likelyOverlapPairs: likelyOverlaps.slice(0, 20),
    medianPropositionsPerObject: medianProps,
    medianUtterancesPerObject: medianUtts,
  };
}

function titleJaccard(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}
