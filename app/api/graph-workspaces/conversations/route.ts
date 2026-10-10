import { NextRequest, NextResponse } from "next/server";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import {
  getGraphWorkspace,
  addConversationToGraph,
  removeConversationFromGraph,
  listGraphConversations,
} from "@/src/lib/db/graph-workspaces";

/**
 * GET /api/graph-workspaces/conversations?graphId=<id>
 * List conversations associated with a graph workspace.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const graphId = new URL(request.url).searchParams.get("graphId");
  if (!graphId) {
    return NextResponse.json({ error: "graphId is required" }, { status: 400 });
  }

  try {
    // Verify ownership
    const workspace = await getGraphWorkspace(graphId);
    if (!workspace || workspace.workspace_id !== session.workspace) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const conversations = await listGraphConversations(graphId);
    return NextResponse.json(conversations, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/graph-workspaces/conversations
 * Associate an existing conversation with a graph workspace.
 * Body: { graphId: string, conversationId: string, sourceNodeId?: string }
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

  const graphId = body.graphId as string | undefined;
  const conversationId = body.conversationId as string | undefined;
  const sourceNodeId = body.sourceNodeId as string | undefined;

  if (!graphId || !conversationId) {
    return NextResponse.json(
      { error: "graphId and conversationId are required" },
      { status: 400 },
    );
  }

  try {
    // Verify graph ownership
    const workspace = await getGraphWorkspace(graphId);
    if (!workspace || workspace.workspace_id !== session.workspace) {
      return NextResponse.json({ error: "Graph not found" }, { status: 404 });
    }

    // Verify conversation access
    const access = await requireConversationAccess(conversationId, session);
    if (isAuthError(access)) return access;

    await addConversationToGraph(graphId, conversationId, sourceNodeId);

    return NextResponse.json(
      { graphId, conversationId, status: "associated" },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/graph-workspaces/conversations
 * Remove a conversation from a graph workspace (does not delete the conversation).
 * Body: { graphId: string, conversationId: string }
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const graphId = body.graphId as string | undefined;
  const conversationId = body.conversationId as string | undefined;

  if (!graphId || !conversationId) {
    return NextResponse.json(
      { error: "graphId and conversationId are required" },
      { status: 400 },
    );
  }

  try {
    // Verify graph ownership
    const workspace = await getGraphWorkspace(graphId);
    if (!workspace || workspace.workspace_id !== session.workspace) {
      return NextResponse.json({ error: "Graph not found" }, { status: 404 });
    }

    await removeConversationFromGraph(graphId, conversationId);

    return NextResponse.json({ graphId, conversationId, status: "removed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
