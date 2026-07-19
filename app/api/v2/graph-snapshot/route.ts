import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { runV2GraphPlan } from "@/src/lib/intelligence-v2";
import { triggerRecoveryOnce } from "@/src/lib/intelligence-v2/incremental/update-runner";

export const maxDuration = 300;

/**
 * GET /api/v2/graph-snapshot?conversationId=<id>
 * Returns the latest stored V2 snapshot without rerunning the pipeline.
 * Also triggers lazy recovery sweep (once per process).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Item 4: recovery triggered on first V2 API access
  triggerRecoveryOnce();

  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  const db = createServerSupabaseClient();
  const { data, error } = await db
    .from("v2_graph_snapshots")
    .select("*")
    .eq("conversation_id", conversationId)
    .single();

  if (error && error.code !== "PGRST116") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ status: "none", snapshotStatus: "none", updateStatus: "idle", conversationId });
  }

  const { data: updateState } = await db
    .from("v2_update_state")
    .select("update_status, update_version, last_update_error, update_failed_at")
    .eq("conversation_id", conversationId)
    .single();

  const snapshotStatus = data.status === "generating" ? "generating_initial" : data.status;
  const updateStatus = (updateState?.update_status as string) ?? "idle";

  return NextResponse.json({
    conversationId: data.conversation_id,
    snapshotStatus,
    updateStatus,
    status: data.status,
    pipelineVersion: data.pipeline_version,
    graphPayload: data.graph_payload,
    diagnostics: data.diagnostics,
    errorMessage: data.error_message,
    lastUpdateError: updateState?.last_update_error ?? null,
    updateFailedAt: updateState?.update_failed_at ?? null,
    updateVersion: updateState?.update_version ?? 0,
    generatedAt: data.generated_at,
    updatedAt: data.updated_at,
    loadedFromSnapshot: true,
  });
}

/**
 * POST /api/v2/graph-snapshot
 * Bounded baseline generation with pre-generation high-water mark.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json();
  const conversationId = body.conversationId;
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  const db = createServerSupabaseClient();

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: Capture baselineMessageSeq BEFORE generation starts
  // ═══════════════════════════════════════════════════════════════════════
  const { data: hwmRow } = await db
    .from("messages")
    .select("message_seq")
    .eq("conversation_id", conversationId)
    .order("message_seq", { ascending: false })
    .limit(1)
    .single();

  const baselineMessageSeq: number = (hwmRow?.message_seq as number) ?? 0;

  // Mark as generating
  const { error: upsertError } = await db
    .from("v2_graph_snapshots")
    .upsert({
      conversation_id: conversationId,
      status: "generating",
      pipeline_version: "2.0.0",
      graph_payload: null,
      diagnostics: { baselineMessageSeq },
      error_message: null,
      generated_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "conversation_id" });

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: Run full pipeline bounded to message_seq <= baselineMessageSeq
    // Messages arriving during generation are excluded.
    // ═══════════════════════════════════════════════════════════════════════
    const plan = await runV2GraphPlan(conversationId, { maxMessageSeq: baselineMessageSeq });

    const graphPayload = {
      objects: plan.objects.map((o) => ({
        objectId: o.objectId, objectType: o.objectType, title: o.title,
        description: o.description, propositionIds: o.propositionIds,
        threadIds: o.threadIds, supportingUtteranceIds: o.supportingUtteranceIds,
        contextualAssistantUtteranceIds: o.contextualAssistantUtteranceIds,
        maturity: o.maturity, status: o.status, provenanceSummary: o.provenanceSummary,
      })),
      relationships: [...plan.semanticRelationships, ...plan.structuralRelationships].map((r) => ({
        relationshipId: r.relationshipId, sourceObjectId: r.sourceObjectId,
        targetObjectId: r.targetObjectId, type: r.type, family: r.family,
        confidence: r.confidence, explanation: r.explanation, sourcePropositionIds: r.sourcePropositionIds,
      })),
      hierarchy: plan.derivedHierarchy,
      trees: plan.trees,
      propositions: plan.propositions.map((p) => ({
        propositionId: p.propositionId, propositionType: p.propositionType,
        normalizedContent: p.normalizedContent, sourceUtteranceIds: p.sourceUtteranceIds,
        authoredBy: p.authoredBy, provenance: p.provenance,
      })),
      threads: plan.threads.map((t) => ({ threadId: t.threadId, subject: t.subject, utteranceIds: t.utteranceIds })),
    };

    const diagnostics = {
      propositionCount: plan.propositions.length,
      threadCount: plan.threads.length,
      objectCount: plan.objects.length,
      relationshipCount: [...plan.semanticRelationships, ...plan.structuralRelationships].length,
      hierarchyNodeCount: plan.derivedHierarchy.length,
      treeCount: plan.trees.length,
      maxDepth: Math.max(0, ...plan.derivedHierarchy.map((h) => h.depth)),
      validationErrors: plan.validationResults.filter((v) => !v.valid).length,
      baselineMessageSeq,
      cursorEstablished: true,
      needsBaselineRebuild: false,
    };

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: Atomic baseline commit — snapshot + cursor together
    // Use v2_commit_update RPC to atomically establish both.
    // ═══════════════════════════════════════════════════════════════════════
    const { error: rpcError } = await db.rpc("v2_commit_update", {
      p_conversation_id: conversationId,
      p_new_snapshot: graphPayload,
      p_from_version: 0,
      p_to_version: 0, // Baseline is version 0
      p_mutations: [], // No incremental mutations for baseline
      p_last_processed_seq: baselineMessageSeq,
      p_message_seq_from: 1,
      p_message_seq_to: baselineMessageSeq,
    });

    if (rpcError) {
      // RPC not available — use sequential writes as pre-migration fallback ONLY
      // After migration, this path should not be reached.
      await db.from("v2_graph_snapshots").update({
        status: "ready",
        graph_payload: graphPayload,
        diagnostics,
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("conversation_id", conversationId);

      await db.from("v2_update_state").upsert({
        conversation_id: conversationId,
        last_processed_message_seq: baselineMessageSeq,
        update_version: 0,
        update_status: "idle",
        updated_at: new Date().toISOString(),
      }, { onConflict: "conversation_id" });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: Check if messages arrived during generation
    // ═══════════════════════════════════════════════════════════════════════
    const { data: latestRow } = await db
      .from("messages")
      .select("message_seq")
      .eq("conversation_id", conversationId)
      .order("message_seq", { ascending: false })
      .limit(1)
      .single();

    const currentMax = (latestRow?.message_seq as number) ?? baselineMessageSeq;

    if (currentMax > baselineMessageSeq) {
      // Messages arrived during generation — queue incremental processing
      await db.from("v2_update_state").upsert({
        conversation_id: conversationId,
        update_status: "queued",
        pending_since: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "conversation_id" });

      // The incremental runner will pick this up via recovery or next enqueue
      const { enqueueV2Update } = await import("@/src/lib/intelligence-v2/incremental/update-runner");
      enqueueV2Update({
        conversationId,
        messages: [], // Empty — runner reads from cursor
        v2ContinuationObjectId: null,
        enqueuedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({ status: "ready", conversationId, diagnostics, baselineMessageSeq });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await db.from("v2_graph_snapshots").update({
      status: "failed", error_message: message, updated_at: new Date().toISOString(),
    }).eq("conversation_id", conversationId);
    return NextResponse.json({ status: "failed", conversationId, error: message }, { status: 500 });
  }
}
