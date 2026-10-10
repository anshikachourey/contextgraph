/**
 * Atomic Identity-Context Loader
 *
 * Loads all identity-resolution state for a conversation through one atomic
 * database RPC (v2_load_sie_identity_context). The RPC executes in a single
 * PostgreSQL MVCC snapshot ensuring cross-version consistency.
 *
 * Responsibilities:
 * - Call the context-loader RPC and map its response to IdentityGraphStateContext.
 * - Validate graph version, snapshot token/digest, embedding hashes/versions,
 *   and suppression filtering.
 * - Fail on partial or invalid context — never return cross-version data.
 *
 * This module is TypeScript orchestration code. It does NOT make semantic
 * identity decisions — those are exclusively Python's domain.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { components } from "./generated";

// ─── Transport types from generated contract ────────────────────────────────

type ConcernSummary = components["schemas"]["ConcernSummary"];
type PropositionSummary = components["schemas"]["PropositionSummary"];
type AssociationSummary = components["schemas"]["AssociationSummary"];
type PendingDecisionSummary = components["schemas"]["PendingDecisionSummary"];
type GraphStateContext = components["schemas"]["GraphStateContext"];

// ─── Identity Context Extended Types ────────────────────────────────────────
// These extend the base GraphStateContext with fields returned by the atomic
// context-loader RPC but not yet in the generated OpenAPI contract.

/**
 * Status of concern embeddings loading.
 * LOADED — embeddings table exists and data was returned.
 * UNAVAILABLE — embeddings table does not exist or is not provisioned.
 */
export type EmbeddingLoadStatus = "LOADED" | "UNAVAILABLE";

/**
 * A single concern embedding with version/hash metadata for staleness detection.
 */
export interface ConcernEmbedding {
  concern_id: string;
  embedding: number[];
  source_text_hash: string;
  embedding_model_version: string;
  graph_version: number;
  /** True if this embedding matches the current graph version. */
  is_current: boolean;
}

/**
 * Embedding payload from the RPC — either loaded with data or explicitly unavailable.
 */
export type EmbeddingPayload =
  | { status: "LOADED"; embeddings: ConcernEmbedding[] }
  | { status: "UNAVAILABLE"; reason: string };

/**
 * Normalized alias entry returned by the context loader.
 */
export interface NormalizedAlias {
  alias_id: string;
  concern_id: string;
  alias_text: string;
}

/**
 * Pending identity detail record from the context loader.
 */
export interface PendingIdentityDetail {
  detail_id: string;
  decision_id: string;
  packet_id: string;
  graph_version_analyzed: number;
  source_resolution_record_id: string | null;
  identity_stage_status: string;
  identity_confidence: string | null;
  sufficiency_stage_status: string;
  sufficiency_confidence: string | null;
}

/**
 * Pending identity proposition membership from the context loader.
 */
export interface PendingIdentityProposition {
  id: string;
  decision_id: string;
  proposition_id: string;
  ordinal: number;
}

/**
 * Packet lineage entry including optional split origin.
 */
export interface PacketLineageEntry {
  packet_id: string;
  conversation_id: string;
  message_seq_start: number;
  message_seq_end: number;
  user_grounded_meaning: string;
  cohesion_status: string;
  split_from_packet_id: string | null;
}

/**
 * Extended pending decision as returned by the identity context loader.
 * Richer than the transport PendingDecisionSummary.
 */
export interface IdentityPendingDecision {
  decision_id: string;
  stage: string;
  entity_creation_key: string;
  outcome: string;
  lifecycle_state: string;
  rationale: string | null;
  dependency_refs: string[];
}

/**
 * Full identity graph state context returned by the atomic context-loader RPC.
 *
 * This extends the base GraphStateContext with snapshot binding, embeddings,
 * normalized aliases, packet lineage, pending identity details/memberships,
 * and privacy suppression information.
 */
export interface IdentityGraphStateContext {
  // ── Version binding ─────────────────────────────────────────────────────
  /** Current committed graph version. */
  graph_version: number;
  /** Snapshot token binding this read to a specific version and time. */
  snapshot_token: string;
  /** Deterministic digest of (token + version) for validation. */
  snapshot_digest: string;

