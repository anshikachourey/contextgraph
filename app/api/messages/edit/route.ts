import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";

type SuccessResponse = { ok: true };
type ErrorResponse = { error: string };

/**
 * POST /api/messages/edit
 *
 * Updates a message's content by ID.
 * Enforces workspace ownership via the message's conversation.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
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

  const b = body as Record<string, unknown>;
  const db = createServerSupabaseClient();

  // Look up the message's conversation for access check
  const messageId = b.messageId as string;
  if (typeof messageId !== "string") {
    return NextResponse.json(
      { error: "Request must include messageId (string)." },
      { status: 400 },
    );
  }

  const { data: msgRow } = await db
    .from("messages")
    .select("conversation_id")
    .eq("id", messageId)
    .single();

  if (!msgRow) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const access = await requireConversationAccess(msgRow.conversation_id, session);
  if (isAuthError(access)) return access;

  // Delete action
  if (typeof b.messageId === "string" && b.action === "delete") {
    const { error } = await db.from("messages").delete().eq("id", b.messageId);
    if (error) {
      return NextResponse.json(
        { error: `Failed to delete message: ${error.message}` },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (typeof b.messageId !== "string" || typeof b.content !== "string") {
    return NextResponse.json(
      { error: "Request must include messageId (string) and content (string)." },
      { status: 400 },
    );
  }

  const content = (b.content as string).trim();
  if (!content) {
    return NextResponse.json(
      { error: "Content must not be empty." },
      { status: 400 },
    );
  }

  const { error } = await db
    .from("messages")
    .update({ content })
    .eq("id", b.messageId);

  if (error) {
    return NextResponse.json(
      { error: `Failed to update message: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
