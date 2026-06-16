import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type {
  GenerateNodeSuggestionRequest,
  GenerateNodeSuggestionResponse,
  GenerateNodeSuggestionError,
} from "@/src/types/ai";

// Initialised once per cold start — Next.js caches module-level values.
// The key is read server-side only and never reaches the client bundle.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are a helpful assistant that analyzes conversation excerpts and produces structured metadata.

Given a list of chat messages, return a JSON object with exactly two fields:
- "title": a concise label for the topic, max 60 characters
- "summary": a brief description of what the messages discuss, max 200 characters

Respond with raw JSON only — no markdown, no code fences, no explanation.
Example response: {"title":"Core Problem","summary":"Discussion about long AI chats losing context over time."}`;

function buildUserPrompt(
  messages: GenerateNodeSuggestionRequest["messages"],
): string {
  const formatted = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  return `Here are the selected messages:\n\n${formatted}\n\nReturn a JSON object with "title" and "summary".`;
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<GenerateNodeSuggestionResponse | GenerateNodeSuggestionError>> {
  // --- Parse and validate the request body ---
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

  const { messages } = body as GenerateNodeSuggestionRequest;

  if (messages.length === 0) {
    return NextResponse.json(
      { error: "messages array must not be empty." },
      { status: 400 },
    );
  }

  // --- Call OpenAI ---
  let rawContent: string | null;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(messages) },
      ],
      temperature: 0.4,
      max_tokens: 150,
    });

    rawContent = completion.choices[0]?.message?.content ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `OpenAI request failed: ${message}` },
      { status: 500 },
    );
  }

  if (!rawContent) {
    return NextResponse.json(
      { error: "OpenAI returned an empty response." },
      { status: 500 },
    );
  }

  // --- Parse and validate the model response ---
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return NextResponse.json(
      { error: "Model response could not be parsed as JSON." },
      { status: 500 },
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).title !== "string" ||
    typeof (parsed as Record<string, unknown>).summary !== "string"
  ) {
    return NextResponse.json(
      { error: "Model response is missing required title or summary fields." },
      { status: 500 },
    );
  }

  const { title, summary } = parsed as GenerateNodeSuggestionResponse;

  return NextResponse.json({ title, summary }, { status: 200 });
}