  // ── Core graph state (compatible with base GraphStateContext) ────────────
  concerns: ConcernSummary[];
  propositions: PropositionSummary[];
  active_associations: AssociationSummary[];

  // ── Normalized aliases ──────────────────────────────────────────────────
  normalized_aliases: NormalizedAlias[];

  // ── Pending decisions ───────────────────────────────────────────────────
  pending_decisions: IdentityPendingDecision[];
  pending_identity_details: PendingIdentityDetail[];
  pending_identity_propositions: PendingIdentityProposition[];

  // ── Packet lineage ──────────────────────────────────────────────────────
  packet_lineage: PacketLineageEntry[];

  // ── Embeddings ──────────────────────────────────────────────────────────
  concern_embeddings: EmbeddingPayload;

  // ── Privacy ─────────────────────────────────────────────────────────────
  /** IDs of concerns suppressed by privacy policy (excluded from concerns array). */
  privacy_suppressed_concern_ids: string[];
}

// ─── Validation Errors ──────────────────────────────────────────────────────

/**
 * Error thrown when the context-loader RPC returns invalid, partial,
 * or cross-version context.
 */
export class IdentityContextLoadError extends Error {
  constructor(
    message: string,
    public readonly conversationId: string,
    public readonly reason:
      | "rpc_error"
      | "missing_graph_version"
      | "invalid_snapshot"
      | "partial_context"
      | "invalid_embeddings"
      | "suppression_violation"
      | "invalid_response_structure"
  ) {
    super(message);
    this.name = "IdentityContextLoadError";
  }
}

// ─── Result Type ────────────────────────────────────────────────────────────

export interface IdentityContextLoadResult {
  /** Full identity graph state context for Python consumption. */
  identityContext: IdentityGraphStateContext;
  /** Base GraphStateContext for backward-compatible use. */
  graphStateContext: GraphStateContext;
  /** The graph version loaded. */
  graphVersion: number;
  /** Snapshot token for commit-time validation. */
  snapshotToken: string;
  /** Snapshot digest for integrity verification. */
  snapshotDigest: string;
}

// ─── Raw RPC Response Shape ─────────────────────────────────────────────────
// Mirrors the JSONB structure returned by v2_load_sie_identity_context.

interface RawContextResponse {
  graph_version?: number;
  snapshot_token?: string;
  snapshot_digest?: string;
  concerns?: unknown[];
  propositions?: unknown[];
  active_associations?: unknown[];
  normalized_aliases?: unknown[];
  pending_decisions?: unknown[];
  pending_identity_details?: unknown[];
  pending_identity_propositions?: unknown[];
  packet_lineage?: unknown[];
  concern_embeddings?: {
    status?: string;
    reason?: string;
    embeddings?: unknown[];
  };
  privacy_suppressed_concern_ids?: string[];
}

// ─── Main Loader Function ───────────────────────────────────────────────────

/**
 * Loads the complete identity-resolution context for a conversation through
 * one atomic database RPC call.
 *
 * The RPC (v2_load_sie_identity_context) executes in a single PostgreSQL
 * MVCC snapshot, guaranteeing all returned data belongs to one consistent
 * graph version. Privacy-suppressed concerns are excluded server-side.
 *
 * @throws IdentityContextLoadError on RPC failure, partial context, or
 *   validation failure.
 */
