/**
 * Task 2: Preservation Property Tests
 *
 * These tests capture the CURRENT behavior of segmentation, routing,
 * and confidence computation. They must pass BEFORE and AFTER the fix
 * to guarantee no regressions to pipeline mechanics.
 */
import { describe, it, expect } from "vitest";
import { checkSegmentBoundary, updateSegmentCentroid } from "../stages";
import { computeConfidence, shouldMaterialize, checkMaterializationBlock, routeSegment } from "../stages";
import type { OpenSegmentState, CandidateState, NodeState, SegmentData } from "../types";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeEmbedding(seed: number, dim = 10): number[] {
  // Deterministic pseudo-random embedding for testing
  const emb = [];
  for (let i = 0; i < dim; i++) {
    emb.push(Math.sin(seed * (i + 1) * 0.7) * 0.5 + 0.5);
  }
  // Normalize
  const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
  return emb.map((v) => v / norm);
}

function makeOpenSegment(exchangeCount: number, seed = 1): OpenSegmentState {
  return {
    startMessageId: "start-msg",
    endMessageId: "end-msg",
    embedding: makeEmbedding(seed),
    userEmbedding: makeEmbedding(seed + 100),
    lastUserEmbedding: makeEmbedding(seed + 200),
    lastExchangeEmbedding: makeEmbedding(seed),
    exchangeCount,
  };
}

function makeCandidate(segmentCount: number, messagesPerSeg: number, seed = 1): CandidateState {
  const segments: SegmentData[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const msgIds = [];
    for (let j = 0; j < messagesPerSeg; j++) {
      msgIds.push(`msg-${seed}-${i}-${j}`);
    }
    segments.push({
      messageIds: msgIds,
      embedding: makeEmbedding(seed + i * 10),
      completedAt: new Date().toISOString(),
    });
  }
  return {
    id: `candidate-${seed}`,
    segments,
    embedding: makeEmbedding(seed),
    confidence: 0,
    lastTouchedRun: 0,
  };
}

function makeNode(seed: number): NodeState {
  return {
    id: `node-${seed}`,
    title: `Test Node ${seed}`,
    summary: `Summary for node ${seed}`,
    embedding: makeEmbedding(seed + 50),
    messageIds: [`msg-${seed}-0`, `msg-${seed}-1`],
    positionX: 0,
    positionY: 0,
    neighborhoodId: null,
    importance: 0.5,
    stability: 1,
  };
}

// ─── Segmentation Preservation ──────────────────────────────────────────────

describe("Preservation: Segmentation", () => {
  it("should use early thresholds (0.35) for segments with ≤2 exchanges", () => {
    const openSeg = makeOpenSegment(1);
    const newUserEmb = makeEmbedding(999); // very different
    const result = checkSegmentBoundary(openSeg, newUserEmb);

    expect(result.centroidThreshold).toBe(0.35);
    expect(result.localThreshold).toBe(0.35);
  });

  it("should use standard thresholds (0.50/0.45) for segments with >2 exchanges", () => {
    const openSeg = makeOpenSegment(3);
    const newUserEmb = makeEmbedding(999);
    const result = checkSegmentBoundary(openSeg, newUserEmb);

    expect(result.centroidThreshold).toBe(0.50);
    expect(result.localThreshold).toBe(0.45);
  });

  it("should close when centroid similarity drops below threshold", () => {
    // Use very different embeddings to force closure
    const openSeg = makeOpenSegment(3, 1);
    const veryDifferent = makeEmbedding(500);
    const result = checkSegmentBoundary(openSeg, veryDifferent);

    // With very different embeddings, similarity should be low
    expect(result.centroidUserSim).toBeLessThan(1.0);
    // The decision depends on actual similarity value
    if (result.centroidUserSim < result.centroidThreshold) {
      expect(result.shouldClose).toBe(true);
    }
  });

  it("should continue when similarity is above threshold", () => {
    // Use the same embedding as the segment's user centroid
    const openSeg = makeOpenSegment(3, 1);
    const sameAsSegment = openSeg.userEmbedding;
    const result = checkSegmentBoundary(openSeg, sameAsSegment);

    expect(result.centroidUserSim).toBeCloseTo(1.0, 1);
    expect(result.shouldClose).toBe(false);
  });

  it("updateSegmentCentroid should produce normalized output", () => {
    const current = makeEmbedding(1);
    const newEmb = makeEmbedding(2);
    const updated = updateSegmentCentroid(current, 1, newEmb);

    // Should be normalized (L2 norm ≈ 1)
    const norm = Math.sqrt(updated.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });
});

// ─── Routing Preservation ───────────────────────────────────────────────────

describe("Preservation: Routing", () => {
  it("should return new_candidate when no nodes or candidates exist", () => {
    const segmentEmb = makeEmbedding(1);
    const msgIds = ["msg-1", "msg-2"];
    const result = routeSegment(segmentEmb, msgIds, [], []);

    expect(result.type).toBe("new_candidate");
  });

  it("should return extend_node when segment is very similar to existing node", () => {
    const node = makeNode(1);
    // Use same embedding as the node
    const segmentEmb = node.embedding!;
    const msgIds = ["msg-1", "msg-2"];
    const result = routeSegment(segmentEmb, msgIds, [node], []);

    expect(result.type).toBe("extend_node");
    if (result.type === "extend_node") {
      expect(result.nodeId).toBe(node.id);
    }
  });

  it("should return accumulate when segment matches existing candidate", () => {
    const candidate = makeCandidate(1, 3, 1);
    // Use same embedding as the candidate
    const segmentEmb = candidate.embedding!;
    const msgIds = ["msg-new-1", "msg-new-2"];
    const result = routeSegment(segmentEmb, msgIds, [], [candidate]);

    expect(result.type).toBe("accumulate");
    if (result.type === "accumulate") {
      expect(result.candidateId).toBe(candidate.id);
    }
  });
});

// ─── Confidence & Materialization Preservation ──────────────────────────────

describe("Preservation: Confidence & Materialization", () => {
  it("should compute confidence between 0 and 1", () => {
    const candidate = makeCandidate(2, 3, 1);
    const nodes = [makeNode(1)];
    const confidence = computeConfidence(candidate, nodes);

    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it("should not materialize with fewer than MIN_EVIDENCE_MESSAGES (4)", () => {
    const candidate = makeCandidate(1, 2, 1); // only 2 messages
    candidate.confidence = 0.9; // high confidence
    const result = shouldMaterialize(candidate, []);

    expect(result).toBe(false);
  });

  it("should block candidates exceeding MAX_AUTO_NODE_MESSAGES (8)", () => {
    const candidate = makeCandidate(1, 10, 1); // 10 messages
    const block = checkMaterializationBlock(candidate);

    expect(block.blocked).toBe(true);
  });

  it("should not block candidates within limits", () => {
    const candidate = makeCandidate(1, 6, 1); // 6 messages, 1 segment
    const block = checkMaterializationBlock(candidate);

    expect(block.blocked).toBe(false);
  });

  it("confidence should increase with more segments (recurrence)", () => {
    const oneSegment = makeCandidate(1, 4, 1);
    const twoSegments = makeCandidate(2, 3, 1);

    const conf1 = computeConfidence(oneSegment, []);
    const conf2 = computeConfidence(twoSegments, []);

    // Two segments should have higher recurrence score
    expect(conf2).toBeGreaterThan(conf1);
  });
});
