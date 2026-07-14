import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { buildUtterances } from "@/src/lib/intelligence-v2/utterances";
import { extractPropositions } from "@/src/lib/intelligence-v2/propositions";
import { formThreads } from "@/src/lib/intelligence-v2/threads";
import { formObjects } from "@/src/lib/intelligence-v2/objects";
import { generateRelationships } from "@/src/lib/intelligence-v2/relationships";
import { deriveHierarchy } from "@/src/lib/intelligence-v2/hierarchy";
import { computeGranularityDiagnostics } from "@/src/lib/intelligence-v2/granularity";
import { validateGraphPlan } from "@/src/lib/intelligence-v2/validator";
import type { V2GraphPlan, Relationship } from "@/src/lib/intelligence-v2/schemas";

export const maxDuration = 300;

/**
 * GET /api/debug/v2-trace?id=<conversationId>
 *
 * Full pipeline instrumentation. Exposes every intermediate artifact.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("id");

  if (!conversationId) {
    return NextResponse.json({ error: "id query parameter is required" }, { status: 400 });
  }

  try {
    const trace: Record<string, unknown> = {};
    const timings: Record<string, number> = {};
    const pipelineStart = Date.now();

    const db = createServerSupabaseClient();

    // ─── Messages ───────────────────────────────────────────────────────
    const { data: msgData, error: dbError } = await db
      .from("messages")
      .select("id, role, content, conversation_id, created_at, parent_node_id, branch_root_message_id")
      .eq("conversation_id", conversationId)
      .is("parent_node_id", null)
      .order("created_at", { ascending: true });

    if (dbError) return NextResponse.json({ error: `DB: ${dbError.message}` }, { status: 500 });

    const messages = (msgData ?? []) as Array<{
      id: string; role: string; content: string; conversation_id: string;
      created_at: string; parent_node_id: string | null; branch_root_message_id: string | null;
    }>;

    trace["01_messages"] = { count: messages.length };

    if (messages.length < 2) {
      trace["ABORT"] = "fewer than 2 messages";
      return NextResponse.json(trace);
    }

    // ─── Utterances ─────────────────────────────────────────────────────
    const utterances = buildUtterances(messages, conversationId);
    trace["02_utterances"] = { count: utterances.length };

    // ─── Propositions ───────────────────────────────────────────────────
    let t0 = Date.now();
    const { propositions, diagnostics: propDiag } = await extractPropositions(utterances);
    timings.propositions = Date.now() - t0;
    trace["03_propositions"] = {
      count: propositions.length,
      batchCount: propDiag.batchCount,
      rejected: propDiag.rejectedCount,
    };

    // ─── Threads ────────────────────────────────────────────────────────
    t0 = Date.now();
    const { threads, diagnostics: threadDiag } = await formThreads(utterances, propositions);
    timings.threads = Date.now() - t0;
    trace["04_threads"] = {
      count: threads.length,
      rejected: threadDiag.rejectedCount,
      items: threads.map((t) => ({ id: t.threadId, subject: t.subject, propCount: t.propositionIds.length })),
    };

    // ─── Objects ────────────────────────────────────────────────────────
    t0 = Date.now();
    const { objects, diagnostics: objDiag } = await formObjects(propositions, threads);
    timings.objects = Date.now() - t0;
    trace["05_objects"] = {
      count: objects.length,
      returnPath: objDiag.returnPath,
      totalAccepted: objDiag.totalAcceptedObjects,
      totalRejected: objDiag.totalRejectedDrafts,
      failedThreads: objDiag.failedThreads,
      threadDiagnostics: objDiag.threadDiagnostics,
    };

    // ─── Object Granularity Diagnostics ─────────────────────────────────
    const granularity = computeGranularityDiagnostics(objects);
    trace["05b_granularity"] = granularity;

    // ─── Relationships ──────────────────────────────────────────────────
    t0 = Date.now();
    const { relationships: allRelationships, diagnostics: relDiag } = await generateRelationships(objects, propositions);
    timings.relationships = Date.now() - t0;

    const childOfAccepted = allRelationships.filter((r) => r.type === "child_of");

    trace["06_relationships"] = {
      totalAccepted: relDiag.totalAccepted,
      totalRejected: relDiag.totalRejected,
      totalAbstained: relDiag.totalAbstained,
      acceptedByType: relDiag.acceptedByType,
      rejectedReasons: relDiag.rejectedReasons.slice(0, 20),
      candidates: relDiag.candidates,
      batchCount: relDiag.batchDiagnostics.length,
      batchDiagnostics: relDiag.batchDiagnostics,
      childOfCount: childOfAccepted.length,
      sampleRelationships: allRelationships.slice(0, 15).map((r) => ({
        id: r.relationshipId,
        source: r.sourceObjectId,
        target: r.targetObjectId,
        type: r.type,
        confidence: r.confidence,
      })),
    };

    // ─── Hierarchy ──────────────────────────────────────────────────────
    t0 = Date.now();
    const { hierarchy, trees, diagnostics: hierDiag } = deriveHierarchy(objects, allRelationships);
    timings.hierarchy = Date.now() - t0;

    trace["07_hierarchy"] = {
      diagnostics: hierDiag,
      hierarchyNodeCount: hierarchy.length,
      treeCount: trees.length,
      maxDepth: hierDiag.maxDepth,
      roots: hierarchy.filter((h) => h.depth === 0).length,
      nonRoots: hierarchy.filter((h) => h.depth > 0).map((h) => ({
        objectId: h.objectId,
        depth: h.depth,
        parent: h.parentObjectId,
      })),
    };

    // ─── Summary ────────────────────────────────────────────────────────
    trace["08_summary"] = {
      propositions: propositions.length,
      threads: threads.length,
      objects: objects.length,
      candidatePairs: relDiag.candidates.deduplicatedCandidatePairs,
      relationshipBatches: relDiag.batchDiagnostics.length,
      acceptedRelationships: relDiag.totalAccepted,
      acceptedByType: relDiag.acceptedByType,
      rejectedRelationships: relDiag.totalRejected,
      childOfAccepted: childOfAccepted.length,
      roots: hierDiag.rootCount,
      trees: hierDiag.treeCount,
      maxDepth: hierDiag.maxDepth,
      granularity,
      timings,
      totalRuntimeMs: Date.now() - pipelineStart,
    };

    return NextResponse.json(trace);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: `Trace failed: ${message}`, stack }, { status: 500 });
  }
}
