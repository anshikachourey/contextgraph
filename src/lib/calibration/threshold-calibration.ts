/**
 * Similarity threshold calibration — pure, deterministic, offline.
 *
 * Given the embeddings of existing nodes, this derives candidate edge similarity
 * thresholds from the SHAPE of the pairwise-similarity distribution — with a
 * self-check that REFUSES to produce a threshold when the distribution does not
 * clearly justify one (i.e. it is not separable into "unrelated" vs "related").
 *
 * No user labels. No LLM. No user signal. No side effects. Fully unit-testable.
 *
 * The consumer (DB layer / trigger endpoint) decides what to do with the result:
 *   - result.applied === true  → persist the derived thresholds.
 *   - result.applied === false → keep the existing compile-time constants
 *                                 (`reason` explains why it was rejected).
 */

import { cosineSimilarity } from "../cosineSimilarity";
import {
  STRONGLY_RELATED_THRESHOLD,
  POSSIBLY_RELATED_THRESHOLD,
} from "../similarityThresholds";

// ─── Tunables (calibration meta-parameters, not the thresholds themselves) ───

/** Minimum node count before calibration is even attempted. */
export const MIN_NODES_FOR_CALIBRATION = 20;

/** Minimum pairwise samples required to trust the distribution shape. */
export const MIN_PAIRS_FOR_CALIBRATION = 100;

/**
 * Sarle's bimodality coefficient threshold. BC > ~0.555 indicates a distribution
 * that is bimodal/flat rather than unimodal. Below this we treat the data as a
 * single blob and refuse to derive a threshold. Conservative on purpose.
 */
export const MIN_BIMODALITY_COEFFICIENT = 0.555;

/** Number of histogram bins used for valley detection. */
export const HISTOGRAM_BINS = 40;

// ─── Types ───────────────────────────────────────────────────────────────────

export type NodeEmbedding = {
  id: string;
  embedding: number[] | null;
};

export type CalibrationResult = {
  /** True → data justifies new thresholds; false → keep existing constants. */
  applied: boolean;
  /** Threshold values to use (derived if applied, else the fallback constants). */
  stronglyRelated: number;
  possiblyRelated: number;
  /** Diagnostics / provenance. */
  nodeCount: number;
  samplePairCount: number;
  bimodalityCoefficient: number | null;
  valleyScore: number | null;
  reason: string;
};

// ─── Statistics helpers (pure) ───────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[], m: number): number {
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * Sarle's bimodality coefficient: BC = (skew^2 + 1) / kurtosis.
 * Uses sample skewness and (non-excess) kurtosis. Higher = more bimodal/flat.
 */
export function bimodalityCoefficient(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const s = stdDev(xs, m);
  if (s === 0) return 0;

  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = (x - m) / s;
    m3 += d ** 3;
    m4 += d ** 4;
  }
  const skew = m3 / n;
  const kurt = m4 / n; // non-excess kurtosis
  if (kurt === 0) return 0;
  return (skew * skew + 1) / kurt;
}

/**
 * Find the deepest valley (anti-mode) between the two dominant peaks of a
 * histogram of the scores. Returns the score at the valley, or null if no
 * clear valley between two peaks exists.
 */
export function findValley(scores: number[], bins = HISTOGRAM_BINS): number | null {
  if (scores.length === 0) return null;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max <= min) return null;

  const width = (max - min) / bins;
  const hist = new Array(bins).fill(0);
  for (const s of scores) {
    let idx = Math.floor((s - min) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    hist[idx] += 1;
  }

  // Identify the two tallest, non-adjacent peaks.
  const peaks: { idx: number; count: number }[] = [];
  for (let i = 0; i < bins; i++) {
    const left = i > 0 ? hist[i - 1] : -1;
    const right = i < bins - 1 ? hist[i + 1] : -1;
    if (hist[i] > left && hist[i] >= right && hist[i] > 0) {
      peaks.push({ idx: i, count: hist[i] });
    }
  }
  if (peaks.length < 2) return null;

  peaks.sort((a, b) => b.count - a.count);
  const [p1, p2] = [peaks[0], peaks[1]].sort((a, b) => a.idx - b.idx);
  if (p2.idx - p1.idx < 2) return null; // peaks too close → no real valley

  // Deepest bin strictly between the two peaks.
  let valleyIdx = p1.idx;
  let valleyCount = Infinity;
  for (let i = p1.idx + 1; i < p2.idx; i++) {
    if (hist[i] < valleyCount) {
      valleyCount = hist[i];
      valleyIdx = i;
    }
  }

  // Valley must be a genuine trough — clearly below both surrounding peaks.
  const shallower = Math.min(p1.count, p2.count);
  if (valleyCount >= shallower * 0.8) return null;

  // Return the score at the center of the valley bin.
  return min + (valleyIdx + 0.5) * width;
}

