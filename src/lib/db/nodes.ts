import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import {
  generateEmbedding,
  generateEvidenceSummary,
  buildNodeEmbeddingText,
} from "@/src/lib/embeddings";
import type { ContextNode } from "@/src/types/node";
import type { NodeMetadata } from "@/src/types/db";
import type { ChatMessage } from "@/src/types/message";

// Persist a context node, its linked message IDs, evidence summary, and embedding.
//
// Generation strategy: synchronous with soft-fail.
// Both OpenAI calls (evidence summary + embedding) run before the DB insert.
// If either fails, we log the error and proceed with null values.
// The node is always saved — AI enrichment is additive, not required.
export async function persistNode(
  conversationId: string,
  node: ContextNode,
  linkedMessages: ChatMessage[],
  metadata: NodeMetadata = {},
): Promise<void> {
  const db = createServerSupabaseClient();

  // Step 1: Generate evidence summary from linked messages (soft-fail)
  // Skip for very short content where AI can't produce a meaningful summary.
  let evidenceSummary: string | null = null;
  const totalContent = linkedMessages.reduce((acc, m) => acc + m.content.length, 0);
  if (linkedMessages.length > 0 && totalContent > 20) {
    try {
      evidenceSummary = await generateEvidenceSummary(linkedMessages);
    } catch (err) {
      console.error(
        `[persistNode] Evidence summary generation failed for "${node.title}":`,
        err,
      );
    }
  }

  // Step 2: Generate structured embedding (soft-fail)
  let embedding: number[] | null = null;
  try {
    const text = buildNodeEmbeddingText(node.title, node.summary, evidenceSummary);
    embedding = await generateEmbedding(text);
  } catch (err) {
    console.error(
      `[persistNode] Embedding generation failed for "${node.title}":`,
      err,
    );
  }

  // Step 3: Insert the node row
  const { error: nodeError } = await db.from("nodes").insert({
    id: node.id,
    conversation_id: conversationId,
    title: node.title,
    summary: node.summary,
    evidence_summary: evidenceSummary,
    metadata: {
      ...metadata,
      messageCount: node.messageIds.length,
    },
    embedding,
  });

  if (nodeError) throw new Error(`Failed to persist node: ${nodeError.message}`);

  // Step 4: Insert node-message links
  if (node.messageIds.length > 0) {
    const links = node.messageIds.map((messageId) => ({
      node_id: node.id,
      message_id: messageId,
    }));

    const { error: linkError } = await db.from("node_messages").insert(links);
    if (linkError) {
      throw new Error(`Failed to persist node-message links: ${linkError.message}`);
    }
  }
}

// Load nodes with their embeddings and evidence_summary status for the debug view.
// Not used by the main conversation load — kept separate deliberately.
export async function loadNodesWithEmbeddings(
  conversationId: string,
): Promise<
  Array<{
    id: string;
    title: string;
    summary: string;
    evidenceSummary: string | null;
    embedding: number[] | null;
  }>
> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("nodes")
    .select("id, title, summary, evidence_summary, embedding")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to load nodes with embeddings: ${error.message}`);

  return (data ?? []).map(
    (row: {
      id: string;
      title: string;
      summary: string;
      evidence_summary: unknown;
      embedding: unknown;
    }) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      evidenceSummary:
        typeof row.evidence_summary === "string" ? row.evidence_summary : null,
      embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : null,
    }),
  );
}
