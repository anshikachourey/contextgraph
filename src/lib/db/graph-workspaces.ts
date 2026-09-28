/**
 * Database operations for graph workspaces.
 * 
 * All functions use the service-role client (bypasses RLS).
 * Authorization is enforced at the API route layer.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GraphWorkspace = {
  id: string;
  workspace_id: string;
  name: string;
  graph_payload: GraphPayloadV1;
  schema_version: number;
  legacy_import_key: string | null;
  created_at: string;
  updated_at: string;
};

export type GraphWorkspaceListItem = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  node_count: number;
};

export type PersistedNode = {
  id: string;
  position: { x: number; y: number };
  conversationId?: string;
  data: {
    title: string;
    objectType: string;
    description: string;
    provenance: string;
    createdAt: string;
  };
};

export type PersistedEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  data?: {
    type: string;
    explanation: string;
    provenance: string;
    createdAt: string;
  };
};

export type GraphPayloadV1 = {
  nodes: PersistedNode[];
  edges: PersistedEdge[];
};

export type GraphWorkspaceConversation = {
  graph_workspace_id: string;
  conversation_id: string;
  source_node_id: string | null;
  created_at: string;
  // Joined from conversations table
  title?: string;
  conversation_created_at?: string;
};

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listGraphWorkspaces(workspaceId: string): Promise<GraphWorkspaceListItem[]> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("graph_workspaces")
    .select("id, name, graph_payload, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`Failed to list graph workspaces: ${error.message}`);

  return (data || []).map((row) => {
    const payload = row.graph_payload as GraphPayloadV1 | null;
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      node_count: payload?.nodes?.length ?? 0,
    };
  });
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getGraphWorkspace(id: string): Promise<GraphWorkspace | null> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("graph_workspaces")
    .select("*")
    .eq("id", id)
    .single();

  if (error && error.code === "PGRST116") return null; // not found
  if (error) throw new Error(`Failed to load graph workspace: ${error.message}`);

  return data as GraphWorkspace;
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createGraphWorkspace(
  workspaceId: string,
  name: string,
  options?: {
    graphPayload?: GraphPayloadV1;
    legacyImportKey?: string;
  },
): Promise<GraphWorkspace> {
  const db = createServerSupabaseClient();

  const payload = options?.graphPayload ?? { nodes: [], edges: [] };

  const { data, error } = await db
    .from("graph_workspaces")
    .insert({
      workspace_id: workspaceId,
      name,
      graph_payload: payload,
      schema_version: 1,
      legacy_import_key: options?.legacyImportKey ?? null,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create graph workspace: ${error.message}`);

  return data as GraphWorkspace;
}

// ─── Import Legacy (Idempotent) ───────────────────────────────────────────────

/**
 * Import legacy dashboard data into a graph workspace.
 * Uses legacy_import_key for idempotency — retrying with the same key
 * returns the existing graph without creating a duplicate.
 */
export async function importLegacyGraphWorkspace(
  workspaceId: string,
  legacyImportKey: string,
  payload: GraphPayloadV1,
): Promise<{ graphWorkspace: GraphWorkspace; alreadyExisted: boolean }> {
  const db = createServerSupabaseClient();

  // Check if already imported
  const { data: existing } = await db
    .from("graph_workspaces")
    .select("*")
    .eq("legacy_import_key", legacyImportKey)
    .maybeSingle();

  if (existing) {
    return { graphWorkspace: existing as GraphWorkspace, alreadyExisted: true };
  }

  // Create new graph workspace with the legacy data
  const graphWorkspace = await createGraphWorkspace(workspaceId, "Graph Dashboard", {
    graphPayload: payload,
    legacyImportKey,
  });

  return { graphWorkspace, alreadyExisted: false };
}

// ─── Rename ───────────────────────────────────────────────────────────────────

export async function renameGraphWorkspace(id: string, name: string): Promise<void> {
  const db = createServerSupabaseClient();

  const { error } = await db
    .from("graph_workspaces")
    .update({ name })
    .eq("id", id);

  if (error) throw new Error(`Failed to rename graph workspace: ${error.message}`);
}

