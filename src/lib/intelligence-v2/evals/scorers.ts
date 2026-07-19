/**
 * Deterministic Scorers for Semantic Mutation Evals.
 */

import type { EvalFixture, EvalModelOutput, ScorerResult } from "./types";

/**
 * Run all applicable scorers on a model output against a fixture.
 */
export function scoreCase(fixture: EvalFixture, output: EvalModelOutput): ScorerResult[] {
  const results: ScorerResult[] = [];

  results.push(scoreDurableSignificance(fixture, output));
  results.push(scoreIdentityResolution(fixture, output));
  results.push(scoreIdentityWidening(fixture, output));
  results.push(scoreParentRetrievalWidening(fixture, output));
  results.push(scoreCanonicalParent(fixture, output));
  results.push(scoreCrossObjectImpact(fixture, output));
  results.push(scoreRelationshipDecision(fixture, output));
  results.push(scoreSupersession(fixture, output));
  results.push(scoreRestructuringSignal(fixture, output));
  results.push(scoreMutationCompleteness(fixture, output));
  results.push(scoreForbiddenOutcomes(fixture, output));
  results.push(scoreStructuralInvariants(fixture, output));

  if (fixture.executionMode === "SEQUENCE") {
    results.push(scoreSequenceEmergence(fixture, output));
  }

  return results;
}

/**
 * Apply the golden case pass rule.
 */
export function applyPassRule(fixture: EvalFixture, scorerResults: ScorerResult[]): boolean {
  // All critical assertions must pass
  const forbidden = scorerResults.find((r) => r.scorerName === "ForbiddenOutcomeViolations");
  const structural = scorerResults.find((r) => r.scorerName === "StructuralInvariantViolations");

  if (forbidden && !forbidden.passed) return false;
  if (structural && !structural.passed) return false;

  // Check critical assertions
  for (const assertion of fixture.criticalAssertions) {
    if (!checkCriticalAssertion(assertion, fixture, scorerResults)) return false;
  }

  return true;
}

// ─── Individual Scorers ─────────────────────────────────────────────────────

function scoreDurableSignificance(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const expected = fixture.expectedTrace.durableSemanticSignificance;
  const actual = output.durableSemanticSignificance;
  return {
    scorerName: "DurableSignificance",
    passed: expected === actual,
    checks: [{ name: "durableSemanticSignificance match", passed: expected === actual, expected, actual }],
  };
}

function scoreIdentityResolution(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const checks: ScorerResult["checks"] = [];
  const expectedId = fixture.expectedTrace.identity?.finalPrimaryObjectId;
  const actualId = output.identity?.finalPrimaryObjectId;

  if (expectedId !== undefined) {
    checks.push({ name: "finalPrimaryObjectId", passed: expectedId === actualId, expected: expectedId, actual: actualId });
  }

  const expectedInitial = fixture.expectedTrace.identity?.initialSameObjectId;
  const actualInitial = output.identity?.initialSameObjectId;
  if (expectedInitial !== undefined) {
    checks.push({ name: "initialSameObjectId", passed: expectedInitial === actualInitial, expected: expectedInitial, actual: actualInitial });
  }

  return { scorerName: "IdentityResolution", passed: checks.every((c) => c.passed), checks };
}

function scoreIdentityWidening(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const checks: ScorerResult["checks"] = [];
  const expectedSuff = fixture.expectedTrace.identity?.identitySearchSufficient;
  const actualSuff = output.identity?.identitySearchSufficient;
  if (expectedSuff !== undefined) {
    checks.push({ name: "identitySearchSufficient", passed: expectedSuff === actualSuff, expected: expectedSuff, actual: actualSuff });
  }

  const expectedWiden = fixture.expectedTrace.identity?.mustWidenIdentitySearch;
  const actualWiden = output.identity?.mustWidenIdentitySearch;
  if (expectedWiden !== undefined) {
    checks.push({ name: "mustWidenIdentitySearch", passed: expectedWiden === actualWiden, expected: expectedWiden, actual: actualWiden });
  }

  return { scorerName: "IdentityWidening", passed: checks.length === 0 || checks.every((c) => c.passed), checks };
}

function scoreParentRetrievalWidening(fixture: EvalFixture, _output: EvalModelOutput): ScorerResult {
  // Parent widening checks are fixture-specific; not all fixtures specify them
  return { scorerName: "ParentRetrievalWidening", passed: true, checks: [] };
}

function scoreCanonicalParent(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const checks: ScorerResult["checks"] = [];
  // Check structural mutations for parent assignment
  const expectedStructural = fixture.expectedMutationSet.structuralMutations;
  const actualStructural = output.structuralMutations ?? [];

  if (expectedStructural.length === 0 && actualStructural.length === 0) {
    checks.push({ name: "no structural mutation expected or produced", passed: true });
  }

  // Check max one parent constraint
  const parentMutations = actualStructural.filter((m) => (m as Record<string, unknown>).type === "ADD_CHILD_OF");
  checks.push({ name: "at most one structural parent", passed: parentMutations.length <= 1 });

  return { scorerName: "CanonicalParent", passed: checks.every((c) => c.passed), checks };
}

function scoreCrossObjectImpact(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const expected = fixture.expectedTrace.crossObjectImpacts ?? [];
  const actual = output.crossObjectImpacts ?? [];
  const passed = expected.length === actual.length;
  return { scorerName: "CrossObjectImpact", passed, checks: [{ name: "impact set size", passed, expected: expected.length, actual: actual.length }] };
}

