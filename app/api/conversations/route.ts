import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  createConversation,
  updateConversationTitle,
} from "@/src/lib/db/conversations";
import type { ConversationListItem } from "@/src/lib/db/conversations";

type ErrorResponse = { error: string };

// GET /api/conversations — list all conversations
export async function GET(): Promise<
  NextResponse<ConversationListItem[] | ErrorResponse>
> {
  try {
    const conversations = await listConversations();
    return NextResponse.json(conversations);
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
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Empty body is fine — we'll use defaults
  }

  // If id + title provided, this is a title update
  if (typeof body.id === "string" && typeof body.title === "string") {
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

  // Otherwise, create a new conversation
  const title = typeof body.title === "string" ? body.title : "New conversation";

  try {
    const data = await createConversation(title);
    return NextResponse.json(
      { id: data.conversation.id, title: data.conversation.title },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to create conversation: ${message}` },
      { status: 500 },
    );
  }
}
