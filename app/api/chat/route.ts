import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatRequest, ChatResponse, ChatErrorResponse } from "@/src/types/ai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
    // Branch mode: scoped context from the node
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
      // Include linked messages as conversation history
      ...branchContext.linkedMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      // Include any prior branch messages + the new user message
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];
  } else {
    // Normal mode: full conversation history
    llmMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
  }

  // Call OpenAI
  let content: string;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: llmMessages,
      temperature: 0.7,
      max_tokens: 512,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) {
      return NextResponse.json(
        { error: "OpenAI returned an empty response." },
        { status: 500 },
      );
    }
    content = raw;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `OpenAI request failed: ${message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ content }, { status: 200 });
}
