import { NextRequest, NextResponse } from "next/server";
import { persistMessages } from "@/src/lib/db/messages";
import type { ChatMessage } from "@/src/types/message";

type ErrorResponse = { error: string };

export async function POST(
  request: NextRequest,
): Promise<NextResponse<Record<string, never> | ErrorResponse>> {
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

  if (
    typeof b.conversationId !== "string" ||
    !Array.isArray(b.messages) ||
    b.messages.length === 0
  ) {
    return NextResponse.json(
      { error: "Request must include conversationId and a non-empty messages array." },
      { status: 400 },
    );
  }

  try {
    await persistMessages(b.conversationId, b.messages as ChatMessage[]);
    return NextResponse.json({}, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to persist messages: ${message}` },
      { status: 500 },
    );
  }
}
