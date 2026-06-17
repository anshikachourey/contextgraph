import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { ContextNode } from "@/src/types/node";
import type { NodeMetadata } from "@/src/types/db";

// Persist a context node and its linked message IDs.
export async function persistNode(
  conversationId: string,
  node: ContextNode,
  metadata: NodeMetadata = {},
): Promise<void> {
  const db = createServerSupabaseClient();

  // Insert the node
  const { error: nodeError } = await db.from("nodes").insert({
    id: node.id,
    conversation_id: conversationId,
    title: node.title,
    summary: node.summary,
    metadata: {
      ...metadata,
      messageCount: node.messageIds.length,
    },
  });

  if (nodeError) throw new Error(`Failed to persist node: ${nodeError.message}`);

  // Insert node-message links
  if (node.messageIds.length > 0) {
    const links = node.messageIds.map((messageId) => ({
      node_id: node.id,
      message_id: messageId,
    }));

    const { error: linkError } = await db.from("node_messages").insert(links);
    if (linkError) throw new Error(`Failed to persist node-message links: ${linkError.message}`);
  }
}
