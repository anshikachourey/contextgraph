import { NextRequest, NextResponse } from "next/server";
import {
  loadLatestConversation,
  loadConversationById,
  createConversation,
} from "@/src/lib/db/conversations";
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
  try {
    const { searchParams } = new URL(request.url);
    const idParam = searchParams.get("id");

    let data;

    if (idParam) {
      // Load specific conversation by ID
      data = await loadConversationById(idParam);
      if (!data) {
        return NextResponse.json(
          { error: `Conversation not found: ${idParam}` },
          { status: 404 },
        );
      }
    } else {
      // Load the most recent conversation
      data = await loadLatestConversation();

      // No conversation yet — create one and seed with mock messages
      if (!data) {
        data = await createConversation("My first conversation", mockMessages);
      }
    }

    return NextResponse.json({
      conversationId: data.conversation.id,
      messages: data.messages,
      nodes: data.nodes,
      edges: data.edges,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to load conversation: ${message}` },
      { status: 500 },
    );
  }
}
