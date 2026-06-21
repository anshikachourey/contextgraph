import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { SuggestedEdge, SemanticEdge } from "@/src/types/edge";
import type { DbEdge } from "@/src/types/db";

/**
 * Canonical pair ordering — always store the lexicographically smaller UUID
 * as source_node_id and the larger as target_node_id. This guarantees that
 * A↔B and B↔A produce the same row, enabling a unique constraint to prevent
 * duplicates at the database level.
 */
function canonicalPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

/**
 * Persist suggested edges to the database.
 * Treats suggested edges as a regenerable cache:
 * 1. Deletes ALL existing edges with status='suggested' for the conversation.
 * 2. Inserts the new batch fresh.
 * Never touches edges with status='confirmed' or any other status.
 * Returns the count of newly inserted edges.
 */
export async function persistEdges(
  conversationId: string,
  suggestions: SuggestedEdge[],
): Promise<number> {
  const db = createServerSupabaseClient();

  // Step 1: Clear stale suggested edges — confirmed/rejected edges are untouched
  const { error: deleteError } = await db
    .from("edges")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("status", "suggested");

  if (deleteError) {
    throw new Error(`Failed to clear old suggested edges: ${deleteError.message}`);
  }

  if (suggestions.length === 0) return 0;

  // Step 2: Insert fresh suggestions
  const rows = suggestions.map((s) => {
    const [source, target] = canonicalPair(s.sourceNodeId, s.targetNodeId);
    return {
      conversation_id: conversationId,
      source_node_id: source,
      target_node_id: target,
      relationship_type: "related",
      status: "suggested",
      similarity_score: s.similarity,
      explanation: s.explanation,
    };
  });

  const { error: insertError } = await db.from("edges").insert(rows);
  if (insertError) throw new Error(`Failed to persist edges: ${insertError.message}`);

  return rows.length;
}

/**
 * Load all persisted edges for a conversation.
 * Returns UI-typed SemanticEdge objects.
 */
export async function loadEdges(conversationId: string): Promise<SemanticEdge[]> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("edges")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("similarity_score", { ascending: false });

  if (error) throw new Error(`Failed to load edges: ${error.message}`);

  return (data ?? []).map((row: DbEdge) => ({
    id: row.id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    relationshipType: row.relationship_type,
    status: row.status as SemanticEdge["status"],
    similarityScore: row.similarity_score,
    explanation: row.explanation,
  }));
}
