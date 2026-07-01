/**
 * Node Evolution Engine — detection heuristics.
 *
 * Pure functions that compare embeddings and produce typed suggestions.
 * No side effects, no DB access, no API calls.
 * The API route orchestrates loading data and calling these.
 */

import { cosineSimilarity } from "./cosineSimilarity";
import {
  EXTEND_SUGGEST_THRESHOLD,
  EXTEND_WINDOW_SIZE,
  MERGE_THRESHOLD,
  PARENT_MIN_CLUSTER_SIZE,
  PARENT_INTRA_SIMILARITY,
} from "./evolutionConfig";
import type { ChatMessage } from "@/src/types/message";
import type { SemanticEdge } from "@/src/types/edge";
import type {
  NodeWithEmbedding,
  EmbeddedWindow,
  ExtendNodeSuggestion,
  MergeSuggestion,
  ParentSuggestion,
} from "@/src/types/evolution";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Map a raw score into [0, 1] confidence given min/max range. */
function normalizeConfidence(score: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (score - min) / (max - min)));
}

// ─── extend_node detection ──────────────────────────────────────────────────

/**
 * Build non-overlapping windows of consecutive unlinked messages.
 * Only includes messages NOT already linked to any node.
 */
export function buildUnlinkedWindows(
  messages: ChatMessage[],
  linkedMessageIds: Set<string>,
  windowSize: number = EXTEND_WINDOW_SIZE,
): ChatMessage[][] {
  // Filter to only unlinked messages, preserving conversation order
  const unlinked = messages.filter(
    (m) => !linkedMessageIds.has(m.id) && !m.parentNodeId,
  );

  const windows: ChatMessage[][] = [];
  for (let i = 0; i <= unlinked.length - windowSize; i += windowSize) {
    windows.push(unlinked.slice(i, i + windowSize));
  }

  return windows;
}

/**
 * Detect messages that should extend an existing node.
 * For each unlinked window, find the most similar node.
 */
export function detectExtendNode(
  windows: EmbeddedWindow[],
  nodes: NodeWithEmbedding[],
): ExtendNodeSuggestion[] {
  const suggestions: ExtendNodeSuggestion[] = [];

  for (const window of windows) {
    let bestScore = 0;
    let bestNode: NodeWithEmbedding | null = null;

    for (const node of nodes) {
      if (!node.embedding || node.embedding.length === 0) continue;
      const score = cosineSimilarity(window.embedding, node.embedding);
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    if (bestNode && bestScore >= EXTEND_SUGGEST_THRESHOLD) {
      suggestions.push({
        id: crypto.randomUUID(),
        action: "extend_node",
        targetNodeId: bestNode.id,
        messageIds: window.messageIds,
        similarityScore: bestScore,
        confidence: normalizeConfidence(bestScore, EXTEND_SUGGEST_THRESHOLD, 1.0),
        reason: `Recent messages are related to "${bestNode.title}" (${(bestScore * 100).toFixed(0)}% similarity)`,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return suggestions;
}

// ─── suggest_merge detection ────────────────────────────────────────────────

/**
 * Detect pairs of nodes that may be duplicates.
 * Very high threshold — only near-identical topics trigger this.
 */
export function detectMergeCandidates(
  nodes: NodeWithEmbedding[],
): MergeSuggestion[] {
  const suggestions: MergeSuggestion[] = [];
  const withEmbeddings = nodes.filter((n) => n.embedding.length > 0);

  for (let i = 0; i < withEmbeddings.length; i++) {
    for (let j = i + 1; j < withEmbeddings.length; j++) {
      const nodeA = withEmbeddings[i];
      const nodeB = withEmbeddings[j];
      const similarity = cosineSimilarity(nodeA.embedding, nodeB.embedding);

      if (similarity >= MERGE_THRESHOLD) {
        suggestions.push({
          id: crypto.randomUUID(),
          action: "suggest_merge",
          nodeAId: nodeA.id,
          nodeBId: nodeB.id,
          similarityScore: similarity,
          confidence: normalizeConfidence(similarity, MERGE_THRESHOLD, 1.0),
          reason: `"${nodeA.title}" and "${nodeB.title}" cover very similar topics (${(similarity * 100).toFixed(0)}% overlap)`,
          proposedTitle: null,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  return suggestions;
}

// ─── suggest_parent detection ───────────────────────────────────────────────

/**
 * Find connected components in the semantic edge graph.
 * Returns groups of node IDs that are reachable from each other.
 */
function findConnectedComponents(
  nodeIds: string[],
  edges: SemanticEdge[],
): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());

  for (const edge of edges) {
    adj.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    adj.get(edge.targetNodeId)?.add(edge.sourceNodeId);
  }

  const visited = new Set<string>();
  const components: string[][] = [];

  for (const id of nodeIds) {
    if (visited.has(id)) continue;
    const component: string[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  return components;
}

/**
 * Detect groups of related nodes that may belong under a common parent topic.
 * Uses connected components in the edge graph + pairwise similarity check.
 */
export function detectParentCandidates(
  nodes: NodeWithEmbedding[],
  edges: SemanticEdge[],
): ParentSuggestion[] {
  const suggestions: ParentSuggestion[] = [];
  const nodeIds = nodes.filter((n) => n.embedding.length > 0).map((n) => n.id);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const components = findConnectedComponents(nodeIds, edges);

  for (const component of components) {
    if (component.length < PARENT_MIN_CLUSTER_SIZE) continue;

    // Compute average pairwise similarity within the component
    let totalSim = 0;
    let pairCount = 0;

    for (let i = 0; i < component.length; i++) {
      for (let j = i + 1; j < component.length; j++) {
        const nodeA = nodeMap.get(component[i]);
        const nodeB = nodeMap.get(component[j]);
        if (!nodeA || !nodeB) continue;
        if (nodeA.embedding.length === 0 || nodeB.embedding.length === 0) continue;
        totalSim += cosineSimilarity(nodeA.embedding, nodeB.embedding);
        pairCount++;
      }
    }

    if (pairCount === 0) continue;
    const avgSimilarity = totalSim / pairCount;

    if (avgSimilarity >= PARENT_INTRA_SIMILARITY) {
      const childTitles = component
        .map((id) => nodeMap.get(id)?.title ?? "")
        .filter(Boolean);

      const confidence = normalizeConfidence(
        avgSimilarity,
        PARENT_INTRA_SIMILARITY,
        1.0,
      );

      suggestions.push({
        id: crypto.randomUUID(),
        action: "suggest_parent",
        childNodeIds: component,
        proposedTitle: `Parent of: ${childTitles.slice(0, 3).join(", ")}${childTitles.length > 3 ? "…" : ""}`,
        avgSimilarity,
        confidence,
        reason: `${component.length} related nodes share ${(avgSimilarity * 100).toFixed(0)}% average similarity and could be grouped under a broader topic`,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return suggestions;
}
