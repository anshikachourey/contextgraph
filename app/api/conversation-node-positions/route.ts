import { NextRequest, NextResponse } from "next/server";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import {
  getConversationNodePositions,
  saveConversationNodePositions,
} from "@/src/lib/db/graph-workspaces";

/**
 * GET /api/conversation-node-positions?conversationId=<id>
 * Load saved user-arranged node positions for a conversation's Knowledge Map.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  try {
    const positions = await getConversationNodePositions(conversationId);
    return NextResponse.json(positions, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/conversation-node-positions
 * Batch upsert user-arranged node positions for a conversation's Knowledge Map.
 * Body: { conversationId: string, positions: Array<{ nodeId: string, x: number, y: number }> }
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const conversationId = body.conversationId as string | undefined;
  const positions = body.positions as Array<{ nodeId: string; x: number; y: number }> | undefined;

  if (!conversationId || !Array.isArray(positions)) {
    return NextResponse.json(
      { error: "conversationId and positions array are required" },
      { status: 400 },
    );
  }

  // Validate position entries
  for (const p of positions) {
    if (!p.nodeId || typeof p.x !== "number" || typeof p.y !== "number") {
      return NextResponse.json(
        { error: "Each position must have nodeId (string), x (number), y (number)" },
        { status: 400 },
      );
    }
  }

  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  try {
    await saveConversationNodePositions(conversationId, positions);
    return NextResponse.json({ status: "saved", count: positions.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