// ─── Save Payload ─────────────────────────────────────────────────────────────

export async function saveGraphWorkspacePayload(
  id: string,
  payload: GraphPayloadV1,
): Promise<void> {
  const db = createServerSupabaseClient();

  const { error } = await db
    .from("graph_workspaces")
    .update({ graph_payload: payload })
    .eq("id", id);

  if (error) throw new Error(`Failed to save graph workspace payload: ${error.message}`);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteGraphWorkspace(id: string): Promise<void> {
  const db = createServerSupabaseClient();

  const { error } = await db
    .from("graph_workspaces")
    .delete()
    .eq("id", id);

  if (error) throw new Error(`Failed to delete graph workspace: ${error.message}`);
}

// ─── Conversation Membership ──────────────────────────────────────────────────

export async function listGraphConversations(graphId: string): Promise<GraphWorkspaceConversation[]> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("graph_workspace_conversations")
    .select(`
      graph_workspace_id,
      conversation_id,
      source_node_id,
      created_at,
      conversations:conversation_id (title, created_at)
    `)
    .eq("graph_workspace_id", graphId);

  if (error) throw new Error(`Failed to list graph conversations: ${error.message}`);

  return (data || []).map((row) => {
    const conv = row.conversations as unknown as { title: string; created_at: string } | null;
    return {
      graph_workspace_id: row.graph_workspace_id,
      conversation_id: row.conversation_id,
      source_node_id: row.source_node_id,
      created_at: row.created_at,
      title: conv?.title ?? "Untitled",
      conversation_created_at: conv?.created_at,
    };
  });
}

export async function addConversationToGraph(
  graphId: string,
  conversationId: string,
  sourceNodeId?: string | null,
): Promise<void> {
  const db = createServerSupabaseClient();

  const { error } = await db
    .from("graph_workspace_conversations")
    .upsert(
      {
        graph_workspace_id: graphId,
        conversation_id: conversationId,
        source_node_id: sourceNodeId ?? null,
      },
      { onConflict: "graph_workspace_id,conversation_id" },
    );

  if (error) throw new Error(`Failed to add conversation to graph: ${error.message}`);
}

export async function removeConversationFromGraph(
  graphId: string,
  conversationId: string,
): Promise<void> {
  const db = createServerSupabaseClient();

  const { error } = await db
    .from("graph_workspace_conversations")
    .delete()
    .eq("graph_workspace_id", graphId)
    .eq("conversation_id", conversationId);

  if (error) throw new Error(`Failed to remove conversation from graph: ${error.message}`);
}

/**
 * When a dashboard node is deleted, unlink it from any conversation associations
 * but keep the conversation in the graph (set source_node_id = NULL).
 */
export async function unlinkNodeFromConversations(
  graphId: string,
  nodeId: string,
): Promise<void> {
  const db = createServerSupabaseClient();

  const { error } = await db
    .from("graph_workspace_conversations")
    .update({ source_node_id: null })
    .eq("graph_workspace_id", graphId)
    .eq("source_node_id", nodeId);

  if (error) throw new Error(`Failed to unlink node from conversations: ${error.message}`);
}

// ─── Conversation Node Positions (Knowledge Map) ──────────────────────────────

export type NodePosition = {
  node_id: string;
  position_x: number;
  position_y: number;
};

export async function getConversationNodePositions(
  conversationId: string,
): Promise<NodePosition[]> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("conversation_node_positions")
    .select("node_id, position_x, position_y")
    .eq("conversation_id", conversationId);

  if (error) throw new Error(`Failed to load node positions: ${error.message}`);

  return data || [];
}

export async function saveConversationNodePositions(
  conversationId: string,
  positions: Array<{ nodeId: string; x: number; y: number }>,
): Promise<void> {
  if (positions.length === 0) return;

  const db = createServerSupabaseClient();

  const rows = positions.map((p) => ({
    conversation_id: conversationId,
    node_id: p.nodeId,
    position_x: p.x,
    position_y: p.y,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await db
    .from("conversation_node_positions")
    .upsert(rows, { onConflict: "conversation_id,node_id" });

  if (error) throw new Error(`Failed to save node positions: ${error.message}`);
}
