import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { DbConversation, DbMessage, DbNode, DbNodeMessage } from "@/src/types/db";
import type { ChatMessage } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import type { SemanticEdge } from "@/src/types/edge";
import { loadEdges } from "./edges";

export type ConversationData = {
  conversation: DbConversation;
  messages: ChatMessage[];
  nodes: ContextNode[];
  edges: SemanticEdge[];
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
    parentNodeId: m.parent_node_id ?? null,
    branchRootMessageId: m.branch_root_message_id ?? null,
  }));

  // Load neighborhood hues for color derivation
  const neighborhoodIds = (dbNodes ?? [])
    .map((n: any) => n.neighborhood_id)
    .filter((id: unknown): id is string => id !== null && id !== undefined);

  let neighborhoodHueMap = new Map<string, number>();
  if (neighborhoodIds.length > 0) {
    const uniqueIds = [...new Set(neighborhoodIds)];
    const { data: nbData } = await db
      .from("neighborhoods")
      .select("id, hue")
      .in("id", uniqueIds);
    for (const nb of (nbData ?? []) as { id: string; hue: number }[]) {
      neighborhoodHueMap.set(nb.id, nb.hue);
    }
  }

  const nodes: ContextNode[] = (dbNodes ?? []).map((n: DbNode & { neighborhood_id?: string; hierarchy_depth?: number }) => ({
    id: n.id,
    title: n.title,
    summary: n.summary,
    messageIds: nodeMessages
      .filter((nm) => nm.node_id === n.id)
      .map((nm) => nm.message_id),
    neighborhoodHue: n.neighborhood_id ? (neighborhoodHueMap.get(n.neighborhood_id) ?? null) : null,
    hierarchyDepth: (n as any).hierarchy_depth ?? 0,
  }));

  // Load persisted semantic edges
  const edges = await loadEdges(conversation.id);

  return { conversation, messages, nodes, edges };
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
    edges: [],
  };
}
