import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { ChatMessage } from "@/src/types/message";

/**
 * Persist one or more messages to the database.
 * Supports branch messages: if parentNodeId is set, stores it.
 * Uses explicit created_at with 1ms offsets to preserve insertion order.
 *
 * Options:
 * - freshIds: if true, generates new UUIDs for all messages (used when
 *   copying history into a new conversation to avoid PK conflicts)
 */
export async function persistMessages(
  conversationId: string,
  messages: ChatMessage[],
  options?: { freshIds?: boolean },
): Promise<void> {
  const db = createServerSupabaseClient();

  const baseTime = Date.now();
  const rows = messages.map((m, idx) => ({
    id: options?.freshIds ? crypto.randomUUID() : m.id,
    conversation_id: conversationId,
    role: m.role,
    content: m.content,
    attachments: m.attachments && m.attachments.length > 0 ? m.attachments : null,
    parent_node_id: m.parentNodeId ?? null,
    branch_root_message_id: m.branchRootMessageId ?? null,
    created_at: new Date(baseTime + idx).toISOString(),
  }));

  const { error } = await db.from("messages").insert(rows);
  if (error) {
    console.error("[persistMessages] Insert failed:", {
      conversationId,
      messageCount: messages.length,
      messageIds: rows.map((r) => r.id),
      roles: rows.map((r) => r.role),
      freshIds: options?.freshIds ?? false,
      error: error.message,
      code: error.code,
      details: error.details,
    });
    throw new Error(`Failed to persist messages: ${error.message}`);
  }
}
