import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";

/**
 * POST /api/v2/manual-node
 *
 * Manages user-created manual objects in the V2 Knowledge Map snapshot.
 * Supports: create, edit, delete (nodes), and create/delete (edges).
 * Manual objects carry provenance "USER_CREATED" and are explicitly
 * distinguishable from SIE-generated semantic objects.
 *
 * Actions:
 *   { action: "create_node", conversationId, title, description?, messageIds? }
 *   { action: "edit_node", conversationId, objectId, title?, description? }
 *   { action: "delete_node", conversationId, objectId }
 *   { action: "create_edge", conversationId, sourceObjectId, targetObjectId, type?, explanation? }
 *   { action: "delete_edge", conversationId, relationshipId }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action as string | undefined;
  const conversationId = body.conversationId as string | undefined;

  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  const db = createServerSupabaseClient();

  switch (action) {
    case "create_node":
      return handleCreateNode(db, conversationId, body);
    case "edit_node":
      return handleEditNode(db, conversationId, body);
    case "delete_node":
      return handleDeleteNode(db, conversationId, body);
    case "create_edge":
      return handleCreateEdge(db, conversationId, body);
    case "edit_edge":
      return handleEditEdge(db, conversationId, body);
    case "delete_edge":
      return handleDeleteEdge(db, conversationId, body);
    default:
      // Legacy: no action field means create_node (backward compat)
      if (body.title) {
        return handleCreateNode(db, conversationId, body);
      }
      return NextResponse.json(
        { error: "action is required (create_node, edit_node, delete_node, create_edge, delete_edge)" },
        { status: 400 },
      );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DB = ReturnType<typeof createServerSupabaseClient>;

async function loadPayload(db: DB, conversationId: string) {
  const { data, error } = await db
    .from("v2_graph_snapshots")
    .select("graph_payload, status")
    .eq("conversation_id", conversationId)
    .single();

  if (error && error.code !== "PGRST116") {
    return { payload: null, error: error.message };
  }
  return { payload: data?.graph_payload as Record<string, unknown> | null, error: null };
}

async function savePayload(db: DB, conversationId: string, payload: Record<string, unknown>) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("v2_graph_snapshots")
    .update({ graph_payload: payload, updated_at: now })
    .eq("conversation_id", conversationId);
  return error;
}

async function ensureSnapshot(db: DB, conversationId: string): Promise<Record<string, unknown>> {
  const { payload } = await loadPayload(db, conversationId);
  if (payload) return payload;

  // Create an empty snapshot
  const empty = {
    objects: [],
    relationships: [],
    hierarchy: [],
    trees: [],
    propositions: [],
    threads: [],
  };

  const now = new Date().toISOString();
  await db.from("v2_graph_snapshots").upsert({
    conversation_id: conversationId,
    status: "ready",
    pipeline_version: "2.0.0-manual",
    graph_payload: empty,
    diagnostics: { objectCount: 0, relationshipCount: 0, treeCount: 0, maxDepth: 0 },
    generated_at: now,
    updated_at: now,
  }, { onConflict: "conversation_id" });

  return empty;
}

// ─── Create Node ──────────────────────────────────────────────────────────────

async function handleCreateNode(db: DB, conversationId: string, body: Record<string, unknown>): Promise<NextResponse> {
  const title = body.title as string | undefined;
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const description = (body.description as string) || "";
  const messageIds = (body.messageIds as string[]) || [];

  const payload = await ensureSnapshot(db, conversationId);
  const objects = (payload.objects as unknown[]) || [];
  const hierarchy = (payload.hierarchy as unknown[]) || [];
  const trees = (payload.trees as Array<{ treeId: string; rootObjectId: string; objectIds: string[] }>) || [];

  const objectId = crypto.randomUUID();
  const manualObject = {
    objectId,
    objectType: "manual_node",
    title,
    description,
    propositionIds: [],
    threadIds: [],
    supportingUtteranceIds: messageIds,
    contextualAssistantUtteranceIds: [],
    maturity: "established",
    status: "active",
    provenanceSummary: "USER_CREATED",
  };

  objects.push(manualObject);

  const manualTreeId = `tree-manual-${objectId.slice(0, 8)}`;
  hierarchy.push({
    objectId,
    depth: 0,
    parentObjectId: null,
    childObjectIds: [],
    treeId: manualTreeId,
  });
  trees.push({ treeId: manualTreeId, rootObjectId: objectId, objectIds: [objectId] });

  payload.objects = objects;
  payload.hierarchy = hierarchy;
  payload.trees = trees;

  const err = await savePayload(db, conversationId, payload);
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({ objectId, status: "created" }, { status: 201 });
}

// ─── Edit Node ────────────────────────────────────────────────────────────────

async function handleEditNode(db: DB, conversationId: string, body: Record<string, unknown>): Promise<NextResponse> {
  const objectId = body.objectId as string | undefined;
  if (!objectId) {
    return NextResponse.json({ error: "objectId is required" }, { status: 400 });
  }

  const { payload, error } = await loadPayload(db, conversationId);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!payload) return NextResponse.json({ error: "No snapshot found" }, { status: 404 });

  const objects = payload.objects as Array<Record<string, unknown>>;
  const obj = objects.find((o) => o.objectId === objectId);
  if (!obj) return NextResponse.json({ error: "Object not found" }, { status: 404 });

  if (body.title !== undefined) obj.title = body.title;
  if (body.description !== undefined) obj.description = body.description;

  const err = await savePayload(db, conversationId, payload);
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({ objectId, status: "updated" });
}

// ─── Delete Node ──────────────────────────────────────────────────────────────

async function handleDeleteNode(db: DB, conversationId: string, body: Record<string, unknown>): Promise<NextResponse> {
  const objectId = body.objectId as string | undefined;
  if (!objectId) {
    return NextResponse.json({ error: "objectId is required" }, { status: 400 });
  }

  const { payload, error } = await loadPayload(db, conversationId);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!payload) return NextResponse.json({ error: "No snapshot found" }, { status: 404 });

  // Remove from objects
  payload.objects = (payload.objects as Array<Record<string, unknown>>).filter((o) => o.objectId !== objectId);

  // Remove from hierarchy
  payload.hierarchy = (payload.hierarchy as Array<Record<string, unknown>>).filter((h) => h.objectId !== objectId);

  // Remove from trees
  payload.trees = (payload.trees as Array<Record<string, unknown>>).filter(
    (t) => (t as { rootObjectId?: string }).rootObjectId !== objectId
  );
  // Also remove from tree objectIds arrays
  for (const tree of payload.trees as Array<{ objectIds: string[] }>) {
    tree.objectIds = tree.objectIds.filter((id) => id !== objectId);
  }

  // Remove connected relationships
  payload.relationships = (payload.relationships as Array<Record<string, unknown>>).filter(
    (r) => r.sourceObjectId !== objectId && r.targetObjectId !== objectId,
  );

  // Remove from parent's childObjectIds in hierarchy
  for (const h of payload.hierarchy as Array<{ childObjectIds?: string[] }>) {
    if (h.childObjectIds) {
      h.childObjectIds = h.childObjectIds.filter((id) => id !== objectId);
    }
  }

  const err = await savePayload(db, conversationId, payload);
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({ objectId, status: "deleted" });
}

// ─── Create Edge ──────────────────────────────────────────────────────────────

async function handleCreateEdge(db: DB, conversationId: string, body: Record<string, unknown>): Promise<NextResponse> {
  const sourceObjectId = body.sourceObjectId as string | undefined;
  const targetObjectId = body.targetObjectId as string | undefined;

  if (!sourceObjectId || !targetObjectId) {
    return NextResponse.json({ error: "sourceObjectId and targetObjectId are required" }, { status: 400 });
  }

  if (sourceObjectId === targetObjectId) {
    return NextResponse.json({ error: "A node cannot be connected to itself" }, { status: 400 });
  }

  const { payload, error } = await loadPayload(db, conversationId);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!payload) return NextResponse.json({ error: "No snapshot found" }, { status: 404 });

  // Verify both objects exist
  const objects = payload.objects as Array<Record<string, unknown>>;
  if (!objects.find((o) => o.objectId === sourceObjectId)) {
    return NextResponse.json({ error: "Source object not found" }, { status: 404 });
  }
  if (!objects.find((o) => o.objectId === targetObjectId)) {
    return NextResponse.json({ error: "Target object not found" }, { status: 404 });
  }

  const relationships = (payload.relationships as unknown[]) || [];
  const relationshipId = crypto.randomUUID();

  relationships.push({
    relationshipId,
    sourceObjectId,
    targetObjectId,
    type: (body.type as string) || "related_to",
    family: "semantic",
    confidence: 1.0,
    explanation: (body.explanation as string) || "User-created relationship",
    sourcePropositionIds: [],
    provenance: "USER_CREATED",
  });

  payload.relationships = relationships;

  const err = await savePayload(db, conversationId, payload);
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({ relationshipId, status: "created" }, { status: 201 });
}

// ─── Delete Edge ──────────────────────────────────────────────────────────────

async function handleDeleteEdge(db: DB, conversationId: string, body: Record<string, unknown>): Promise<NextResponse> {
  const relationshipId = body.relationshipId as string | undefined;
  if (!relationshipId) {
    return NextResponse.json({ error: "relationshipId is required" }, { status: 400 });
  }

  const { payload, error } = await loadPayload(db, conversationId);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!payload) return NextResponse.json({ error: "No snapshot found" }, { status: 404 });

  payload.relationships = (payload.relationships as Array<Record<string, unknown>>).filter(
    (r) => r.relationshipId !== relationshipId,
  );

  const err = await savePayload(db, conversationId, payload);
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({ relationshipId, status: "deleted" });
}

// ─── Edit Edge ────────────────────────────────────────────────────────────────

async function handleEditEdge(db: DB, conversationId: string, body: Record<string, unknown>): Promise<NextResponse> {
  const relationshipId = body.relationshipId as string | undefined;
  if (!relationshipId) {
    return NextResponse.json({ error: "relationshipId is required" }, { status: 400 });
  }

  const { payload, error } = await loadPayload(db, conversationId);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!payload) return NextResponse.json({ error: "No snapshot found" }, { status: 404 });

  const relationships = payload.relationships as Array<Record<string, unknown>>;
  const rel = relationships.find((r) => r.relationshipId === relationshipId);
  if (!rel) return NextResponse.json({ error: "Relationship not found" }, { status: 404 });

  if (body.type !== undefined) rel.type = body.type;
  if (body.explanation !== undefined) rel.explanation = body.explanation;

  const err = await savePayload(db, conversationId, payload);
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({ relationshipId, status: "updated" });
}
