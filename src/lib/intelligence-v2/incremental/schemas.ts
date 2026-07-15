/**
 * Incremental V2 Engine — Type Definitions.
 *
 * Defines mutation types, decision types, and the incremental update result.
 */

import type {
  Utterance, Proposition, Thread, ConversationalObject,
  Relationship, DerivedHierarchyNode, DerivedTree,
  RelationType, ObjectType, ObjectMaturity, ObjectStatus, PropositionStatus,
} from "../schemas";

// ─── Object Action Decisions ────────────────────────────────────────────────

export type ObjectAction =
  | "extend_object"
  | "revise_object"
  | "resolve_object"
  | "reopen_object"
  | "contradict_object"
  | "add_evidence"
  | "create_object"
  | "defer"
  | "discard";

export interface ObjectDecision {
  action: ObjectAction;
  targetObjectId: string | null;
  newObjectDraft: { objectType: string; title: string; description: string } | null;
  supportingNewPropositionIds: string[];
  relevantExistingPropositionIds: string[];
  lifecycleTransition: string | null;
  confidence: number;
  explanation: string;
}

// ─── Placement Decisions ────────────────────────────────────────────────────

export type PlacementDecision =
  | "child_of"
  | "sibling_via_shared_parent"
  | "tangent_from"
  | "diverged_from"
  | "continued_from"
  | "branch_from"
  | "cross_tree_bridge"
  | "independent_root"
  | "defer_placement";

export interface PlacementResult {
  placement: PlacementDecision;
  targetObjectId: string | null;
  relationshipType: RelationType | null;
  supportingPropositionIds: string[];
  confidence: number;
  explanation: string;
}

// ─── Relationship Mutations ─────────────────────────────────────────────────

export type RelationshipMutationType =
  | "add_relationship"
  | "reclassify_relationship"
  | "strengthen_relationship"
  | "weaken_relationship"
  | "remove_relationship"
  | "no_change";

export interface RelationshipMutation {
  mutationType: RelationshipMutationType;
  relationshipId: string | null;
  sourceObjectId: string;
  targetObjectId: string;
  previousType: RelationType | null;
  proposedType: RelationType | null;
  supportingPropositionIds: string[];
  reason: string;
  confidence: number;
}

// ─── Graph Mutations ────────────────────────────────────────────────────────

export type MutationType =
  | "add_proposition"
  | "supersede_proposition"
  | "retract_proposition"
  | "continue_thread"
  | "create_object"
  | "update_object"
  | "transition_object_status"
  | "add_object_proposition"
  | "add_relationship"
  | "update_relationship"
  | "remove_relationship";

export interface GraphMutation {
  mutationId: string;
  type: MutationType;
  targetId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  sourceUtteranceIds: string[];
  sourcePropositionIds: string[];
  reason: string;
  confidence: number;
  provenance: "deterministic" | "llm_generated";
}

// ─── Retrieved Context ──────────────────────────────────────────────────────

export interface RetrievedContext {
  activeThread: Thread | null;
  recentObjects: ConversationalObject[];
  semanticNeighbors: Array<{ object: ConversationalObject; similarity: number; reason: string }>;
  unresolvedInquiries: ConversationalObject[];
  recentlyUpdated: ConversationalObject[];
  retrievalDiagnostics: {
    objectsConsidered: number;
    objectsRetrieved: number;
    threadsConsidered: number;
    threadsRetrieved: number;
    reasons: string[];
  };
}

// ─── Hierarchy Delta ────────────────────────────────────────────────────────

export interface HierarchyDelta {
  parentChanges: Array<{ objectId: string; previousParent: string | null; newParent: string | null }>;
  depthChanges: Array<{ objectId: string; previousDepth: number; newDepth: number }>;
  rootsAdded: string[];
  rootsRemoved: string[];
  treesCreated: string[];
  treesRemoved: string[];
  cycleRejections: string[];
}

// ─── Snapshot (in-memory graph state) ───────────────────────────────────────

export interface V2Snapshot {
  conversationId: string;
  objects: ConversationalObject[];
  relationships: Relationship[];
  propositions: Proposition[];
  threads: Thread[];
  hierarchy: DerivedHierarchyNode[];
  trees: DerivedTree[];
}

// ─── Full Incremental Result ────────────────────────────────────────────────

export interface IncrementalResult {
  newUtterances: Utterance[];
  newPropositions: Proposition[];
  retrievedContext: RetrievedContext;
  decisions: ObjectDecision[];
  proposedMutations: GraphMutation[];
  acceptedMutations: GraphMutation[];
  rejectedMutations: Array<{ mutation: GraphMutation; reason: string }>;
  updatedGraph: V2Snapshot;
  hierarchyChanges: HierarchyDelta;
  diagnostics: IncrementalDiagnostics;
}

export interface IncrementalDiagnostics {
  newUtteranceCount: number;
  newPropositionCount: number;
  retrievedObjectCount: number;
  primaryDecisionsByType: Record<string, number>;
  objectsCreated: number;
  objectsUpdated: number;
  objectsResolved: number;
  objectsReopened: number;
  relationshipsAdded: number;
  relationshipsChanged: number;
  relationshipsRemoved: number;
  rootsBefore: number;
  rootsAfter: number;
  maxDepthBefore: number;
  maxDepthAfter: number;
  hierarchyChanges: number;
  llmCalls: number;
  embeddingCalls: number;
  runtimeMs: number;
}
