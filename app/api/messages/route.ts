import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { persistMessages } from "@/src/lib/db/messages";
import { runIntelligenceEngine } from "@/src/lib/intelligence";
import type { ChatMessage } from "@/src/types/message";

type ErrorResponse = { error: string };
type SuccessResponse = { engineRan: boolean; nodesCreated: number; nodesExtended: number };

/**
 * GET /api/messages?conversationId=<id>&messageIds=<id1,id2,...>
 * Fetch specific messages by ID for the node inspection panel.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId");
  const messageIdsParam = searchParams.get("messageIds");

  if (!conversationId || !messageIdsParam) {
    return NextResponse.json([], { status: 200 });
  }

  const messageIds = messageIdsParam.split(",").filter(Boolean);
  if (messageIds.length === 0) {
    return NextResponse.json([]);
  }

  const db = createServerSupabaseClient();
  const { data, error } = await db
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .in("id", messageIds)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json([], { status: 200 });
  }

  return NextResponse.json(data ?? []);
}

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

  const conversationId = b.conversationId as string;
  const messages = b.messages as ChatMessage[];
  const freshIds = b.freshIds === true;

  try {
    await persistMessages(conversationId, messages, { freshIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to persist messages: ${message}` },
      { status: 500 },
    );
  }

  // Run intelligence engine AFTER messages are persisted (so it sees the current turn).
  // Skip for branch messages (parentNodeId != null).
  const isBranch = messages.some((m) => m.parentNodeId);
  let engineRan = false;
  let nodesCreated = 0;
  let nodesExtended = 0;

  if (!isBranch) {
    // Extract the user + assistant pair from the just-persisted messages
    const userMsg = messages.find((m) => m.role === "user");
    const assistantMsg = messages.find((m) => m.role === "assistant");
    const newMessageIds = userMsg && assistantMsg
      ? { userMessageId: userMsg.id, assistantMessageId: assistantMsg.id }
      : undefined;

    try {
      const engineResult = await runIntelligenceEngine(conversationId, newMessageIds);
      engineRan = true;
      nodesCreated = engineResult.nodesCreated;
      nodesExtended = engineResult.nodesExtended;

      // Always log engine result for debugging
      console.log("[messages] Engine result:", {
        engineRan: true,
        nodesCreated: engineResult.nodesCreated,
        nodesExtended: engineResult.nodesExtended,
        edgesAdded: engineResult.edgesAdded,
        edgesRemoved: engineResult.edgesRemoved,
        mutationCount: engineResult.mutations.length,
        mutationTypes: engineResult.mutations.map((m) => m.type),
      });
    } catch (err) {
      console.error("[messages] Intelligence engine failed (non-fatal):", err);
    }
  }

  return NextResponse.json({ engineRan, nodesCreated, nodesExtended }, { status: 200 });
}
