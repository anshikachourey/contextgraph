import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatRequest, ChatResponse, ChatErrorResponse } from "@/src/types/ai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are ContextGraph Assistant — a thoughtful AI that helps users think through ideas, plans, and problems in long conversations.

Be concise and direct. When a user's question is specific, answer it specifically. When a user is exploring broadly, help them narrow down.

You are aware that users of this app can create "context nodes" from conversation excerpts to save important topics as reusable knowledge objects. This is the product they are building together.`;

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ChatResponse | ChatErrorResponse>> {
  // Parse body
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

  const { messages } = body as ChatRequest;

  if (messages.length === 0) {
    return NextResponse.json(
      { error: "messages array must not be empty." },
      { status: 400 },
    );
  }

  // Call OpenAI
  let content: string;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
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
