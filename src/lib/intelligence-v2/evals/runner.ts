/**
 * Eval Runner — Executes fixtures against model adapters and produces scored results.
 */

import type { EvalFixture, EvalCaseResult, EvalExperimentResult, EvalSummary, ModelAdapter, EvalModelOutput } from "./types";
import { scoreCase, applyPassRule } from "./scorers";
import { loadGoldenFixtures, loadGoldenFixture } from "./loader";
import { createHash } from "crypto";

export type EvalMode = "semantic-decision" | "fixture-pipeline" | "sequence";

export interface RunOptions {
  mode: EvalMode;
  provider: string;
  model: string;
  adapter: ModelAdapter;
  constitutionText: string;
  constitutionVersion: string;
  repeat?: number;
  fixtureIds?: string[];
}

/**
 * Run a single fixture and return a scored result.
 */
export async function runSingleCase(
  fixture: EvalFixture,
  adapter: ModelAdapter,
  constitutionText: string,
  constitutionVersion: string,
): Promise<EvalCaseResult> {
  const constitutionHash = createHash("sha256").update(constitutionText).digest("hex").slice(0, 12);

  if (!adapter.available) {
    return {
      fixtureId: fixture.id,
      provider: adapter.provider,
      model: adapter.model,
      constitutionVersion,
      constitutionHash,
      rawModelOutput: "",
      parsedOutput: null,
      scorerResults: [],
      passed: false,
      latencyMs: 0,
      parseErrors: [],
      schemaErrors: [],
      providerErrors: [`Provider ${adapter.provider} is unavailable`],
    };
  }

  const runOutput = await adapter.run({ fixture, constitutionText, constitutionVersion });

  const parsedOutput = runOutput.parsedOutput;
  const scorerResults = parsedOutput ? scoreCase(fixture, parsedOutput) : [];
  const passed = parsedOutput ? applyPassRule(fixture, scorerResults) : false;

  return {
    fixtureId: fixture.id,
    provider: adapter.provider,
    model: adapter.model,
    constitutionVersion,
    constitutionHash,
    rawModelOutput: runOutput.rawOutput,
    parsedOutput,
    scorerResults,
    passed,
    latencyMs: runOutput.latencyMs,
    inputTokens: runOutput.inputTokens,
    outputTokens: runOutput.outputTokens,
    parseErrors: runOutput.parseErrors,
    schemaErrors: [],
    providerErrors: runOutput.providerErrors,
  };
}

/**
 * Run an experiment: multiple fixtures, optionally repeated.
 */
export async function runExperiment(options: RunOptions): Promise<EvalExperimentResult> {
  const constitutionHash = createHash("sha256").update(options.constitutionText).digest("hex").slice(0, 12);
  const repeat = options.repeat ?? 1;

  // Load fixtures
  let fixtures: EvalFixture[];
  if (options.fixtureIds && options.fixtureIds.length > 0) {
    fixtures = options.fixtureIds
      .map((id) => loadGoldenFixture(id))
      .filter((f): f is EvalFixture => f !== null);
  } else {
    const { items } = loadGoldenFixtures();
    fixtures = items;
  }

  // Filter by mode
  if (options.mode === "sequence") {
    fixtures = fixtures.filter((f) => f.executionMode === "SEQUENCE");
  }

  // Run all cases
  const allCases: EvalCaseResult[] = [];
  for (let r = 0; r < repeat; r++) {
    for (const fixture of fixtures) {
      const result = await runSingleCase(fixture, options.adapter, options.constitutionText, options.constitutionVersion);
      allCases.push(result);
    }
  }

  const summary = computeSummary(allCases, repeat);

  return {
    experimentId: `exp-${Date.now()}`,
    timestamp: new Date().toISOString(),
    constitutionVersion: options.constitutionVersion,
    constitutionHash,
    provider: options.provider,
    model: options.model,
    cases: allCases,
    summary,
  };
}

function computeSummary(cases: EvalCaseResult[], repeat: number): EvalSummary {
  const total = cases.length;
  const passed = cases.filter((c) => c.passed).length;

  // Per-scorer accuracy
  const identityChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "IdentityResolution")?.checks ?? []);
  const wideningChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "IdentityWidening")?.checks ?? []);
  const parentChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "CanonicalParent")?.checks ?? []);
  const crossChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "CrossObjectImpact")?.checks ?? []);
  const relChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "RelationshipDecision")?.checks ?? []);
  const supersessionChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "Supersession")?.checks ?? []);
  const restructChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "RestructuringSignal")?.checks ?? []);
  const forbiddenChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "ForbiddenOutcomeViolations")?.checks ?? []);
  const structInvChecks = cases.flatMap((c) => c.scorerResults.find((r) => r.scorerName === "StructuralInvariantViolations")?.checks ?? []);

  const acc = (checks: typeof identityChecks) => checks.length === 0 ? 1 : checks.filter((c) => c.passed).length / checks.length;

  // Repeat-run consistency: for each fixture, check if all runs gave same result
  const fixtureIds = [...new Set(cases.map((c) => c.fixtureId))];
  let consistentFixtures = 0;
  for (const fid of fixtureIds) {
    const runs = cases.filter((c) => c.fixtureId === fid);
    const allSame = runs.every((r) => r.passed === runs[0].passed);
    if (allSame) consistentFixtures++;
  }

  return {
    goldenCasePassRate: total > 0 ? passed / total : 0,
    variantPassRate: 0, // Computed separately for variant experiments
    identityAccuracy: acc(identityChecks),
    identityWideningAccuracy: acc(wideningChecks),
    parentAccuracy: acc(parentChecks),
    parentWideningAccuracy: 0,
    crossObjectImpactAccuracy: acc(crossChecks),
    relationshipPrecision: acc(relChecks),
    supersessionAccuracy: acc(supersessionChecks),
    restructuringSignalAccuracy: acc(restructChecks),
    forbiddenOutcomeRate: 1 - acc(forbiddenChecks),
    structuralInvariantViolationRate: 1 - acc(structInvChecks),
    repeatRunConsistency: fixtureIds.length > 0 ? consistentFixtures / fixtureIds.length : 1,
    avgLatencyMs: total > 0 ? cases.reduce((s, c) => s + c.latencyMs, 0) / total : 0,
    totalInputTokens: cases.reduce((s, c) => s + (c.inputTokens ?? 0), 0),
    totalOutputTokens: cases.reduce((s, c) => s + (c.outputTokens ?? 0), 0),
    totalEstimatedCost: cases.reduce((s, c) => s + (c.estimatedCost ?? 0), 0),
  };
}
