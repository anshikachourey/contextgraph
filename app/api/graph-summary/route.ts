import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
 * Answers: What were the main topics? Which were connected? What themes emerged?
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

  // Build structured input for the LLM
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
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You summarize knowledge graphs from conversations. Given a set of topic nodes and their semantic connections, write a concise summary (3–5 sentences) that answers:
- What were the main topics discussed?
- Which topics were connected and how?
- What key themes or insights emerged?
- What should the user remember?

Be direct and insightful. Write in second person ("You discussed..."). Do not list the nodes back — synthesize them into a coherent narrative.`,
        },
        {
          role: "user",
          content: `Here is the knowledge graph:\n\nTopics:\n${nodesText}\n\nConnections:\n${edgesText}\n\nSummarize this graph:`,
        },
      ],
      temperature: 0.5,
      max_tokens: 300,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) {
      return NextResponse.json(
        { error: "OpenAI returned an empty response." },
        { status: 500 },
      );
    }

    return NextResponse.json({ summary: raw.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Summary generation failed: ${message}` },
      { status: 500 },
    );
  }
}
