/**
 * Benchmark evaluation utility.
 *
 * Scores engine output against predefined quality standards.
 * Used by /api/debug/benchmark endpoint and tests.
 */

// ─── Shallow detection patterns ─────────────────────────────────────────────

const SHALLOW_TITLE_PATTERNS = [
  /^exploring\b/i,
  /^discussion about\b/i,
  /^understanding\b/i,
  /^overview of\b/i,
  /^talking about\b/i,
  /^analysis of\b/i,
  /^examination of\b/i,
  /^learning about\b/i,
];

const SHALLOW_SUMMARY_PATTERNS = [
  /^(they |the user |we )?(discussed|talked about|explored|examined)/i,
  /^discussion about/i,
  /^a conversation about/i,
  /^messages about/i,
];

// ─── Scoring ────────────────────────────────────────────────────────────────

export interface BenchmarkScore {
  titleQuality: number;       // 1-5
  summaryQuality: number;     // 1-5
  edgeQuality: number;        // 1-5
  segmentation: number;       // 1-5
  recallTest: number;         // 1-5
  overall: number;            // average
  details: {
    titles: Array<{ title: string; score: number; reason: string }>;
    summaries: Array<{ summary: string; score: number; reason: string }>;
    edges: Array<{ type: string; explanation: string; score: number; reason: string }>;
    nodeCount: number;
    edgeCount: number;
  };
}

export interface GraphSnapshot {
  nodes: Array<{ id: string; title: string; summary: string }>;
  edges: Array<{ sourceNodeId: string; targetNodeId: string; relationshipType: string; explanation: string }>;
}

/**
 * Score a graph snapshot against quality standards.
 * Does NOT require a benchmark definition — evaluates intrinsic quality.
 */
export function evaluateGraphQuality(graph: GraphSnapshot): BenchmarkScore {
  const titleScores: BenchmarkScore["details"]["titles"] = [];
  const summaryScores: BenchmarkScore["details"]["summaries"] = [];
  const edgeScores: BenchmarkScore["details"]["edges"] = [];

  // Score titles
  for (const node of graph.nodes) {
    const isShallow = SHALLOW_TITLE_PATTERNS.some((p) => p.test(node.title));
    const isLong = node.title.length > 30;
    const hasDepth = /\b(why|how|through|beyond|beneath|within|between|toward)\b/i.test(node.title);

    let score = 3; // default acceptable
    let reason = "acceptable";

    if (isShallow) {
      score = 1;
      reason = "topic-label pattern detected";
    } else if (!isLong) {
      score = 2;
      reason = "too short to convey insight";
    } else if (hasDepth) {
      score = 5;
      reason = "captures depth/insight";
    } else {
      score = 3;
      reason = "adequate but could be more insightful";
    }

    titleScores.push({ title: node.title, score, reason });
  }

  // Score summaries
  for (const node of graph.nodes) {
    const isShallow = SHALLOW_SUMMARY_PATTERNS.some((p) => p.test(node.summary));
    const isLong = node.summary.length > 100;
    const hasConclusion = /\b(realized|concluded|discovered|understood|learned|insight|realization|shift)\b/i.test(node.summary);

    let score = 3;
    let reason = "acceptable";

    if (isShallow) {
      score = 1;
      reason = "message-replay pattern detected";
    } else if (!isLong) {
      score = 2;
      reason = "too brief to articulate insight";
    } else if (hasConclusion) {
      score = 5;
      reason = "articulates conclusion/realization";
    } else {
      score = 3;
      reason = "adequate description but lacks explicit insight";
    }

    summaryScores.push({ summary: node.summary.slice(0, 60) + "...", score, reason });
  }

  // Score edges
  for (const edge of graph.edges) {
    const isMeaningless = edge.relationshipType === "related" || edge.relationshipType === "";
    const hasExplanation = edge.explanation.length > 15;
    const isVerbPhrase = edge.relationshipType.split(" ").length >= 2;

    let score = 3;
    let reason = "acceptable";

    if (isMeaningless && !hasExplanation) {
      score = 1;
      reason = "no semantic meaning";
    } else if (isMeaningless) {
      score = 2;
      reason = "has explanation but generic type";
    } else if (isVerbPhrase && hasExplanation) {
      score = 5;
      reason = "meaningful verb-phrase type + explanation";
    } else if (isVerbPhrase) {
      score = 4;
      reason = "good type, could use better explanation";
    }

    edgeScores.push({
      type: edge.relationshipType,
      explanation: edge.explanation.slice(0, 40) + "...",
      score,
      reason,
    });
  }

  // Segmentation score (based on node count heuristic)
  let segmentation = 3;
  if (graph.nodes.length === 0) segmentation = 1;
  else if (graph.nodes.length === 1) segmentation = 2;
  else if (graph.nodes.length >= 2 && graph.nodes.length <= 4) segmentation = 4;
  else if (graph.nodes.length > 6) segmentation = 2;

  // Recall test (heuristic: combination of title quality + edges present)
  const avgTitle = titleScores.length > 0
    ? titleScores.reduce((s, t) => s + t.score, 0) / titleScores.length
    : 1;
  const avgEdge = edgeScores.length > 0
    ? edgeScores.reduce((s, e) => s + e.score, 0) / edgeScores.length
    : 1;
  const recallTest = Math.round((avgTitle + avgEdge + segmentation) / 3);

  const titleQuality = titleScores.length > 0
    ? Math.round(titleScores.reduce((s, t) => s + t.score, 0) / titleScores.length)
    : 1;
  const summaryQuality = summaryScores.length > 0
    ? Math.round(summaryScores.reduce((s, t) => s + t.score, 0) / summaryScores.length)
    : 1;
  const edgeQuality = edgeScores.length > 0
    ? Math.round(edgeScores.reduce((s, e) => s + e.score, 0) / edgeScores.length)
    : 1;

  const overall = parseFloat(
    ((titleQuality + summaryQuality + edgeQuality + segmentation + recallTest) / 5).toFixed(1),
  );

  return {
    titleQuality,
    summaryQuality,
    edgeQuality,
    segmentation,
    recallTest,
    overall,
    details: {
      titles: titleScores,
      summaries: summaryScores,
      edges: edgeScores,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    },
  };
}
