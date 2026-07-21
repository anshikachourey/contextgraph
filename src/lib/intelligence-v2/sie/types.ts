/**
 * TypeScript-OWNED orchestration types for the SIE pipeline.
 *
 * These types represent orchestration outcomes (invariant validation,
 * commit results, local graph-state wrappers). They are NOT semantic
 * decisions — semantic judgments live in the Python-owned transport
 * types generated from the OpenAPI contract.
 *
 * Transport types (ProcessResult, entity models, enums, etc.) are
 * re-exported from ./generated and should never be duplicated here.
 */

import type { components } from "./generated";

// ─── Re-export transport entity types for convenience ───────────────────────

/** Python-owned ProcessResult — semantic decisions from the ml-service. */
export type ProcessResult = components["schemas"]["ProcessResult"];

/** Python-owned entity types used in graph-state wrappers. */
export type PersistentConcern = components["schemas"]["ConcernSummary"];
export type Proposition = components["schemas"]["Proposition"];
export type PropositionAssociation = components["schemas"]["PropositionAssociation"];
export type SemanticPacket = components["schemas"]["SemanticPacket"];

// ─── TypeScript-owned orchestration types ───────────────────────────────────

/**
 * Structural invariant violation detected by TypeScript validation.
 *
 * TypeScript validates structural correctness (no cycles, single parent,
 * version consistency, referential integrity) — it does NOT make semantic
 * ownership decisions.
 */
export interface InvariantViolation {
  type:
    | "cycle_detected"
    | "multi_parent"
    | "version_conflict"
    | "dangling_reference";
  entityId: string;
  description: string;
}

/**
 * Result of deterministic invariant validation performed by TypeScript.
 */
export interface InvariantValidationResult {
  valid: boolean;
  violations: InvariantViolation[];
}

/**
 * Result of the atomic database commit operation.
 *
 * Represents the outcome of committing semantic decisions to the database
 * through the versioned commit RPC.
 */
export interface CommitResult {
  success: boolean;
  committedGraphVersion: number | null;
  requestId: string;
  retryRequired: boolean;
  violations: InvariantViolation[];
}

/**
 * Full orchestration result combining Python semantic decisions,
 * TypeScript structural validation, and commit outcome.
 *
 * This is the top-level return type from the SIE orchestrator after
 * processing messages through the full pipeline.
 */
export interface SIEOrchestratorResult {
  /** Semantic decisions from Python ml-service. */
  processResult: ProcessResult;
  /** Structural invariant validation performed by TypeScript. */
  invariantValidation: InvariantValidationResult;
  /** Atomic commit outcome. */
  commitResult: CommitResult;
}

/**
 * Local graph-state wrapper used by the TypeScript orchestrator.
 *
 * Represents the current conversation graph state loaded from Supabase,
 * used for invariant validation and as input context for Python processing.
 */
export interface SIEGraphState {
  graphVersion: number;
  concerns: PersistentConcern[];
  propositions: Proposition[];
  associations: PropositionAssociation[];
  packets: SemanticPacket[];
}
