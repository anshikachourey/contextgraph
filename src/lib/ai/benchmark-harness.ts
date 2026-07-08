/**
 * AI Provider Benchmark Harness.
 *
 * Runs the same conversation through different providers/models
 * and scores the resulting graph quality side-by-side.
 *
 * Usage:
 *   Call from /api/debug/ai-benchmark or from tests.
 */

import { complete, embed, type CompletionOptions } from "./provider";
import { evaluateGraphQuality, type GraphSnapshot } from "../intelligence/benchmark";

export type BenchmarkConfig = {
  /** Label for this run */
  label: string;
  /** Provider override for this run */
  provider?: "openai" | "anthropic";
  /** Model to use for node generation */
  nodeModel: string;
  /** Model to use for edge generation */
  edgeModel: string;
  /** Model to use for synthesis */
  synthesisModel: string;
};

export type BenchmarkRunResult = {
  label: string;
  nodeModel: string;
  edgeModel: string;
  synthesisModel: string;
  scores: ReturnType<typeof evaluateGraphQuality>;
  nodesGenerated: number;
  edgesGenerated: number;
  latencyMs: number;
};

/**
 * Default benchmark configurations for comparison.
 */
export const DEFAULT_CONFIGS: BenchmarkConfig[] = [
  {
    label: "GPT-4o-mini (current)",
    nodeModel: "gpt-4o-mini",
    edgeModel: "gpt-4o-mini",
    synthesisModel: "gpt-4o-mini",
  },
  {
    label: "GPT-4o (high quality)",
    nodeModel: "gpt-4o",
    edgeModel: "gpt-4o",
    synthesisModel: "gpt-4o",
  },
  {
    label: "Claude 3.5 Sonnet",
    provider: "anthropic",
    nodeModel: "claude-sonnet-4-20250514",
    edgeModel: "claude-sonnet-4-20250514",
    synthesisModel: "claude-sonnet-4-20250514",
  },
];

/**
 * Run a single benchmark configuration against a graph snapshot.
 * Returns quality scores.
 *
 * NOTE: This evaluates an EXISTING graph — it doesn't re-generate nodes.
 * For full re-generation benchmarks, use the /api/debug/ai-benchmark endpoint
 * which processes conversations end-to-end with different models.
 */
export function evaluateExistingGraph(graph: GraphSnapshot): ReturnType<typeof evaluateGraphQuality> {
  return evaluateGraphQuality(graph);
}

/**
 * Format benchmark results for comparison.
 */
export function formatBenchmarkComparison(results: BenchmarkRunResult[]): string {
  const header = "| Config | Title | Summary | Edge | Segmentation | Recall | Overall |";
  const separator = "|--------|-------|---------|------|-------------|--------|---------|";

  const rows = results.map((r) =>
    `| ${r.label} | ${r.scores.titleQuality} | ${r.scores.summaryQuality} | ${r.scores.edgeQuality} | ${r.scores.segmentation} | ${r.scores.recallTest} | ${r.scores.overall} |`
  );

  return [header, separator, ...rows].join("\n");
}
