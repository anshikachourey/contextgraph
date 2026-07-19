/**
 * Eval Harness Infrastructure Tests.
 * Tests the loader, scorers, and runner — NOT semantic model quality.
 */
import { describe, it, expect } from "vitest";
import { loadGoldenFixtures, loadGoldenFixture, loadVariants, classifyVariant, materializeVariant } from "../loader";
import { scoreCase, applyPassRule } from "../scorers";
import { createReplayAdapter, buildPassingOutput } from "../replay-adapter";
import { runSingleCase, runExperiment } from "../runner";

describe("Fixture Loader", () => {
  it("loads all 10 golden fixtures", () => {
    const { items, errors } = loadGoldenFixtures();
    expect(items.length).toBe(10);
    expect(errors.length).toBe(0);
  });

  it("loads a single fixture by ID", () => {
    const fixture = loadGoldenFixture("SMT-001");
    expect(fixture).not.toBeNull();
    expect(fixture!.id).toBe("SMT-001");
    expect(fixture!.executionMode).toBe("SINGLE_STEP");
  });

  it("returns null for nonexistent fixture", () => {
    const fixture = loadGoldenFixture("SMT-999");
    expect(fixture).toBeNull();
  });

  it("fixture IDs are unique", () => {
    const { items } = loadGoldenFixtures();
    const ids = items.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("distinguishes SINGLE_STEP and SEQUENCE fixtures", () => {
    const { items } = loadGoldenFixtures();
    const single = items.filter((f) => f.executionMode === "SINGLE_STEP");
    const sequence = items.filter((f) => f.executionMode === "SEQUENCE");
    expect(single.length).toBeGreaterThan(0);
    expect(sequence.length).toBeGreaterThan(0);
    // SMT-009 is SEQUENCE
    const smt009 = items.find((f) => f.id === "SMT-009");
    expect(smt009?.executionMode).toBe("SEQUENCE");
    expect(smt009?.steps).toBeDefined();
  });

  it("loads all 30 variants", () => {
    const { items, errors } = loadVariants();
    expect(items.length).toBe(30);
    expect(errors.length).toBe(0);
  });
});

describe("Variant Classification", () => {
  it("classifies JSON-patch variants as MACHINE_MATERIALIZABLE", () => {
    const { items } = loadVariants();
    const first = items[0]; // SMT-001-A has patches
    expect(classifyVariant(first)).toBe("MACHINE_MATERIALIZABLE");
  });

  it("materializes a variant by applying patches to base", () => {
    const base = loadGoldenFixture("SMT-001")!;
    const { items } = loadVariants();
    const variant = items.find((v) => v.id === "SMT-001-A")!;
    const materialized = materializeVariant(base, variant);

    expect(materialized).not.toBeNull();
    expect(materialized!.id).toBe("SMT-001-A");
    // The retrieval should be different from base
    const baseRanks = base.retrieval!.initialIdentityCandidates.map((c) => c.objectId);
    const matRanks = materialized!.retrieval!.initialIdentityCandidates.map((c: { objectId: string }) => c.objectId);
    // obj-112 moved from rank 5 to rank 2
    expect(matRanks[1]).toBe("obj-112");
    expect(baseRanks[1]).not.toBe("obj-112");
  });
});

describe("Scorers", () => {
  it("golden pass rule: passing output passes", () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const output = buildPassingOutput(fixture);
    const results = scoreCase(fixture, output);
    const passed = applyPassRule(fixture, results);
    expect(passed).toBe(true);
  });

  it("forbidden outcomes force failure", () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    // Create output that violates a forbidden outcome (CREATE_OBJECT)
    const output = buildPassingOutput(fixture);
    output.objectMutations = [{ type: "CREATE_OBJECT" }];
    const results = scoreCase(fixture, output);
    const forbiddenResult = results.find((r) => r.scorerName === "ForbiddenOutcomeViolations");
    expect(forbiddenResult!.passed).toBe(false);
  });

  it("structural invariant violations force failure", () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const output = buildPassingOutput(fixture);
    // Add duplicate structural mutations
    output.structuralMutations = [
      { type: "ADD_CHILD_OF", parentObjectId: "obj-110" },
      { type: "ADD_CHILD_OF", parentObjectId: "obj-110" },
    ];
    const results = scoreCase(fixture, output);
    const structResult = results.find((r) => r.scorerName === "StructuralInvariantViolations");
    expect(structResult!.passed).toBe(false);
  });

  it("wrong primary object fails identity resolution", () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const output = buildPassingOutput(fixture);
    output.identity = { ...output.identity, finalPrimaryObjectId: "obj-110" }; // Wrong
    const results = scoreCase(fixture, output);
    const identityResult = results.find((r) => r.scorerName === "IdentityResolution");
    expect(identityResult!.passed).toBe(false);
  });
});

