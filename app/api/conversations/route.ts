import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  listArchivedConversations,
  createConversation,
  updateConversationTitle,
  archiveConversation,
  restoreConversation,
  deleteConversation,
} from "@/src/lib/db/conversations";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import type { ConversationListItem } from "@/src/lib/db/conversations";

type ErrorResponse = { error: string };

// GET /api/conversations — list conversations (?archived=true for archived)
export async function GET(
  request: NextRequest,
): Promise<NextResponse<ConversationListItem[] | ErrorResponse>> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  try {
    const { searchParams } = new URL(request.url);
    const showArchived = searchParams.get("archived") === "true";
    const conversations = showArchived
      ? await listArchivedConversations(session.workspace)
      : await listConversations(session.workspace);
    return NextResponse.json(conversations, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to list conversations: ${message}` },
      { status: 500 },
    );
  }
}

type CreateResponse = { id: string; title: string };

// POST /api/conversations — create a new conversation or update title
export async function POST(
  request: NextRequest,
): Promise<NextResponse<CreateResponse | ErrorResponse>> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Empty body is fine — we'll use defaults
  }

  // If id + title provided, this is a title update
  if (typeof body.id === "string" && typeof body.title === "string") {
    const access = await requireConversationAccess(body.id, session);
    if (isAuthError(access)) return access;

    try {
      await updateConversationTitle(body.id, body.title);
      return NextResponse.json({ id: body.id, title: body.title });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json(
        { error: `Failed to update title: ${message}` },
        { status: 500 },
      );
    }
  }

  // Archive action
  if (typeof body.id === "string" && body.action === "archive") {
    const access = await requireConversationAccess(body.id, session);
    if (isAuthError(access)) return access;

    try {
      await archiveConversation(body.id);
      return NextResponse.json({ id: body.id, title: "archived" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json(
        { error: `Failed to archive: ${message}` },
        { status: 500 },
      );
    }
  }

  // Restore action
  if (typeof body.id === "string" && body.action === "restore") {
    const access = await requireConversationAccess(body.id, session);
    if (isAuthError(access)) return access;

    try {
      await restoreConversation(body.id);
      return NextResponse.json({ id: body.id, title: "restored" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json(
        { error: `Failed to restore: ${message}` },
        { status: 500 },
      );
    }
  }

  // Permanent delete action
  if (typeof body.id === "string" && body.action === "delete") {
    const access = await requireConversationAccess(body.id, session);
    if (isAuthError(access)) return access;

    try {
      await deleteConversation(body.id);
      return NextResponse.json({ id: body.id, title: "deleted" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json(
        { error: `Failed to delete: ${message}` },
        { status: 500 },
      );
    }
  }

  // Otherwise, create a new conversation — assign workspace from session
  const title = typeof body.title === "string" ? body.title : "New conversation";

  try {
    const data = await createConversation(title, [], session.workspace);
    return NextResponse.json(
      { id: data.conversation.id, title: data.conversation.title },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to create conversation: ${message}` },
      { status: 500 },
    );
  }
}
