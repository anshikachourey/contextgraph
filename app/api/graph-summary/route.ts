import { NextRequest, NextResponse } from "next/server";
import { generateGraphSummary } from "@/src/lib/ai";

type SummaryRequest = {
  nodes: Array<{ title: string; summary: string }>;
  edges: Array<{ sourceTitle: string; targetTitle: string; explanation: string }>;
};

type SummaryResponse = { summary: string };
type ErrorResponse = { error: string };

/**
 * POST /api/graph-summary
 *
 * Generates a concise graph-level summary from nodes and edges.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<SummaryResponse | ErrorResponse>> {
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
  if (!Array.isArray(b.nodes) || b.nodes.length === 0) {
    return NextResponse.json(
      { error: "nodes array is required and must be non-empty." },
      { status: 400 },
    );
  }

  const { nodes, edges } = b as SummaryRequest;

  const nodesText = nodes
    .map((n) => `• ${n.title}: ${n.summary}`)
    .join("\n");

  const edgesText =
    edges.length > 0
      ? edges
          .map((e) => `• ${e.sourceTitle} ↔ ${e.targetTitle}: ${e.explanation}`)
          .join("\n")
      : "(no connections yet)";

  try {
    const summary = await generateGraphSummary(nodesText, edgesText);
    if (!summary) {
      return NextResponse.json(
        { error: "AI returned an empty response." },
        { status: 500 },
      );
    }
    return NextResponse.json({ summary: summary.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Summary generation failed: ${message}` },
      { status: 500 },
    );
  }
}
