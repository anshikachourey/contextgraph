import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";

type ApplyRequest = {
  conversationId: string;
  nodeId: string;
  messageIds: string[];
};

type ErrorResponse = { error: string };

/**
 * POST /api/evolve-apply
 *
 * Applies an extend_node suggestion by linking messages to an existing node.
 * Only inserts node_messages links — does not modify the node itself.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<Record<string, never> | ErrorResponse>> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { conversationId, nodeId, messageIds } = body as ApplyRequest;

  if (!nodeId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return NextResponse.json(
      { error: "nodeId and non-empty messageIds are required." },
      { status: 400 },
    );
  }

  if (!conversationId) {
    return NextResponse.json(
      { error: "conversationId is required." },
      { status: 400 },
    );
  }

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  try {
    const db = createServerSupabaseClient();

    const links = messageIds.map((messageId) => ({
      node_id: nodeId,
      message_id: messageId,
    }));

    // Use upsert to avoid duplicate key errors if already linked
    const { error } = await db
      .from("node_messages")
      .upsert(links, { onConflict: "node_id,message_id", ignoreDuplicates: true });

    if (error) throw new Error(error.message);

    return NextResponse.json({}, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to apply: ${message}` },
      { status: 500 },
    );
  }
}
