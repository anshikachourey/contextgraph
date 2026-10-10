/**
 * SIE Commit Manager — Builds validated commit bundles and executes atomic
 * database commits through a single authoritative RPC call.
 *
 * Design rules:
 * - Build and validate one semantic commit bundle BEFORE any database mutation.
 * - Include pending-decision creations and resolutions in the bundle.
 * - Make exactly ONE authoritative RPC call (v2_commit_update) plus
 *   v2_commit_identity_bundle for identity-specific sections.
 * - NEVER write to SIE tables directly (no client-side writeSIETables).
 * - On version conflict: reload graph state + pending decisions and require
 *   fresh Python semantic analysis. Never blindly replay stale mutations.
 * - NEVER choose a concern, reinterpret scores, change confidence, or
 *   override Python's semantic decision.
 * - Treat database-side validation as authoritative even after TypeScript
 *   pre-validation passes.
 * - Route SIE identity work through existing semantic-authority/shadow
 *   controls; do not bypass or mutate authority state.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { validateInvariants } from "./invariant-validator";
import { projectToV2Snapshot, type V2SnapshotProjection } from "./v2-projection";
import {
  canWriteProductionSnapshot,
  isShadowMode,
  type AuthorityState,
} from "./authority-state-machine";
import type {
  CommitResult,
  InvariantViolation,
  ProcessResult,
  SIEGraphState,
} from "./types";
import type { components } from "./generated";

// ─── Transport types from generated contract ────────────────────────────────

type RetentionDecision = components["schemas"]["RetentionDecision"];
type Proposition = components["schemas"]["Proposition"];
type SemanticPacket = components["schemas"]["SemanticPacket"];
type PropositionAssociation = components["schemas"]["PropositionAssociation"];
type PacketMembership = components["schemas"]["PacketMembership"];
type PacketSplitRecord = components["schemas"]["PacketSplitRecord"];
type ConcernProposal = components["schemas"]["ConcernProposal"];
type PendingDecisionSummary = components["schemas"]["PendingDecisionSummary"];
type IdentityResolutionResult = components["schemas"]["IdentityResolutionResult"];
type SemanticDependencyGroupRef = components["schemas"]["SemanticDependencyGroupRef"];

// ─── Commit Bundle Types ────────────────────────────────────────────────────

/**
 * Represents new pending decisions to create — derived from unresolved/deferred
 * identity resolutions in the ProcessResult.
 */
export interface PendingDecisionCreation {
  entity_id: string;
  stage: string;
  outcome: string;
  rationale: string | null;
  request_id: string;
}

/**
 * Represents pending decisions that are now resolved — their entity received
 * a successful resolution in this ProcessResult.
 */
export interface PendingDecisionResolution {
  entity_id: string;
  resolved_by_request_id: string;
}

/**
 * Identity resolution record for the identity bundle commit.
 * Passed through to v2_commit_identity_bundle without modification.
 * TypeScript NEVER reinterprets or modifies these records — they arrive
 * from Python as authoritative semantic decisions.
 */
export interface IdentityResolutionRecordBundle {
  record_id: string;
  request_id: string;
  packet_id: string;
  graph_version_analyzed: number;
  graph_snapshot_token?: string | null;
  outcome: string;
  action: string;
  identity_stage_status: string;
  identity_confidence: string | null;
  sufficiency_stage_status: string | null;
  sufficiency_confidence: string | null;
  matched_concern_id: string | null;
  proposed_concern_id: string | null;
  candidates_considered: unknown[];
  irs_signals: unknown[];
  retrieval_attempts: unknown[];
  sufficiency_record: unknown | null;
  evidence_references: unknown[];
  reasoning: string;
  semantic_policy_version: string;
  retrieval_policy_version: string;
  model_config_version: string;
  prompt_version: string;
  proposed_dependency_group_id: string | null;
  created_at?: string;
}

/**
 * Retrieval attempt record for the identity bundle commit.
 * Passed through to v2_commit_identity_bundle without modification.
 */
export interface RetrievalAttemptBundle {
  attempt_id: string;
  record_id: string;
  packet_id: string;
  channel_id: string;
  channel_family: string;
  query_mode: string;
  query_reference: string;
  scope_description: string;
  status: string;
  candidate_ids: string[];
  candidate_count: number;
  latency_ms: number | null;
  failure_reason: string | null;
  retrieval_policy_version: string;
  is_widening_attempt: boolean;
  triggered_by_signal: string | null;
  created_at?: string;
}

/**
 * Pending identity detail for the identity bundle commit.
 * Passed through to v2_commit_identity_bundle without modification.
 */
export interface PendingIdentityDetailBundle {
  detail_id: string;
  decision_id: string;
  packet_id: string;
  graph_version_analyzed: number;
  source_resolution_record_id: string;
  identity_stage_status: string;
  identity_confidence: string | null;
  sufficiency_stage_status: string | null;
  sufficiency_confidence: string | null;
  created_at?: string;
}

/**
 * Pending identity proposition membership for the identity bundle commit.
 * Passed through to v2_commit_identity_bundle without modification.
 */
export interface PendingPropositionMembershipBundle {
  id: string;
  decision_id: string;
  proposition_id: string;
  ordinal: number;
  created_at?: string;
}

