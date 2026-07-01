/**
 * Evidence Accumulation Graph Engine — Type definitions.
 *
 * TopicCandidates are hidden graph objects that accumulate evidence
 * until they materialize into visible nodes. They are persisted in
 * the database, never shown to users, and evolve continuously.
 */

import type { ChatMessage } from "./message";

// ─── Topic Candidate (persisted, hidden) ────────────────────────────────────

export type CandidateStatus = "accumulating" | "materialized" | "discarded";

export interface MessageSegment {
  messageIds: string[];
  embedding: number[];
  completedAt: string;
}

export interface TopicCandidate {
  id: string;
  conversationId: string;
  status: CandidateStatus;
  segments: MessageSegment[];
  /** Running centroid embedding (mean of segment embeddings) */
  embedding: number[] | null;
  /** Weighted confidence score [0, 1] */
  confidence: number;
  /** If materialized, the node ID it became */
  materializedNodeId: string | null;
  /** When the candidate was last updated with new evidence */
  lastUpdatedAt: string;
  createdAt: string;
}

// ─── Confidence scoring weights ─────────────────────────────────────────────

export interface ConfidenceFactors {
  /** How internally consistent are the segments? (mean pairwise similarity) */
  semanticConsistency: number;
  /** How many times has this topic recurred? (segment count) */
  recurrence: number;
  /** Total message evidence volume */
  evidenceVolume: number;
  /** How different is this from existing nodes? (1 - bestMatchScore) */
  uniqueness: number;
}

// ─── Engine actions ─────────────────────────────────────────────────────────

export type EngineAction =
  | { type: "extend_node"; nodeId: string; messageIds: string[] }
  | { type: "create_node"; candidateId: string; title: string; summary: string; messageIds: string[] }
  | { type: "create_parent"; childNodeIds: string[]; title: string }
  | { type: "accumulate"; candidateId: string; segment: MessageSegment }
  | { type: "new_candidate"; segment: MessageSegment }
  | { type: "no_action" };

// ─── API contract ───────────────────────────────────────────────────────────

export interface GraphEngineRequest {
  conversationId: string;
}

export interface GraphEngineResponse {
  actions: EngineAction[];
  candidatesUpdated: number;
  nodesCreated: number;
  nodesExtended: number;
  parentsCreated: number;
}

// ─── DB row type ────────────────────────────────────────────────────────────

export interface DbTopicCandidate {
  id: string;
  conversation_id: string;
  status: CandidateStatus;
  segments: MessageSegment[];
  embedding: number[] | null;
  confidence: number;
  materialized_node_id: string | null;
  last_updated_at: string;
  created_at: string;
}

// ─── Node embedding (for comparisons) ───────────────────────────────────────

export interface NodeEmbedding {
  id: string;
  title: string;
  embedding: number[];
}
