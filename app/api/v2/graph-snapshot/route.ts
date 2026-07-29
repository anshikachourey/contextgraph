import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { runV2GraphPlan } from "@/src/lib/intelligence-v2";
import { triggerRecoveryOnce } from "@/src/lib/intelligence-v2/incremental/update-runner";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";

export const maxDuration = 300;

/**
 * GET /api/v2/graph-snapshot?conversationId=<id>
 * Returns the latest stored V2 snapshot status without rerunning the pipeline.
 * Reports raw generation state — the frontend decides how to present it.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  triggerRecoveryOnce();

  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

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

  // Extract attempt metadata from diagnostics
  const diag = (data.diagnostics ?? {}) as Record<string, unknown>;
  const attemptId = (diag.generationAttemptId as string) ?? null;
  const generationStartedAt = (diag.generationStartedAt as string) ?? null;

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
    // Attempt/lease fields for frontend state management
    generationAttemptId: attemptId,
    generationStartedAt,
    loadedFromSnapshot: true,
  });
}

/**
 * POST /api/v2/graph-snapshot
 *
 * ⚠️  PREVIEW-ONLY ON VERCEL: Graph generation runs inline in this serverless
 * function. It is NOT durable — if the function times out (300s max on Pro),
 * the attempt is lost. For production, generation should be delegated to a
 * durable worker on Railway. See docs/deployment-architecture.md.
 *
 * Attempt/lease model:
 * 1. Registers a new generation attempt (unique attemptId) and returns 202 immediately.
 * 2. Generation runs asynchronously (fire-and-forget from the HTTP response perspective).
 * 3. On completion, the attempt checks its ID still matches before writing — preventing
 *    a stale/old attempt from overwriting a newer retry.
 * 4. Retry calls create a new attempt that supersedes any in-progress work.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const conversationId = body.conversationId;
  if (!conversationId || typeof conversationId !== "string") {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId as string, session);
  if (isAuthError(access)) return access;

  const db = createServerSupabaseClient();

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: Validate conversation has enough messages
  // ═══════════════════════════════════════════════════════════════════════
  let baselineMessageSeq: number;

  const { data: hwmRow, error: hwmError } = await db
    .from("messages")
    .select("message_seq")
    .eq("conversation_id", conversationId)
    .order("message_seq", { ascending: false })
    .limit(1)
    .single();

  if (hwmError && hwmError.message?.includes("does not exist")) {
    const { data: countData, error: countError } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .is("parent_node_id", null)
      .order("created_at", { ascending: false })
      .limit(1);

    if (countError) {
      return NextResponse.json({ error: `Failed to count messages: ${countError.message}` }, { status: 500 });
    }

    if (!countData || countData.length === 0) {
      baselineMessageSeq = 0;
    } else {
      const { count, error: fullCountErr } = await db
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .is("parent_node_id", null);
      baselineMessageSeq = fullCountErr ? 0 : (count ?? 0);
    }
  } else if (hwmError && hwmError.code !== "PGRST116") {
    return NextResponse.json({ error: `Failed to read messages: ${hwmError.message}` }, { status: 500 });
  } else {
    baselineMessageSeq = (hwmRow?.message_seq as number) ?? 0;
  }

  if (baselineMessageSeq === 0) {
    return NextResponse.json(
      { error: "Conversation has no messages. At least 2 messages are required for graph generation." },
      { status: 422 },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Register a new generation attempt (supersedes any prior attempt)
  // ═══════════════════════════════════════════════════════════════════════
  const attemptId = crypto.randomUUID();
  const generationStartedAt = new Date().toISOString();

  const { error: upsertError } = await db
    .from("v2_graph_snapshots")
    .upsert({
      conversation_id: conversationId,
      status: "generating",
      pipeline_version: "2.0.0",
      graph_payload: null,
      diagnostics: {
        baselineMessageSeq,
        generationAttemptId: attemptId,
        generationStartedAt,
      },
      error_message: null,
      generated_at: null,
      updated_at: generationStartedAt,
    }, { onConflict: "conversation_id" });

  if (upsertError) {
    if (upsertError.code === "23503") {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  // Ensure v2_update_state row exists
  await db.from("v2_update_state").upsert({
    conversation_id: conversationId,
    last_processed_message_seq: 0,
    update_version: 0,
    update_status: "updating",
    updated_at: generationStartedAt,
  }, { onConflict: "conversation_id", ignoreDuplicates: true });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: Return 202 immediately — generation continues asynchronously
  // ═══════════════════════════════════════════════════════════════════════

  // Fire-and-forget: run generation in background
  runGenerationAttempt(conversationId, attemptId, baselineMessageSeq).catch((err) => {
    console.error(`[v2-snapshot] Background generation crashed for ${conversationId} attempt ${attemptId}:`, err);
  });

  return NextResponse.json(
    {
      status: "generating",
      conversationId,
      generationAttemptId: attemptId,
      generationStartedAt,
      baselineMessageSeq,
    },
    { status: 202 },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Background generation logic — runs after HTTP response is sent
// ═══════════════════════════════════════════════════════════════════════════

async function runGenerationAttempt(
  conversationId: string,
  attemptId: string,
  baselineMessageSeq: number,
): Promise<void> {
  const db = createServerSupabaseClient();

  try {
    const plan = await runV2GraphPlan(conversationId, { maxMessageSeq: baselineMessageSeq });

    // ─── Guard: check our attempt is still the active one ────────────────
    const isActive = await isAttemptStillActive(db, conversationId, attemptId);
    if (!isActive) {
      console.log(`[v2-snapshot] Attempt ${attemptId} superseded — discarding result.`);
      return;
    }

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
      generationAttemptId: attemptId,
      generationStartedAt: null, // Clear — generation complete
      generationCompletedAt: new Date().toISOString(),
    };

    // ─── Attempt atomic commit via RPC ───────────────────────────────────
    const { error: rpcError } = await db.rpc("v2_commit_update", {
      p_conversation_id: conversationId,
      p_new_snapshot: graphPayload,
      p_from_version: 0,
      p_to_version: 0,
      p_mutations: [],
      p_last_processed_seq: baselineMessageSeq,
      p_message_seq_from: 1,
      p_message_seq_to: baselineMessageSeq,
    });

    // Re-check attempt still active after RPC (RPC may take time)
    const stillActive = await isAttemptStillActive(db, conversationId, attemptId);
    if (!stillActive) {
      console.log(`[v2-snapshot] Attempt ${attemptId} superseded after RPC — discarding.`);
      return;
    }

    if (rpcError) {
      // Fallback to sequential writes
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
    } else {
      // RPC succeeded — update diagnostics and timestamps
      await db.from("v2_graph_snapshots").update({
        diagnostics,
        generated_at: new Date().toISOString(),
      }).eq("conversation_id", conversationId);
    }

    // Check for messages that arrived during generation
    const { data: latestRow } = await db
      .from("messages")
      .select("message_seq")
      .eq("conversation_id", conversationId)
      .order("message_seq", { ascending: false })
      .limit(1)
      .single();

    const currentMax = (latestRow?.message_seq as number) ?? baselineMessageSeq;

    if (currentMax > baselineMessageSeq) {
      await db.from("v2_update_state").upsert({
        conversation_id: conversationId,
        update_status: "queued",
        pending_since: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "conversation_id" });

      const { enqueueV2Update } = await import("@/src/lib/intelligence-v2/incremental/update-runner");
      enqueueV2Update({
        conversationId,
        messages: [],
        v2ContinuationObjectId: null,
        enqueuedAt: new Date().toISOString(),
      });
    }

    console.log(`[v2-snapshot] Attempt ${attemptId} completed successfully for ${conversationId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // Only write failure if this attempt is still active
    const isActive = await isAttemptStillActive(db, conversationId, attemptId);
    if (!isActive) {
      console.log(`[v2-snapshot] Attempt ${attemptId} superseded — not recording failure.`);
      return;
    }

    await db.from("v2_graph_snapshots").update({
      status: "failed",
      error_message: message,
      diagnostics: {
        generationAttemptId: attemptId,
        generationStartedAt: null,
        failedAt: new Date().toISOString(),
        failureReason: message,
      },
      updated_at: new Date().toISOString(),
    }).eq("conversation_id", conversationId);

    await db.from("v2_update_state").upsert({
      conversation_id: conversationId,
      update_status: "failed",
      last_update_error: message,
      update_failed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "conversation_id" });

    console.error(`[v2-snapshot] Attempt ${attemptId} failed for ${conversationId}: ${message}`);
  }
}

/**
 * Check if the given attemptId is still the active generation attempt.
 * Returns false if a newer retry has superseded it.
 */
async function isAttemptStillActive(
  db: ReturnType<typeof createServerSupabaseClient>,
  conversationId: string,
  attemptId: string,
): Promise<boolean> {
  const { data } = await db
    .from("v2_graph_snapshots")
    .select("diagnostics")
    .eq("conversation_id", conversationId)
    .single();

  if (!data) return false;
  const diag = (data.diagnostics ?? {}) as Record<string, unknown>;
  return diag.generationAttemptId === attemptId;
}