// ─── Core calibration ──────────────────────────────────────────────────────

/**
 * Compute all pairwise cosine similarities between nodes that have embeddings.
 * O(n^2) — intended for offline/triggered runs, not per-request hot paths.
 */
export function computePairwiseScores(nodes: NodeEmbedding[]): number[] {
  const withEmb = nodes.filter(
    (n): n is NodeEmbedding & { embedding: number[] } =>
      Array.isArray(n.embedding) && n.embedding.length > 0,
  );
  const scores: number[] = [];
  for (let i = 0; i < withEmb.length; i++) {
    for (let j = i + 1; j < withEmb.length; j++) {
      scores.push(cosineSimilarity(withEmb[i].embedding, withEmb[j].embedding));
    }
  }
  // Canonicalize order so every downstream statistic (bimodality coefficient,
  // valley detection, upper-mean) is computed over the scores in a fixed,
  // input-order-independent sequence. Floating-point summation is not
  // associative, so without this a permutation of the input nodes could change
  // provenance diagnostics in the last bits and violate order-independence
  // (Req 5.3 / Property 2).
  scores.sort((a, b) => a - b);
  return scores;
}

/**
 * Derive calibrated thresholds from node embeddings, or refuse and fall back.
 *
 * Guards (any failure → applied:false, constants returned):
 *   1. Too few nodes / pairs to be meaningful.
 *   2. Distribution not bimodal (single blob → no natural cut).
 *   3. No clear valley between the two dominant peaks.
 *   4. Derived threshold outside a sane range.
 */
export function calibrateThresholds(nodes: NodeEmbedding[]): CalibrationResult {
  const nodeCount = nodes.filter(
    (n) => Array.isArray(n.embedding) && n.embedding.length > 0,
  ).length;

  const fallback = (reason: string, extra: Partial<CalibrationResult> = {}): CalibrationResult => ({
    applied: false,
    stronglyRelated: STRONGLY_RELATED_THRESHOLD,
    possiblyRelated: POSSIBLY_RELATED_THRESHOLD,
    nodeCount,
    samplePairCount: 0,
    bimodalityCoefficient: null,
    valleyScore: null,
    reason,
    ...extra,
  });

  if (nodeCount < MIN_NODES_FOR_CALIBRATION) {
    return fallback(
      `Too few embedded nodes (${nodeCount} < ${MIN_NODES_FOR_CALIBRATION}); kept constants.`,
    );
  }

  const scores = computePairwiseScores(nodes);
  if (scores.length < MIN_PAIRS_FOR_CALIBRATION) {
    return fallback(
      `Too few score pairs (${scores.length} < ${MIN_PAIRS_FOR_CALIBRATION}); kept constants.`,
      { samplePairCount: scores.length },
    );
  }

  const bc = bimodalityCoefficient(scores);
  if (bc < MIN_BIMODALITY_COEFFICIENT) {
    return fallback(
      `Distribution not separable (bimodality ${bc.toFixed(3)} < ${MIN_BIMODALITY_COEFFICIENT}); kept constants.`,
      { samplePairCount: scores.length, bimodalityCoefficient: bc },
    );
  }

  const valley = findValley(scores);
  if (valley === null) {
    return fallback(
      "No clear valley between related/unrelated clusters; kept constants.",
      { samplePairCount: scores.length, bimodalityCoefficient: bc },
    );
  }

  // The valley is the "possibly related" boundary (below it = distinct).
  // "Strongly related" sits above it, toward the upper (related) mode.
  const possibly = valley;
  const upperScores = scores.filter((s) => s >= valley);
  const strongly = upperScores.length > 0 ? mean(upperScores) : valley + 0.1;

  // Sanity clamp — refuse absurd cuts even if the shape technically passed.
  if (possibly < 0.3 || possibly > 0.85 || strongly <= possibly || strongly > 0.98) {
    return fallback(
      `Derived thresholds out of sane range (possibly=${possibly.toFixed(3)}, strongly=${strongly.toFixed(3)}); kept constants.`,
      { samplePairCount: scores.length, bimodalityCoefficient: bc, valleyScore: valley },
    );
  }

  return {
    applied: true,
    stronglyRelated: Number(strongly.toFixed(4)),
    possiblyRelated: Number(possibly.toFixed(4)),
    nodeCount,
    samplePairCount: scores.length,
    bimodalityCoefficient: Number(bc.toFixed(4)),
    valleyScore: Number(valley.toFixed(4)),
    reason: "Applied data-derived thresholds from bimodal distribution valley.",
  };
}
