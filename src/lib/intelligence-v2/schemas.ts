/**
 * V2 ContextGraph Engine — Canonical Semantic Model.
 *
 * Derivation chain: Utterance → Proposition → Thread → Object → Relationship → (emergent) Hierarchy
 */

// ─── Layer 0: Utterance (immutable ground truth) ────────────────────────────

export interface Utterance {
  utteranceId: string;
  sourceMessageId: string;
  conversationId: string;
  author: "user" | "assistant";
  rawContent: string;
  createdAt: string;
  temporalPosition: number;
  branchId: string | null;
  branchPath: string[];
  branchPointMessageId: string | null;
  tombstoned: boolean;
}

// ─── Layer 1: Proposition (smallest semantic claim) ─────────────────────────

export type PropositionType =
  | "claim" | "question" | "preference" | "intent"
  | "decision" | "emotional_state" | "example" | "request";

export type PropositionProvenance = "direct" | "paraphrase" | "interpretation" | "inference";
export type PropositionStatus = "active" | "superseded" | "retracted" | "invalidated";

export interface Proposition {
  propositionId: string;
  propositionType: PropositionType;
  normalizedContent: string;
  sourceUtteranceIds: string[];
  authoredBy: "user" | "assistant";
  provenance: PropositionProvenance;
  confirmedByUser: boolean;
  confidence: number;
  status: PropositionStatus;
  supersedesPropositionId: string | null;
}

// ─── Layer 2: Thread (contiguous subject-coherent sequence) ─────────────────

export type ThreadStatus = "active" | "completed" | "abandoned" | "branched";

export interface Thread {
  threadId: string;
  utteranceIds: string[];
  propositionIds: string[];
  subject: string;
  branchId: string | null;
  originThreadId: string | null;
  divergenceUtteranceId: string | null;
  status: ThreadStatus;
}

// ─── Layer 3: Object (navigable graph unit) ─────────────────────────────────

export type ObjectType =
  | "inquiry" | "insight" | "problem" | "task" | "project"
  | "goal" | "decision" | "preference" | "explanation"
  | "plan" | "comparison" | "unresolved" | "noise";

export type ObjectMaturity = "nascent" | "developing" | "stable";
export type ObjectStatus = "active" | "resolved" | "deferred" | "discarded";

export interface ConversationalObject {
  objectId: string;
  objectType: ObjectType;
  title: string;
  description: string;
  propositionIds: string[];
  threadIds: string[];
  supportingUtteranceIds: string[];
  contextualAssistantUtteranceIds: string[];
  maturity: ObjectMaturity;
  status: ObjectStatus;
  provenanceSummary: string;
}

// ─── Layer 4: Relationship (graph edges) ────────────────────────────────────

export type SemanticRelationType =
  | "answers" | "raises_question" | "supports" | "evidence_for"
  | "example_of" | "elaborates" | "reframes" | "contrasts_with"
  | "causes" | "depends_on" | "specializes" | "generalizes" | "leads_to";

export type StructuralRelationType =
  | "child_of" | "tangent_from" | "diverged_from" | "branch_from"
  | "continued_from" | "merged_from" | "split_from";

export type ManualRelationType = "manual_merge" | "user_linked";

export type RelationType = SemanticRelationType | StructuralRelationType | ManualRelationType;
export type RelationFamily = "semantic" | "structural" | "manual";
export type VisualClass = "semantic" | "structural" | "weak" | "manual";
export type RelationStatus = "proposed" | "validated" | "active" | "reclassified" | "removed";

export interface Relationship {
  relationshipId: string;
  sourceObjectId: string;
  targetObjectId: string;
  type: RelationType;
  family: RelationFamily;
  sourcePropositionIds: string[];
  provenance: string;
  confidence: number;
  createdBy: "system" | "user";
  status: RelationStatus;
  visualClass: VisualClass;
  explanation: string;
}

// ─── Emergent Hierarchy (derived, never stored as authority) ─────────────────

export interface DerivedHierarchyNode {
  objectId: string;
  treeId: string;
  depth: number;
  parentObjectId: string | null;
  childObjectIds: string[];
  siblingObjectIds: string[];
}

export interface DerivedTree {
  treeId: string;
  rootObjectId: string;
  objectIds: string[];
  bridges: Array<{ targetTreeId: string; relation: RelationType; explanation: string }>;
}

// ─── Full V2 Output ─────────────────────────────────────────────────────────

export interface V2GraphPlan {
  conversationId: string;
  timestamp: string;
  utterances: Utterance[];
  propositions: Proposition[];
  threads: Thread[];
  objects: ConversationalObject[];
  semanticRelationships: Relationship[];
  structuralRelationships: Relationship[];
  manualRelationships: Relationship[];
  derivedHierarchy: DerivedHierarchyNode[];
  trees: DerivedTree[];
  unsupportedClaims: string[];
  supersededPropositions: Proposition[];
  validationResults: ValidationResult[];
  proposedOperations: MutationOperation[];
}

export interface ValidationResult {
  targetId: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface MutationOperation {
  operationId: string;
  operationType: string;
  sourceObjectIds: string[];
  sourceMessageIds: string[];
  explanation: string;
  confidence: number;
  provenance: string;
  validationWarnings: string[];
}