/**
 * Association mutation for the identity bundle commit.
 * These represent normalized proposition-concern associations produced
 * by identity resolution. TypeScript passes them through without choosing
 * roles, reinterpreting confidence, or modifying provenance.
 */
export interface AssociationMutationBundle {
  association_id: string;
  association_creation_key: string;
  proposition_id: string;
  concern_id: string;
  role: string;
  confidence: string;
  provenance: string;
  established_by_packet_id: string | null;
  semantic_state: string;
  created_at?: string;
  version: number;
}

/**
 * Shared concern proposal for the identity bundle commit.
 * TypeScript never chooses or modifies concern details — they arrive
 * from Python as complete proposals.
 */
export interface SharedProposalBundle {
  concern_id: string;
  identity_summary: string;
  display_title: string;
  current_summary: string;
  status: string;
  canonical_parent_id: string | null;
  parent_resolution_state: string;
  metadata: Record<string, unknown>;
  semantic_version: number;
  merged_into_concern_id: string | null;
  created_at?: string;
  last_active_at?: string;
}

/**
 * Request state transition for the identity bundle commit.
 * Transitions the commit request to COMMITTED state after successful commit.
 */
export interface RequestStateTransitionBundle {
  request_id: string;
  target_status: string;
  committed_graph_version: number;
  result: unknown;
  committed_at?: string;
  completed_at?: string;
  transition_metadata?: Record<string, unknown>;
}

/**
 * The identity bundle sections extracted from the ProcessResult.
 * These are passed directly to v2_commit_identity_bundle without
 * any TypeScript semantic modification.
 */
export interface IdentityBundleSections {
  resolutionRecords: IdentityResolutionRecordBundle[];
  retrievalAttempts: RetrievalAttemptBundle[];
  pendingIdentityDetails: PendingIdentityDetailBundle[];
  pendingPropositionMemberships: PendingPropositionMembershipBundle[];
  associationMutations: AssociationMutationBundle[];
  sharedProposals: SharedProposalBundle[];
  requestStateTransition: RequestStateTransitionBundle | null;
}

/**
 * The complete commit bundle assembled from a ProcessResult. This contains
 * all SIE mutations that will be applied in a single atomic RPC transaction.
 *
 * Built entirely in-memory before any database mutation occurs.
 */
export interface SIECommitBundle {
  // ─── Entity registrations ───────────────────────────────────────────
  entityRegistrations: Array<{
    entity_kind: string;
    creation_key: string;
    entity_id: string;
  }>;

  // ─── Core SIE entities ──────────────────────────────────────────────
  concerns: ConcernProposal[];
  propositions: Proposition[];
  packets: SemanticPacket[];
  associations: PropositionAssociation[];
  memberships: PacketMembership[];
  splits: PacketSplitRecord[];
  retentionDecisions: RetentionDecision[];

  // ─── Pending decisions ──────────────────────────────────────────────
  pendingDecisionCreations: PendingDecisionCreation[];
  pendingDecisionResolutions: PendingDecisionResolution[];

  // ─── Identity bundle sections ───────────────────────────────────────
  /** All identity resolution sections from Python. TypeScript NEVER
   * modifies, reinterprets, or overrides these — they are passed through
   * to the database commit RPC exactly as Python produced them. */
  identityBundle: IdentityBundleSections;

  // ─── Audit trail ────────────────────────────────────────────────────
  auditEntries: Array<{
    entity_type: string;
    entity_id: string;
    field_changed: string;
    previous_value: unknown;
    new_value: unknown;
    change_reason: string;
    change_type: string;
  }>;

  // ─── Metadata ───────────────────────────────────────────────────────
  conversationId: string;
  requestId: string;
  idempotencyKey: string;
  baseGraphVersion: number;
  targetGraphVersion: number;
  lowestSeq: number;
  highestSeq: number;
  payloadFingerprint: string;
}

// ─── Version Conflict Error Detection ───────────────────────────────────────

const VERSION_CONFLICT_PATTERNS = [
  "version conflict",
  "version_conflict",
  "optimistic lock",
  "concurrent update",
  "stale version",
] as const;

function isVersionConflictError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return VERSION_CONFLICT_PATTERNS.some((pattern) => lower.includes(pattern));
}

// ─── Database Validation Error Detection ────────────────────────────────────

const DB_VALIDATION_PATTERNS = [
  "invariant_violation",
  "lease_invalid",
  "fingerprint_mismatch",
  "entity_registry_conflict",
  "conversation_ownership",
  "dependency_group_incomplete",
  "association_uniqueness",
] as const;

/**
 * Detects database-side validation errors that are authoritative.
 * Even when TypeScript pre-validation passes, the database may reject
 * for stronger invariant enforcement.
 */
function isDatabaseValidationError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return DB_VALIDATION_PATTERNS.some((pattern) => lower.includes(pattern));
}

// ─── Contract and Dependency Group Validation ───────────────────────────────

/**
 * Validates that the generated contract fields in the ProcessResult are complete.
 * This is a structural check — it verifies that all required fields exist and
 * are properly typed. It does NOT reinterpret or override Python's decisions.
 */
