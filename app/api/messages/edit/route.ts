import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";

type SuccessResponse = { ok: true };
type ErrorResponse = { error: string };

/**
 * POST /api/messages/edit
 *
 * Updates a message's content by ID.
 * Uses service role — no RLS dependency.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
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

  // Delete action
  if (typeof b.messageId === "string" && b.action === "delete") {
    const db = createServerSupabaseClient();
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

  const db = createServerSupabaseClient();

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
