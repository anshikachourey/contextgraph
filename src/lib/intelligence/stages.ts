/**
 * GraphIntelligenceEngine v1 — Pipeline Stages.
 *
 * Each stage is a pure function (no DB, no side effects).
 * Input: previous stage output + context.
 * Output: typed decisions/mutations.
 */

import { cosineSimilarity } from "@/src/lib/cosineSimilarity";
import {
  WINDOW_SIZE,
  BOUNDARY_THRESHOLD,
  EXTEND_THRESHOLD,
  CANDIDATE_MATCH_THRESHOLD,
  MATERIALIZE_THRESHOLD,
  MIN_EVIDENCE_MESSAGES,
  EDGE_THRESHOLD,
  WEIGHTS,
  TRIVIAL_MAX_CHARS,
  SUBSTANTIVE_MIN_CHARS,
} from "./config";
import type { ChatMessage } from "@/src/types/message";
import type {
  NodeState,
  EdgeState,
  CandidateState,
  SegmentData,
  EmbedOutput,
  SegmentOutput,
  RouteDecision,
  MaterializeDecision,
  GraphMutation,
} from "./types";

// ─── Stage 2: SEGMENT ───────────────────────────────────────────────────────

/**
 * Detect if a segment boundary exists by comparing
 * current window embedding against previous window embedding.
 */
export function detectSegment(
  currentWindowEmbedding: number[],
  previousWindowEmbedding: number[] | null,
  recentMessages: ChatMessage[],
): SegmentOutput {
  if (!previousWindowEmbedding || previousWindowEmbedding.length === 0) {
    // First run — no comparison possible. Store embedding for next time.
    return { segmentCompleted: false, completedSegment: null, completedSegmentEmbedding: null };
  }

  const similarity = cosineSimilarity(currentWindowEmbedding, previousWindowEmbedding);

  if (similarity < BOUNDARY_THRESHOLD) {
    // Boundary detected: the messages BEFORE the current window form the completed segment
    const completedSegment = recentMessages.slice(0, -WINDOW_SIZE);
    if (completedSegment.length === 0) {
      return { segmentCompleted: false, completedSegment: null, completedSegmentEmbedding: null };
    }
    return {
      segmentCompleted: true,
      completedSegment,
      completedSegmentEmbedding: previousWindowEmbedding,
    };
  }

  return { segmentCompleted: false, completedSegment: null, completedSegmentEmbedding: null };
}

// ─── Stage 3: ROUTE ─────────────────────────────────────────────────────────

/**
 * Decide what to do with a completed segment.
 */
export function routeSegment(
  segmentEmbedding: number[],
  segmentMessageIds: string[],
  nodes: NodeState[],
  candidates: CandidateState[],
): RouteDecision {
  // Compare against existing nodes
  let bestNodeScore = 0;
  let bestNodeId: string | null = null;

  for (const node of nodes) {
    if (!node.embedding || node.embedding.length === 0) continue;
    const score = cosineSimilarity(segmentEmbedding, node.embedding);
    if (score > bestNodeScore) {
      bestNodeScore = score;
      bestNodeId = node.id;
    }
  }

  if (bestNodeScore >= EXTEND_THRESHOLD && bestNodeId) {
    return { type: "extend_node", nodeId: bestNodeId, messageIds: segmentMessageIds };
  }

  // Compare against candidates
  let bestCandidateScore = 0;
  let bestCandidate: CandidateState | null = null;

  for (const candidate of candidates) {
    if (!candidate.embedding || candidate.embedding.length === 0) continue;
    const score = cosineSimilarity(segmentEmbedding, candidate.embedding);
    if (score > bestCandidateScore) {
      bestCandidateScore = score;
      bestCandidate = candidate;
    }
  }

  const segment: SegmentData = {
    messageIds: segmentMessageIds,
    embedding: segmentEmbedding,
    completedAt: new Date().toISOString(),
  };

  if (bestCandidateScore >= CANDIDATE_MATCH_THRESHOLD && bestCandidate) {
    return { type: "accumulate", candidateId: bestCandidate.id, segment };
  }

  return { type: "new_candidate", segment };
}

// ─── Stage 4: MATERIALIZE ───────────────────────────────────────────────────

/**
 * Check if a candidate should materialize into a visible node.
 */
export function shouldMaterialize(
  candidate: CandidateState,
  nodes: NodeState[],
): boolean {
  const totalMessages = candidate.segments.reduce(
    (sum, s) => sum + s.messageIds.length, 0,
  );

  if (totalMessages < MIN_EVIDENCE_MESSAGES) return false;

  const confidence = computeConfidence(candidate, nodes);
  return confidence >= MATERIALIZE_THRESHOLD;
}

