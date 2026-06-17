import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { DbConversation, DbMessage, DbNode, DbNodeMessage } from "@/src/types/db";
import type { ChatMessage } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";

export type ConversationData = {
  conversation: DbConversation;
  messages: ChatMessage[];
  nodes: ContextNode[];
};

// Load the most recent conversation with all its messages and nodes.
// Returns null if no conversations exist yet.
export async function loadLatestConversation(): Promise<ConversationData | null> {
  const db = createServerSupabaseClient();

  const { data: conversations, error: convError } = await db
    .from("conversations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (convError) throw new Error(`Failed to load conversation: ${convError.message}`);
  if (!conversations || conversations.length === 0) return null;

  const conversation = conversations[0] as DbConversation;

  // Load messages ordered by creation time
  const { data: dbMessages, error: msgError } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true });

  if (msgError) throw new Error(`Failed to load messages: ${msgError.message}`);

  // Load nodes
  const { data: dbNodes, error: nodeError } = await db
    .from("nodes")
    .select("*")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true });

  if (nodeError) throw new Error(`Failed to load nodes: ${nodeError.message}`);

  // Load node-message links
  const nodeIds = (dbNodes ?? []).map((n: DbNode) => n.id);
  let nodeMessages: DbNodeMessage[] = [];

  if (nodeIds.length > 0) {
    const { data: nmData, error: nmError } = await db
      .from("node_messages")
      .select("*")
      .in("node_id", nodeIds);

    if (nmError) throw new Error(`Failed to load node messages: ${nmError.message}`);
    nodeMessages = (nmData ?? []) as DbNodeMessage[];
  }

  // Map DB rows to UI types
  const messages: ChatMessage[] = (dbMessages ?? []).map((m: DbMessage) => ({
    id: m.id,
    role: m.role,
    content: m.content,
  }));

  const nodes: ContextNode[] = (dbNodes ?? []).map((n: DbNode) => ({
    id: n.id,
    title: n.title,
    summary: n.summary,
    messageIds: nodeMessages
      .filter((nm) => nm.node_id === n.id)
      .map((nm) => nm.message_id),
  }));

  return { conversation, messages, nodes };
}

// Create a new conversation and seed it with initial messages.
export async function createConversation(
  title: string,
  seedMessages: ChatMessage[],
): Promise<ConversationData> {
  const db = createServerSupabaseClient();

  const { data: convData, error: convError } = await db
    .from("conversations")
    .insert({ title })
    .select()
    .single();

  if (convError || !convData) {
    throw new Error(`Failed to create conversation: ${convError?.message}`);
  }

  const conversation = convData as DbConversation;

  if (seedMessages.length > 0) {
    const rows = seedMessages.map((m) => ({
      id: m.id,
      conversation_id: conversation.id,
      role: m.role,
      content: m.content,
    }));

    const { error: msgError } = await db.from("messages").insert(rows);
    if (msgError) throw new Error(`Failed to seed messages: ${msgError.message}`);
  }

  return {
    conversation,
    messages: seedMessages,
    nodes: [],
  };
}
