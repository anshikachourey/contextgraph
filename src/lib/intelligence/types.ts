/**
 * GraphIntelligenceEngine v1 — Types.
 *
 * Separates decisions from mutations.
 * Each pipeline stage produces typed outputs.
 */

import type { ChatMessage } from "@/src/types/message";

// ─── Graph State (loaded once per engine run) ───────────────────────────────

export interface NodeState {
  id: string;
  title: string;
  summary: string;
  embedding: number[] | null;
  messageIds: string[];
  positionX: number | null;
  positionY: number | null;
  neighborhoodId: string | null;
  importance: number;
  stability: number;
}

export interface EdgeState {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  similarityScore: number;
}

export interface CandidateState {
  id: string;
  segments: SegmentData[];
  embedding: number[] | null;
  confidence: number;
}

export interface SegmentData {
  messageIds: string[];
  embedding: number[];
  completedAt: string;
}

export interface EngineState {
  lastWindowEmbedding: number[] | null;
  lastProcessedMessageId: string | null;
  totalRuns: number;
}

// ─── Pipeline Context ───────────────────────────────────────────────────────

export interface PipelineContext {
  conversationId: string;
  newMessages: ChatMessage[];
  recentMessages: ChatMessage[];       // last N messages for window comparison
  nodes: NodeState[];
  edges: EdgeState[];
  candidates: CandidateState[];
  engineState: EngineState;
}

// ─── Stage Outputs ──────────────────────────────────────────────────────────

export interface EmbedOutput {
  windowEmbedding: number[];
  windowText: string;
}

export interface SegmentOutput {
  segmentCompleted: boolean;
  completedSegment: ChatMessage[] | null;
  completedSegmentEmbedding: number[] | null;
}

export type RouteDecision =
  | { type: "extend_node"; nodeId: string; messageIds: string[] }
  | { type: "accumulate"; candidateId: string; segment: SegmentData }
  | { type: "new_candidate"; segment: SegmentData }
  | { type: "continue" };

export interface MaterializeDecision {
  candidateId: string;
  messageIds: string[];
  embedding: number[];
}

// ─── Mutations (batch-persisted at end) ─────────────────────────────────────

export type GraphMutation =
  | { type: "extend_node"; nodeId: string; messageIds: string[] }
  | { type: "create_candidate"; segment: SegmentData; embedding: number[]; confidence: number }
  | { type: "update_candidate"; candidateId: string; segments: SegmentData[]; embedding: number[]; confidence: number }
  | { type: "materialize"; candidateId: string; nodeId: string; title: string; summary: string; messageIds: string[]; embedding: number[]; position: { x: number; y: number } }
  | { type: "add_edge"; sourceNodeId: string; targetNodeId: string; similarity: number; explanation: string }
  | { type: "remove_edge"; edgeId: string }
  | { type: "update_metrics"; nodeId: string; importance: number; stability: number }
  | { type: "update_engine_state"; windowEmbedding: number[]; lastMessageId: string };

// ─── Engine Result ──────────────────────────────────────────────────────────

export interface EngineResult {
  mutations: GraphMutation[];
  nodesExtended: number;
  nodesCreated: number;
  edgesAdded: number;
  edgesRemoved: number;
}
