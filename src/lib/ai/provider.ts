/**
 * AI Provider Abstraction.
 *
 * Routes completion and embedding requests to the configured provider.
 * The rest of the application never imports provider SDKs directly.
 */

import { AI_PROVIDER, EMBEDDING_PROVIDER, EMBEDDING_MODEL } from "./models";

export type CompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionOptions = {
  model: string;
  messages: CompletionMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type CompletionResult = {
  content: string;
};

// ─── Reasoning Provider ─────────────────────────────────────────────────────

export async function complete(options: CompletionOptions): Promise<CompletionResult> {
  switch (AI_PROVIDER) {
    case "openai":
      return openaiComplete(options);
    case "anthropic":
      return anthropicComplete(options);
    default:
      throw new Error(`Unknown AI provider: ${AI_PROVIDER}`);
  }
}

async function openaiComplete(options: CompletionOptions): Promise<CompletionResult> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const completion = await client.chat.completions.create({
    model: options.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 512,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Provider returned empty response");
  return { content };
}

async function anthropicComplete(options: CompletionOptions): Promise<CompletionResult> {
  // @ts-expect-error — Anthropic SDK is optional; install with: npm i @anthropic-ai/sdk
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Anthropic separates system from messages
  const systemMsg = options.messages.find((m) => m.role === "system");
  const nonSystem = options.messages.filter((m) => m.role !== "system");

  const response = await client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens ?? 512,
    system: systemMsg?.content,
    messages: nonSystem.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Provider returned non-text response");
  return { content: block.text };
}

// ─── Embedding Provider ─────────────────────────────────────────────────────

export async function embed(text: string): Promise<number[]> {
  switch (EMBEDDING_PROVIDER) {
    case "openai":
      return openaiEmbed(text);
    default:
      throw new Error(`Unknown embedding provider: ${EMBEDDING_PROVIDER}`);
  }
}

async function openaiEmbed(text: string): Promise<number[]> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  return response.data[0].embedding;
}
