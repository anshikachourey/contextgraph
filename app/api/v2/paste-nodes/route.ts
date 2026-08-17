import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";

/**
 * POST /api/v2/paste-nodes
 *
 * Pastes copied nodes and edges into a target conversation's V2 Knowledge Map.
 * Creates new IDs for all objects. Preserves provenance lineage.
 * Cross-workspace access is prevented server-side.
 *
 * Body:
 * {
 *   conversationId: string,
 *   nodes: Array<{ newObjectId, title, description, objectType, provenance }>,
 *   edges: Array<{ newRelationshipId, sourceObjectId, targetObjectId, type, explanation, provenance }>
 * }
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

  const conversationId = body.conversationId as string | undefined;
  const nodes = body.nodes as Array<Record<string, unknown>> | undefined;
  const edges = body.edges as Array<Record<string, unknown>> | undefined;

  if (!conversationId || !nodes || !Array.isArray(nodes) || nodes.length === 0) {
    return NextResponse.json(
      { error: "conversationId and non-empty nodes array are required" },
      { status: 400 },
    );
  }

  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  const db = createServerSupabaseClient();

  // Load or create snapshot
  const { data: existing, error: fetchError } = await db
    .from("v2_graph_snapshots")
    .select("graph_payload, status")
    .eq("conversation_id", conversationId)
    .single();

  if (fetchError && fetchError.code !== "PGRST116") {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const now = new Date().toISOString();
  let payload: Record<string, unknown>;

  if (existing && existing.graph_payload) {
    payload = existing.graph_payload as Record<string, unknown>;
  } else {
    // Create empty snapshot
    payload = {
      objects: [],
      relationships: [],
      hierarchy: [],
      trees: [],
      propositions: [],
      threads: [],
    };
  }

  const objects = (payload.objects as unknown[]) || [];
  const relationships = (payload.relationships as unknown[]) || [];
  const hierarchy = (payload.hierarchy as unknown[]) || [];
  const trees = (payload.trees as Array<{ treeId: string; rootObjectId: string; objectIds: string[] }>) || [];

  // Add pasted nodes
  for (const node of nodes) {
    const objectId = node.newObjectId as string;
    const provenance = node.provenance as Record<string, string> | undefined;

    objects.push({
      objectId,
      objectType: (node.objectType as string) || "manual_node",
      title: node.title as string,
      description: (node.description as string) || "",
      propositionIds: [],
      threadIds: [],
      supportingUtteranceIds: [],
      contextualAssistantUtteranceIds: [],
      maturity: "established",
      status: "active",
      provenanceSummary: `PASTED_COPY (from ${provenance?.copiedFrom ?? "unknown"})`,
    });

    // Add as a root in hierarchy
    const treeId = `tree-paste-${objectId.slice(0, 8)}`;
    hierarchy.push({
      objectId,
      depth: 0,
      parentObjectId: null,
      childObjectIds: [],
      treeId,
    });
    trees.push({ treeId, rootObjectId: objectId, objectIds: [objectId] });
  }

  // Add pasted edges (only those whose both endpoints now exist in the snapshot)
  const allObjectIds = new Set((objects as Array<{ objectId: string }>).map((o) => o.objectId));
  for (const edge of (edges || [])) {
    const sourceId = edge.sourceObjectId as string;
    const targetId = edge.targetObjectId as string;

    // Only add if both endpoints exist (safety check)
    if (allObjectIds.has(sourceId) && allObjectIds.has(targetId)) {
      const provenance = edge.provenance as Record<string, string> | undefined;
      relationships.push({
        relationshipId: edge.newRelationshipId as string,
        sourceObjectId: sourceId,
        targetObjectId: targetId,
        type: (edge.type as string) || "related_to",
        family: "semantic",
        confidence: 1.0,
        explanation: (edge.explanation as string) || "Pasted relationship",
        sourcePropositionIds: [],
        provenance: `PASTED_COPY (from ${provenance?.copiedFrom ?? "unknown"})`,
      });
    }
  }

  payload.objects = objects;
  payload.relationships = relationships;
  payload.hierarchy = hierarchy;
  payload.trees = trees;

  // Save
  if (existing) {
    const { error: updateError } = await db
      .from("v2_graph_snapshots")
      .update({ graph_payload: payload, updated_at: now })
      .eq("conversation_id", conversationId);
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  } else {
    const { error: insertError } = await db
      .from("v2_graph_snapshots")
      .upsert({
        conversation_id: conversationId,
        status: "ready",
        pipeline_version: "2.0.0-manual",
        graph_payload: payload,
        diagnostics: { objectCount: nodes.length, relationshipCount: (edges || []).length, treeCount: nodes.length, maxDepth: 0 },
        generated_at: now,
        updated_at: now,
      }, { onConflict: "conversation_id" });
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({
    status: "pasted",
    nodeCount: nodes.length,
    edgeCount: (edges || []).length,
  }, { status: 201 });
}