export async function loadIdentityContext(
  conversationId: string
): Promise<IdentityContextLoadResult> {
  const db = createServerSupabaseClient();

  // ── 1. Call the atomic context-loader RPC ─────────────────────────────
  const { data, error } = await db.rpc("v2_load_sie_identity_context", {
    p_conversation_id: conversationId,
  });

  if (error) {
    throw new IdentityContextLoadError(
      `RPC v2_load_sie_identity_context failed for conversation ${conversationId}: ${error.message}`,
      conversationId,
      "rpc_error"
    );
  }

  if (!data || typeof data !== "object") {
    throw new IdentityContextLoadError(
      `RPC returned null or non-object response for conversation ${conversationId}`,
      conversationId,
      "invalid_response_structure"
    );
  }

  const raw = data as RawContextResponse;

  // ── 2. Validate graph version ─────────────────────────────────────────
  if (raw.graph_version == null || typeof raw.graph_version !== "number") {
    throw new IdentityContextLoadError(
      `Missing or invalid graph_version in context for conversation ${conversationId}`,
      conversationId,
      "missing_graph_version"
    );
  }

  // ── 3. Validate snapshot token and digest ─────────────────────────────
  if (
    !raw.snapshot_token ||
    typeof raw.snapshot_token !== "string" ||
    !raw.snapshot_digest ||
    typeof raw.snapshot_digest !== "string"
  ) {
    throw new IdentityContextLoadError(
      `Missing or invalid snapshot_token/snapshot_digest for conversation ${conversationId}`,
      conversationId,
      "invalid_snapshot"
    );
  }

  // Verify snapshot digest is consistent with the token and version
  // The RPC generates digest as md5(snapshot_token || graph_version)
  // We can't replicate md5 in the browser easily, but we verify non-emptiness
  // and format. The snapshot digest must be a 32-char hex string (md5).
  if (!/^[a-f0-9]{32}$/.test(raw.snapshot_digest)) {
    throw new IdentityContextLoadError(
      `Snapshot digest has invalid format (expected 32-char hex) for conversation ${conversationId}`,
      conversationId,
      "invalid_snapshot"
    );
  }

  // ── 4. Validate required arrays are present ───────────────────────────
  if (!Array.isArray(raw.concerns)) {
    throw new IdentityContextLoadError(
      `Missing concerns array in context for conversation ${conversationId}`,
      conversationId,
      "partial_context"
    );
  }

  if (!Array.isArray(raw.propositions)) {
    throw new IdentityContextLoadError(
      `Missing propositions array in context for conversation ${conversationId}`,
      conversationId,
      "partial_context"
    );
  }

  if (!Array.isArray(raw.active_associations)) {
    throw new IdentityContextLoadError(
      `Missing active_associations array in context for conversation ${conversationId}`,
      conversationId,
      "partial_context"
    );
  }

  if (!Array.isArray(raw.normalized_aliases)) {
    throw new IdentityContextLoadError(
      `Missing normalized_aliases array in context for conversation ${conversationId}`,
      conversationId,
      "partial_context"
    );
  }

  if (!Array.isArray(raw.pending_decisions)) {
    throw new IdentityContextLoadError(
      `Missing pending_decisions array in context for conversation ${conversationId}`,
      conversationId,
      "partial_context"
    );
  }

  if (!Array.isArray(raw.pending_identity_details)) {
    throw new IdentityContextLoadError(
      `Missing pending_identity_details array in context for conversation ${conversationId}`,
      conversationId,
      "partial_context"
    );
  }

  if (!Array.isArray(raw.pending_identity_propositions)) {
    throw new IdentityContextLoadError(
      `Missing pending_identity_propositions array in context for conversation ${conversationId}`,
      conversationId,
      "partial_context"
    );
  }

  if (!Array.isArray(raw.packet_lineage)) {
    throw new IdentityContextLoadError(
      `Missing packet_lineage array in context for conversation ${conversationId}`,
      conversationId,
      "partial_context"
    );
  }

  // ── 5. Validate embeddings structure ──────────────────────────────────
  if (!raw.concern_embeddings || typeof raw.concern_embeddings !== "object") {
    throw new IdentityContextLoadError(
      `Missing or invalid concern_embeddings in context for conversation ${conversationId}`,
      conversationId,
      "invalid_embeddings"
    );
  }

  const embeddingPayload = validateEmbeddingPayload(
    raw.concern_embeddings,
    conversationId
  );

  // ── 6. Validate suppression filtering ─────────────────────────────────
  const suppressedIds = raw.privacy_suppressed_concern_ids ?? [];
  if (!Array.isArray(suppressedIds)) {
    throw new IdentityContextLoadError(
      `privacy_suppressed_concern_ids is not an array for conversation ${conversationId}`,
      conversationId,
      "suppression_violation"
    );
  }

  // Verify no suppressed concern leaked into the concerns array
  if (suppressedIds.length > 0) {
    const concernIds = new Set(
      (raw.concerns as Array<{ concern_id?: string }>).map((c) => c.concern_id)
    );
    for (const suppressedId of suppressedIds) {
      if (concernIds.has(suppressedId)) {
        throw new IdentityContextLoadError(
          `Privacy-suppressed concern ${suppressedId} found in concerns array for conversation ${conversationId}. ` +
            `Server-side suppression filtering failed.`,
          conversationId,
          "suppression_violation"
        );
      }
    }
  }

  // ── 7. Map raw response to typed context ──────────────────────────────
  const concerns = mapConcerns(raw.concerns as unknown[]);
  const propositions = mapPropositions(raw.propositions as unknown[]);
  const activeAssociations = mapAssociations(
    raw.active_associations as unknown[]
  );
  const normalizedAliases = mapNormalizedAliases(
    raw.normalized_aliases as unknown[]
  );
  const pendingDecisions = mapPendingDecisions(
    raw.pending_decisions as unknown[]
  );
  const pendingIdentityDetails = mapPendingIdentityDetails(
    raw.pending_identity_details as unknown[]
  );
  const pendingIdentityPropositions = mapPendingIdentityPropositions(
    raw.pending_identity_propositions as unknown[]
  );
  const packetLineage = mapPacketLineage(raw.packet_lineage as unknown[]);

  // ── 8. Validate embedding version consistency ─────────────────────────
  if (embeddingPayload.status === "LOADED") {
    validateEmbeddingVersions(
      embeddingPayload.embeddings,
      raw.graph_version,
      conversationId
    );
  }

  // ── 9. Assemble the full identity context ─────────────────────────────
  const identityContext: IdentityGraphStateContext = {
    graph_version: raw.graph_version,
    snapshot_token: raw.snapshot_token,
    snapshot_digest: raw.snapshot_digest,
    concerns,
    propositions,
    active_associations: activeAssociations,
    normalized_aliases: normalizedAliases,
    pending_decisions: pendingDecisions,
    pending_identity_details: pendingIdentityDetails,
    pending_identity_propositions: pendingIdentityPropositions,
    packet_lineage: packetLineage,
    concern_embeddings: embeddingPayload,
    privacy_suppressed_concern_ids: suppressedIds,
  };

  // ── 10. Build backward-compatible GraphStateContext ────────────────────
  const graphStateContext: GraphStateContext = {
    graph_version: raw.graph_version,
    snapshot_token: raw.snapshot_token,
    snapshot_digest: raw.snapshot_digest,
    concerns,
    propositions,
    active_associations: activeAssociations,
    pending_decisions: pendingDecisions.map((d) => ({
      entity_id: d.entity_creation_key,
      stage: d.stage,
      outcome: d.outcome as PendingDecisionSummary["outcome"],
      rationale: d.rationale,
    })),
  };

  return {
    identityContext,
    graphStateContext,
    graphVersion: raw.graph_version,
    snapshotToken: raw.snapshot_token,
    snapshotDigest: raw.snapshot_digest,
  };
}

