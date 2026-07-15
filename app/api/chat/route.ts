import { NextRequest, NextResponse } from "next/server";
import { generateChatResponse } from "@/src/lib/ai";
import type { ChatResponse, ChatErrorResponse } from "@/src/types/ai";

const SYSTEM_PROMPT = `You are ContextGraph Assistant — a thoughtful AI that helps users think through ideas, plans, and problems in long conversations.

Be concise and direct. When a user's question is specific, answer it specifically. When a user is exploring broadly, help them narrow down.

You are aware that users of this app can create "context nodes" from conversation excerpts to save important topics as reusable knowledge objects. This is the product they are building together.`;

const BRANCH_SYSTEM_PROMPT = `You are ContextGraph Assistant, continuing a focused discussion about a specific topic from the user's knowledge graph.

The user has selected a saved context node and is asking a follow-up question about that specific topic. Your response should be focused entirely on this topic's context — do not bring in unrelated conversation threads.

Be concise, direct, and helpful. Build on what was previously discussed in this topic.`;

type BranchContext = {
  nodeTitle: string;
  nodeSummary: string;
  evidenceSummary?: string;
  linkedMessages: Array<{ role: "user" | "assistant"; content: string }>;
};

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ChatResponse | ChatErrorResponse>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).messages)
  ) {
    return NextResponse.json(
      { error: "Request body must contain a messages array." },
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const messages = b.messages as Array<{ role: "user" | "assistant"; content: string }>;
  const branchContext = b.branchContext as BranchContext | undefined;

  if (messages.length === 0) {
    return NextResponse.json(
      { error: "messages array must not be empty." },
      { status: 400 },
    );
  }

  // Build LLM messages based on mode
  let llmMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;

  if (branchContext) {
    console.log("[chat] branchContext active:", {
      nodeTitle: branchContext.nodeTitle,
      nodeSummaryLength: branchContext.nodeSummary?.length ?? 0,
      evidenceSummaryLength: branchContext.evidenceSummary?.length ?? 0,
      linkedMessageCount: branchContext.linkedMessages?.length ?? 0,
      userMessageCount: messages.length,
    });

    const contextParts: string[] = [
      `Topic: ${branchContext.nodeTitle}`,
      `Summary: ${branchContext.nodeSummary}`,
    ];
    if (branchContext.evidenceSummary) {
      contextParts.push(`Key points:\n${branchContext.evidenceSummary}`);
    }

    const nodeContextMessage = contextParts.join("\n\n");

    llmMessages = [
      { role: "system", content: BRANCH_SYSTEM_PROMPT },
      { role: "user", content: `Here is the topic context:\n\n${nodeContextMessage}` },
      { role: "assistant", content: "I understand the context. What would you like to explore about this topic?" },
      ...branchContext.linkedMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];
  } else {
    console.log("[chat] normal mode, message count:", messages.length);
    llmMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
  }

  // Generate assistant response
  let content: string;
  try {
    content = await generateChatResponse(llmMessages);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `AI request failed: ${message}` },
      { status: 500 },
    );
  }

  // Intelligence engine no longer runs here — it runs in /api/messages
  // after the new messages are persisted, so it has access to the current turn.

  return NextResponse.json({ content }, { status: 200 });
}
