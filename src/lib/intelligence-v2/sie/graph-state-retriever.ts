/**
 * Graph State Retriever — loads the full SIE graph state for one conversation.
 *
 * Produces:
 * - `GraphStateContext` (versioned contract consumed by Python ml-service)
 * - `SIEGraphState` (local TypeScript wrapper for orchestration)
 * - Graph version and authoritative-engine state
 *
 * Query strategy:
 * - Includes ACTIVE, DORMANT, and historically relevant RETIRED concerns
 *   (not filtered solely by recency).
 * - Reloads all pending/unresolved/deferred semantic decisions on every request.
 * - Loads associations with `established_by_packet_id`.
 * - Loads ACTIVE + contextually relevant SUPERSEDED propositions.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { components } from "./generated";
import type { SIEGraphState } from "./types";

// ─── Transport types from generated contract ────────────────────────────────

type ConcernSummary = components["schemas"]["ConcernSummary"];
type PropositionSummary = components["schemas"]["PropositionSummary"];
type AssociationSummary = components["schemas"]["AssociationSummary"];
type PendingDecisionSummary = components["schemas"]["PendingDecisionSummary"];
type GraphStateContext = components["schemas"]["GraphStateContext"];
type SemanticPacket = components["schemas"]["SemanticPacket"];
type Proposition = components["schemas"]["Proposition"];
type PropositionAssociation = components["schemas"]["PropositionAssociation"];

// ─── Authoritative engine type ──────────────────────────────────────────────

export type AuthoritativeEngine = "V2" | "SIE_SHADOW" | "SIE";

// ─── Result type ────────────────────────────────────────────────────────────

export interface GraphStateRetrievalResult {
  /** Versioned graph-state context for Python consumption. */
  graphStateContext: GraphStateContext;
  /** Current graph version from v2_update_state. */
  graphVersion: number;
  /** Current authoritative engine state. */
  authoritativeEngine: AuthoritativeEngine;
  /** Full SIE graph state for TypeScript orchestration. */
  sieGraphState: SIEGraphState;
}

// ─── Database row types (match Supabase schema) ─────────────────────────────

interface UpdateStateRow {
  update_version: number;
  authoritative_engine: string;
}

interface ConcernRow {
  concern_id: string;
  identity_summary: string;
  display_title: string;
  current_summary: string;
  status: string;
  last_active_at: string;
  canonical_parent_id: string | null;
  parent_resolution_state: string;
  semantic_version: number;
}

interface AliasRow {
  concern_id: string;
  alias_text: string;
}

interface PropositionRow {
  proposition_id: string;
  conversation_id: string;
  source_message_ids: string[];
  speaker_role: string;
  canonical_meaning: string;
  proposition_type: string;
  message_seq_start: number;
  message_seq_end: number;
  provenance: string;
  semantic_state: string;
  retention_levels: string[];
  created_at: string;
  extraction_version: string;
  supersedes_proposition_id: string | null;
  proposition_creation_key?: string;
}

interface AssociationRow {
  association_id: string;
  proposition_id: string;
  concern_id: string;
  role: string;
  confidence: string;
  provenance: string;
  semantic_state: string;
  established_at: string;
  established_by_packet_id: string | null;
  version: number;
  association_creation_key?: string;
}

interface PacketRow {
  packet_id: string;
  conversation_id: string;
  source_message_ids: string[];
  message_seq_start: number;
  message_seq_end: number;
  user_grounded_meaning: string;
  assistant_context: string | null;
  continuation_origin: string | null;
  provenance: string;
  packet_formation_version: string;
  cohesion_status: string;
  created_at: string;
  packet_creation_key?: string;
}

interface PendingDecisionRow {
  decision_id: string;
  stage: string;
  outcome: string;
  rationale: string | null;
  entity_id: string;
  lifecycle_state: string;
}

// ─── Main retrieval function ────────────────────────────────────────────────

/**
 * Retrieves the full graph state for a conversation.
 *
 * Loads all SIE entities from Supabase and assembles the versioned
 * GraphStateContext for Python and the local SIEGraphState for TypeScript.
 */