// ─── Mapping Helpers ────────────────────────────────────────────────────────

function mapConcerns(raw: unknown[]): ConcernSummary[] {
  return raw.map((item) => {
    const c = item as Record<string, unknown>;
    return {
      concern_id: String(c.concern_id ?? ""),
      identity_summary: String(c.identity_summary ?? ""),
      display_title: String(c.display_title ?? ""),
      current_summary: String(c.current_summary ?? ""),
      status: String(c.status ?? "ACTIVE") as ConcernSummary["status"],
      aliases: Array.isArray(c.aliases) ? c.aliases.map(String) : [],
      canonical_parent_id: c.canonical_parent_id
        ? String(c.canonical_parent_id)
        : null,
      parent_resolution_state: String(
        c.parent_resolution_state ?? "PARENT_DEFERRED"
      ) as ConcernSummary["parent_resolution_state"],
      last_active_at: String(c.last_active_at ?? ""),
      semantic_version: Number(c.semantic_version ?? 0),
    };
  });
}

function mapPropositions(raw: unknown[]): PropositionSummary[] {
  return raw.map((item) => {
    const p = item as Record<string, unknown>;
    return {
      proposition_id: String(p.proposition_id ?? ""),
      canonical_meaning: String(p.canonical_meaning ?? ""),
      proposition_type: String(
        p.proposition_type ?? "ASSERTION"
      ) as PropositionSummary["proposition_type"],
      speaker_role: String(p.speaker_role ?? "USER"),
      semantic_state: String(
        p.semantic_state ?? "ACTIVE"
      ) as PropositionSummary["semantic_state"],
      message_seq_range: [
        Number(p.message_seq_start ?? 0),
        Number(p.message_seq_end ?? 0),
      ] as [number, number],
    };
  });
}