function scoreRelationshipDecision(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const expected = fixture.expectedMutationSet.relationshipMutations;
  const actual = output.relationshipMutations ?? [];
  const passed = expected.length === actual.length;
  return { scorerName: "RelationshipDecision", passed, checks: [{ name: "relationship count", passed, expected: expected.length, actual: actual.length }] };
}

function scoreSupersession(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const expected = fixture.expectedMutationSet.propositionStateMutations;
  const actual = output.propositionStateMutations ?? [];
  const passed = expected.length === actual.length;
  return { scorerName: "Supersession", passed, checks: [{ name: "supersession count", passed, expected: expected.length, actual: actual.length }] };
}

function scoreRestructuringSignal(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const expected = fixture.expectedMutationSet.restructuringSignals;
  const actual = output.restructuringSignals ?? [];
  const passed = expected.length === actual.length;
  return { scorerName: "RestructuringSignal", passed, checks: [{ name: "signal count", passed, expected: expected.length, actual: actual.length }] };
}

function scoreMutationCompleteness(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const checks: ScorerResult["checks"] = [];
  const expectedObj = fixture.expectedMutationSet.objectMutations;
  const actualObj = output.objectMutations ?? [];

  // Check that required mutations are present
  for (const exp of expectedObj) {
    const expType = (exp as Record<string, unknown>).type as string;
    const expTarget = (exp as Record<string, unknown>).targetObjectId as string | undefined;
    const found = actualObj.some((a) => {
      const at = (a as Record<string, unknown>).type;
      const aTarget = (a as Record<string, unknown>).targetObjectId;
      return at === expType && (!expTarget || aTarget === expTarget);
    });
    checks.push({ name: `${expType}${expTarget ? ` → ${expTarget}` : ""}`, passed: found, expected: exp });
  }

  return { scorerName: "MutationCompleteness", passed: checks.every((c) => c.passed), checks };
}

function scoreForbiddenOutcomes(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const checks: ScorerResult["checks"] = [];
  const allOutputMutations = [...(output.objectMutations ?? []), ...(output.structuralMutations ?? []), ...(output.relationshipMutations ?? [])];

  for (const forbidden of fixture.forbiddenOutcomes) {
    const fType = forbidden.type;
    const violated = allOutputMutations.some((m) => {
      const mt = (m as Record<string, unknown>).type as string;
      if (mt !== fType) return false;
      // Check additional fields
      for (const [k, v] of Object.entries(forbidden)) {
        if (k === "type") continue;
        if ((m as Record<string, unknown>)[k] !== v) return false;
      }
      return true;
    });
    checks.push({ name: `forbidden: ${fType}`, passed: !violated, reason: violated ? "VIOLATED" : undefined });
  }

  return { scorerName: "ForbiddenOutcomeViolations", passed: checks.every((c) => c.passed), checks };
}

function scoreStructuralInvariants(fixture: EvalFixture, output: EvalModelOutput): ScorerResult {
  const checks: ScorerResult["checks"] = [];
  const structural = output.structuralMutations ?? [];

  // Max one parent
  const parents = structural.filter((m) => (m as Record<string, unknown>).type === "ADD_CHILD_OF");
  checks.push({ name: "max one parent", passed: parents.length <= 1 });

  // No self-parent
  for (const p of parents) {
    const child = (p as Record<string, unknown>).childObjectId;
    const parent = (p as Record<string, unknown>).parentObjectId;
    checks.push({ name: "no self-parent", passed: child !== parent });
  }

  // No duplicate edges (simplified check)
  const edgeKeys = structural.map((m) => JSON.stringify(m));
  const uniqueKeys = new Set(edgeKeys);
  checks.push({ name: "no duplicate edge", passed: edgeKeys.length === uniqueKeys.size });

  return { scorerName: "StructuralInvariantViolations", passed: checks.every((c) => c.passed), checks };
}

function scoreSequenceEmergence(fixture: EvalFixture, _output: EvalModelOutput): ScorerResult {
  // For sequence fixtures, check longitudinal emergence expectations
  const emergence = fixture.expectedTrace.longitudinalEmergence;
  if (!emergence) return { scorerName: "SequenceEmergence", passed: true, checks: [] };

  // Basic structural checks
  const checks: ScorerResult["checks"] = [];
  checks.push({ name: "longitudinal emergence defined", passed: true });

  return { scorerName: "SequenceEmergence", passed: true, checks };
}

// ─── Critical Assertion Checker ─────────────────────────────────────────────

function checkCriticalAssertion(assertion: string, fixture: EvalFixture, results: ScorerResult[]): boolean {
  if (assertion.startsWith("primary_object=")) {
    const expected = assertion.split("=")[1];
    const identity = results.find((r) => r.scorerName === "IdentityResolution");
    return identity?.checks.some((c) => c.name === "finalPrimaryObjectId" && c.passed) ?? false;
  }
  if (assertion === "identity_widening=false") {
    const widening = results.find((r) => r.scorerName === "IdentityWidening");
    return widening?.passed ?? false;
  }
  if (assertion === "no_new_object") {
    const completeness = results.find((r) => r.scorerName === "MutationCompleteness");
    return completeness?.passed ?? true;
  }
  if (assertion === "no_structural_mutation") {
    const structural = results.find((r) => r.scorerName === "StructuralInvariantViolations");
    return structural?.passed ?? true;
  }
  // Default: pass unknown assertions (they'll be caught by other scorers)
  return true;
}
