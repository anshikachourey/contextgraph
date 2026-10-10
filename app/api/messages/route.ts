import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { persistMessages } from "@/src/lib/db/messages";
import { runIntelligenceEngine } from "@/src/lib/intelligence";
import { enqueueV2Update } from "@/src/lib/intelligence-v2/incremental/update-runner";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import type { ChatMessage } from "@/src/types/message";

type ErrorResponse = { error: string };
type SuccessResponse = { engineRan: boolean; nodesCreated: number; nodesExtended: number; v2Queued: boolean };

/**
 * GET /api/messages?conversationId=<id>&messageIds=<id1,id2,...>
 * Fetch specific messages by ID for the node inspection panel.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId");
  const messageIdsParam = searchParams.get("messageIds");
  const parentNodeId = searchParams.get("parentNodeId");
  const continuationEntityId = searchParams.get("continuationEntityId");

  if (!conversationId) return NextResponse.json([], { status: 200 });

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  const db = createServerSupabaseClient();

  // Fetch by explicit IDs
  let sourceMessages: Array<Record<string, unknown>> = [];
  if (messageIdsParam) {
    const messageIds = messageIdsParam.split(",").filter(Boolean);
    if (messageIds.length > 0) {
      const { data } = await db
        .from("messages")
        .select("id, role, content, attachments, created_at, parent_node_id")
        .eq("conversation_id", conversationId)
        .in("id", messageIds)
        .order("created_at", { ascending: true });
      sourceMessages = (data ?? []) as Array<Record<string, unknown>>;
    }
  }

  // Fetch continuation messages by parentNodeId (workspace filtering)
  let continuationMessages: Array<Record<string, unknown>> = [];
  if (parentNodeId) {
    const { data } = await db
      .from("messages")
      .select("id, role, content, attachments, created_at, parent_node_id")
      .eq("conversation_id", conversationId)
      .eq("parent_node_id", parentNodeId)
      .order("created_at", { ascending: true });
    continuationMessages = (data ?? []) as Array<Record<string, unknown>>;
  }

  // ALSO: query canonical continuation_provenance for this entity
  if (continuationEntityId) {
    const { data: provRows } = await db
      .from("continuation_provenance")
      .select("message_ids")
      .eq("conversation_id", conversationId)
      .eq("origin_entity_id", continuationEntityId);

    if (provRows && provRows.length > 0) {
      const provMessageIds = provRows.flatMap((r) => (r.message_ids as string[]) ?? []);
      if (provMessageIds.length > 0) {
        const { data: provMsgs } = await db
          .from("messages")
          .select("id, role, content, attachments, created_at, parent_node_id")
          .eq("conversation_id", conversationId)
          .in("id", provMessageIds)
          .order("created_at", { ascending: true });
        if (provMsgs) continuationMessages.push(...(provMsgs as Array<Record<string, unknown>>));
      }
    }
  }

  // Merge and deduplicate by id
  const seen = new Set<string>();
  const merged: Array<Record<string, unknown>> = [];
  for (const m of [...sourceMessages, ...continuationMessages]) {
    const id = m.id as string;
    if (!seen.has(id)) { seen.add(id); merged.push(m); }
  }
  merged.sort((a, b) => (a.created_at as string).localeCompare(b.created_at as string));

  return NextResponse.json(merged);
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  if (typeof b.conversationId !== "string" || !Array.isArray(b.messages) || b.messages.length === 0) {
    return NextResponse.json({ error: "Request must include conversationId and a non-empty messages array." }, { status: 400 });
  }

  const conversationId = b.conversationId as string;

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  const messages = b.messages as ChatMessage[];
  const freshIds = b.freshIds === true;
  const v2ContinuationObjectId = typeof b.v2ContinuationObjectId === "string" ? b.v2ContinuationObjectId : null;

  // ─── Persist messages ───────────────────────────────────────────────────
  try {
    await persistMessages(conversationId, messages, { freshIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Failed to persist messages: ${message}` }, { status: 500 });
  }

  // ─── V1 Intelligence Engine (synchronous) ───────────────────────────────
  const isBranch = messages.some((m) => m.parentNodeId);
  let engineRan = false;
  let nodesCreated = 0;
  let nodesExtended = 0;

  if (!isBranch) {
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
    } catch (err) {
      console.error("[messages] V1 engine failed (non-fatal):", err);
    }
  }

  // ─── V2 Incremental Update (NON-BLOCKING, SEQUENTIAL) ──────────────────
  let v2Queued = false;
  const db = createServerSupabaseClient();
  const { data: snapCheck } = await db
    .from("v2_graph_snapshots")
    .select("status, diagnostics")
    .eq("conversation_id", conversationId)
    .single();

  // Only enqueue if: snapshot is ready AND baseline is established (cursor is valid)
  const snapDiag = (snapCheck?.diagnostics as Record<string, unknown>) ?? {};
  const needsRebuild = snapDiag.needsBaselineRebuild === true;

  if (snapCheck && snapCheck.status === "ready" && !needsRebuild) {
    enqueueV2Update({
      conversationId,
      messages,
      v2ContinuationObjectId,
      enqueuedAt: new Date().toISOString(),
    });
    v2Queued = true;
  }

  return NextResponse.json({ engineRan, nodesCreated, nodesExtended, v2Queued }, { status: 200 });
}
