/**
 * GraphIntelligenceEngine v2 — Pipeline Stages.
 *
 * Each stage is a pure function (no DB, no side effects).
 * Exchange-based incremental segmentation.
 */

import { cosineSimilarity } from "@/src/lib/cosineSimilarity";
import { debugLog } from "./logger";
import {
  SEGMENT_CLOSE_THRESHOLD,
  SEGMENT_CLOSE_THRESHOLD_EARLY,
  USER_CENTROID_THRESHOLD,
  USER_LOCAL_THRESHOLD,
  USER_CENTROID_THRESHOLD_EARLY,
  USER_LOCAL_THRESHOLD_EARLY,
  EXTEND_THRESHOLD,
  CANDIDATE_MATCH_THRESHOLD,
  ACCUMULATE_COHERENCE_GATE,
  MATERIALIZE_THRESHOLD,
  MIN_EVIDENCE_MESSAGES,
  MAX_AUTO_NODE_MESSAGES,
  MAX_AUTO_NODE_SEGMENTS,
  MIN_COHERENCE_FOR_MATERIALIZATION,
  THRESHOLD_INCREASE_PER_EXTRA_SEGMENT,
  EDGE_THRESHOLD,
  WEIGHTS,
} from "./config";
import type {
  NodeState,
  EdgeState,
  CandidateState,
  SegmentData,
  OpenSegmentState,
  RouteDecision,
} from "./types";

// ─── Stage 2: SEGMENT (user-message boundary detection) ─────────────────────

export interface SegmentBoundaryResult {
  /** Whether the open segment should be closed */
  shouldClose: boolean;
  /** Similarity between new user message and open segment's user centroid */
  centroidUserSim: number;
  /** Similarity between new user message and the previous user message */
  localUserSim: number | null;
  /** Centroid threshold applied */
  centroidThreshold: number;
  /** Local threshold applied */
  localThreshold: number;
  /** Reason for decision */
  reason: string;
}

/**
 * Determine whether a new exchange should close the current open segment.
 * Uses user-message-only embeddings to avoid format/style inflation.
 */
export function checkSegmentBoundary(
  openSegment: OpenSegmentState,
  newUserEmbedding: number[],
): SegmentBoundaryResult {
  // Adaptive thresholds: early segments are more lenient
  const centroidThreshold = openSegment.exchangeCount <= 2
    ? USER_CENTROID_THRESHOLD_EARLY
    : USER_CENTROID_THRESHOLD;
  const localThreshold = openSegment.exchangeCount <= 2
    ? USER_LOCAL_THRESHOLD_EARLY
    : USER_LOCAL_THRESHOLD;

  if (openSegment.userEmbedding.length === 0 || newUserEmbedding.length === 0) {
    return {
      shouldClose: false,
      centroidUserSim: 1.0,
      localUserSim: null,
      centroidThreshold,
      localThreshold,
      reason: "Missing embeddings — cannot compare",
    };
  }

  const centroidUserSim = cosineSimilarity(newUserEmbedding, openSegment.userEmbedding);

  let localUserSim: number | null = null;
  if (openSegment.lastUserEmbedding && openSegment.lastUserEmbedding.length > 0) {
    localUserSim = cosineSimilarity(newUserEmbedding, openSegment.lastUserEmbedding);
  }

  // Close if EITHER centroid OR local similarity drops below threshold.
  // This catches both gradual drift (centroid) and sharp pivots (local).
  const centroidBelow = centroidUserSim < centroidThreshold;
  const localBelow = localUserSim !== null && localUserSim < localThreshold;
  const shouldClose = centroidBelow || localBelow;

  let reason: string;
  if (shouldClose) {
    const parts: string[] = [];
    if (centroidBelow) parts.push(`centroidUserSim ${centroidUserSim.toFixed(3)} < ${centroidThreshold}`);
    if (localBelow) parts.push(`localUserSim ${localUserSim!.toFixed(3)} < ${localThreshold}`);
    reason = `CLOSE: ${parts.join(" AND ")}`;
  } else {
    reason = `CONTINUE: centroidUserSim=${centroidUserSim.toFixed(3)}>=${centroidThreshold}` +
      (localUserSim !== null ? `, localUserSim=${localUserSim.toFixed(3)}>=${localThreshold}` : "");
  }

  return { shouldClose, centroidUserSim, localUserSim, centroidThreshold, localThreshold, reason };
}

/**
 * Compute updated centroid by incorporating a new exchange embedding.
 * Incremental mean + L2 normalize.
 */
