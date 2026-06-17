// Raw database row shapes — these mirror the Supabase tables exactly.
// UI types (ChatMessage, ContextNode) are derived from these in the data layer.

export type DbConversation = {
  id: string;
  title: string;
  created_at: string;
};

export type DbMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type DbNode = {
  id: string;
  conversation_id: string;
  title: string;
  summary: string;
  metadata: NodeMetadata;
  created_at: string;
};

export type DbNodeMessage = {
  node_id: string;
  message_id: string;
};

// Flexible metadata — fields are added over time without schema migrations.
export type NodeMetadata = {
  createdBy?: "user" | "ai";
  messageCount?: number;
  editedTitle?: boolean;
  editedSummary?: boolean;
  acceptedWithoutChanges?: boolean;
};
