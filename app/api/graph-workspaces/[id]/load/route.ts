import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAuthError } from "@/src/lib/auth";
import {
  getGraphWorkspace,
  listGraphConversations,
} from "@/src/lib/db/graph-workspaces";

/**
 * GET /api/graph-workspaces/:id/load
 *
 * Load a graph workspace's payload and associated conversations.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const { id } = await params;

  try {
    const workspace = await getGraphWorkspace(id);
    if (!workspace || workspace.workspace_id !== session.workspace) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const conversations = await listGraphConversations(id);

    return NextResponse.json(
      {
        id: workspace.id,
        name: workspace.name,
        graph_payload: workspace.graph_payload,
        schema_version: workspace.schema_version,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
        conversations,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
