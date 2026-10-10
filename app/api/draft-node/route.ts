import { NextRequest, NextResponse } from "next/server";
import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { generateEmbedding } from "@/src/lib/embeddings";
import { cosineSimilarity } from "@/src/lib/cosineSimilarity";
import { DRAFT_SUPPRESS_THRESHOLD } from "@/src/lib/aiDraftConfig";
import { loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { parseJsonFromLLM, isTitleSummaryResponse } from "@/src/lib/llmJson";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import type { ChatMessage } from "@/src/types/message";

type DraftRequest = {
  conversationId: string;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
};

type DraftResponse =
  | {
      suppressed: true;
      suppressedBy: string;
      suppressionScore: number;
      bestMatchTitle: string;
      bestMatchScore: number;
    }
  | {
      suppressed: false;
      title: string;
      summary: string;
      bestMatchTitle: string | null;
      bestMatchScore: number | null;
    };

type ErrorResponse = { error: string };

/**
 * POST /api/draft-node
 *
 * Revised pipeline (suppress first, generate only if needed):
 *
 * 1. Embed the recent message window as a single text block.
 * 2. Load existing node embeddings from the database (no regeneration).
 * 3. Compare the window embedding against each existing node.
 * 4. If any node scores above DRAFT_SUPPRESS_THRESHOLD → suppress.
 *    The topic is already covered. No LLM calls. Fast + cheap.
 * 5. Only if NO existing node is similar enough → generate title + summary.
 *    The conversation has moved to genuinely new territory.
 *
 * This means the system asks "Where does this new information belong?"
 * before deciding "Should I create a new container for it?"
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<DraftResponse | ErrorResponse>> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  // ─── Parse and validate ─────────────────────────────────────────────────

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

  if (typeof b.conversationId !== "string") {
    return NextResponse.json(
      { error: "conversationId is required." },
      { status: 400 },
    );
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return NextResponse.json(
      { error: "messages array is required and must be non-empty." },
      { status: 400 },
    );
  }

  const conversationId = b.conversationId as string;

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  const messages = b.messages as ChatMessage[];

  // ─── Step 1: Embed the recent message window ────────────────────────────

  const windowText = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  let windowEmbedding: number[];
  try {
    windowEmbedding = await generateEmbedding(windowText);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Window embedding failed: ${message}` },
      { status: 500 },
    );
  }

  // ─── Step 2: Load existing node embeddings from DB ──────────────────────

  let existingNodes: Array<{
    id: string;
    title: string;
    embedding: number[] | null;
  }>;
  try {
    const loaded = await loadNodesWithEmbeddings(conversationId);
    existingNodes = loaded.map((n) => ({
      id: n.id,
      title: n.title,
      embedding: n.embedding,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to load existing nodes: ${message}` },
      { status: 500 },
    );
  }

  // ─── Step 3: Compare against existing node embeddings ───────────────────

  let bestMatchTitle: string | null = null;
  let bestMatchScore: number | null = null;

  for (const node of existingNodes) {
    if (!node.embedding || node.embedding.length === 0) continue;

    const score = cosineSimilarity(windowEmbedding, node.embedding);

    if (bestMatchScore === null || score > bestMatchScore) {
      bestMatchScore = score;
      bestMatchTitle = node.title;
    }

    if (score >= DRAFT_SUPPRESS_THRESHOLD) {
      // This conversation window is semantically close to an existing node.
      // The topic is already covered — no draft needed.
      console.log(
        `[draft-node] SUPPRESSED — window matched "${node.title}" (score: ${score.toFixed(4)}, threshold: ${DRAFT_SUPPRESS_THRESHOLD})`,
      );
      return NextResponse.json({
        suppressed: true,
        suppressedBy: node.title,
        suppressionScore: score,
        bestMatchTitle: node.title,
        bestMatchScore: score,
      });
    }
  }

  // Log the best match even when not suppressed — useful for threshold tuning
  if (bestMatchTitle !== null) {
    console.log(
      `[draft-node] NOT SUPPRESSED — best match: "${bestMatchTitle}" (score: ${bestMatchScore!.toFixed(4)}, threshold: ${DRAFT_SUPPRESS_THRESHOLD})`,
    );
  } else {
    console.log(
      `[draft-node] NOT SUPPRESSED — no existing nodes with embeddings to compare against`,
    );
  }

  // ─── Step 4: No existing node covers this — generate draft ──────────────

  const formatted = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  let title: string;
  let summary: string;

  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        {
          role: "system",
          content: `You synthesize knowledge graph nodes from conversation segments. Each node captures what was REALIZED, LEARNED, or EMOTIONALLY UNDERSTOOD.

Given a list of chat messages, return a JSON object:
- "title": the core insight or realization — max 80 chars — NOT a topic label
- "summary": what was concluded or learned — max 300 chars

Respond with raw JSON only.`,
        },
        {
          role: "user",
          content: `Here are the messages:\n\n${formatted}\n\nReturn a JSON object with "title" and "summary".`,
        },
      ],
      temperature: 0.5,
      maxTokens: 300,
    });

    const raw = result.content;
    if (!raw) {
      return NextResponse.json(
        { error: "AI returned empty response for draft generation." },
        { status: 500 },
      );
    }

    const parsed = parseJsonFromLLM(raw);
    if (!isTitleSummaryResponse(parsed)) {
      return NextResponse.json(
        { error: "Model response missing title or summary." },
        { status: 500 },
      );
    }

    title = parsed.title;
    summary = parsed.summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Draft generation failed: ${message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ suppressed: false, title, summary, bestMatchTitle, bestMatchScore });
}
