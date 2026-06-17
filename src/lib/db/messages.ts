import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { ChatMessage } from "@/src/types/message";

// Persist one or more messages to the database.
// Called after optimistic UI update — fire and forget from the frontend.
export async function persistMessages(
  conversationId: string,
  messages: ChatMessage[],
): Promise<void> {
  const db = createServerSupabaseClient();

  const rows = messages.map((m) => ({
    id: m.id,
    conversation_id: conversationId,
    role: m.role,
    content: m.content,
  }));

  const { error } = await db.from("messages").insert(rows);
  if (error) throw new Error(`Failed to persist messages: ${error.message}`);
}
