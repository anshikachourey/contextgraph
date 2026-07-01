/**
 * Node Evolution Engine — Type definitions.
 * v1: Detection + suggestions only. No auto-apply, no split detection.
 */

export type EvolutionAction = "extend_node" | "suggest_merge" | "suggest_parent";

interface EvolutionSuggestionBase {
  id: string;
  action: EvolutionAction;
  confidence: number; // 0.0 – 1.0
  reason: string;
  createdAt: string;
}

export interface ExtendNodeSuggestion extends EvolutionSuggestionBase {
  action: "extend_node";
  targetNodeId: string;
  messageIds: string[];
  similarityScore: number;
}

export interface MergeSuggestion extends EvolutionSuggestionBase {
  action: "suggest_merge";
  nodeAId: string;
  nodeBId: string;
  similarityScore: number;
  proposedTitle: string | null;
}

export interface ParentSuggestion extends EvolutionSuggestionBase {
  action: "suggest_parent";
  childNodeIds: string[];
  proposedTitle: string;
  avgSimilarity: number;
}

export type EvolutionSuggestion =
  | ExtendNodeSuggestion
  | MergeSuggestion
  | ParentSuggestion;

// API contract
export interface EvolveGraphRequest {
  conversationId: string;
}

export interface EvolveGraphResponse {
  suggestions: EvolutionSuggestion[];
  meta: {
    unlinkedMessageCount: number;
    nodesAnalyzed: number;
    processingTimeMs: number;
  };
}

// Internal types used by the detection engine
export interface NodeWithEmbedding {
  id: string;
  title: string;
  summary: string;
  evidenceSummary: string | null;
  embedding: number[];
  messageIds: string[];
}

export interface EmbeddedWindow {
  messageIds: string[];
  embedding: number[];
  text: string;
}
