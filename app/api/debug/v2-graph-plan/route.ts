import { requireDebugAccess } from "@/src/lib/auth/debug";
import { NextRequest, NextResponse } from "next/server";
import { runV2GraphPlan } from "@/src/lib/intelligence-v2";

export const maxDuration = 120;

/**
 * GET /api/debug/v2-graph-plan?id=<conversationId>
 *
 * Shadow mode: runs the full V2 canonical pipeline.
 * Derivation: Utterance → Proposition → Thread → Object → Relationship → Hierarchy
 * Persists nothing. Returns complete derivation chain for inspection.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const debugAuthError = await requireDebugAccess();
  if (debugAuthError) return debugAuthError;

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("id");

  if (!conversationId) {
    return NextResponse.json({ error: "id query parameter is required" }, { status: 400 });
  }

  try {
    const plan = await runV2GraphPlan(conversationId);

    return NextResponse.json({
      ...plan,
      _summary: {
        utteranceCount: plan.utterances.length,
        propositionCount: plan.propositions.length,
        threadCount: plan.threads.length,
        objectCount: plan.objects.length,
        semanticRelationshipCount: plan.semanticRelationships.length,
        structuralRelationshipCount: plan.structuralRelationships.length,
        treeCount: plan.trees.length,
        unsupportedClaimCount: plan.unsupportedClaims.length,
        validationErrorCount: plan.validationResults.filter((r) => !r.valid).length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: `V2 plan failed: ${message}`, stack }, { status: 500 });
  }
}
