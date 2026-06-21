import { NextResponse } from "next/server";
import { loadLatestConversation } from "@/src/lib/db/conversations";
import { loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { computeSuggestedEdges } from "@/src/lib/edgeSuggestions";
import type { SuggestedEdge } from "@/src/types/edge";

type SuccessResponse = {
  suggestions: SuggestedEdge[];
  nodeNames: Record<string, string>;
};
type ErrorResponse = { error: string };

/**
 * GET /api/debug/suggestions
 *
 * On-demand endpoint for the debug page. Computes suggested edges
 * with LLM explanations. Each call costs ~1 LLM call per candidate edge.
 * Not intended for production use — validation only.
 */
export async function GET(): Promise<
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
    const suggestions = await computeSuggestedEdges(nodes);

    // Build a name lookup for the frontend
    const nodeNames: Record<string, string> = {};
    for (const n of nodes) {
      nodeNames[n.id] = n.title;
    }

    return NextResponse.json({ suggestions, nodeNames });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Suggestion generation failed: ${message}` },
      { status: 500 },
    );
  }
}