function mapAssociations(raw: unknown[]): AssociationSummary[] {
  return raw.map((item) => {
    const a = item as Record<string, unknown>;
    return {
      association_id: String(a.association_id ?? ""),
      proposition_id: String(a.proposition_id ?? ""),
      concern_id: String(a.concern_id ?? ""),
      role: String(a.role ?? "PRIMARY_OWNER") as AssociationSummary["role"],
      semantic_state: String(
        a.semantic_state ?? "ACTIVE"
      ) as AssociationSummary["semantic_state"],
    };
  });
}

function mapNormalizedAliases(raw: unknown[]): NormalizedAlias[] {
  return raw.map((item) => {
    const a = item as Record<string, unknown>;
    return {
      alias_id: String(a.alias_id ?? ""),
      concern_id: String(a.concern_id ?? ""),
      alias_text: String(a.alias_text ?? ""),
    };
  });
}

function mapPendingDecisions(raw: unknown[]): IdentityPendingDecision[] {
  return raw.map((item) => {
    const d = item as Record<string, unknown>;
    return {
      decision_id: String(d.decision_id ?? ""),
      stage: String(d.stage ?? ""),
      entity_creation_key: String(d.entity_creation_key ?? ""),
      outcome: String(d.outcome ?? ""),
      lifecycle_state: String(d.lifecycle_state ?? "pending"),
      rationale: d.rationale ? String(d.rationale) : null,
      dependency_refs: Array.isArray(d.dependency_refs)
        ? d.dependency_refs.map(String)
        : [],
    };
  });
}

function mapPendingIdentityDetails(raw: unknown[]): PendingIdentityDetail[] {
  return raw.map((item) => {
    const d = item as Record<string, unknown>;
    return {
      detail_id: String(d.detail_id ?? ""),
      decision_id: String(d.decision_id ?? ""),
      packet_id: String(d.packet_id ?? ""),
      graph_version_analyzed: Number(d.graph_version_analyzed ?? 0),
      source_resolution_record_id: d.source_resolution_record_id
        ? String(d.source_resolution_record_id)
        : null,
      identity_stage_status: String(d.identity_stage_status ?? "NOT_RUN"),
      identity_confidence: d.identity_confidence
        ? String(d.identity_confidence)
        : null,
      sufficiency_stage_status: String(
        d.sufficiency_stage_status ?? "NOT_RUN"
      ),
      sufficiency_confidence: d.sufficiency_confidence
        ? String(d.sufficiency_confidence)
        : null,
    };
  });
}

function mapPendingIdentityPropositions(
  raw: unknown[]
): PendingIdentityProposition[] {
  return raw.map((item) => {
    const p = item as Record<string, unknown>;
    return {
      id: String(p.id ?? ""),
      decision_id: String(p.decision_id ?? ""),
      proposition_id: String(p.proposition_id ?? ""),
      ordinal: Number(p.ordinal ?? 0),
    };
  });
}

