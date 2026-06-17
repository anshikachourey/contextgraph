import { NextResponse } from "next/server";
import {
  loadLatestConversation,
  createConversation,
} from "@/src/lib/db/conversations";
import { mockMessages } from "@/src/data/mockMessages";
import type { ChatMessage } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";

export type ConversationRouteResponse = {
  conversationId: string;
  messages: ChatMessage[];
  nodes: ContextNode[];
};

type ErrorResponse = { error: string };

export async function GET(): Promise<
  NextResponse<ConversationRouteResponse | ErrorResponse>
> {
  try {
    // Try to load an existing conversation
    let data = await loadLatestConversation();

    // No conversation yet — create one and seed with mock messages
    if (!data) {
      data = await createConversation("My first conversation", mockMessages);
    }

    return NextResponse.json({
      conversationId: data.conversation.id,
      messages: data.messages,
      nodes: data.nodes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to load conversation: ${message}` },
      { status: 500 },
    );
  }
}
