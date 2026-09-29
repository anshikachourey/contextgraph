import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The engine module owns the expensive O(n^2) work. We spy on it to prove the
// read path never touches it.
import * as engine from "./threshold-calibration";

// The Threshold_Accessor lazily imports the store; mock it so getEdgeThresholds
// can resolve without a real DB. getStoredCalibration resolves null so the
// accessor falls back to the compile-time constants (no error, no computation).
vi.mock("../db/calibration", () => ({
  getStoredCalibration: vi.fn(async () => null),
  loadAllNodeEmbeddings: vi.fn(async () => []),
  saveCalibration: vi.fn(async () => {}),
}));

// The Edge_Suggestion_Flow consumer (selectCandidates) is pure and does its own
// inline cosine computation — it must NOT reach into the engine at all.
import { getEdgeThresholds } from "../similarityThresholds";
import { selectCandidates, type NodeForSuggestion } from "../edgeSuggestions";

/**
 * Read path (Threshold_Accessor + Edge_Suggestion_Flow selection) must NEVER
 * trigger the O(n^2) Calibration_Engine.
 *
 * Reqs 3.3, 3.5, 3.6:
 *  - 3.3: WHILE handling chat/graph/edge-suggestion requests, the engine SHALL
 *         NOT compute a new Calibration_Result.
 *  - 3.5: WHEN thresholds are resolved for the flow, the accessor SHALL read the
 *         stored result WITHOUT computing pairwise scores.
 *  - 3.6: IF no stored result exists, the accessor SHALL return the constants
 *         WITHOUT triggering the engine to compute one.
 */
describe("read path never computes (Reqs 3.3, 3.5, 3.6)", () => {
  let computeSpy: ReturnType<typeof vi.spyOn>;
  let calibrateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    computeSpy = vi.spyOn(engine, "computePairwiseScores");
    calibrateSpy = vi.spyOn(engine, "calibrateThresholds");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getEdgeThresholds() reads the store without invoking the engine (Reqs 3.5, 3.6)", async () => {
    const result = await getEdgeThresholds();

    // No calibration stored → compile-time constants, and crucially the engine
    // was never asked to compute anything.
    expect(result.calibrated).toBe(false);
    expect(computeSpy).not.toHaveBeenCalled();
    expect(calibrateSpy).not.toHaveBeenCalled();
  });

  it("selectCandidates() computes its own scores inline and never calls the engine (Req 3.3)", () => {
    const nodes = buildNodes();

    // Default threshold and an explicit threshold — neither path may reach the engine.
    const withDefault = selectCandidates(nodes);
    const withExplicit = selectCandidates(nodes, 0.6);

    // Sanity: the pure selector did real work (returns an array either way).
    expect(Array.isArray(withDefault)).toBe(true);
    expect(Array.isArray(withExplicit)).toBe(true);

    expect(computeSpy).not.toHaveBeenCalled();
    expect(calibrateSpy).not.toHaveBeenCalled();
  });

  it("neither engine function is called across combined read-path operations", async () => {
    const nodes = buildNodes();

    await getEdgeThresholds();
    selectCandidates(nodes);
    selectCandidates(nodes, 0.7);
    await getEdgeThresholds();

    expect(computeSpy).not.toHaveBeenCalled();
    expect(calibrateSpy).not.toHaveBeenCalled();
  });

  // Sanity check that the spies are genuinely attached to the engine module —
  // directly calling the engine DOES register on the spy. This proves the
  // "not called" assertions above are meaningful rather than vacuous.
  it("sanity: directly calling the engine registers on the spy", () => {
    expect(calibrateSpy).not.toHaveBeenCalled();
    engine.calibrateThresholds([]);
    expect(calibrateSpy).toHaveBeenCalledTimes(1);

    expect(computeSpy).not.toHaveBeenCalled();
    engine.computePairwiseScores([]);
    expect(computeSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Test data ───────────────────────────────────────────────────────────────

/** Small set of NodeForSuggestion with simple embeddings for selectCandidates. */
function buildNodes(): NodeForSuggestion[] {
  const mk = (
    id: string,
    embedding: number[] | null,
  ): NodeForSuggestion => ({
    id,
    title: `Node ${id}`,
    summary: `Summary ${id}`,
    evidenceSummary: null,
    embedding,
  });

  return [
    mk("a", [1, 0, 0, 0]),
    mk("b", [0.9, 0.1, 0, 0]),
    mk("c", [0, 1, 0, 0]),
    mk("d", [0, 0.95, 0.05, 0]),
    mk("e", null), // embedding-less node should simply be skipped
  ];
}
