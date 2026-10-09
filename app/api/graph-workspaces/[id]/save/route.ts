import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAuthError } from "@/src/lib/auth";
import { resolveRequestDbClient, useRlsScopedAccess } from "@/src/lib/db/request-client";
import {
  getGraphWorkspace,
  saveGraphWorkspacePayload,
  type GraphPayloadV1,
} from "@/src/lib/db/graph-workspaces";

/**
 * PUT /api/graph-workspaces/:id/save
 *
 * Save graph payload (nodes, edges, positions) for a specific graph workspace.
 * Triggers updated_at via database trigger.
 *
 * Body: { nodes: PersistedNode[], edges: PersistedEdge[] }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const nodes = body.nodes as unknown[] | undefined;
  const edges = body.edges as unknown[] | undefined;

  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return NextResponse.json(
      { error: "nodes and edges arrays are required" },
      { status: 400 },
    );
  }

  // Flag-aware client: service-role (behavior-neutral) while disabled,
  // user-scoped (RLS on graph_workspaces) once enabled.
  const db = await resolveRequestDbClient();

  // Verify ownership (RLS on flag-true, manual workspace_id on flag-false)
  try {
    const existing = await getGraphWorkspace(id, db);
    if (!existing || (!useRlsScopedAccess() && existing.workspace_id !== session.workspace)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const payload: GraphPayloadV1 = {
      nodes: nodes as GraphPayloadV1["nodes"],
      edges: edges as GraphPayloadV1["edges"],
    };

    await saveGraphWorkspacePayload(id, payload, db);

    return NextResponse.json({
      status: "saved",
      nodeCount: nodes.length,
      edgeCount: edges.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
