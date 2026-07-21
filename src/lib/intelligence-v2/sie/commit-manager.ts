/**
 * SIE Commit Manager — Builds validated commit bundles and executes atomic
 * database commits through a single authoritative RPC call.
 *
 * Design rules:
 * - Build and validate one semantic commit bundle BEFORE any database mutation.
 * - Include pending-decision creations and resolutions in the bundle.
 * - Make exactly ONE authoritative RPC call (v2_commit_update).
 * - NEVER write to SIE tables directly (no client-side writeSIETables).
 * - On version conflict: reload graph state + pending decisions and require
 *   fresh Python semantic analysis. Never blindly replay stale mutations.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { validateInvariants } from "./invariant-validator";
import { projectToV2Snapshot, type V2SnapshotProjection } from "./v2-projection";
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

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Builds a complete commit bundle from a ProcessResult and current graph state.
 *
 * The bundle contains all entity registrations, SIE mutations, pending-decision
 * lifecycle updates, audit entries, and metadata required for the atomic commit.
 * No database mutation occurs during bundle construction.
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
 * Main commit function — validates invariants, builds the commit bundle,
 * computes the V2 projection, and executes exactly one atomic RPC call.
 *
 * Flow:
 * 1. Validate structural invariants
 * 2. If violations: return failure with violations (no RPC call)
 * 3. Build commit bundle (entities, associations, splits, audit, pending decisions)
 * 4. Compute V2 snapshot projection
 * 5. Compute payload fingerprint for idempotency
 * 6. Call v2_commit_update RPC with all parameters (8 original + 5 SIE)
 * 7. On success: return CommitResult with new graph version
 * 8. On version conflict: return CommitResult with retryRequired=true
 * 9. On other errors: throw
 *
 * NEVER writes to SIE tables directly. All mutations go through the
 * single atomic RPC.
 */
export async function commitSIEResult(
  conversationId: string,
  processResult: ProcessResult,
  sieGraphState: SIEGraphState,
  v2Projection?: V2SnapshotProjection
): Promise<CommitResult> {
  // ─── Step 1: Validate structural invariants ─────────────────────────
  const validation = validateInvariants(
    processResult,
    sieGraphState,
    sieGraphState.graphVersion
  );

  // ─── Step 2: Reject if invariant violations exist ───────────────────
  if (!validation.valid) {
    return {
      success: false,
      committedGraphVersion: null,
      requestId: processResult.request_id,
      retryRequired: false,
      violations: validation.violations,
    };
  }

  // ─── Step 3: Build commit bundle ────────────────────────────────────
  const commitBundle = buildCommitBundle(processResult, sieGraphState);

  // ─── Step 4: Compute V2 snapshot projection ─────────────────────────
  // If not provided externally, compute from the resulting SIE state.
  // The resulting state is the current state + new entities from the bundle.
  const snapshot = v2Projection ?? projectToV2Snapshot(buildResultingSIEState(sieGraphState, commitBundle));

  // ─── Step 5: Payload fingerprint (already computed in bundle) ────────
  const payloadFingerprint = commitBundle.payloadFingerprint;

  // ─── Step 6: Format mutations for V2 compatibility ──────────────────
  const v2Mutations = formatMutationsForV2(commitBundle);

  // ─── Step 7: Execute single atomic RPC call ─────────────────────────
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

  // ─── Step 8: Handle version conflict ────────────────────────────────
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

    // ─── Step 9: Other errors — throw ───────────────────────────────────
    throw new Error(
      `SIE commit RPC failed for conversation ${conversationId}: ${error.message}`
    );
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
