/**
 * ContextGraph Semantic Mutation Eval — Core Types.
 */

// ─── Fixture Types ──────────────────────────────────────────────────────────

export type ExecutionMode = "SINGLE_STEP" | "SEQUENCE";

export interface EvalFixture {
  id: string;
  title: string;
  tags: string[];
  executionMode: ExecutionMode;
  existingGraph: { objects: EvalObject[]; relationships: EvalRelationship[] };
  newMessages?: EvalMessage[];
  semanticPacket?: EvalSemanticPacket;
  steps?: EvalStep[];
  retrieval?: { initialIdentityCandidates: Array<{ objectId: string; rank: number }> };
  expectedTrace: EvalExpectedTrace;
  expectedMutationSet: EvalExpectedMutationSet;
  forbiddenOutcomes: EvalForbiddenOutcome[];
  criticalAssertions: string[];
}

export interface EvalObject {
  objectId: string;
  title: string;
  persistentConcern: string;
  status: string;
  parentObjectId?: string;
}

export interface EvalRelationship {
  sourceObjectId: string;
  targetObjectId: string;
  type: string;
}

export interface EvalMessage {
  role: string;
  messageId: string;
  content: string;
}

export interface EvalSemanticPacket {
  packetId: string;
  userEvidenceMessageIds: string[];
  assistantContextMessageIds: string[];
  conciseMeaning: string;
  focalSubject: string;
  operativeIntent: string;
}

export interface EvalStep {
  stepId: string;
  userMessage: string;
  expected: Record<string, unknown>;
}

export interface EvalExpectedTrace {
  durableSemanticSignificance: boolean;
  identity?: {
    initialSameObjectId?: string;
    identitySearchSufficient?: boolean;
    mustWidenIdentitySearch?: boolean;
    finalPrimaryObjectId?: string;
    primaryObjectDisposition?: string;
  };
  crossObjectImpacts?: Array<Record<string, unknown>>;
  longitudinalEmergence?: Record<string, unknown>;
}

export interface EvalExpectedMutationSet {
  objectMutations: Array<Record<string, unknown>>;
  structuralMutations: Array<Record<string, unknown>>;
  relationshipMutations: Array<Record<string, unknown>>;
  propositionStateMutations: Array<Record<string, unknown>>;
  restructuringSignals: Array<Record<string, unknown>>;
}

export interface EvalForbiddenOutcome {
  type: string;
  [key: string]: unknown;
}

// ─── Variant Types ──────────────────────────────────────────────────────────

export interface EvalVariant {
  id: string;
  baseCaseId: string;
  description: string;
  transformation: { patches: Array<{ op: string; path: string; value: unknown }> };
  expectedInvariant: { preserveCriticalAssertions: boolean; preserveForbiddenOutcomes: boolean; preserveExpectedMutationSemantics: boolean };
}

export type VariantMaterializationStatus = "MACHINE_MATERIALIZABLE" | "REQUIRES_EXPLICIT_MATERIALIZATION" | "INVALID";

// ─── Model Output Types ─────────────────────────────────────────────────────

export interface EvalModelOutput {
  durableSemanticSignificance: boolean;
  identity?: {
    initialSameObjectId?: string;
    identitySearchSufficient?: boolean;
    mustWidenIdentitySearch?: boolean;
    finalPrimaryObjectId?: string;
    primaryObjectDisposition?: string;
  };
  crossObjectImpacts?: Array<Record<string, unknown>>;
  objectMutations?: Array<Record<string, unknown>>;
  structuralMutations?: Array<Record<string, unknown>>;
  relationshipMutations?: Array<Record<string, unknown>>;
  propositionStateMutations?: Array<Record<string, unknown>>;
  restructuringSignals?: Array<Record<string, unknown>>;
}

// ─── Scorer Types ───────────────────────────────────────────────────────────

export interface ScorerResult {
  scorerName: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; expected?: unknown; actual?: unknown; reason?: string }>;
}

export interface EvalCaseResult {
  fixtureId: string;
  provider: string;
  model: string;
  modelVersion?: string;
  constitutionVersion: string;
  constitutionHash: string;
  outputContractVersion?: string;
  rawModelOutput: string;
  parsedOutput: EvalModelOutput | null;
  scorerResults: ScorerResult[];
  passed: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  parseErrors: string[];
  schemaErrors: string[];
  providerErrors: string[];
}

export interface EvalExperimentResult {
  experimentId: string;
  timestamp: string;
  constitutionVersion: string;
  constitutionHash: string;
  provider: string;
  model: string;
  cases: EvalCaseResult[];
  summary: EvalSummary;
}

export interface EvalSummary {
  goldenCasePassRate: number;
  variantPassRate: number;
  identityAccuracy: number;
  identityWideningAccuracy: number;
  parentAccuracy: number;
  parentWideningAccuracy: number;
  crossObjectImpactAccuracy: number;
  relationshipPrecision: number;
  supersessionAccuracy: number;
  restructuringSignalAccuracy: number;
  forbiddenOutcomeRate: number;
  structuralInvariantViolationRate: number;
  repeatRunConsistency: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
}

// ─── Provider Adapter Types ─────────────────────────────────────────────────

export interface ModelAdapter {
  provider: string;
  model: string;
  available: boolean;
  run(input: EvalRunInput): Promise<EvalRunOutput>;
}

export interface EvalRunInput {
  fixture: EvalFixture;
  constitutionText: string;
  constitutionVersion: string;
  outputContractSchema?: Record<string, unknown>;
}

export interface EvalRunOutput {
  rawOutput: string;
  parsedOutput: EvalModelOutput | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  parseErrors: string[];
  providerErrors: string[];
}
