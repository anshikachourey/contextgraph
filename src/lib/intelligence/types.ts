/**
 * GraphIntelligenceEngine v2 — Types.
 *
 * Exchange-based incremental segmentation.
 * The engine processes one exchange (user+assistant pair) per run.
 * Open segment grows until a boundary is detected, then freezes.
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
  /** Engine run count when this candidate was last touched (created or accumulated into) */
  lastTouchedRun: number | null;
}

export interface SegmentData {
  messageIds: string[];
  embedding: number[];
  completedAt: string;
}

// ─── Engine State (persisted in conversation_engine_state) ──────────────────

export interface OpenSegmentState {
  /** ID of the first message in this open segment */
  startMessageId: string;
  /** ID of the last message included in this open segment */
  endMessageId: string;
  /** Running centroid embedding of all exchanges (for candidate/node creation) */
  embedding: number[];
  /** Running centroid of user-only embeddings (for segmentation boundary detection) */
  userEmbedding: number[];
  /** Embedding of the most recent user message (for local boundary detection) */
  lastUserEmbedding: number[];
  /** Embedding of the most recent exchange (kept for compatibility) */
  lastExchangeEmbedding: number[];
  /** Number of exchanges (user+assistant pairs) in this segment */
  exchangeCount: number;
}

export interface EngineState {
  /** Cursor: ID of the last fully processed message. Engine only looks AFTER this. */
  cursor: string | null;
  /** The currently open (unfrozen) segment. Null if no segment is open. */
  openSegment: OpenSegmentState | null;
  /** Total engine runs for this conversation */
  totalRuns: number;
}

// ─── Pipeline Context ───────────────────────────────────────────────────────

export interface PipelineContext {
  conversationId: string;
  /** The new exchange to process (user + assistant messages after cursor) */
  newExchange: { user: ChatMessage; assistant: ChatMessage } | null;
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
  | { type: "block_candidate"; candidateId: string; reason: string }
  | { type: "materialize"; candidateId: string; nodeId: string; title: string; summary: string; messageIds: string[]; embedding: number[]; position: { x: number; y: number } }
  | { type: "add_edge"; sourceNodeId: string; targetNodeId: string; similarity: number; explanation: string }
  | { type: "remove_edge"; edgeId: string }
  | { type: "update_metrics"; nodeId: string; importance: number; stability: number }
  | { type: "update_engine_state"; engineState: EngineState };

// ─── Engine Result ──────────────────────────────────────────────────────────

export interface EngineResult {
  mutations: GraphMutation[];
  nodesExtended: number;
  nodesCreated: number;
  edgesAdded: number;
  edgesRemoved: number;
}
