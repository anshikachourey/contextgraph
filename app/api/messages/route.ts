import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { persistMessages } from "@/src/lib/db/messages";
import { runIntelligenceEngine } from "@/src/lib/intelligence";
import { runIncrementalV2Update } from "@/src/lib/intelligence-v2/incremental";
import type { V2Snapshot } from "@/src/lib/intelligence-v2/incremental";
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

  // ─── V2 Incremental Analysis ──────────────────────────────────────────────
  // After V1 engine, also run V2 incremental analysis if a snapshot exists
  let v2Updated = false;
  const v2ContinuationObjectId = typeof b.v2ContinuationObjectId === "string" ? b.v2ContinuationObjectId : null;

  try {
    const db2 = createServerSupabaseClient();
    const { data: snapRow } = await db2
      .from("v2_graph_snapshots")
      .select("graph_payload, diagnostics")
      .eq("conversation_id", conversationId)
      .eq("status", "ready")
      .single();

    if (snapRow?.graph_payload) {
      const gp = snapRow.graph_payload as Record<string, unknown>;
      const snapshot: V2Snapshot = {
        conversationId,
        objects: (gp.objects as V2Snapshot["objects"]) ?? [],
        relationships: (gp.relationships as V2Snapshot["relationships"]) ?? [],
        propositions: (gp.propositions as V2Snapshot["propositions"]) ?? [],
        threads: ((gp.threads as Array<Record<string, unknown>>) ?? []).map((t) => ({
          threadId: (t.threadId as string) ?? "",
          utteranceIds: (t.utteranceIds as string[]) ?? [],
          propositionIds: (t.propositionIds as string[]) ?? [],
          subject: (t.subject as string) ?? "",
          branchId: null,
          originThreadId: null,
          divergenceUtteranceId: null,
          status: "active" as const,
        })),
        hierarchy: (gp.hierarchy as V2Snapshot["hierarchy"]) ?? [],
        trees: (gp.trees as V2Snapshot["trees"]) ?? [],
      };

      // Build new message rows for the incremental engine
      const newMsgRows = messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        conversation_id: conversationId,
        created_at: new Date().toISOString(),
        parent_node_id: m.parentNodeId ?? null,
        branch_root_message_id: m.branchRootMessageId ?? null,
      }));

      const incrementalResult = await runIncrementalV2Update({
        conversationId,
        snapshot,
        newMessages: newMsgRows,
      });

      // If mutations were accepted, update the snapshot
      if (incrementalResult.acceptedMutations.length > 0) {
        const updatedPayload = {
          objects: incrementalResult.updatedGraph.objects,
          relationships: incrementalResult.updatedGraph.relationships,
          propositions: incrementalResult.updatedGraph.propositions,
          threads: incrementalResult.updatedGraph.threads,
          hierarchy: incrementalResult.updatedGraph.hierarchy,
          trees: incrementalResult.updatedGraph.trees,
        };

        // Append continuation provenance if present
        const existingDiag = (snapRow.diagnostics as Record<string, unknown>) ?? {};
        if (v2ContinuationObjectId) {
          // Persist to canonical continuation_provenance table
          try {
            await db2.from("continuation_provenance").insert({
              conversation_id: conversationId,
              origin_entity_id: v2ContinuationObjectId,
              origin_graph_version: "v2",
              origin_entity_type: "object",
              message_ids: messages.map((m) => m.id),
            });
          } catch { /* table may not exist yet */ }
        }

        await db2
          .from("v2_graph_snapshots")
          .update({
            graph_payload: updatedPayload,
            diagnostics: {
              ...existingDiag,
              lastIncrementalUpdate: new Date().toISOString(),
              lastIncrementalMutations: incrementalResult.acceptedMutations.length,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("conversation_id", conversationId);

        v2Updated = true;
        console.log("[messages] V2 incremental update:", {
          mutations: incrementalResult.acceptedMutations.length,
          decisions: Object.keys(incrementalResult.diagnostics.primaryDecisionsByType),
          objectsCreated: incrementalResult.diagnostics.objectsCreated,
          objectsUpdated: incrementalResult.diagnostics.objectsUpdated,
          v2ContinuationObjectId,
          runtimeMs: incrementalResult.diagnostics.runtimeMs,
        });
      } else {
        // Still record continuation provenance even with no mutations
        if (v2ContinuationObjectId) {
          // Persist to canonical continuation_provenance table
          try {
            await db2.from("continuation_provenance").insert({
              conversation_id: conversationId,
              origin_entity_id: v2ContinuationObjectId,
              origin_graph_version: "v2",
              origin_entity_type: "object",
              message_ids: messages.map((m) => m.id),
            });
          } catch {
            // Table may not exist yet — fall back to snapshot diagnostics
            const existingDiag = (snapRow.diagnostics as Record<string, unknown>) ?? {};
            const continuationHistory = (existingDiag.continuationHistory as Array<unknown>) ?? [];
            continuationHistory.push({
              sourceObjectId: v2ContinuationObjectId,
              messageIds: messages.map((m) => m.id),
              timestamp: new Date().toISOString(),
            });
            await db2
              .from("v2_graph_snapshots")
              .update({ diagnostics: { ...existingDiag, continuationHistory }, updated_at: new Date().toISOString() })
              .eq("conversation_id", conversationId);
          }
        }
        console.log("[messages] V2 incremental: no mutations needed");
      }
    }
  } catch (err) {
    console.error("[messages] V2 incremental analysis failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ engineRan, nodesCreated, nodesExtended, v2Updated }, { status: 200 });
}
