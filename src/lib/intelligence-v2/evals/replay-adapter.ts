/**
 * Deterministic Replay Adapter.
 *
 * Returns supplied structured test outputs to exercise:
 * loader → runner → parser → scorer → aggregation → reporting
 *
 * This adapter NEVER represents evidence of semantic-model quality.
 * It exists only to prove the harness infrastructure works.
 */

import type { ModelAdapter, EvalRunInput, EvalRunOutput, EvalModelOutput } from "./types";

/**
 * Create a replay adapter that returns a fixed output for testing.
 */
export function createReplayAdapter(fixedOutputs: Map<string, EvalModelOutput>): ModelAdapter {
  return {
    provider: "replay",
    model: "deterministic-fixture",
    available: true,
    async run(input: EvalRunInput): Promise<EvalRunOutput> {
      const start = Date.now();
      const output = fixedOutputs.get(input.fixture.id);

      if (!output) {
        return {
          rawOutput: "",
          parsedOutput: null,
          latencyMs: Date.now() - start,
          parseErrors: [`No replay output configured for fixture ${input.fixture.id}`],
          providerErrors: [],
        };
      }

      const rawOutput = JSON.stringify(output, null, 2);

      return {
        rawOutput,
        parsedOutput: output,
        latencyMs: Date.now() - start,
        inputTokens: rawOutput.length,
        outputTokens: rawOutput.length,
        parseErrors: [],
        providerErrors: [],
      };
    },
  };
}

/**
 * Build a passing replay output for a given fixture (matches expected trace/mutations exactly).
 */
export function buildPassingOutput(fixture: import("./types").EvalFixture): EvalModelOutput {
  return {
    durableSemanticSignificance: fixture.expectedTrace.durableSemanticSignificance,
    identity: fixture.expectedTrace.identity,
    crossObjectImpacts: fixture.expectedTrace.crossObjectImpacts ?? [],
    objectMutations: fixture.expectedMutationSet.objectMutations,
    structuralMutations: fixture.expectedMutationSet.structuralMutations,
    relationshipMutations: fixture.expectedMutationSet.relationshipMutations,
    propositionStateMutations: fixture.expectedMutationSet.propositionStateMutations,
    restructuringSignals: fixture.expectedMutationSet.restructuringSignals,
  };
}
