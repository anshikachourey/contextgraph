// Raw database row shapes — these mirror the Supabase tables exactly.
// UI types (ChatMessage, ContextNode) are derived from these in the data layer.

export type DbConversation = {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string | null;
};

export type DbMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  attachments: Array<{ url: string; filename: string; mimeType: string; size: number }> | null;
  parent_node_id: string | null;
  branch_root_message_id: string | null;
  created_at: string;
};

export type DbNode = {
  id: string;
  conversation_id: string;
  title: string;
  summary: string;
  // AI-generated bullet-point summary of the linked conversation evidence.
  // Null for nodes created before this column was added.
  evidence_summary: string | null;
  metadata: NodeMetadata;
  // Stored as jsonb (number[]). Null for nodes without embeddings.
  embedding: number[] | null;
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

export type DbEdge = {
  id: string;
  conversation_id: string;
  source_node_id: string;
  target_node_id: string;
  relationship_type: string;
  status: string;
  similarity_score: number;
  explanation: string;
  created_at: string;
};
