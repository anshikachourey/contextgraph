import { NextResponse } from "next/server";
import { loadLatestConversation } from "@/src/lib/db/conversations";
import { loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { persistEdges } from "@/src/lib/db/edges";
import { computeSuggestedEdges } from "@/src/lib/edgeSuggestions";
import { STRONGLY_RELATED_THRESHOLD } from "@/src/lib/similarityThresholds";

type SuccessResponse = { persisted: number; total: number };
type ErrorResponse = { error: string };

/**
 * POST /api/debug/persist-edges
 *
 * Debug-triggered edge generation.
 * 1. Computes suggested edges (with LLM explanations).
 * 2. Filters to STRONGLY_RELATED_THRESHOLD only.
 * 3. Persists to the edges table (skipping duplicates).
 *
 * Not intended for production — validation only.
 */
export async function POST(): Promise<
  NextResponse<SuccessResponse | ErrorResponse>
> {
  try {
    const data = await loadLatestConversation();
    if (!data) {
      return NextResponse.json(
        { error: "No conversation found." },
        { status: 404 },
      );
    }

    const nodes = await loadNodesWithEmbeddings(data.conversation.id);
    const allSuggestions = await computeSuggestedEdges(nodes);

    // Only persist strongly related edges
    const strongEdges = allSuggestions.filter(
      (s) => s.similarity >= STRONGLY_RELATED_THRESHOLD,
    );

    const persisted = await persistEdges(data.conversation.id, strongEdges);

    return NextResponse.json({ persisted, total: strongEdges.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Edge persistence failed: ${message}` },
      { status: 500 },
    );
  }
}