export function updateSegmentCentroid(
  currentCentroid: number[],
  currentCount: number,
  newEmbedding: number[],
): number[] {
  if (currentCentroid.length === 0) return newEmbedding;

  const dim = currentCentroid.length;
  const result = new Array(dim);
  for (let i = 0; i < dim; i++) {
    result[i] = (currentCentroid[i] * currentCount + newEmbedding[i]) / (currentCount + 1);
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += result[i] * result[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) result[i] /= norm;
  }

  return result;
}

// ─── Stage 3: ROUTE ─────────────────────────────────────────────────────────

/**
 * Decide what to do with a completed (frozen) segment.
 * Compares against existing nodes and active candidates.
 */
export function routeSegment(
  segmentEmbedding: number[],
  segmentMessageIds: string[],
  nodes: NodeState[],
  candidates: CandidateState[],
): RouteDecision {
  // Compare against existing nodes
  const nodeScores: Array<{ id: string; title: string; similarity: number }> = [];
  let bestNodeScore = 0;
  let bestNodeId: string | null = null;

  for (const node of nodes) {
    if (!node.embedding || node.embedding.length === 0) continue;
    const score = cosineSimilarity(segmentEmbedding, node.embedding);
    nodeScores.push({ id: node.id, title: node.title, similarity: parseFloat(score.toFixed(3)) });
    if (score > bestNodeScore) {
      bestNodeScore = score;
      bestNodeId = node.id;
    }
  }

  // Compare against candidates
  const candidateScores: Array<{ id: string; similarity: number; segmentCount: number }> = [];
  let bestCandidateScore = 0;
  let bestCandidate: CandidateState | null = null;

  for (const candidate of candidates) {
    if (!candidate.embedding || candidate.embedding.length === 0) continue;
    const score = cosineSimilarity(segmentEmbedding, candidate.embedding);
    candidateScores.push({ id: candidate.id, similarity: parseFloat(score.toFixed(3)), segmentCount: candidate.segments.length });
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

  // Determine decision
  let decision: RouteDecision;
  let reason: string;

  if (bestNodeScore >= EXTEND_THRESHOLD && bestNodeId) {
    decision = { type: "extend_node", nodeId: bestNodeId, messageIds: segmentMessageIds };
    reason = `Best node score ${bestNodeScore.toFixed(3)} >= EXTEND_THRESHOLD ${EXTEND_THRESHOLD}`;
  } else if (bestCandidateScore >= CANDIDATE_MATCH_THRESHOLD && bestCandidate) {
    // Coherence gate
    const existingSegments = bestCandidate.segments.filter(
      (s) => s.embedding.length > 0,
    );
    let coherenceGatePassed = true;
    let avgCoherence = 1.0;
    if (existingSegments.length > 0) {
      let totalSim = 0;
      for (const seg of existingSegments) {
        totalSim += cosineSimilarity(segmentEmbedding, seg.embedding);
      }
      avgCoherence = totalSim / existingSegments.length;
      if (avgCoherence < ACCUMULATE_COHERENCE_GATE) {
        coherenceGatePassed = false;
      }
    }

    if (coherenceGatePassed) {
      decision = { type: "accumulate", candidateId: bestCandidate.id, segment };
      reason = `Best candidate score ${bestCandidateScore.toFixed(3)} >= CANDIDATE_MATCH_THRESHOLD ${CANDIDATE_MATCH_THRESHOLD}, coherence ${avgCoherence.toFixed(3)} >= ${ACCUMULATE_COHERENCE_GATE}`;
    } else {
      decision = { type: "new_candidate", segment };
      reason = `Best candidate score ${bestCandidateScore.toFixed(3)} passed threshold but coherence gate FAILED: ${avgCoherence.toFixed(3)} < ${ACCUMULATE_COHERENCE_GATE}`;
    }
  } else {
    decision = { type: "new_candidate", segment };
    reason = `Best node ${bestNodeScore.toFixed(3)} < ${EXTEND_THRESHOLD}, best candidate ${bestCandidateScore.toFixed(3)} < ${CANDIDATE_MATCH_THRESHOLD}`;
  }

  // Log routing details
  debugLog("[routeSegment]", {
    decision: decision.type,
    reason,
    nodeScores,
    candidateScores,
    thresholds: { EXTEND_THRESHOLD, CANDIDATE_MATCH_THRESHOLD, ACCUMULATE_COHERENCE_GATE },
  });

  return decision;
}

// ─── Stage 4: MATERIALIZE ───────────────────────────────────────────────────

export type BlockReason =
  | { blocked: true; reason: string }
  | { blocked: false };

export function checkMaterializationBlock(
  candidate: CandidateState,
): BlockReason {
  const totalMessages = candidate.segments.reduce(
    (sum, s) => sum + s.messageIds.length, 0,
  );

  if (totalMessages > MAX_AUTO_NODE_MESSAGES) {
    return {
      blocked: true,
      reason: `${totalMessages} messages exceeds MAX_AUTO_NODE_MESSAGES (${MAX_AUTO_NODE_MESSAGES})`,
    };
  }

  if (candidate.segments.length >= 2) {
    const internalCoherence = computeInternalCoherence(candidate.segments);
    if (internalCoherence < MIN_COHERENCE_FOR_MATERIALIZATION) {
      return {
        blocked: true,
        reason: `internal coherence ${internalCoherence.toFixed(3)} < ${MIN_COHERENCE_FOR_MATERIALIZATION} (${candidate.segments.length} segments, ${totalMessages} messages)`,
      };
    }
  }

  return { blocked: false };
}

export function shouldMaterialize(
  candidate: CandidateState,
  nodes: NodeState[],
): boolean {
  const totalMessages = candidate.segments.reduce(
    (sum, s) => sum + s.messageIds.length, 0,
  );

  if (totalMessages < MIN_EVIDENCE_MESSAGES) return false;

  const block = checkMaterializationBlock(candidate);
  if (block.blocked) return false;

  const extraSegments = Math.max(0, candidate.segments.length - MAX_AUTO_NODE_SEGMENTS);
  const adjustedThreshold = MATERIALIZE_THRESHOLD + (extraSegments * THRESHOLD_INCREASE_PER_EXTRA_SEGMENT);

  const confidence = computeConfidence(candidate, nodes);
  return confidence >= adjustedThreshold;
}

export function computeInternalCoherence(segments: SegmentData[]): number {
  const validSegments = segments.filter((s) => s.embedding.length > 0);
  if (validSegments.length < 2) return 1.0;

  let totalSim = 0;
  let pairs = 0;

  for (let i = 0; i < validSegments.length; i++) {
    for (let j = i + 1; j < validSegments.length; j++) {
      totalSim += cosineSimilarity(validSegments[i].embedding, validSegments[j].embedding);
      pairs++;
    }
  }

  return pairs > 0 ? totalSim / pairs : 0;
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

export function computeIncrementalEdges(
  affectedNodeId: string,
  affectedNodeEmbedding: number[],
  nodes: NodeState[],
  existingEdges: EdgeState[],
): { addEdges: Array<{ targetNodeId: string; similarity: number }>; removeEdgeIds: string[] } {
  const addEdges: Array<{ targetNodeId: string; similarity: number }> = [];
  const removeEdgeIds: string[] = [];

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

  for (const edge of currentEdges) {
    const otherNodeId = edge.sourceNodeId === affectedNodeId
      ? edge.targetNodeId
      : edge.sourceNodeId;
    const otherNode = nodes.find((n) => n.id === otherNodeId);
    if (!otherNode || !otherNode.embedding || otherNode.embedding.length === 0) continue;

    const newSim = cosineSimilarity(affectedNodeEmbedding, otherNode.embedding);
    if (newSim < EDGE_THRESHOLD * 0.9) {
      removeEdgeIds.push(edge.id);
    }
  }

  return { addEdges, removeEdgeIds };
}

// ─── Stage 7: METRICS ───────────────────────────────────────────────────────

export function computeMetrics(
  node: NodeState,
  edges: EdgeState[],
): { importance: number; stability: number } {
  const edgeCount = edges.filter(
    (e) => e.sourceNodeId === node.id || e.targetNodeId === node.id,
  ).length;
  const messageCount = node.messageIds.length;

  const importance = Math.min(1.0, (edgeCount * 0.3 + messageCount * 0.1));
  const stability = Math.min(1.0, node.stability);

  return { importance, stability };
}

// ─── Stage 8: LAYOUT ────────────────────────────────────────────────────────

export function computeNewNodePosition(
  newNodeEmbedding: number[],
  existingNodes: NodeState[],
): { x: number; y: number } {
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
    const angle = (Math.random() * Math.PI * 2);
    const distance = 150 + Math.random() * 50;
    return {
      x: nearestNode.positionX + Math.cos(angle) * distance,
      y: nearestNode.positionY + Math.sin(angle) * distance,
    };
  }

  return { x: 0, y: 0 };
}

// ─── Centroid computation (for candidate segments) ──────────────────────────

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
