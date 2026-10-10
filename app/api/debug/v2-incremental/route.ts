import { requireDebugAccess } from "@/src/lib/auth/debug";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { runIncrementalV2Update } from "@/src/lib/intelligence-v2/incremental";
import type { V2Snapshot } from "@/src/lib/intelligence-v2/incremental";

export const maxDuration = 60;

/**
 * POST /api/debug/v2-incremental
 *
 * Runs the incremental engine in shadow mode.
 * Does not persist changes to production tables.
 *
 * Input: { conversationId, newMessageIds, snapshotOverride? }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const debugAuthError = await requireDebugAccess();
  if (debugAuthError) return debugAuthError;

  const body = await request.json();
  const { conversationId, newMessageIds, snapshotOverride } = body;

  if (!conversationId || !newMessageIds || !Array.isArray(newMessageIds)) {
    return NextResponse.json({ error: "conversationId and newMessageIds[] required" }, { status: 400 });
  }

  try {
    const db = createServerSupabaseClient();

    // Load snapshot (from override or DB)
    let snapshot: V2Snapshot;
    if (snapshotOverride) {
      snapshot = snapshotOverride;
    } else {
      const { data: snapData } = await db
        .from("v2_graph_snapshots")
        .select("graph_payload")
        .eq("conversation_id", conversationId)
        .eq("status", "ready")
        .single();

      if (!snapData?.graph_payload) {
        return NextResponse.json({ error: "No ready V2 snapshot found. Generate one first via POST /api/v2/graph-snapshot" }, { status: 404 });
      }

      const gp = snapData.graph_payload as Record<string, unknown>;
      snapshot = {
        conversationId,
        objects: (gp.objects as V2Snapshot["objects"]) ?? [],
        relationships: (gp.relationships as V2Snapshot["relationships"]) ?? [],
        propositions: (gp.propositions as V2Snapshot["propositions"]) ?? [],
        threads: (gp.threads as V2Snapshot["threads"]) ?? [],
        hierarchy: (gp.hierarchy as V2Snapshot["hierarchy"]) ?? [],
        trees: (gp.trees as V2Snapshot["trees"]) ?? [],
      };
    }

    // Load the new messages
    const { data: msgData, error: msgError } = await db
      .from("messages")
      .select("id, role, content, conversation_id, created_at, parent_node_id, branch_root_message_id")
      .in("id", newMessageIds)
      .order("created_at", { ascending: true });

    if (msgError) {
      return NextResponse.json({ error: msgError.message }, { status: 500 });
    }

    const newMessages = (msgData ?? []) as Array<{
      id: string; role: string; content: string; conversation_id: string;
      created_at: string; parent_node_id: string | null; branch_root_message_id: string | null;
    }>;

    if (newMessages.length === 0) {
      return NextResponse.json({ error: "No messages found for provided IDs" }, { status: 404 });
    }

    // Run incremental engine
    const result = await runIncrementalV2Update({
      conversationId,
      snapshot,
      newMessages,
    });

    // Return compact summary
    return NextResponse.json({
      diagnostics: result.diagnostics,
      decisions: result.decisions,
      acceptedMutations: result.acceptedMutations.map((m) => ({
        mutationId: m.mutationId,
        type: m.type,
        targetId: m.targetId,
        reason: m.reason,
        confidence: m.confidence,
      })),
      rejectedMutations: result.rejectedMutations.map((r) => ({
        mutationId: r.mutation.mutationId,
        type: r.mutation.type,
        reason: r.reason,
      })),
      updatedGraph: {
        objectCount: result.updatedGraph.objects.length,
        relationshipCount: result.updatedGraph.relationships.length,
        propositionCount: result.updatedGraph.propositions.length,
      },
      hierarchyChanges: result.hierarchyChanges,
      newPropositions: result.newPropositions.map((p) => ({
        id: p.propositionId,
        content: p.normalizedContent,
        author: p.authoredBy,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message, stack: err instanceof Error ? err.stack : undefined }, { status: 500 });
  }
}
