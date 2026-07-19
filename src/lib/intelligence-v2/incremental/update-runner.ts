/**
 * V2 Incremental Update Runner — Cursor-Based, Durable.
 *
 * Correctness: persisted cursor in v2_update_state (never advanced past proven coverage).
 * Ordering: process-local Promise chain per conversation.
 * Atomicity: v2_commit_update PostgreSQL RPC (required after migration).
 * Recovery: automatic sweep triggered on first enqueue per process lifetime.
 *
 * Serialization scope: PROCESS-LOCAL only.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { runIncrementalV2Update } from "./index";
import type { V2Snapshot } from "./schemas";
import type { ChatMessage } from "@/src/types/message";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UpdateJob {
  conversationId: string;
  messages: ChatMessage[];
  v2ContinuationObjectId: string | null;
  enqueuedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STALE_TIMEOUT_MS = 5 * 60 * 1000;

// ─── State ──────────────────────────────────────────────────────────────────

const conversationChains = new Map<string, Promise<void>>();
let recoveryTriggered = false;

// ─── Public API ─────────────────────────────────────────────────────────────

export function enqueueV2Update(job: UpdateJob): void {
  triggerRecoveryOnce();
  markQueued(job.conversationId);

  const chain = conversationChains.get(job.conversationId) ?? Promise.resolve();
  const next = chain
    .then(() => processFromCursor(job.conversationId, job.v2ContinuationObjectId))
    .catch((err) => {
      console.error(`[v2-runner] ${job.conversationId}:`, err instanceof Error ? err.message : err);
    });
  conversationChains.set(job.conversationId, next);
}

/** Await all pending jobs for a conversation. For testing. */
export function drainConversation(conversationId: string): Promise<void> {
  return conversationChains.get(conversationId) ?? Promise.resolve();
}

/** Reset module state. For testing only. */
export function _reset(): void {
  conversationChains.clear();
  recoveryTriggered = false;
}

// ─── Recovery ───────────────────────────────────────────────────────────────

/**
 * Triggers recovery exactly once per process lifetime.
 * Exported so it can be called from V2 API access paths (GET snapshot).
 * Uses a module-level flag to prevent duplicate sweeps.
 */
export function triggerRecoveryOnce(): void {
  if (recoveryTriggered) return;
  recoveryTriggered = true;
  recoverAbandonedWork().catch((err) => {
    console.error("[v2-runner] Recovery sweep error:", err instanceof Error ? err.message : err);
  });
}

/**
 * Reclaim queued or stale-updating work from the database.
 * Returns the number of conversations reclaimed.
 */
export async function recoverAbandonedWork(): Promise<number> {
  const db = createServerSupabaseClient();
  const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();

  const { data: rows } = await db
    .from("v2_update_state")
    .select("conversation_id")
    .or(`update_status.eq.queued,and(update_status.eq.updating,updated_at.lt.${staleThreshold})`);

  if (!rows || rows.length === 0) return 0;

  for (const row of rows) {
    const convId = row.conversation_id as string;
    const chain = conversationChains.get(convId) ?? Promise.resolve();
    const next = chain
      .then(() => processFromCursor(convId, null))
      .catch((err) => {
        console.error(`[v2-runner] Recovery ${convId}:`, err instanceof Error ? err.message : err);
      });
    conversationChains.set(convId, next);
  }

  return rows.length;
}

// ─── Core Processor ─────────────────────────────────────────────────────────