export function computeConfidence(
  candidate: CandidateState,
  nodes: NodeState[],
): number {
  const segments = candidate.segments;

  // Coherence
  let coherence = 0.85;
  if (segments.length >= 2) {
    let totalSim = 0;
    let pairs = 0;
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        if (segments[i].embedding.length > 0 && segments[j].embedding.length > 0) {
          totalSim += cosineSimilarity(segments[i].embedding, segments[j].embedding);
          pairs++;
        }
      }
    }
    coherence = pairs > 0 ? totalSim / pairs : 0.5;
  }

  // Distinctiveness
  let bestNodeMatch = 0;
  if (candidate.embedding && candidate.embedding.length > 0) {
    for (const node of nodes) {
      if (!node.embedding || node.embedding.length === 0) continue;
      const sim = cosineSimilarity(candidate.embedding, node.embedding);
      if (sim > bestNodeMatch) bestNodeMatch = sim;
    }
  }
  const distinctiveness = 1.0 - bestNodeMatch;

  // Recurrence
  const recurrence = Math.min(1.0, 0.3 + (segments.length - 1) * 0.35);

  // Quality
  const totalMsgs = segments.reduce((sum, s) => sum + s.messageIds.length, 0);
  const quality = Math.min(1.0, totalMsgs / 8);

  return Math.max(0, Math.min(1,
    coherence * WEIGHTS.coherence +
    distinctiveness * WEIGHTS.distinctiveness +
    recurrence * WEIGHTS.recurrence +
    quality * WEIGHTS.quality,
  ));
}

// ─── Stage 5: RELATE (incremental) ─────────────────────────────────────────

/**
 * Compute edges only for the affected node against all other nodes.
 * Returns edges to add and edges to remove.
 */
export function computeIncrementalEdges(
  affectedNodeId: string,
  affectedNodeEmbedding: number[],
  nodes: NodeState[],
  existingEdges: EdgeState[],
): { addEdges: Array<{ targetNodeId: string; similarity: number }>; removeEdgeIds: string[] } {
  const addEdges: Array<{ targetNodeId: string; similarity: number }> = [];
  const removeEdgeIds: string[] = [];

  // Existing edges involving this node
  const currentEdges = existingEdges.filter(
    (e) => e.sourceNodeId === affectedNodeId || e.targetNodeId === affectedNodeId,
  );
  const currentEdgeTargets = new Set(
    currentEdges.map((e) =>
      e.sourceNodeId === affectedNodeId ? e.targetNodeId : e.sourceNodeId,
    ),
  );

  for (const node of nodes) {
    if (node.id === affectedNodeId) continue;
    if (!node.embedding || node.embedding.length === 0) continue;

    const similarity = cosineSimilarity(affectedNodeEmbedding, node.embedding);

    if (similarity >= EDGE_THRESHOLD && !currentEdgeTargets.has(node.id)) {
      addEdges.push({ targetNodeId: node.id, similarity });
    }
  }

  // Check if existing edges should be removed (score dropped below threshold)
  for (const edge of currentEdges) {
    const otherNodeId = edge.sourceNodeId === affectedNodeId
      ? edge.targetNodeId
      : edge.sourceNodeId;
    const otherNode = nodes.find((n) => n.id === otherNodeId);
    if (!otherNode || !otherNode.embedding || otherNode.embedding.length === 0) continue;

    const newSim = cosineSimilarity(affectedNodeEmbedding, otherNode.embedding);
    if (newSim < EDGE_THRESHOLD * 0.9) { // hysteresis: remove only if well below
      removeEdgeIds.push(edge.id);
    }
  }

  return { addEdges, removeEdgeIds };
}

// ─── Stage 7: METRICS ───────────────────────────────────────────────────────

/**
 * Compute basic importance and stability for a node.
 */
export function computeMetrics(
  node: NodeState,
  edges: EdgeState[],
): { importance: number; stability: number } {
  const edgeCount = edges.filter(
    (e) => e.sourceNodeId === node.id || e.targetNodeId === node.id,
  ).length;
  const messageCount = node.messageIds.length;

  // Importance: combination of connections and evidence
  const importance = Math.min(1.0, (edgeCount * 0.3 + messageCount * 0.1));

  // Stability: older nodes are more stable (simple version)
  const stability = Math.min(1.0, node.stability);

  return { importance, stability };
}

// ─── Stage 8: LAYOUT (incremental) ──────────────────────────────────────────

/**
 * Compute position for a new node based on its most similar existing node.
 */
export function computeNewNodePosition(
  newNodeEmbedding: number[],
  existingNodes: NodeState[],
): { x: number; y: number } {
  // Find nearest existing node with a position
  let bestScore = 0;
  let nearestNode: NodeState | null = null;

  for (const node of existingNodes) {
    if (node.positionX === null || node.positionY === null) continue;
    if (!node.embedding || node.embedding.length === 0) continue;
    const score = cosineSimilarity(newNodeEmbedding, node.embedding);
    if (score > bestScore) {
      bestScore = score;
      nearestNode = node;
    }
  }

  if (nearestNode && nearestNode.positionX !== null && nearestNode.positionY !== null) {
    // Place near the most similar node, offset at a deterministic angle
    const angle = (Math.random() * Math.PI * 2); // Will be replaced with hash-based determinism
    const distance = 150 + Math.random() * 50;
    return {
      x: nearestNode.positionX + Math.cos(angle) * distance,
      y: nearestNode.positionY + Math.sin(angle) * distance,
    };
  }

  // No positioned nodes yet — place at origin
  return { x: 0, y: 0 };
}

// ─── Centroid computation ────────────────────────────────────────────────────

export function computeCentroid(segments: SegmentData[]): number[] {
  const valid = segments.filter((s) => s.embedding.length > 0);
  if (valid.length === 0) return [];

  const dim = valid[0].embedding.length;
  const centroid = new Array(dim).fill(0);

  for (const seg of valid) {
    for (let i = 0; i < dim; i++) centroid[i] += seg.embedding[i];
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) {
    centroid[i] /= valid.length;
    norm += centroid[i] * centroid[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) centroid[i] /= norm;
  }

  return centroid;
}
