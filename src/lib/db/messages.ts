import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { ChatMessage } from "@/src/types/message";

// Persist one or more messages to the database.
// Supports branch messages: if parentNodeId is set, stores it.
// Uses explicit created_at with 1ms offsets to preserve insertion order.
export async function persistMessages(
  conversationId: string,
  messages: ChatMessage[],
): Promise<void> {
  const db = createServerSupabaseClient();

  const baseTime = Date.now();
  const rows = messages.map((m, idx) => ({
    id: m.id,
    conversation_id: conversationId,
    role: m.role,
    content: m.content,
    parent_node_id: m.parentNodeId ?? null,
    branch_root_message_id: m.branchRootMessageId ?? null,
    created_at: new Date(baseTime + idx).toISOString(),
  }));

  const { error } = await db.from("messages").insert(rows);
  if (error) throw new Error(`Failed to persist messages: ${error.message}`);
}
