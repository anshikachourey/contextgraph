import { cosineSimilarity } from "./cosineSimilarity";
import { POSSIBLY_RELATED_THRESHOLD } from "./similarityThresholds";
import { complete } from "@/src/lib/ai";
import { EDGE_MODEL } from "@/src/lib/ai/models";
import type { SuggestedEdge } from "@/src/types/edge";

const MAX_CANDIDATES_PER_NODE = 3;

// ─── Input types ────────────────────────────────────────────────────────────

export type NodeForSuggestion = {
  id: string;
  title: string;
  summary: string;
  evidenceSummary: string | null;
  embedding: number[] | null;
};

// ─── Candidate selection (pure, no LLM) ─────────────────────────────────────

type Candidate = {
  sourceNodeId: string;
  targetNodeId: string;
  similarity: number;
};

/**
 * Select candidate edges based on embedding similarity.
 *
 * Algorithm:
 * 1. Compute all pairwise similarities (skip nodes without embeddings).
 * 2. Filter below POSSIBLY_RELATED_THRESHOLD.
 * 3. For each node, keep only the top MAX_CANDIDATES_PER_NODE neighbors.
 * 4. Deduplicate: each unordered pair appears exactly once.
 *
 * Returns candidates sorted by similarity descending.
 */
export function selectCandidates(nodes: NodeForSuggestion[]): Candidate[] {
  const withEmbeddings = nodes.filter(
    (n): n is NodeForSuggestion & { embedding: number[] } =>
      n.embedding !== null && n.embedding.length > 0,
  );

  // Compute all pairwise scores
  type ScoredPair = { a: string; b: string; score: number };
  const allPairs: ScoredPair[] = [];

  for (let i = 0; i < withEmbeddings.length; i++) {
    for (let j = i + 1; j < withEmbeddings.length; j++) {
      const score = cosineSimilarity(
        withEmbeddings[i].embedding,
        withEmbeddings[j].embedding,
      );
      if (score >= POSSIBLY_RELATED_THRESHOLD) {
        allPairs.push({ a: withEmbeddings[i].id, b: withEmbeddings[j].id, score });
      }
    }
  }

  // For each node, keep only top N candidates
  const topPerNode = new Map<string, ScoredPair[]>();

  for (const pair of allPairs) {
    // Register pair for both sides
    for (const nodeId of [pair.a, pair.b]) {
      const existing = topPerNode.get(nodeId) ?? [];
      existing.push(pair);
      topPerNode.set(nodeId, existing);
    }
  }

  // Trim each node's list to top N by score
  for (const [nodeId, pairs] of topPerNode) {
    pairs.sort((x, y) => y.score - x.score);
    topPerNode.set(nodeId, pairs.slice(0, MAX_CANDIDATES_PER_NODE));
  }

  // Collect unique pairs from all top-N lists
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const pairs of topPerNode.values()) {
    for (const pair of pairs) {
      // Canonical key: alphabetically smaller ID first
      const key = pair.a < pair.b ? `${pair.a}|${pair.b}` : `${pair.b}|${pair.a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        sourceNodeId: pair.a,
        targetNodeId: pair.b,
        similarity: pair.score,
      });
    }
  }

  return candidates.sort((a, b) => b.similarity - a.similarity);
}

// ─── LLM explanation ────────────────────────────────────────────────────────

/**
 * Generate a one-sentence explanation of why two nodes are semantically related.
 */
export async function generateEdgeExplanation(
  nodeA: Pick<NodeForSuggestion, "title" | "summary" | "evidenceSummary">,
  nodeB: Pick<NodeForSuggestion, "title" | "summary" | "evidenceSummary">,
): Promise<string> {
  function formatNode(
    label: string,
    n: Pick<NodeForSuggestion, "title" | "summary" | "evidenceSummary">,
  ): string {
    const parts = [`${label} Title: ${n.title}`];
    if (n.summary) parts.push(`${label} Summary: ${n.summary}`);
    if (n.evidenceSummary) parts.push(`${label} Evidence: ${n.evidenceSummary}`);
    return parts.join("\n");
  }

  const prompt = `You are given two knowledge nodes from the same conversation.
They have already been identified as semantically related via embedding similarity.
Your job is to explain HOW they are related in exactly one concise sentence.

Do NOT say whether they are related — that is already known.
Focus on the specific conceptual connection.

${formatNode("Node A", nodeA)}

${formatNode("Node B", nodeB)}

Write one sentence explaining the relationship:`;

  const result = await complete({
    model: EDGE_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
    maxTokens: 100,
  });

  return result.content.trim();
}

// ─── Full suggestion pipeline ───────────────────────────────────────────────

/**
 * Generate suggested edges with explanations for a set of nodes.
 *
 * This calls the LLM once per candidate edge. For cost control during
 * validation, the debug page calls this on-demand rather than automatically.
 */
export async function computeSuggestedEdges(
  nodes: NodeForSuggestion[],
): Promise<SuggestedEdge[]> {
  const candidates = selectCandidates(nodes);

  if (candidates.length === 0) return [];

  // Build a lookup for node data
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Generate explanations in parallel (bounded concurrency isn't needed
  // at debug scale — typically ≤ 10 candidates max)
  const suggestions = await Promise.all(
    candidates.map(async (candidate) => {
      const nodeA = nodeMap.get(candidate.sourceNodeId);
      const nodeB = nodeMap.get(candidate.targetNodeId);

      let explanation = "";
      if (nodeA && nodeB) {
        try {
          explanation = await generateEdgeExplanation(nodeA, nodeB);
        } catch (err) {
          console.error(
            `[edgeSuggestions] Explanation failed for ${nodeA.title} ↔ ${nodeB.title}:`,
            err,
          );
          explanation = "(explanation generation failed)";
        }
      }

      return {
        sourceNodeId: candidate.sourceNodeId,
        targetNodeId: candidate.targetNodeId,
        similarity: candidate.similarity,
        explanation,
      } satisfies SuggestedEdge;
    }),
  );

  return suggestions;
}
