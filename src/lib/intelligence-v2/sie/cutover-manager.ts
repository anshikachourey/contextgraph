/**
 * SIE Cutover Manager — Guarded cutover and rollback operations with
 * graph-version optimistic locking and audit trail.
 *
 * Design rules:
 * - Cutover transitions a conversation from SIE_SHADOW → SIE authority.
 * - Rollback transitions from SIE authority → SIE_SHADOW.
 * - Both operations are guarded by graph-version optimistic locks:
 *   they FAIL if the current graph version doesn't match the expected version.
 * - Both operations write to sie_audit_history recording the authority change.
 * - SIE authority must NEVER be activated for production conversations
 *   in this implementation plan. All flags are disabled by default.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { SIE_AUTHORITY_ENABLED } from "./feature-flags";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Authority states for a conversation's semantic engine. */
export type AuthorityState = "V2" | "SIE_SHADOW" | "SIE";

/** Result of a cutover operation (SIE_SHADOW → SIE). */
export interface CutoverResult {
  success: boolean;
  newAuthority: AuthorityState;
  graphVersion: number;
  error?: string;
}

/** Result of a rollback operation (SIE → SIE_SHADOW). */
export interface RollbackResult {
  success: boolean;
  newAuthority: AuthorityState;
  graphVersion: number;
  error?: string;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

interface UpdateStateRow {
  authoritative_engine: string;
  update_version: number;
}

/**
 * Loads the current authority state and graph version for a conversation.
 */
async function loadAuthorityState(
  conversationId: string
): Promise<{ engine: AuthorityState; graphVersion: number } | null> {
  const db = createServerSupabaseClient();
  const { data, error } = await db
    .from("v2_update_state")
    .select("authoritative_engine, update_version")
    .eq("conversation_id", conversationId)
    .single();

  if (error || !data) return null;

  const row = data as UpdateStateRow;
  return {
    engine: row.authoritative_engine as AuthorityState,
    graphVersion: row.update_version,
  };
}

/**
 * Writes an audit record for an authority state transition.
 */
async function writeAuthorityAudit(params: {
  conversationId: string;
  previousAuthority: AuthorityState;
  newAuthority: AuthorityState;
  graphVersion: number;
  operation: "cutover" | "rollback";
}): Promise<void> {
  const db = createServerSupabaseClient();
  await db.from("sie_audit_history").insert({
    entity_type: "authority_state",
    entity_id: params.conversationId,
    field_changed: "authoritative_engine",
    previous_value: params.previousAuthority,
    new_value: params.newAuthority,
    change_reason: `${params.operation} at graph version ${params.graphVersion}`,
    change_type: params.operation,
    created_at: new Date().toISOString(),
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Requests a cutover from SIE_SHADOW to SIE authority for a conversation.
 *
 * Guards:
 * - SIE_AUTHORITY_ENABLED must be true (feature flag).
 * - The conversation must currently be in SIE_SHADOW state.
 * - The provided currentGraphVersion must match the actual graph version
 *   (optimistic lock — prevents stale cutover requests).
 *
 * On success, the conversation's authoritative engine becomes SIE and
 * an audit record is written.
 */
export async function requestCutover(
  conversationId: string,
  currentGraphVersion: number
): Promise<CutoverResult> {
  // ─── Guard: Feature flag must be enabled ──────────────────────────────
  if (!SIE_AUTHORITY_ENABLED) {
    return {
      success: false,
      newAuthority: "SIE_SHADOW",
      graphVersion: currentGraphVersion,
      error:
        "SIE authority is not enabled. Set SIE_AUTHORITY_ENABLED=true to allow cutover.",
    };
  }

  // ─── Guard: Load current state ────────────────────────────────────────
  const state = await loadAuthorityState(conversationId);
  if (!state) {
    return {
      success: false,
      newAuthority: "V2",
      graphVersion: currentGraphVersion,
      error: `Conversation ${conversationId} not found in v2_update_state.`,
    };
  }

  // ─── Guard: Must be in SIE_SHADOW ────────────────────────────────────
  if (state.engine !== "SIE_SHADOW") {
    return {
      success: false,
      newAuthority: state.engine,
      graphVersion: state.graphVersion,
      error: `Cannot cutover: conversation is in ${state.engine} state (expected SIE_SHADOW).`,
    };
  }

  // ─── Guard: Graph version must match (optimistic lock) ────────────────
  if (state.graphVersion !== currentGraphVersion) {
    return {
      success: false,
      newAuthority: state.engine,
      graphVersion: state.graphVersion,
      error: `Version mismatch: expected ${currentGraphVersion}, actual ${state.graphVersion}. Reload state and retry.`,
    };
  }

  // ─── Transition: SIE_SHADOW → SIE ────────────────────────────────────
  const db = createServerSupabaseClient();
  const { error: updateError } = await db
    .from("v2_update_state")
    .update({
      authoritative_engine: "SIE",
      sie_cutover_graph_version: currentGraphVersion,
    })
    .eq("conversation_id", conversationId)
    .eq("update_version", currentGraphVersion);

  if (updateError) {
    return {
      success: false,
      newAuthority: "SIE_SHADOW",
      graphVersion: currentGraphVersion,
      error: `Database update failed: ${updateError.message}`,
    };
  }

  // ─── Audit trail ──────────────────────────────────────────────────────
  await writeAuthorityAudit({
    conversationId,
    previousAuthority: "SIE_SHADOW",
    newAuthority: "SIE",
    graphVersion: currentGraphVersion,
    operation: "cutover",
  });

  return {
    success: true,
    newAuthority: "SIE",
    graphVersion: currentGraphVersion,
  };
}

/**
 * Requests a rollback from SIE authority back to SIE_SHADOW for a conversation.
 *
 * Guards:
 * - The conversation must currently be in SIE state.
 * - The provided currentGraphVersion must match the actual graph version
 *   (optimistic lock — prevents stale rollback requests).
 *
 * On success, the conversation's authoritative engine returns to SIE_SHADOW
 * and an audit record is written. The legacy V2 pipeline resumes authority.
 */
export async function requestRollback(
  conversationId: string,
  currentGraphVersion: number
): Promise<RollbackResult> {
  // ─── Guard: Load current state ────────────────────────────────────────
  const state = await loadAuthorityState(conversationId);
  if (!state) {
    return {
      success: false,
      newAuthority: "V2",
      graphVersion: currentGraphVersion,
      error: `Conversation ${conversationId} not found in v2_update_state.`,
    };
  }

  // ─── Guard: Must be in SIE ────────────────────────────────────────────
  if (state.engine !== "SIE") {
    return {
      success: false,
      newAuthority: state.engine,
      graphVersion: state.graphVersion,
      error: `Cannot rollback: conversation is in ${state.engine} state (expected SIE).`,
    };
  }

  // ─── Guard: Graph version must match (optimistic lock) ────────────────
  if (state.graphVersion !== currentGraphVersion) {
    return {
      success: false,
      newAuthority: state.engine,
      graphVersion: state.graphVersion,
      error: `Version mismatch: expected ${currentGraphVersion}, actual ${state.graphVersion}. Reload state and retry.`,
    };
  }

  // ─── Transition: SIE → SIE_SHADOW ────────────────────────────────────
  const db = createServerSupabaseClient();
  const { error: updateError } = await db
    .from("v2_update_state")
    .update({
      authoritative_engine: "SIE_SHADOW",
    })
    .eq("conversation_id", conversationId)
    .eq("update_version", currentGraphVersion);

  if (updateError) {
    return {
      success: false,
      newAuthority: "SIE",
      graphVersion: currentGraphVersion,
      error: `Database update failed: ${updateError.message}`,
    };
  }

  // ─── Audit trail ──────────────────────────────────────────────────────
  await writeAuthorityAudit({
    conversationId,
    previousAuthority: "SIE",
    newAuthority: "SIE_SHADOW",
    graphVersion: currentGraphVersion,
    operation: "rollback",
  });

  return {
    success: true,
    newAuthority: "SIE_SHADOW",
    graphVersion: currentGraphVersion,
  };
}
