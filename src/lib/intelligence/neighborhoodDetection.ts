/**
 * Neighborhood Detection Engine v2.
 *
 * Pure, deterministic algorithm. No database access.
 *
 * Strategy: Top-K adjacency + coherence guard.
 * 1. Compute pairwise similarities between all nodes.
 * 2. Build internal adjacency: edge exists only if
 *    similarity >= threshold AND at least one node considers
 *    the other a top-K nearest neighbor.
 * 3. Run connected components.
 * 4. For each component, check coherence (avg pairwise similarity).
 *    If below MIN_NEIGHBORHOOD_COHERENCE, iteratively remove the
 *    weakest-connected member until coherence passes.
 *
 * This prevents chain-merge: A-B-C won't form one component if
 * A↔C similarity is weak, because the coherence guard will split them.
 */

import { cosineSimilarity } from "@/src/lib/cosineSimilarity";

// ─── Config ─────────────────────────────────────────────────────────────────

/** Minimum pairwise similarity for an internal adjacency edge candidate. */
export const INTERNAL_ADJACENCY_THRESHOLD = 0.60;

/** Each node considers at most K nearest neighbors for adjacency. */
export const INTERNAL_ADJACENCY_TOP_K = 3;

/** Minimum avg pairwise similarity within a component to be a valid neighborhood. */
export const MIN_NEIGHBORHOOD_COHERENCE = 0.55;

/**
 * Minimum pairwise similarity between ANY two members of a neighborhood.
 * If any pair scores below this, the component must be split.
 * This prevents chain-merge where avg is acceptable but outlier pairs are terrible.
 */
export const MIN_PAIRWISE_SIM_IN_NEIGHBORHOOD = 0.45;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NeighborhoodNode {
  id: string;
  embedding: number[] | null;
}

export interface NeighborhoodEdge {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface NeighborhoodAssignment {
  neighborhoodId: string;
  nodeIds: string[];
  centroidEmbedding: number[];
  avgPairwiseSimilarity: number;
  minPairwiseSimilarity: number;
  internalEdgesUsed: number;
}

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Detect neighborhoods using top-K adjacency + coherence guard.
 */
export function detectNeighborhoodsFromEmbeddings(
  nodes: NeighborhoodNode[],
  threshold: number = INTERNAL_ADJACENCY_THRESHOLD,
  topK: number = INTERNAL_ADJACENCY_TOP_K,
  minCoherence: number = MIN_NEIGHBORHOOD_COHERENCE,
): { assignments: NeighborhoodAssignment[]; internalEdgeCount: number } {
  if (nodes.length === 0) return { assignments: [], internalEdgeCount: 0 };

  const nodesWithEmb = nodes.filter(
    (n): n is NeighborhoodNode & { embedding: number[] } =>
      n.embedding !== null && n.embedding.length > 0,
  );

  // Step 1: Compute all pairwise similarities
  const simMatrix = new Map<string, Map<string, number>>();
  for (const n of nodesWithEmb) {
    simMatrix.set(n.id, new Map());
  }

  for (let i = 0; i < nodesWithEmb.length; i++) {
    for (let j = i + 1; j < nodesWithEmb.length; j++) {
      const a = nodesWithEmb[i];
      const b = nodesWithEmb[j];
      const sim = cosineSimilarity(a.embedding, b.embedding);
      simMatrix.get(a.id)!.set(b.id, sim);
      simMatrix.get(b.id)!.set(a.id, sim);
    }
  }

  // Step 2: Build top-K neighbors for each node (sorted by similarity desc)
  const topKNeighbors = new Map<string, Set<string>>();
  for (const node of nodesWithEmb) {
    const similarities = [...(simMatrix.get(node.id) ?? [])];
    similarities.sort((a, b) => b[1] - a[1]);
    const topNeighbors = new Set(
      similarities.slice(0, topK).map(([id]) => id),
    );
    topKNeighbors.set(node.id, topNeighbors);
  }

  // Step 3: Build internal adjacency edges
  // Edge exists if: similarity >= threshold AND (A in B's top-K OR B in A's top-K)
  const internalEdges: NeighborhoodEdge[] = [];
  const edgeSet = new Set<string>();

  for (let i = 0; i < nodesWithEmb.length; i++) {
    for (let j = i + 1; j < nodesWithEmb.length; j++) {
      const a = nodesWithEmb[i];
      const b = nodesWithEmb[j];
      const sim = simMatrix.get(a.id)?.get(b.id) ?? 0;

      if (sim < threshold) continue;

      const aInBTopK = topKNeighbors.get(b.id)?.has(a.id) ?? false;
      const bInATopK = topKNeighbors.get(a.id)?.has(b.id) ?? false;

      if (aInBTopK || bInATopK) {
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          internalEdges.push({ sourceNodeId: a.id, targetNodeId: b.id });
        }
      }
    }
  }

