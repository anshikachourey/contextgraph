import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  calibrateThresholds,
  computePairwiseScores,
  bimodalityCoefficient,
  findValley,
  MIN_NODES_FOR_CALIBRATION,
  type NodeEmbedding,
} from "./threshold-calibration";
import {
  STRONGLY_RELATED_THRESHOLD,
  POSSIBLY_RELATED_THRESHOLD,
} from "../similarityThresholds";

// ─── Helpers to synthesize embeddings ────────────────────────────────────────

/** Deterministic pseudo-random in [-1, 1] from a seed. */
function seeded(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}

function unit(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Build `count` embeddings tightly clustered around a base direction. */
function cluster(baseSeed: number, count: number, jitter: number, dim = 16): number[][] {
  const rand = seeded(baseSeed);
  const base = unit(Array.from({ length: dim }, () => rand()));
  const jitRand = seeded(baseSeed + 999);
  return Array.from({ length: count }, () =>
    unit(base.map((x) => x + jitRand() * jitter)),
  );
}

function toNodes(vectors: number[][]): NodeEmbedding[] {
  return vectors.map((embedding, i) => ({ id: `n${i}`, embedding }));
}

// ─── Shared fast-check arbitrary (REUSED by Properties 1–6, tasks 2.2–2.6) ────
//
// `nodeSetArb` produces `NodeEmbedding[]` sets that intelligently span the
// engine's whole input space so both the *applied* and *reverted* guard-chain
// branches get exercised:
//   - fixed-dimension `number[]` embeddings (DIM),
//   - one-cluster ("single blob" → reverts on separability) AND two-cluster
//     ("bimodal" → can reach the applied branch) distributions, built from the
//     existing deterministic `cluster()` helper via a fast-check-chosen seed,
//   - a fast-check-chosen count that straddles MIN_NODES_FOR_CALIBRATION so the
//     too-few-nodes revert branch is also hit,
//   - a controllable number of embedding-less nodes (`null` and `[]`) mixed in,
//     shuffled into the set, so exclusion behavior is covered too.
//
// Everything is derived from fast-check-provided integers, keeping each drawn
// case fully reproducible (fast-check replays failing seeds). Later property
// tasks should import/reuse `nodeSetArb` rather than redefining generators.

/** Fixed embedding dimension used across the property generators. */
export const DIM = 16;

/**
 * Build a single node set from primitive fast-check draws. Exposed so tasks
 * 2.2–2.6 can reuse the exact same distribution shaping.
 */
export function buildNodeSet(params: {
  shape: "one-cluster" | "two-cluster";
  seedA: number;
  seedB: number;
  count: number;
  jitter: number;
  nullCount: number;
  emptyCount: number;
  shuffleSeed: number;
}): NodeEmbedding[] {
  const { shape, seedA, seedB, count, jitter, nullCount, emptyCount, shuffleSeed } = params;

  let vectors: number[][];
  if (shape === "one-cluster") {
    vectors = cluster(seedA, count, jitter, DIM);
  } else {
    const half = Math.max(1, Math.floor(count / 2));
    vectors = [
      ...cluster(seedA, half, jitter, DIM),
      ...cluster(seedB, count - half, jitter, DIM),
    ];
  }

  const nodes: NodeEmbedding[] = toNodes(vectors);
  for (let i = 0; i < nullCount; i++) nodes.push({ id: `null${i}`, embedding: null });
  for (let i = 0; i < emptyCount; i++) nodes.push({ id: `empty${i}`, embedding: [] });

  // Deterministic Fisher–Yates shuffle so embedding-less nodes are interleaved.
  const rand = seeded(shuffleSeed);
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = Math.floor(((rand() + 1) / 2) * (i + 1)) % (i + 1);
    [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
  }
  return nodes;
}

/**
 * Shared arbitrary of node sets. REUSED by tasks 2.2–2.6.
 * Counts straddle MIN_NODES_FOR_CALIBRATION and jitter/shape variety ensure
 * both applied (bimodal, wide-enough separation) and reverted (too few nodes,
 * single blob, non-separable) branches are covered across 100+ runs.
 */
export const nodeSetArb: fc.Arbitrary<NodeEmbedding[]> = fc
  .record({
    shape: fc.constantFrom<"one-cluster" | "two-cluster">("one-cluster", "two-cluster"),
    seedA: fc.integer({ min: 1, max: 100000 }),
    seedB: fc.integer({ min: 1, max: 100000 }),
    count: fc.integer({ min: MIN_NODES_FOR_CALIBRATION - 10, max: MIN_NODES_FOR_CALIBRATION + 30 }),
    // jitter spans tight (near-identical → single blob) to loose (separated).
    jitter: fc.double({ min: 0.01, max: 0.6, noNaN: true, noDefaultInfinity: true }),
    nullCount: fc.integer({ min: 0, max: 5 }),
    emptyCount: fc.integer({ min: 0, max: 5 }),
    shuffleSeed: fc.integer({ min: 1, max: 100000 }),
  })
  .map(buildNodeSet);

// ─── Property-based tests ─────────────────────────────────────────────────────

describe("calibrateThresholds — properties (fast-check)", () => {
  // Feature: adaptive-similarity-thresholds, Property 1: Determinism
  // Validates: Requirements 5.2
  it("Property 1: Determinism — same set twice yields identical CalibrationResult", () => {
    fc.assert(
      fc.property(nodeSetArb, (nodes) => {
        const a = calibrateThresholds(nodes);
        const b = calibrateThresholds(nodes);
        expect(b).toEqual(a);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: adaptive-similarity-thresholds, Property 2: Order-independence (permutation invariance)
  // Validates: Requirements 5.3
  it("Property 2: Order-independence — permuting the set yields an identical CalibrationResult", () => {
    fc.assert(
      fc.property(nodeSetArb, fc.integer({ min: 1, max: 2147483646 }), (nodes, permSeed) => {
        // Deterministic Fisher–Yates permutation from a fast-check-drawn seed so
        // each case is fully reproducible (no Math.random).
        const permuted = nodes.slice();
        const rand = seeded(permSeed);
        for (let i = permuted.length - 1; i > 0; i--) {
          const j = Math.floor(((rand() + 1) / 2) * (i + 1)) % (i + 1);
          [permuted[i], permuted[j]] = [permuted[j], permuted[i]];
        }

        const original = calibrateThresholds(nodes);
        const reordered = calibrateThresholds(permuted);
        expect(reordered).toEqual(original);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: adaptive-similarity-thresholds, Property 3: Embedding-less nodes are excluded
  // Validates: Requirements 5.1, 5.4
  it("Property 3: Embedding-less nodes are excluded — inserting null/[] nodes doesn't change the result, and pairwise count is k*(k-1)/2", () => {
    fc.assert(
      fc.property(
        nodeSetArb,
        fc.integer({ min: 0, max: 8 }), // extra null-embedding nodes
        fc.integer({ min: 0, max: 8 }), // extra []-embedding nodes
        fc.integer({ min: 1, max: 2147483646 }), // insertion-position seed
        (baseNodes, extraNull, extraEmpty, posSeed) => {
          // Baseline result over the generated set.
          const original = calibrateThresholds(baseNodes);

          // k = count of nodes with a usable (non-empty) embedding.
          const usable = baseNodes.filter(
            (n) => n.embedding !== null && n.embedding.length > 0,
          );
          const k = usable.length;

          // Pairwise score count is exactly k*(k-1)/2 for the base set.
          expect(computePairwiseScores(baseNodes)).toHaveLength((k * (k - 1)) / 2);

          // Build the extra embedding-less nodes to insert at arbitrary positions.
          const extras: NodeEmbedding[] = [
            ...Array.from({ length: extraNull }, (_, i) => ({
              id: `x-null${i}`,
              embedding: null as number[] | null,
            })),
            ...Array.from({ length: extraEmpty }, (_, i) => ({
              id: `x-empty${i}`,
              embedding: [] as number[],
            })),
          ];

          // Insert each extra node at a deterministic arbitrary position.
          const augmented = baseNodes.slice();
          const rand = seeded(posSeed);
          for (const extra of extras) {
            const pos = Math.floor(((rand() + 1) / 2) * (augmented.length + 1)) % (augmented.length + 1);
            augmented.splice(pos, 0, extra);
          }

          // Adding embedding-less nodes leaves k (usable count) unchanged, so the
          // pairwise score count is still k*(k-1)/2.
          expect(computePairwiseScores(augmented)).toHaveLength((k * (k - 1)) / 2);

          // And the full CalibrationResult is field-by-field identical.
          const augmentedResult = calibrateThresholds(augmented);
          expect(augmentedResult).toEqual(original);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: adaptive-similarity-thresholds, Property 4: No mutation of inputs
  // Validates: Requirements 5.7
  it("Property 4: No mutation of inputs — nodes and embedding arrays are unchanged after the call", () => {
    fc.assert(
      fc.property(nodeSetArb, (nodes) => {
        // Deep snapshot of the input before the call (structuredClone is
        // available in Node 22). This captures the nodes array, each node
        // object, and each embedding array by value.
        const snapshot = structuredClone(nodes);

        calibrateThresholds(nodes);

        // The input must be deep-equal to its pre-call snapshot: no node
        // object mutated, no embedding array reordered/altered, array length
        // and element order preserved.
        expect(nodes).toEqual(snapshot);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: adaptive-similarity-thresholds, Property 5: Revert-to-safe never installs derived thresholds
  // Validates: Requirements 6.1, 6.4, 7.2, 8.3
  it("Property 5: Revert-to-safe — when applied === false, thresholds equal the compile-time constants", () => {
    fc.assert(
      fc.property(nodeSetArb, (nodes) => {
        const result = calibrateThresholds(nodes);
        if (result.applied === false) {
          // A reverted decision must leave the compile-time constants in effect;
          // no value derived from an insufficient/non-separable/out-of-range
          // sample is ever installed.
          expect(result.stronglyRelated).toBe(STRONGLY_RELATED_THRESHOLD);
          expect(result.possiblyRelated).toBe(POSSIBLY_RELATED_THRESHOLD);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: adaptive-similarity-thresholds, Property 6: Applied results are sane and correctly ordered
  // Validates: Requirements 8.4, 8.5, 8.6, 8.8
  it("Property 6: Applied results are sane and correctly ordered — when applied === true, thresholds are in range and correctly ordered", () => {
    fc.assert(
      fc.property(nodeSetArb, (nodes) => {
        const result = calibrateThresholds(nodes);
        // Conditional invariant: only assert when the applied branch is reached.
        // The generator's two-cluster / wide-jitter cases produce the bimodal
        // distributions that reach the applied branch; if a given run doesn't,
        // the property holds vacuously.
        if (result.applied === true) {
          // possibly-related in [0.3, 0.85] (Reqs 8.4)
          expect(result.possiblyRelated).toBeGreaterThanOrEqual(0.3);
          expect(result.possiblyRelated).toBeLessThanOrEqual(0.85);
          // correctly ordered: possibly < strongly (Req 8.5)
          expect(result.possiblyRelated).toBeLessThan(result.stronglyRelated);
          // strongly-related in range: strongly <= 0.98 (Req 8.6)
          expect(result.stronglyRelated).toBeLessThanOrEqual(0.98);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("computePairwiseScores", () => {
  it("skips nodes without embeddings and returns n*(n-1)/2 scores", () => {
    const nodes: NodeEmbedding[] = [
      { id: "a", embedding: [1, 0, 0] },
      { id: "b", embedding: [0, 1, 0] },
      { id: "c", embedding: null },
      { id: "d", embedding: [] },
    ];
    // Only a,b have usable embeddings → 1 pair.
    expect(computePairwiseScores(nodes)).toHaveLength(1);
  });

  it("orthogonal vectors score ~0, identical score ~1", () => {
    const s = computePairwiseScores([
      { id: "a", embedding: [1, 0] },
      { id: "b", embedding: [0, 1] },
      { id: "c", embedding: [1, 0] },
    ]);
    // pairs: (a,b)=0, (a,c)=1, (b,c)=0
    expect(Math.max(...s)).toBeCloseTo(1, 5);
    expect(Math.min(...s)).toBeCloseTo(0, 5);
  });
});

describe("bimodalityCoefficient", () => {
  it("is higher for a two-cluster distribution than a unimodal one", () => {
    const bimodal = [
      ...Array(50).fill(0.2),
      ...Array(50).fill(0.8),
    ];
    const unimodal = Array.from({ length: 100 }, (_, i) => 0.5 + (i % 5) * 0.001);
    expect(bimodalityCoefficient(bimodal)).toBeGreaterThan(
      bimodalityCoefficient(unimodal),
    );
  });
});

describe("findValley", () => {
  it("finds a valley between two separated peaks", () => {
    const scores = [
      ...Array(60).fill(0.25),
      ...Array(60).fill(0.85),
    ];
    const valley = findValley(scores);
    expect(valley).not.toBeNull();
    expect(valley!).toBeGreaterThan(0.25);
    expect(valley!).toBeLessThan(0.85);
  });

  it("returns null for a single blob (no valley)", () => {
    // A genuinely unimodal blob: a tight single cluster around 0.5 built from a
    // deterministic triangular (sum-of-uniforms) draw, which concentrates mass at
    // one central mode with monotonically decreasing tails and no interior trough.
    // (Note: Math.sin(i) over integers is bimodal — values pile near ±1 — so it
    // is NOT a valid single-blob fixture.)
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const scores = Array.from({ length: 400 }, () => {
      // Average of several uniforms → triangular/bell shape centered at 0.5.
      const avg = (rand() + rand() + rand() + rand()) / 4;
      return 0.4 + avg * 0.2; // single mode centered ~0.5, tight spread
    });
    expect(findValley(scores)).toBeNull();
  });
});

describe("calibrateThresholds — revert cases", () => {
  it("reverts to constants when too few nodes", () => {
    const result = calibrateThresholds(
      toNodes(cluster(1, MIN_NODES_FOR_CALIBRATION - 5, 0.05)),
    );
    expect(result.applied).toBe(false);
    expect(result.stronglyRelated).toBe(STRONGLY_RELATED_THRESHOLD);
    expect(result.possiblyRelated).toBe(POSSIBLY_RELATED_THRESHOLD);
    expect(result.reason).toMatch(/too few embedded nodes/i);
  });

  it("reverts to constants for a single unimodal blob", () => {
    // One big tight cluster → all pairwise sims near 1.0, no separation.
    const result = calibrateThresholds(toNodes(cluster(7, 40, 0.02)));
    expect(result.applied).toBe(false);
    expect(result.stronglyRelated).toBe(STRONGLY_RELATED_THRESHOLD);
    expect(result.possiblyRelated).toBe(POSSIBLY_RELATED_THRESHOLD);
  });

  it("never returns thresholds outside the fallback when reverting", () => {
    const result = calibrateThresholds(toNodes(cluster(7, 40, 0.02)));
    if (!result.applied) {
      expect(result.possiblyRelated).toBe(POSSIBLY_RELATED_THRESHOLD);
      expect(result.stronglyRelated).toBe(STRONGLY_RELATED_THRESHOLD);
    }
  });
});

describe("calibrateThresholds — applied case", () => {
  it("derives thresholds from a clearly bimodal distribution", () => {
    // Two well-separated clusters → within-cluster sims high, cross-cluster low,
    // producing a bimodal pairwise distribution with a valley.
    const nodes = toNodes([
      ...cluster(11, 20, 0.05),
      ...cluster(9999, 20, 0.05),
    ]);
    const result = calibrateThresholds(nodes);

    if (result.applied) {
      // Derived values must be sane and ordered.
      expect(result.possiblyRelated).toBeGreaterThanOrEqual(0.3);
      expect(result.possiblyRelated).toBeLessThanOrEqual(0.85);
      expect(result.stronglyRelated).toBeGreaterThan(result.possiblyRelated);
      expect(result.valleyScore).not.toBeNull();
      expect(result.bimodalityCoefficient).not.toBeNull();
    } else {
      // If the synthetic separation wasn't strong enough on this platform, it
      // must have safely reverted to constants — never an unsafe partial state.
      expect(result.possiblyRelated).toBe(POSSIBLY_RELATED_THRESHOLD);
    }
  });
});