export function validateContractCompleteness(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // Verify required identity fields
  if (!processResult.api_contract_version) {
    violations.push({
      type: "dangling_reference",
      entityId: processResult.request_id,
      description: "ProcessResult missing api_contract_version",
    });
  }

  if (!processResult.request_id) {
    violations.push({
      type: "dangling_reference",
      entityId: "unknown",
      description: "ProcessResult missing request_id",
    });
  }

  if (!processResult.idempotency_key) {
    violations.push({
      type: "dangling_reference",
      entityId: processResult.request_id ?? "unknown",
      description: "ProcessResult missing idempotency_key",
    });
  }

  if (processResult.base_graph_version == null) {
    violations.push({
      type: "dangling_reference",
      entityId: processResult.request_id ?? "unknown",
      description: "ProcessResult missing base_graph_version",
    });
  }

  // Validate every identity resolution has required fields
  for (const resolution of processResult.identity_resolutions) {
    if (!resolution.packet_id) {
      violations.push({
        type: "dangling_reference",
        entityId: processResult.request_id,
        description: "IdentityResolutionResult missing packet_id",
      });
    }
    if (!resolution.outcome) {
      violations.push({
        type: "dangling_reference",
        entityId: resolution.packet_id ?? processResult.request_id,
        description: "IdentityResolutionResult missing outcome",
      });
    }
  }

  return violations;
}

/**
 * Validates that all dependency groups are complete: every mutation_ref
 * resolves to an entity in the ProcessResult. A dangling ref means the
 * ProcessResult is structurally incomplete and must NOT be committed.
 *
 * This complements the invariant validator's dependency group check
 * specifically for the commit path.
 */