  // Step 4: Connected components
  const components = findConnectedComponents(nodes, internalEdges);

  // Step 5: Coherence guard — split incoherent components
  const validComponents: string[][] = [];

  for (const component of components) {
    if (component.length <= 2) {
      // Small components are always coherent
      validComponents.push(component);
      continue;
    }

    const coherent = enforceCoherence(component, simMatrix, minCoherence, internalEdges);
    validComponents.push(...coherent);
  }

  // Build assignments with metrics
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const assignments: NeighborhoodAssignment[] = validComponents.map((comp) => {
    const { avg, min } = computePairwiseStats(comp, simMatrix);
    const edgesInComp = countInternalEdges(comp, internalEdges);

    return {
      neighborhoodId: computeNeighborhoodId(comp),
      nodeIds: comp,
      centroidEmbedding: computeCentroid(comp, nodeMap),
      avgPairwiseSimilarity: avg,
      minPairwiseSimilarity: min,
      internalEdgesUsed: edgesInComp,
    };
  });

  assignments.sort((a, b) => {
    if (b.nodeIds.length !== a.nodeIds.length) return b.nodeIds.length - a.nodeIds.length;
    return a.neighborhoodId.localeCompare(b.neighborhoodId);
  });

  return { assignments, internalEdgeCount: internalEdges.length };
}

// ─── Original edge-based detection (kept for comparison) ────────────────────

export function detectNeighborhoods(
  nodes: NeighborhoodNode[],
  edges: NeighborhoodEdge[],
): NeighborhoodAssignment[] {
  const components = findConnectedComponents(nodes, edges);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return components.map((comp) => ({
    neighborhoodId: computeNeighborhoodId(comp),
    nodeIds: comp,
    centroidEmbedding: computeCentroid(comp, nodeMap),
    avgPairwiseSimilarity: 0,
    minPairwiseSimilarity: 0,
    internalEdgesUsed: 0,
  }));
}

// ─── Core algorithms ────────────────────────────────────────────────────────

function findConnectedComponents(
  nodes: NeighborhoodNode[],
  edges: NeighborhoodEdge[],
): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const node of nodes) adj.set(node.id, new Set());
  for (const edge of edges) {
    if (adj.has(edge.sourceNodeId) && adj.has(edge.targetNodeId)) {
      adj.get(edge.sourceNodeId)!.add(edge.targetNodeId);
      adj.get(edge.targetNodeId)!.add(edge.sourceNodeId);
    }
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  const sortedIds = [...adj.keys()].sort();

  for (const startId of sortedIds) {
    if (visited.has(startId)) continue;
    const component: string[] = [];
    const queue = [startId];
    visited.add(startId);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of [...(adj.get(current) ?? [])].sort()) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    component.sort();
    components.push(component);
  }

  return components;
}

/**
 * Enforce coherence on a component by:
 * 1. Check avg coherence AND min pairwise similarity.
 * 2. If either fails, find the weakest internal adjacency edge and remove it.
 * 3. Recompute connected components within the original members.
 * 4. Recurse on each sub-component.
 *
 * Returns a list of valid sub-components (may be the original if already valid).
 */
