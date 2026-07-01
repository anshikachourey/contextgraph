import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { TopicCandidate, DbTopicCandidate, MessageSegment } from "@/src/types/graphEngine";

/**
 * Load all active (accumulating) topic candidates for a conversation.
 */
export async function loadActiveCandidates(
  conversationId: string,
): Promise<TopicCandidate[]> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("topic_candidates")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("status", "accumulating")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to load candidates: ${error.message}`);

  return (data ?? []).map(mapDbToCandidate);
}

/**
 * Create a new topic candidate with its first segment.
 */
export async function createCandidate(
  conversationId: string,
  segment: MessageSegment,
  embedding: number[],
  confidence: number,
): Promise<TopicCandidate> {
  const db = createServerSupabaseClient();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = {
    id,
    conversation_id: conversationId,
    status: "accumulating",
    segments: [segment],
    embedding,
    confidence,
    materialized_node_id: null,
    last_updated_at: now,
    created_at: now,
  };

  const { error } = await db.from("topic_candidates").insert(row);
  if (error) throw new Error(`Failed to create candidate: ${error.message}`);

  return {
    id,
    conversationId,
    status: "accumulating",
    segments: [segment],
    embedding,
    confidence,
    materializedNodeId: null,
    lastUpdatedAt: now,
    createdAt: now,
  };
}

/**
 * Add a segment to an existing candidate and update confidence.
 */
export async function updateCandidate(
  candidateId: string,
  segments: MessageSegment[],
  embedding: number[],
  confidence: number,
): Promise<void> {
  const db = createServerSupabaseClient();

  const { error } = await db
    .from("topic_candidates")
    .update({
      segments,
      embedding,
      confidence,
      last_updated_at: new Date().toISOString(),
    })
    .eq("id", candidateId);

  if (error) throw new Error(`Failed to update candidate: ${error.message}`);
}

/**
 * Mark a candidate as materialized (it became a real node).
 */
export async function materializeCandidate(
  candidateId: string,
  nodeId: string,
): Promise<void> {
  const db = createServerSupabaseClient();

  const { error } = await db
    .from("topic_candidates")
    .update({
      status: "materialized",
      materialized_node_id: nodeId,
      last_updated_at: new Date().toISOString(),
    })
    .eq("id", candidateId);

  if (error) throw new Error(`Failed to materialize candidate: ${error.message}`);
}

/**
 * Discard stale candidates that haven't received evidence recently.
 */
export async function discardStaleCandidates(
  conversationId: string,
  staleBeforeDate: string,
): Promise<number> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("topic_candidates")
    .update({ status: "discarded" })
    .eq("conversation_id", conversationId)
    .eq("status", "accumulating")
    .lt("last_updated_at", staleBeforeDate)
    .select("id");

  if (error) throw new Error(`Failed to discard stale candidates: ${error.message}`);
  return (data ?? []).length;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapDbToCandidate(row: DbTopicCandidate): TopicCandidate {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    segments: Array.isArray(row.segments) ? row.segments : [],
    embedding: Array.isArray(row.embedding) ? row.embedding : null,
    confidence: row.confidence,
    materializedNodeId: row.materialized_node_id,
    lastUpdatedAt: row.last_updated_at,
    createdAt: row.created_at,
  };
}
