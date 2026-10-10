import { NextRequest, NextResponse } from "next/server";
import {
  loadLatestConversation,
  loadConversationById,
  createConversation,
} from "@/src/lib/db/conversations";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import { mockMessages } from "@/src/data/mockMessages";
import type { ChatMessage } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import type { SemanticEdge } from "@/src/types/edge";

export type ConversationRouteResponse = {
  conversationId: string;
  messages: ChatMessage[];
  nodes: ContextNode[];
  edges: SemanticEdge[];
};

type ErrorResponse = { error: string };

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ConversationRouteResponse | ErrorResponse>> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  try {
    const { searchParams } = new URL(request.url);
    const idParam = searchParams.get("id");

    let data;

    if (idParam) {
      // Verify ownership before loading
      const access = await requireConversationAccess(idParam, session);
      if (isAuthError(access)) return access;

      data = await loadConversationById(idParam);
      if (!data) {
        return NextResponse.json(
          { error: `Conversation not found: ${idParam}` },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
      }
    } else {
      // Load the most recent conversation for this workspace
      data = await loadLatestConversation(session.workspace);

      // No conversation yet — create one (seed only for owner)
      if (!data) {
        const seedMessages = session.workspace === "owner" ? mockMessages : [];
        data = await createConversation(
          "New conversation",
          seedMessages,
          session.workspace,
        );
      }
    }

    return NextResponse.json(
      {
        conversationId: data.conversation.id,
        messages: data.messages,
        nodes: data.nodes,
        edges: data.edges,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to load conversation: ${message}` },
      { status: 500 },
    );
  }
}