describe("Replay Adapter", () => {
  it("returns configured output for known fixture", async () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const output = buildPassingOutput(fixture);
    const adapter = createReplayAdapter(new Map([["SMT-001", output]]));

    const result = await adapter.run({ fixture, constitutionText: "test", constitutionVersion: "1.0" });
    expect(result.parsedOutput).not.toBeNull();
    expect(result.parseErrors.length).toBe(0);
  });

  it("reports error for unknown fixture", async () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const adapter = createReplayAdapter(new Map());

    const result = await adapter.run({ fixture, constitutionText: "test", constitutionVersion: "1.0" });
    expect(result.parsedOutput).toBeNull();
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it("replay results are clearly infrastructure-only", () => {
    const adapter = createReplayAdapter(new Map());
    expect(adapter.provider).toBe("replay");
    expect(adapter.model).toBe("deterministic-fixture");
  });
});

describe("Runner", () => {
  it("runs a single case with replay adapter", async () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const output = buildPassingOutput(fixture);
    const adapter = createReplayAdapter(new Map([["SMT-001", output]]));

    const result = await runSingleCase(fixture, adapter, "test constitution", "1.0");
    expect(result.passed).toBe(true);
    expect(result.constitutionVersion).toBe("1.0");
    expect(result.constitutionHash.length).toBeGreaterThan(0);
    expect(result.provider).toBe("replay");
  });

  it("records constitution version and hash", async () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const output = buildPassingOutput(fixture);
    const adapter = createReplayAdapter(new Map([["SMT-001", output]]));

    const result = await runSingleCase(fixture, adapter, "test constitution v2", "2.0");
    expect(result.constitutionVersion).toBe("2.0");
    expect(result.constitutionHash).not.toBe("");
  });

  it("runs experiment with all golden fixtures", async () => {
    const { items } = loadGoldenFixtures();
    const outputs = new Map(items.map((f) => [f.id, buildPassingOutput(f)]));
    const adapter = createReplayAdapter(outputs);

    const experiment = await runExperiment({
      mode: "semantic-decision",
      provider: "replay",
      model: "deterministic-fixture",
      adapter,
      constitutionText: "test",
      constitutionVersion: "1.0",
    });

    expect(experiment.cases.length).toBe(10);
    expect(experiment.summary.goldenCasePassRate).toBe(1);
  });

  it("repeat-run consistency calculated correctly", async () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const output = buildPassingOutput(fixture);
    const adapter = createReplayAdapter(new Map([["SMT-001", output]]));

    const experiment = await runExperiment({
      mode: "semantic-decision",
      provider: "replay",
      model: "deterministic-fixture",
      adapter,
      constitutionText: "test",
      constitutionVersion: "1.0",
      repeat: 3,
      fixtureIds: ["SMT-001"],
    });

    expect(experiment.cases.length).toBe(3);
    expect(experiment.summary.repeatRunConsistency).toBe(1); // All same result
  });

  it("unavailable provider fails cleanly", async () => {
    const fixture = loadGoldenFixture("SMT-001")!;
    const adapter = { provider: "unavailable", model: "none", available: false, run: async () => ({ rawOutput: "", parsedOutput: null, latencyMs: 0, parseErrors: [], providerErrors: [] }) };

    const result = await runSingleCase(fixture, adapter, "test", "1.0");
    expect(result.passed).toBe(false);
    expect(result.providerErrors.length).toBeGreaterThan(0);
  });
});