export async function retrieveGraphState(
  conversationId: string
): Promise<GraphStateRetrievalResult> {
  const db = createServerSupabaseClient();

  // ── 1. Load graph version and authoritative engine ──────────────────────
  const { data: updateState, error: updateStateError } = await db
    .from("v2_update_state")
    .select("update_version, authoritative_engine")
    .eq("conversation_id", conversationId)
    .single();

  if (updateStateError || !updateState) {
    throw new Error(
      `Failed to load update state for conversation ${conversationId}: ${updateStateError?.message ?? "not found"}`
    );
  }

  const { update_version: graphVersion, authoritative_engine } =
    updateState as UpdateStateRow;
  const authoritativeEngine = authoritative_engine as AuthoritativeEngine;

  // ── 2. Load concerns (ACTIVE, DORMANT, RETIRED — not MERGED redirects) ─
  // Include DORMANT and historically relevant RETIRED concerns.
  // Do not filter by recency — dormant/retired concerns remain eligible for
  // identity resolution and reactivation.
  const { data: concernRows, error: concernsError } = await db
    .from("sie_persistent_concerns")
    .select(
      "concern_id, identity_summary, display_title, current_summary, status, last_active_at, canonical_parent_id, parent_resolution_state, semantic_version"
    )
    .eq("conversation_id", conversationId)
    .in("status", ["ACTIVE", "DORMANT", "RETIRED"]);

  if (concernsError) {
    throw new Error(
      `Failed to load concerns for conversation ${conversationId}: ${concernsError.message}`
    );
  }

  // ── 3. Load active aliases (removed_at IS NULL) ─────────────────────────
  const concernIds = (concernRows ?? []).map(
    (c: ConcernRow) => c.concern_id
  );

  let aliasMap: Map<string, string[]> = new Map();
  if (concernIds.length > 0) {
    const { data: aliasRows, error: aliasesError } = await db
      .from("sie_concern_aliases")
      .select("concern_id, alias_text")
      .in("concern_id", concernIds)
      .is("removed_at", null);

    if (aliasesError) {
      throw new Error(
        `Failed to load aliases for conversation ${conversationId}: ${aliasesError.message}`
      );
    }

    for (const row of (aliasRows ?? []) as AliasRow[]) {
      const existing = aliasMap.get(row.concern_id) ?? [];
      existing.push(row.alias_text);
      aliasMap.set(row.concern_id, existing);
    }
  }

  // ── 4. Load propositions (ACTIVE + contextually relevant SUPERSEDED) ────
  const { data: propositionRows, error: propositionsError } = await db
    .from("sie_propositions")
    .select(
      "proposition_id, conversation_id, source_message_ids, speaker_role, canonical_meaning, proposition_type, message_seq_start, message_seq_end, provenance, semantic_state, retention_levels, created_at, extraction_version, supersedes_proposition_id, proposition_creation_key"
    )
    .eq("conversation_id", conversationId)
    .in("semantic_state", ["ACTIVE", "SUPERSEDED"]);

  if (propositionsError) {
    throw new Error(
      `Failed to load propositions for conversation ${conversationId}: ${propositionsError.message}`
    );
  }

  // ── 5. Load associations (including established_by_packet_id) ───────────
  const { data: associationRows, error: associationsError } = await db
    .from("sie_proposition_associations")
    .select(
      "association_id, proposition_id, concern_id, role, confidence, provenance, semantic_state, established_at, established_by_packet_id, version, association_creation_key"
    )
    .in(
      "proposition_id",
      (propositionRows ?? []).map((p: PropositionRow) => p.proposition_id)
    );

  // If no propositions, associations query may return empty — that's valid
  if (associationsError) {
    throw new Error(
      `Failed to load associations for conversation ${conversationId}: ${associationsError.message}`
    );
  }

  // ── 6. Load semantic packets ────────────────────────────────────────────
  const { data: packetRows, error: packetsError } = await db
    .from("sie_semantic_packets")
    .select(
      "packet_id, conversation_id, source_message_ids, message_seq_start, message_seq_end, user_grounded_meaning, assistant_context, continuation_origin, provenance, packet_formation_version, cohesion_status, created_at, packet_creation_key"
    )
    .eq("conversation_id", conversationId);

  if (packetsError) {
    throw new Error(
      `Failed to load packets for conversation ${conversationId}: ${packetsError.message}`
    );
  }

  // ── 7. Load ALL pending/unresolved/deferred semantic decisions ──────────
  // Reload on every request per spec requirement.
  const { data: pendingDecisionRows, error: pendingDecisionsError } = await db
    .from("sie_pending_semantic_decisions")
    .select("decision_id, stage, outcome, rationale, entity_id, lifecycle_state")
    .eq("conversation_id", conversationId)
    .neq("lifecycle_state", "resolved");

  if (pendingDecisionsError) {
    throw new Error(
      `Failed to load pending decisions for conversation ${conversationId}: ${pendingDecisionsError.message}`
    );
  }

  // ── Transform DB rows into contract types ───────────────────────────────

  const concerns: ConcernSummary[] = (concernRows ?? []).map(
    (row: ConcernRow) => ({
      concern_id: row.concern_id,
      identity_summary: row.identity_summary,
      display_title: row.display_title,
      current_summary: row.current_summary,
      status: row.status as ConcernSummary["status"],
      aliases: aliasMap.get(row.concern_id) ?? [],
      canonical_parent_id: row.canonical_parent_id,
      parent_resolution_state:
        row.parent_resolution_state as ConcernSummary["parent_resolution_state"],
      last_active_at: row.last_active_at,
      semantic_version: row.semantic_version,
    })
  );

  const propositionSummaries: PropositionSummary[] = (
    propositionRows ?? []
  ).map((row: PropositionRow) => ({
    proposition_id: row.proposition_id,
    canonical_meaning: row.canonical_meaning,
    proposition_type: row.proposition_type as PropositionSummary["proposition_type"],
    speaker_role: row.speaker_role,
    semantic_state: row.semantic_state as PropositionSummary["semantic_state"],
    message_seq_range: [row.message_seq_start, row.message_seq_end] as [
      number,
      number,
    ],
  }));

  const associationSummaries: AssociationSummary[] = (
    associationRows ?? []
  ).map((row: AssociationRow) => ({
    association_id: row.association_id,
    proposition_id: row.proposition_id,
    concern_id: row.concern_id,
    role: row.role as AssociationSummary["role"],
    semantic_state: row.semantic_state as AssociationSummary["semantic_state"],
  }));

  const pendingDecisions: PendingDecisionSummary[] = (
    pendingDecisionRows ?? []
  ).map((row: PendingDecisionRow) => ({
    entity_id: row.entity_id,
    stage: row.stage,
    outcome: row.outcome as PendingDecisionSummary["outcome"],
    rationale: row.rationale,
  }));

  // ── Build GraphStateContext (versioned contract for Python) ──────────────

  const graphStateContext: GraphStateContext = {
    graph_version: graphVersion,
    snapshot_token: `snapshot-${graphVersion}`,
    snapshot_digest: "",
    concerns,
    propositions: propositionSummaries,
    active_associations: associationSummaries,
    pending_decisions: pendingDecisions,
  };

  // ── Build full Proposition transport types for SIEGraphState ─────────────

  const fullPropositions: Proposition[] = (propositionRows ?? []).map(
    (row: PropositionRow) => ({
      proposition_id: row.proposition_id,
      proposition_creation_key: row.proposition_creation_key ?? "",
      conversation_id: row.conversation_id,
      source_message_ids: row.source_message_ids,
      speaker_role: row.speaker_role,
      canonical_meaning: row.canonical_meaning,
      proposition_type: row.proposition_type as Proposition["proposition_type"],
      message_seq_range: [row.message_seq_start, row.message_seq_end] as [
        number,
        number,
      ],
      provenance: row.provenance as Proposition["provenance"],
      semantic_state: row.semantic_state as Proposition["semantic_state"],
      retention_levels: row.retention_levels as Proposition["retention_levels"],
      created_at: row.created_at,
      extraction_version: row.extraction_version,
      supersedes_proposition_id: row.supersedes_proposition_id,
    })
  );

  const fullAssociations: PropositionAssociation[] = (
    associationRows ?? []
  ).map((row: AssociationRow) => ({
    association_id: row.association_id,
    association_creation_key: row.association_creation_key ?? "",
    proposition_id: row.proposition_id,
    concern_id: row.concern_id,
    role: row.role as PropositionAssociation["role"],
    confidence: row.confidence as PropositionAssociation["confidence"],
    provenance: row.provenance,
    semantic_state:
      row.semantic_state as PropositionAssociation["semantic_state"],
    created_at: row.established_at,
    established_by_packet_id: row.established_by_packet_id,
    version: row.version,
  }));

  const fullPackets: SemanticPacket[] = (packetRows ?? []).map(
    (row: PacketRow) => ({
      packet_id: row.packet_id,
      packet_creation_key: row.packet_creation_key ?? "",
      conversation_id: row.conversation_id,
      source_message_ids: row.source_message_ids,
      message_seq_range: [row.message_seq_start, row.message_seq_end] as [
        number,
        number,
      ],
      user_grounded_meaning: row.user_grounded_meaning,
      assistant_context: row.assistant_context,
      continuation_origin: row.continuation_origin,
      provenance: row.provenance,
      packet_formation_version: row.packet_formation_version,
      cohesion_status: row.cohesion_status as SemanticPacket["cohesion_status"],
    })
  );

  // ── Build SIEGraphState (TypeScript-local wrapper) ──────────────────────

  const sieGraphState: SIEGraphState = {
    graphVersion,
    concerns,
    propositions: fullPropositions,
    associations: fullAssociations,
    packets: fullPackets,
  };

  return {
    graphStateContext,
    graphVersion,
    authoritativeEngine,
    sieGraphState,
  };
}