async function processFromCursor(conversationId: string, v2ContinuationObjectId: string | null): Promise<void> {
  const db = createServerSupabaseClient();

  // 1. Read persisted cursor
  const { data: stateRow } = await db
    .from("v2_update_state")
    .select("last_processed_message_seq, update_version")
    .eq("conversation_id", conversationId)
    .single();

  const cursor = (stateRow?.last_processed_message_seq as number) ?? 0;
  const currentVersion = (stateRow?.update_version as number) ?? 0;

  // 2. Query ALL unprocessed messages after cursor
  const { data: msgs } = await db
    .from("messages")
    .select("id, role, content, conversation_id, created_at, parent_node_id, branch_root_message_id, message_seq")
    .eq("conversation_id", conversationId)
    .gt("message_seq", cursor)
    .order("message_seq", { ascending: true });

  if (!msgs || msgs.length === 0) {
    await setIdle(db, conversationId);
    return;
  }

  // 3. Mark updating
  await db.from("v2_update_state").upsert({
    conversation_id: conversationId,
    update_status: "updating",
    updated_at: new Date().toISOString(),
  }, { onConflict: "conversation_id" });

  // 4. Load snapshot
  const { data: snap } = await db
    .from("v2_graph_snapshots")
    .select("graph_payload")
    .eq("conversation_id", conversationId)
    .eq("status", "ready")
    .single();

  if (!snap?.graph_payload) {
    await setIdle(db, conversationId);
    return;
  }

  try {
    const gp = snap.graph_payload as Record<string, unknown>;
    const snapshot: V2Snapshot = buildSnapshot(conversationId, gp);

    const msgRows = msgs.map((m: Record<string, unknown>) => ({
      id: m.id as string, role: m.role as string, content: m.content as string,
      conversation_id: conversationId, created_at: m.created_at as string,
      parent_node_id: (m.parent_node_id as string) ?? null,
      branch_root_message_id: (m.branch_root_message_id as string) ?? null,
    }));

    // 5. Run incremental engine
    const result = await runIncrementalV2Update({ conversationId, snapshot, newMessages: msgRows });

    // 6. Continuation provenance
    if (v2ContinuationObjectId) {
      await db.from("continuation_provenance").insert({
        conversation_id: conversationId,
        origin_entity_id: v2ContinuationObjectId,
        origin_graph_version: "v2",
        origin_entity_type: "object",
        message_ids: msgRows.map((m) => m.id),
      });
    }

    // 7. Compute commit parameters
    const newVersion = currentVersion + 1;
    const highestSeq = Math.max(...msgs.map((m: Record<string, unknown>) => m.message_seq as number));
    const lowestSeq = Math.min(...msgs.map((m: Record<string, unknown>) => m.message_seq as number));

    const payload = result.acceptedMutations.length > 0
      ? { objects: result.updatedGraph.objects, relationships: result.updatedGraph.relationships, propositions: result.updatedGraph.propositions, threads: result.updatedGraph.threads, hierarchy: result.updatedGraph.hierarchy, trees: result.updatedGraph.trees }
      : gp;

    const mutations = result.acceptedMutations.map((m) => ({
      mutationId: m.mutationId, type: m.type, targetId: m.targetId,
      beforeState: m.beforeState, afterState: m.afterState,
      sourceUtteranceIds: m.sourceUtteranceIds, sourcePropositionIds: m.sourcePropositionIds,
      reason: m.reason, confidence: m.confidence, provenance: m.provenance,
    }));

    // 8. ATOMIC COMMIT — required after migration
    const { error: rpcError } = await db.rpc("v2_commit_update", {
      p_conversation_id: conversationId,
      p_new_snapshot: payload,
      p_from_version: currentVersion,
      p_to_version: newVersion,
      p_mutations: mutations,
      p_last_processed_seq: highestSeq,
      p_message_seq_from: lowestSeq,
      p_message_seq_to: highestSeq,
    });

    if (rpcError) {
      throw new Error(`v2_commit_update RPC failed: ${rpcError.message}. Ensure the v2_durable_update_system migration has been applied.`);
    }

    console.log(`[v2-runner] ${conversationId} v${newVersion}: ${result.acceptedMutations.length} mutations, seq ${cursor}→${highestSeq}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[v2-runner] ${conversationId} FAILED:`, msg);

    // Failure: cursor stays, graph stays visible
    await db.from("v2_update_state").upsert({
      conversation_id: conversationId,
      update_status: "failed",
      last_update_error: msg,
      update_failed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "conversation_id" });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function markQueued(conversationId: string): Promise<void> {
  const db = createServerSupabaseClient();
  await db.from("v2_update_state").upsert({
    conversation_id: conversationId,
    update_status: "queued",
    pending_since: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "conversation_id" });
}

async function setIdle(db: ReturnType<typeof createServerSupabaseClient>, conversationId: string): Promise<void> {
  await db.from("v2_update_state").upsert({
    conversation_id: conversationId,
    update_status: "idle",
    updated_at: new Date().toISOString(),
  }, { onConflict: "conversation_id" });
}

function buildSnapshot(conversationId: string, gp: Record<string, unknown>): V2Snapshot {
  return {
    conversationId,
    objects: (gp.objects as V2Snapshot["objects"]) ?? [],
    relationships: (gp.relationships as V2Snapshot["relationships"]) ?? [],
    propositions: (gp.propositions as V2Snapshot["propositions"]) ?? [],
    threads: ((gp.threads as Array<Record<string, unknown>>) ?? []).map((t) => ({
      threadId: (t.threadId as string) ?? "", utteranceIds: (t.utteranceIds as string[]) ?? [],
      propositionIds: (t.propositionIds as string[]) ?? [], subject: (t.subject as string) ?? "",
      branchId: null, originThreadId: null, divergenceUtteranceId: null, status: "active" as const,
    })),
    hierarchy: (gp.hierarchy as V2Snapshot["hierarchy"]) ?? [],
    trees: (gp.trees as V2Snapshot["trees"]) ?? [],
  };
}