function enforceCoherence(
  component: string[],
  simMatrix: Map<string, Map<string, number>>,
  minCoherence: number,
  internalEdges: NeighborhoodEdge[],
): string[][] {
  if (component.length <= 2) {
    // Pair: check directly
    if (component.length === 2) {
      const sim = simMatrix.get(component[0])?.get(component[1]) ?? 0;
      if (sim < MIN_PAIRWISE_SIM_IN_NEIGHBORHOOD) {
        return [[component[0]], [component[1]]];
      }
    }
    return [component];
  }

  const { avg, min, minPairA, minPairB } = computePairwiseStatsDetailed(component, simMatrix);

  // Check if component is valid
  if (avg >= minCoherence && min >= MIN_PAIRWISE_SIM_IN_NEIGHBORHOOD) {
    return [component];
  }

  // Find and remove the weakest internal edge within this component
  const memberSet = new Set(component);
  const componentEdges = internalEdges.filter(
    (e) => memberSet.has(e.sourceNodeId) && memberSet.has(e.targetNodeId),
  );

  if (componentEdges.length === 0) {
    // No internal edges — all become singletons
    return component.map((id) => [id]);
  }

  // Find weakest edge
  let weakestEdge = componentEdges[0];
  let weakestSim = Infinity;
  for (const edge of componentEdges) {
    const sim = simMatrix.get(edge.sourceNodeId)?.get(edge.targetNodeId) ?? 0;
    if (sim < weakestSim) {
      weakestSim = sim;
      weakestEdge = edge;
    }
  }

  // Remove weakest edge and recompute components
  const remainingEdges = componentEdges.filter((e) => e !== weakestEdge);

  // Build adjacency from remaining edges (only within this component)
  const adj = new Map<string, Set<string>>();
  for (const id of component) adj.set(id, new Set());
  for (const edge of remainingEdges) {
    adj.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    adj.get(edge.targetNodeId)?.add(edge.sourceNodeId);
  }

  // Find sub-components via BFS
  const visited = new Set<string>();
  const subComponents: string[][] = [];
  for (const id of [...component].sort()) {
    if (visited.has(id)) continue;
    const sub: string[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      sub.push(curr);
      for (const neighbor of [...(adj.get(curr) ?? [])].sort()) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    sub.sort();
    subComponents.push(sub);
  }

  // Recursively enforce coherence on each sub-component
  const result: string[][] = [];
  for (const sub of subComponents) {
    result.push(...enforceCoherence(sub, simMatrix, minCoherence, remainingEdges));
  }
  return result;
}

// ─── Metrics ────────────────────────────────────────────────────────────────

function computePairwiseStats(
  nodeIds: string[],
  simMatrix: Map<string, Map<string, number>>,
): { avg: number; min: number } {
  if (nodeIds.length < 2) return { avg: 1.0, min: 1.0 };

  let total = 0;
  let min = 1.0;
  let pairs = 0;

  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const sim = simMatrix.get(nodeIds[i])?.get(nodeIds[j]) ?? 0;
      total += sim;
      if (sim < min) min = sim;
      pairs++;
    }
  }

  return { avg: pairs > 0 ? total / pairs : 0, min };
}

function computePairwiseStatsDetailed(
  nodeIds: string[],
  simMatrix: Map<string, Map<string, number>>,
): { avg: number; min: number; minPairA: string; minPairB: string } {
  if (nodeIds.length < 2) return { avg: 1.0, min: 1.0, minPairA: "", minPairB: "" };

  let total = 0;
  let min = 1.0;
  let minPairA = "";
  let minPairB = "";
  let pairs = 0;

  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const sim = simMatrix.get(nodeIds[i])?.get(nodeIds[j]) ?? 0;
      total += sim;
      if (sim < min) {
        min = sim;
        minPairA = nodeIds[i];
        minPairB = nodeIds[j];
      }
      pairs++;
    }
  }

  return { avg: pairs > 0 ? total / pairs : 0, min, minPairA, minPairB };
}

function countInternalEdges(
  component: string[],
  allEdges: NeighborhoodEdge[],
): number {
  const memberSet = new Set(component);
  return allEdges.filter(
    (e) => memberSet.has(e.sourceNodeId) && memberSet.has(e.targetNodeId),
  ).length;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeNeighborhoodId(sortedNodeIds: string[]): string {
  const input = sortedNodeIds.join("|");
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `nb_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function computeCentroid(
  nodeIds: string[],
  nodeMap: Map<string, NeighborhoodNode>,
): number[] {
  const embeddings: number[][] = [];
  for (const id of nodeIds) {
    const node = nodeMap.get(id);
    if (node?.embedding && node.embedding.length > 0) {
      embeddings.push(node.embedding);
    }
  }
  if (embeddings.length === 0) return [];

  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) centroid[i] += emb[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
    norm += centroid[i] * centroid[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) centroid[i] /= norm;
  }
  return centroid;
}

// ─── Debug ──────────────────────────────────────────────────────────────────

export function formatNeighborhoods(
  assignments: NeighborhoodAssignment[],
  nodeNames: Map<string, string>,
): string {
  const lines: string[] = [`Detected ${assignments.length} neighborhood(s):`, ""];
  for (const nb of assignments) {
    const names = nb.nodeIds.map((id) => nodeNames.get(id) ?? id.slice(0, 8)).join(", ");
    lines.push(
      `  ${nb.neighborhoodId} (${nb.nodeIds.length} nodes, coherence=${nb.avgPairwiseSimilarity.toFixed(3)}): ${names}`,
    );
  }
  return lines.join("\n");
}