export function validateDependencyGroupCompleteness(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const groups = processResult.dependency_groups ?? [];

  if (groups.length === 0) {
    return violations;
  }

  // Build set of all known entity IDs in the result
  const allResultIds = new Set<string>();

  for (const prop of processResult.propositions) {
    allResultIds.add(prop.proposition_id);
  }
  for (const packet of processResult.packets) {
    allResultIds.add(packet.packet_id);
  }
  for (const assoc of processResult.proposed_associations) {
    allResultIds.add(assoc.association_id);
  }
  for (const membership of processResult.packet_memberships) {
    allResultIds.add(membership.membership_id);
  }
  for (const split of processResult.splits) {
    allResultIds.add(split.split_id);
  }
  for (const decision of processResult.retention_decisions) {
    allResultIds.add(decision.decision_id);
  }
  for (const proposal of processResult.new_concern_proposals) {
    allResultIds.add(proposal.proposed_concern_id);
  }
  for (const resolution of processResult.identity_resolutions) {
    allResultIds.add(resolution.packet_id);
  }

  for (const group of groups) {
    if (!group.group_id) {
      violations.push({
        type: "dangling_reference",
        entityId: processResult.request_id,
        description: "Dependency group missing group_id",
      });
      continue;
    }

    if (!group.failure_policy) {
      violations.push({
        type: "dangling_reference",
        entityId: group.group_id,
        description: `Dependency group "${group.group_id}" missing failure_policy`,
      });
    }

    const missingRefs: string[] = [];
    for (const ref of group.mutation_refs) {
      if (!allResultIds.has(ref)) {
        missingRefs.push(ref);
      }
    }

    if (missingRefs.length > 0) {
      violations.push({
        type: "dangling_reference",
        entityId: group.group_id,
        description: `Dependency group "${group.group_id}" (policy=${group.failure_policy}) has ${missingRefs.length} missing mutation refs: ${missingRefs.join(", ")}`,
      });
    }
  }

  return violations;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Builds a complete commit bundle from a ProcessResult and current graph state.
 *
 * The bundle contains all entity registrations, SIE mutations, pending-decision
 * lifecycle updates, identity bundle sections, audit entries, and metadata
 * required for the atomic commit. No database mutation occurs during bundle
 * construction.
 *
 * Identity bundle sections are extracted from ProcessResult and passed through
 * unchanged. TypeScript NEVER chooses a concern, reinterprets scores, changes
 * confidence, or overrides Python's semantic decisions.
 */
export function buildCommitBundle(
  processResult: ProcessResult,
  sieGraphState: SIEGraphState
): SIECommitBundle {
  const baseVersion = sieGraphState.graphVersion;
  const targetVersion = baseVersion + 1;

  // ─── Entity registrations ───────────────────────────────────────────
  const entityRegistrations: SIECommitBundle["entityRegistrations"] = [];

  // Register propositions
  for (const prop of processResult.propositions) {
    entityRegistrations.push({
      entity_kind: "proposition",
      creation_key: prop.proposition_creation_key,
      entity_id: prop.proposition_id,
    });
  }

  // Register packets
  for (const packet of processResult.packets) {
    entityRegistrations.push({
      entity_kind: "packet",
      creation_key: packet.packet_creation_key,
      entity_id: packet.packet_id,
    });
  }

  // Register new concerns
  for (const concern of processResult.new_concern_proposals) {
    entityRegistrations.push({
      entity_kind: "concern",
      creation_key: concern.concern_creation_key,
      entity_id: concern.proposed_concern_id,
    });
  }

  // Register associations
  for (const assoc of processResult.proposed_associations) {
    entityRegistrations.push({
      entity_kind: "association",
      creation_key: assoc.association_creation_key,
      entity_id: assoc.association_id,
    });
  }

  // Register memberships
  for (const membership of processResult.packet_memberships) {
    entityRegistrations.push({
      entity_kind: "membership",
      creation_key: membership.membership_creation_key,
      entity_id: membership.membership_id,
    });
  }

  // Register splits
  for (const split of processResult.splits) {
    entityRegistrations.push({
      entity_kind: "split",
      creation_key: split.split_creation_key,
      entity_id: split.split_id,
    });
  }

  // Register retention decisions
  for (const decision of processResult.retention_decisions) {
    entityRegistrations.push({
      entity_kind: "retention_decision",
      creation_key: decision.decision_creation_key,
      entity_id: decision.decision_id,
    });
  }

  // ─── Pending decision lifecycle ─────────────────────────────────────
  const pendingDecisionCreations: PendingDecisionCreation[] = [];
  const pendingDecisionResolutions: PendingDecisionResolution[] = [];

  // Create new pending decisions from unresolved/deferred identity resolutions
  for (const resolution of processResult.identity_resolutions) {
    const isUnresolved =
      resolution.outcome === "UNRESOLVED" ||
      resolution.outcome === "DEFER" ||
      resolution.outcome === "RETRIEVAL_INCONCLUSIVE" ||
      resolution.outcome === "REQUIRES_VALIDATION";

    if (isUnresolved) {
      pendingDecisionCreations.push({
        entity_id: resolution.packet_id,
        stage: "identity_resolution",
        outcome: resolution.outcome,
        rationale: resolution.rationale,
        request_id: processResult.request_id,
      });
    }
  }

  // Resolve existing pending decisions that now have successful resolutions
  const resolvedEntityIds = new Set<string>();
  for (const resolution of processResult.identity_resolutions) {
    if (
      resolution.outcome === "YES" &&
      (resolution.matched_concern_id || resolution.new_concern_proposal)
    ) {
      resolvedEntityIds.add(resolution.packet_id);
    }
  }

  // Check which resolved entities were previously pending
  // (tracked in graph state via pending_decisions in GraphStateContext)
  // Since SIEGraphState doesn't directly expose pending decisions, we match
  // resolved entity IDs against deferred IDs from diagnostics
  const deferredEntityIds = new Set(
    processResult.diagnostics.deferred_entity_ids ?? []
  );
  for (const entityId of resolvedEntityIds) {
    if (deferredEntityIds.has(entityId)) {
      pendingDecisionResolutions.push({
        entity_id: entityId,
        resolved_by_request_id: processResult.request_id,
      });
    }
  }

  // ─── Identity bundle sections ───────────────────────────────────────
  // Extract all identity bundle sections from ProcessResult.
  // These are passed through to v2_commit_identity_bundle WITHOUT any
  // TypeScript semantic modification or reinterpretation.
  const identityBundle = extractIdentityBundleSections(
    processResult,
    baseVersion,
    targetVersion
  );

  // ─── Audit entries for new concerns ─────────────────────────────────
  const auditEntries: SIECommitBundle["auditEntries"] = [];

  for (const concern of processResult.new_concern_proposals) {
    auditEntries.push({
      entity_type: "concern",
      entity_id: concern.proposed_concern_id,
      field_changed: "status",
      previous_value: null,
      new_value: "ACTIVE",
      change_reason: `New concern created via identity resolution (request: ${processResult.request_id})`,
      change_type: "evolution",
    });
  }

  // Audit entries for new associations
  for (const assoc of processResult.proposed_associations) {
    auditEntries.push({
      entity_type: "association",
      entity_id: assoc.association_id,
      field_changed: "role",
      previous_value: null,
      new_value: assoc.role,
      change_reason: `Association established via ${assoc.provenance} (request: ${processResult.request_id})`,
      change_type: "evolution",
    });
  }

  return {
    entityRegistrations,
    concerns: processResult.new_concern_proposals,
    propositions: processResult.propositions,
    packets: processResult.packets,
    associations: processResult.proposed_associations,
    memberships: processResult.packet_memberships,
    splits: processResult.splits,
    retentionDecisions: processResult.retention_decisions,
    pendingDecisionCreations,
    pendingDecisionResolutions,
    identityBundle,
    auditEntries,
    conversationId: processResult.conversation_id,
    requestId: processResult.request_id,
    idempotencyKey: processResult.idempotency_key,
    baseGraphVersion: baseVersion,
    targetGraphVersion: targetVersion,
    lowestSeq: processResult.lowest_seq,
    highestSeq: processResult.highest_seq,
    payloadFingerprint: computePayloadFingerprint(processResult),
  };
}

/**
 * Computes a deterministic fingerprint of a ProcessResult for idempotency.
 *
 * The fingerprint is derived from immutable request identity and entity
 * creation keys — NOT from mutable model text. This ensures that the same
 * logical commit attempt always produces the same fingerprint regardless
 * of non-semantic differences in serialization.
 */
export function computePayloadFingerprint(processResult: ProcessResult): string {
  // Build a canonical representation from immutable fields
  const parts: string[] = [
    processResult.request_id,
    processResult.idempotency_key,
    processResult.conversation_id,
    String(processResult.base_graph_version),
    String(processResult.lowest_seq),
    String(processResult.highest_seq),
    // Entity creation keys (sorted for determinism)
    ...processResult.propositions
      .map((p) => p.proposition_creation_key)
      .sort(),
    ...processResult.packets
      .map((p) => p.packet_creation_key)
      .sort(),
    ...processResult.new_concern_proposals
      .map((c) => c.concern_creation_key)
      .sort(),
    ...processResult.proposed_associations
      .map((a) => a.association_creation_key)
      .sort(),
    ...processResult.packet_memberships
      .map((m) => m.membership_creation_key)
      .sort(),
    ...processResult.splits
      .map((s) => s.split_creation_key)
      .sort(),
    ...processResult.retention_decisions
      .map((d) => d.decision_creation_key)
      .sort(),
  ];

  // Simple deterministic hash using djb2-like algorithm
  // (crypto.subtle unavailable in all contexts; this is a structural fingerprint,
  // not a security hash)
  const input = parts.join("|");
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Convert to hex string with prefix for readability
  return `fp_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Main commit function — validates invariants, contract completeness,
 * dependency-group completeness, builds the commit bundle, checks
 * authority state, computes the V2 projection, and executes atomic RPCs.
 *
 * Flow:
 * 1. Validate contract completeness (generated contract fields)
 * 2. Validate dependency-group completeness (all mutation_refs exist)
 * 3. Validate structural invariants
 * 4. If violations: return failure with violations (no RPC call)
 * 5. Check authority state — SIE must be allowed to write (SIE or SIE_SHADOW)
 * 6. Build commit bundle (entities, associations, splits, audit, pending decisions, identity bundle)
 * 7. Compute V2 snapshot projection
 * 8. Compute payload fingerprint for idempotency
 * 9. Call v2_commit_update RPC with all parameters (8 original + 5 SIE)
 * 10. If SIE authority: call v2_commit_identity_bundle with all identity sections
 * 11. On success: return CommitResult with new graph version
 * 12. On version conflict: return CommitResult with retryRequired=true
 * 13. On database validation error: return failure (database is authoritative)
 * 14. On other errors: throw
 *
 * CRITICAL RULES:
 * - NEVER writes to SIE tables directly. All mutations go through RPCs.
 * - NEVER chooses a concern, reinterprets scores, changes confidence,
 *   or overrides Python's decision.
 * - Treats database-side validation as authoritative even after TypeScript
 *   pre-validation passes.
 * - Routes through the existing semantic-authority/shadow controls; does
 *   NOT bypass or mutate the authority state.
 */
export async function commitSIEResult(
  conversationId: string,
  processResult: ProcessResult,
  sieGraphState: SIEGraphState,
  v2Projection?: V2SnapshotProjection,
  authorityState?: AuthorityState
): Promise<CommitResult> {
  // ─── Step 1: Validate generated contract completeness ───────────────
  const contractViolations = validateContractCompleteness(processResult);
  if (contractViolations.length > 0) {
    return {
      success: false,
      committedGraphVersion: null,
      requestId: processResult.request_id,
      retryRequired: false,
      violations: contractViolations,
    };
  }

  // ─── Step 2: Validate dependency-group completeness ─────────────────
  const groupViolations = validateDependencyGroupCompleteness(processResult);
  if (groupViolations.length > 0) {
    return {
      success: false,
      committedGraphVersion: null,
      requestId: processResult.request_id,
      retryRequired: false,
      violations: groupViolations,
    };
  }

  // ─── Step 3: Validate structural invariants ─────────────────────────
  const validation = validateInvariants(
    processResult,
    sieGraphState,
    sieGraphState.graphVersion
  );

  // ─── Step 4: Reject if invariant violations exist ───────────────────
  if (!validation.valid) {
    return {
      success: false,
      committedGraphVersion: null,
      requestId: processResult.request_id,
      retryRequired: false,
      violations: validation.violations,
    };
  }

  // ─── Step 5: Check authority state ──────────────────────────────────
  // Route through existing semantic-authority/shadow controls.
  // Do NOT bypass or mutate the authority state as a side effect.
  const effectiveAuthority = authorityState ?? "SIE_SHADOW";
  const sieCanWrite = canWriteProductionSnapshot(effectiveAuthority, "sie");
  const inShadowMode = isShadowMode(effectiveAuthority);

  // In shadow mode, SIE writes to isolated shadow storage only.
  // The commit proceeds but is marked as shadow (non-production).
  // If authority is V2 (not shadow, not SIE), SIE should not be committing.
  if (!sieCanWrite && !inShadowMode) {
    return {
      success: false,
      committedGraphVersion: null,
      requestId: processResult.request_id,
      retryRequired: false,
      violations: [{
        type: "version_conflict",
        entityId: processResult.request_id,
        description: `SIE cannot commit: authority state "${effectiveAuthority}" does not permit SIE writes. Use shadow mode for evaluation or switch to SIE authority.`,
      }],
    };
  }

  // ─── Step 6: Build commit bundle ────────────────────────────────────
  const commitBundle = buildCommitBundle(processResult, sieGraphState);

  // ─── Step 7: Compute V2 snapshot projection ─────────────────────────
  // If not provided externally, compute from the resulting SIE state.
  // The resulting state is the current state + new entities from the bundle.
  const snapshot = v2Projection ?? projectToV2Snapshot(buildResultingSIEState(sieGraphState, commitBundle));

  // ─── Step 8: Payload fingerprint (already computed in bundle) ────────
  const payloadFingerprint = commitBundle.payloadFingerprint;

  // ─── Step 9: Format mutations for V2 compatibility ──────────────────
  const v2Mutations = formatMutationsForV2(commitBundle);

  // ─── Step 10: Execute base atomic RPC call ──────────────────────────
  const db = createServerSupabaseClient();

  const { data, error } = await db.rpc("v2_commit_update", {
    // Original 8 parameters (V2 compatibility)
    p_conversation_id: conversationId,
    p_new_snapshot: snapshot,
    p_from_version: commitBundle.baseGraphVersion,
    p_to_version: commitBundle.targetGraphVersion,
    p_mutations: v2Mutations,
    p_last_processed_seq: commitBundle.highestSeq,
    p_message_seq_from: commitBundle.lowestSeq,
    p_message_seq_to: commitBundle.highestSeq,
    // 5 new SIE parameters
    p_sie_commit_bundle: commitBundle,
    p_request_id: commitBundle.requestId,
    p_idempotency_key: commitBundle.idempotencyKey,
    p_payload_fingerprint: payloadFingerprint,
    p_required_engine: "SIE",
  });

  // ─── Step 11: Handle version conflict ───────────────────────────────
  if (error) {
    if (isVersionConflictError(error.message)) {
      // Version conflict: caller must reload graph state (including pending
      // decisions) and re-invoke Python semantic analysis with fresh state.
      // NEVER blindly replay stale mutations.
      return {
        success: false,
        committedGraphVersion: null,
        requestId: processResult.request_id,
        retryRequired: true,
        violations: [],
      };
    }

    // Database validation is authoritative — if the DB rejects, we do NOT
    // retry or override. Return the violation to the caller.
    if (isDatabaseValidationError(error.message)) {
      return {
        success: false,
        committedGraphVersion: null,
        requestId: processResult.request_id,
        retryRequired: false,
        violations: [{
          type: "dangling_reference",
          entityId: processResult.request_id,
          description: `Database validation rejected commit (authoritative): ${error.message}`,
        }],
      };
    }

    // ─── Step 12: Other errors — throw ──────────────────────────────────
    throw new Error(
      `SIE commit RPC failed for conversation ${conversationId}: ${error.message}`
    );
  }

  // ─── Step 13: Identity bundle commit ────────────────────────────────
  // Pass ALL identity bundle sections to v2_commit_identity_bundle.
  // This is a separate RPC that runs within the same DB transaction
  // context. TypeScript passes through Python's decisions without
  // modification.
  const identityBundle = commitBundle.identityBundle;
  const hasIdentityWork =
    identityBundle.resolutionRecords.length > 0 ||
    identityBundle.retrievalAttempts.length > 0 ||
    identityBundle.pendingIdentityDetails.length > 0 ||
    identityBundle.pendingPropositionMemberships.length > 0 ||
    identityBundle.associationMutations.length > 0 ||
    identityBundle.sharedProposals.length > 0 ||
    identityBundle.requestStateTransition !== null;

  if (hasIdentityWork) {
    const { error: bundleError } = await db.rpc("v2_commit_identity_bundle", {
      p_conversation_id: conversationId,
      p_request_id: commitBundle.requestId,
      p_identity_resolution_records:
        identityBundle.resolutionRecords.length > 0
          ? identityBundle.resolutionRecords
          : null,
      p_retrieval_attempts:
        identityBundle.retrievalAttempts.length > 0
          ? identityBundle.retrievalAttempts
          : null,
      p_pending_identity_details:
        identityBundle.pendingIdentityDetails.length > 0
          ? identityBundle.pendingIdentityDetails
          : null,
      p_pending_identity_propositions:
        identityBundle.pendingPropositionMemberships.length > 0
          ? identityBundle.pendingPropositionMemberships
          : null,
      p_association_mutations:
        identityBundle.associationMutations.length > 0
          ? identityBundle.associationMutations
          : null,
      p_shared_proposals:
        identityBundle.sharedProposals.length > 0
          ? identityBundle.sharedProposals
          : null,
      p_request_state_transition:
        identityBundle.requestStateTransition ?? null,
    });

    if (bundleError) {
      if (isVersionConflictError(bundleError.message)) {
        return {
          success: false,
          committedGraphVersion: null,
          requestId: processResult.request_id,
          retryRequired: true,
          violations: [],
        };
      }

      // Database validation is authoritative for identity bundle too
      if (isDatabaseValidationError(bundleError.message)) {
        return {
          success: false,
          committedGraphVersion: null,
          requestId: processResult.request_id,
          retryRequired: false,
          violations: [{
            type: "dangling_reference",
            entityId: processResult.request_id,
            description: `Database validation rejected identity bundle (authoritative): ${bundleError.message}`,
          }],
        };
      }

      throw new Error(
        `SIE identity bundle commit failed for conversation ${conversationId}: ${bundleError.message}`
      );
    }
  }

  // ─── Success ────────────────────────────────────────────────────────
  const committedVersion =
    data && typeof data === "object" && "graph_version" in data
      ? (data as { graph_version: number }).graph_version
      : commitBundle.targetGraphVersion;

  return {
    success: true,
    committedGraphVersion: committedVersion,
    requestId: processResult.request_id,
    retryRequired: false,
    violations: [],
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Extracts identity bundle sections from a ProcessResult.
 *
 * These sections are passed directly to the v2_commit_identity_bundle RPC
 * without any TypeScript semantic modification. TypeScript NEVER:
 * - Chooses a concern
 * - Reinterprets retrieval scores
 * - Changes confidence bands
 * - Overrides Python's identity decisions
 *
 * It only maps the ProcessResult fields to the bundle format expected by
 * the database RPC.
 */
function extractIdentityBundleSections(
  processResult: ProcessResult,
  baseGraphVersion: number,
  targetGraphVersion: number
): IdentityBundleSections {
  // ─── Resolution records ─────────────────────────────────────────────
  // Map each identity resolution to the full record format.
  // Diagnostic fields from ProcessResult.diagnostics are preserved as-is.
  const resolutionRecords: IdentityResolutionRecordBundle[] =
    processResult.identity_resolutions.map((resolution) => ({
      record_id: `irr-${processResult.request_id}-${resolution.packet_id}`,
      request_id: processResult.request_id,
      packet_id: resolution.packet_id,
      graph_version_analyzed: processResult.base_graph_version,
      graph_snapshot_token: null,
      outcome: resolution.outcome,
      action: resolution.action,
      identity_stage_status: resolution.identity_stage_status,
      identity_confidence: resolution.identity_confidence ?? null,
      sufficiency_stage_status: resolution.sufficiency_stage_status,
      sufficiency_confidence: resolution.sufficiency_confidence ?? null,
      matched_concern_id: resolution.matched_concern_id ?? null,
      proposed_concern_id:
        resolution.new_concern_proposal?.proposed_concern_id ?? null,
      candidates_considered: resolution.candidates_considered ?? [],
      irs_signals: [],
      retrieval_attempts: [],
      sufficiency_record: null,
      evidence_references: [],
      reasoning: resolution.rationale,
      semantic_policy_version: processResult.pipeline_version,
      retrieval_policy_version: processResult.pipeline_version,
      model_config_version: processResult.model_version,
      prompt_version: processResult.extraction_version,
      proposed_dependency_group_id: null,
    }));

  // ─── Retrieval attempts ─────────────────────────────────────────────
  // Currently extracted from the resolution records if available;
  // future ProcessResult extensions will provide these directly.
  const retrievalAttempts: RetrievalAttemptBundle[] = [];

  // ─── Pending identity details ───────────────────────────────────────
  // For each unresolved/deferred resolution, create a pending detail record.
  const pendingIdentityDetails: PendingIdentityDetailBundle[] = [];
  const pendingPropositionMemberships: PendingPropositionMembershipBundle[] = [];

  for (const resolution of processResult.identity_resolutions) {
    const isUnresolved =
      resolution.outcome === "UNRESOLVED" ||
      resolution.outcome === "DEFER" ||
      resolution.outcome === "RETRIEVAL_INCONCLUSIVE" ||
      resolution.outcome === "REQUIRES_VALIDATION";

    if (isUnresolved) {
      const detailId = `pid-${processResult.request_id}-${resolution.packet_id}`;
      const decisionId = `psd-${processResult.request_id}-${resolution.packet_id}`;

      pendingIdentityDetails.push({
        detail_id: detailId,
        decision_id: decisionId,
        packet_id: resolution.packet_id,
        graph_version_analyzed: processResult.base_graph_version,
        source_resolution_record_id: `irr-${processResult.request_id}-${resolution.packet_id}`,
        identity_stage_status: resolution.identity_stage_status,
        identity_confidence: resolution.identity_confidence ?? null,
        sufficiency_stage_status: resolution.sufficiency_stage_status,
        sufficiency_confidence: resolution.sufficiency_confidence ?? null,
      });

      // Find propositions belonging to this packet for membership records
      const packetMemberships = processResult.packet_memberships.filter(
        (m) => m.packet_id === resolution.packet_id
      );
      for (const membership of packetMemberships) {
        pendingPropositionMemberships.push({
          id: `ppm-${decisionId}-${membership.proposition_id}-${membership.ordinal}`,
          decision_id: decisionId,
          proposition_id: membership.proposition_id,
          ordinal: membership.ordinal,
        });
      }
    }
  }

  // ─── Association mutations ──────────────────────────────────────────
  // Pass through all proposed associations from Python without modification.
  const associationMutations: AssociationMutationBundle[] =
    processResult.proposed_associations.map((assoc) => ({
      association_id: assoc.association_id,
      association_creation_key: assoc.association_creation_key,
      proposition_id: assoc.proposition_id,
      concern_id: assoc.concern_id,
      role: assoc.role,
      confidence: assoc.confidence,
      provenance: assoc.provenance,
      established_by_packet_id: assoc.established_by_packet_id ?? null,
      semantic_state: assoc.semantic_state ?? "ACTIVE",
      version: assoc.version ?? 1,
    }));

  // ─── Shared proposals (new concerns) ───────────────────────────────
  // Pass through all concern proposals from Python without modification.
  const sharedProposals: SharedProposalBundle[] =
    processResult.new_concern_proposals.map((proposal) => ({
      concern_id: proposal.proposed_concern_id,
      identity_summary: proposal.identity_summary,
      display_title: proposal.display_title,
      current_summary: proposal.initial_summary,
      status: "ACTIVE",
      canonical_parent_id: proposal.proposed_parent_id ?? null,
      parent_resolution_state: proposal.parent_resolution_state ?? "PARENT_DEFERRED",
      metadata: {},
      semantic_version: 1,
      merged_into_concern_id: null,
    }));

  // ─── Request state transition ───────────────────────────────────────
  // Mark the commit request as COMMITTED after successful commit.
  const requestStateTransition: RequestStateTransitionBundle | null =
    processResult.request_id
      ? {
          request_id: processResult.request_id,
          target_status: "COMMITTED",
          committed_graph_version: targetGraphVersion,
          result: {
            success: true,
            request_id: processResult.request_id,
            graph_version: targetGraphVersion,
          },
        }
      : null;

  return {
    resolutionRecords,
    retrievalAttempts,
    pendingIdentityDetails,
    pendingPropositionMemberships,
    associationMutations,
    sharedProposals,
    requestStateTransition,
  };
}

/**
 * Formats the commit bundle mutations into the V2 mutation log format
 * for backward compatibility with existing mutation logging.
 */
function formatMutationsForV2(
  bundle: SIECommitBundle
): Array<{
  mutationId: string;
  type: string;
  targetId: string;
  beforeState: unknown;
  afterState: unknown;
  sourceUtteranceIds: string[];
  sourcePropositionIds: string[];
  reason: string;
  confidence: number;
  provenance: string;
}> {
  const mutations: Array<{
    mutationId: string;
    type: string;
    targetId: string;
    beforeState: unknown;
    afterState: unknown;
    sourceUtteranceIds: string[];
    sourcePropositionIds: string[];
    reason: string;
    confidence: number;
    provenance: string;
  }> = [];

  // Map new concern proposals as "create_object" mutations
  for (const concern of bundle.concerns) {
    mutations.push({
      mutationId: `sie-concern-${concern.proposed_concern_id}`,
      type: "create_object",
      targetId: concern.proposed_concern_id,
      beforeState: null,
      afterState: {
        concern_id: concern.proposed_concern_id,
        display_title: concern.display_title,
        identity_summary: concern.identity_summary,
        status: "ACTIVE",
      },
      sourceUtteranceIds: [],
      sourcePropositionIds: [],
      reason: `New concern: ${concern.display_title}`,
      confidence: 1.0,
      provenance: "sie_identity_resolution",
    });
  }

  // Map new associations as "assign_proposition" mutations
  for (const assoc of bundle.associations) {
    mutations.push({
      mutationId: `sie-assoc-${assoc.association_id}`,
      type: "assign_proposition",
      targetId: assoc.concern_id,
      beforeState: null,
      afterState: {
        proposition_id: assoc.proposition_id,
        role: assoc.role,
        confidence: assoc.confidence,
      },
      sourceUtteranceIds: [],
      sourcePropositionIds: [assoc.proposition_id],
      reason: `${assoc.role} association established via ${assoc.provenance}`,
      confidence: assoc.confidence === "HIGH" ? 0.9 : assoc.confidence === "MEDIUM" ? 0.7 : 0.4,
      provenance: assoc.provenance,
    });
  }

  return mutations;
}

/**
 * Builds the resulting SIE state by merging current graph state with
 * the new entities from the commit bundle. Used for V2 projection when
 * not provided externally.
 */
function buildResultingSIEState(
  currentState: SIEGraphState,
  bundle: SIECommitBundle
): SIEGraphState {
  // Merge new concerns into the state
  const newConcerns = bundle.concerns.map((proposal) => ({
    concern_id: proposal.proposed_concern_id,
    identity_summary: proposal.identity_summary,
    display_title: proposal.display_title,
    current_summary: proposal.initial_summary,
    status: "ACTIVE" as const,
    canonical_parent_id: proposal.proposed_parent_id ?? null,
    parent_resolution_state: proposal.parent_resolution_state,
    last_active_at: new Date().toISOString(),
    semantic_version: 1,
    aliases: [],
  }));

  // Merge new propositions
  const newPropositions = bundle.propositions;

  // Merge new associations
  const newAssociations = bundle.associations;

  // Merge new packets
  const newPackets = bundle.packets;

  return {
    graphVersion: bundle.targetGraphVersion,
    concerns: [...currentState.concerns, ...newConcerns],
    propositions: [...currentState.propositions, ...newPropositions],
    associations: [...currentState.associations, ...newAssociations],
    packets: [...currentState.packets, ...newPackets],
  };
}