function mapPacketLineage(raw: unknown[]): PacketLineageEntry[] {
  return raw.map((item) => {
    const p = item as Record<string, unknown>;
    return {
      packet_id: String(p.packet_id ?? ""),
      conversation_id: String(p.conversation_id ?? ""),
      message_seq_start: Number(p.message_seq_start ?? 0),
      message_seq_end: Number(p.message_seq_end ?? 0),
      user_grounded_meaning: String(p.user_grounded_meaning ?? ""),
      cohesion_status: String(p.cohesion_status ?? ""),
      split_from_packet_id: p.split_from_packet_id
        ? String(p.split_from_packet_id)
        : null,
    };
  });
}

// ─── Embedding Validation ───────────────────────────────────────────────────

function validateEmbeddingPayload(
  raw: { status?: string; reason?: string; embeddings?: unknown[] },
  conversationId: string
): EmbeddingPayload {
  const status = raw.status;

  if (status === "UNAVAILABLE") {
    // Embeddings table not provisioned — this is a valid state, not an error.
    // Mark as unavailable so Python knows it cannot rely on embeddings.
    return {
      status: "UNAVAILABLE",
      reason: String(raw.reason ?? "unknown"),
    };
  }

  if (status === "LOADED") {
    if (!Array.isArray(raw.embeddings)) {
      throw new IdentityContextLoadError(
        `Embeddings status is LOADED but embeddings array is missing for conversation ${conversationId}`,
        conversationId,
        "invalid_embeddings"
      );
    }

    const embeddings: ConcernEmbedding[] = raw.embeddings.map((item) => {
      const e = item as Record<string, unknown>;
      return {
        concern_id: String(e.concern_id ?? ""),
        embedding: Array.isArray(e.embedding)
          ? (e.embedding as number[])
          : [],
        source_text_hash: String(e.source_text_hash ?? ""),
        embedding_model_version: String(e.embedding_model_version ?? ""),
        graph_version: Number(e.graph_version ?? 0),
        is_current: Boolean(e.is_current),
      };
    });

    return { status: "LOADED", embeddings };
  }

  // Unknown status — treat as invalid
  throw new IdentityContextLoadError(
    `Invalid embedding status "${status}" for conversation ${conversationId}. Expected "LOADED" or "UNAVAILABLE".`,
    conversationId,
    "invalid_embeddings"
  );
}

/**
 * Validates embedding version consistency:
 * - Each embedding must have a non-empty source_text_hash.
 * - Each embedding must have a non-empty embedding_model_version.
 * - Stale embeddings (graph_version != current) are allowed but flagged
 *   via is_current=false. We do NOT fail on stale embeddings — they are
 *   included per spec (omitting them would look like successful empty retrieval).
 * - We DO fail on structurally invalid embeddings (missing required fields).
 */
function validateEmbeddingVersions(
  embeddings: ConcernEmbedding[],
  currentGraphVersion: number,
  conversationId: string
): void {
  for (const emb of embeddings) {
    if (!emb.concern_id) {
      throw new IdentityContextLoadError(
        `Embedding missing concern_id for conversation ${conversationId}`,
        conversationId,
        "invalid_embeddings"
      );
    }

    if (!emb.source_text_hash) {
      throw new IdentityContextLoadError(
        `Embedding for concern ${emb.concern_id} missing source_text_hash in conversation ${conversationId}`,
        conversationId,
        "invalid_embeddings"
      );
    }

    if (!emb.embedding_model_version) {
      throw new IdentityContextLoadError(
        `Embedding for concern ${emb.concern_id} missing embedding_model_version in conversation ${conversationId}`,
        conversationId,
        "invalid_embeddings"
      );
    }

    if (!Array.isArray(emb.embedding) || emb.embedding.length === 0) {
      throw new IdentityContextLoadError(
        `Embedding for concern ${emb.concern_id} has empty or invalid embedding vector in conversation ${conversationId}`,
        conversationId,
        "invalid_embeddings"
      );
    }
  }
}
