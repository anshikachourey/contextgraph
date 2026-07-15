import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { runV2GraphPlan } from "@/src/lib/intelligence-v2";

export const maxDuration = 300;

/**
 * GET /api/v2/graph-snapshot?conversationId=<id>
 * Returns the latest stored V2 snapshot without rerunning the pipeline.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
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
    return NextResponse.json({ status: "none", conversationId });
  }

  return NextResponse.json({
    conversationId: data.conversation_id,
    status: data.status,
    pipelineVersion: data.pipeline_version,
    graphPayload: data.graph_payload,
    diagnostics: data.diagnostics,
    errorMessage: data.error_message,
    generatedAt: data.generated_at,
    updatedAt: data.updated_at,
    loadedFromSnapshot: true,
  });
}

/**
 * POST /api/v2/graph-snapshot
 * Generates a new V2 snapshot (or regenerates existing one).
 * Marks as generating, runs pipeline, stores result.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json();
  const conversationId = body.conversationId;
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  const db = createServerSupabaseClient();

  // Upsert as 'generating'
  const { error: upsertError } = await db
    .from("v2_graph_snapshots")
    .upsert({
      conversation_id: conversationId,
      status: "generating",
      pipeline_version: "2.0.0",
      graph_payload: null,
      diagnostics: null,
      error_message: null,
      generated_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "conversation_id" });

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  try {
    const plan = await runV2GraphPlan(conversationId);

    // Build the payload for persistence (strip raw utterance content to save space)
    const graphPayload = {
      objects: plan.objects.map((o) => ({
        objectId: o.objectId,
        objectType: o.objectType,
        title: o.title,
        description: o.description,
        propositionIds: o.propositionIds,
        threadIds: o.threadIds,
        supportingUtteranceIds: o.supportingUtteranceIds,
        contextualAssistantUtteranceIds: o.contextualAssistantUtteranceIds,
        maturity: o.maturity,
        status: o.status,
        provenanceSummary: o.provenanceSummary,
      })),
      relationships: [...plan.semanticRelationships, ...plan.structuralRelationships].map((r) => ({
        relationshipId: r.relationshipId,
        sourceObjectId: r.sourceObjectId,
        targetObjectId: r.targetObjectId,
        type: r.type,
        family: r.family,
        confidence: r.confidence,
        explanation: r.explanation,
        sourcePropositionIds: r.sourcePropositionIds,
      })),
      hierarchy: plan.derivedHierarchy,
      trees: plan.trees,
      propositions: plan.propositions.map((p) => ({
        propositionId: p.propositionId,
        propositionType: p.propositionType,
        normalizedContent: p.normalizedContent,
        sourceUtteranceIds: p.sourceUtteranceIds,
        authoredBy: p.authoredBy,
        provenance: p.provenance,
      })),
      threads: plan.threads.map((t) => ({
        threadId: t.threadId,
        subject: t.subject,
        utteranceIds: t.utteranceIds,
      })),
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
      layerDiagnostics: plan._diagnostics,
    };

    await db
      .from("v2_graph_snapshots")
      .update({
        status: "ready",
        graph_payload: graphPayload,
        diagnostics,
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", conversationId);

    return NextResponse.json({
      status: "ready",
      conversationId,
      diagnostics,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    await db
      .from("v2_graph_snapshots")
      .update({
        status: "failed",
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", conversationId);

    return NextResponse.json({
      status: "failed",
      conversationId,
      error: message,
    }, { status: 500 });
  }
}
