/**
 * AI Provider Abstraction.
 *
 * Routes completion and embedding requests to the configured provider.
 * The rest of the application never imports provider SDKs directly.
 */

import { AI_PROVIDER, EMBEDDING_PROVIDER, EMBEDDING_MODEL } from "./models";

export type CompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string | MultimodalContentPart[];
};

/** Multimodal content parts for messages with images */
export type MultimodalContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "image"; source: { type: "url"; url: string; media_type: string } }
  | { type: "image_url"; image_url: { url: string } };

export type CompletionOptions = {
  model: string;
  messages: CompletionMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type CompletionResult = {
  content: string;
};

// ─── maxTokens Validation ────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;
const MAX_MAX_TOKENS = 16384;

/**
 * Validates the maxTokens value. Accepts integers in [1, 16384].
 * Throws with a descriptive error for invalid values.
 */
export function validateMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MaxTokensValidationError(
      `maxTokens must be an integer between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}. Received: ${String(value)}`
    );
  }
  if (value < MIN_MAX_TOKENS || value > MAX_MAX_TOKENS) {
    throw new MaxTokensValidationError(
      `maxTokens must be an integer between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}. Received: ${value}`
    );
  }
  return value;
}

export class MaxTokensValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaxTokensValidationError";
  }
}

// ─── Reasoning Provider ─────────────────────────────────────────────────────

export async function complete(options: CompletionOptions): Promise<CompletionResult> {
  // Validate maxTokens if explicitly provided
  if (options.maxTokens !== undefined) {
    validateMaxTokens(options.maxTokens);
  }

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
    messages: options.messages as Parameters<typeof client.chat.completions.create>[0]["messages"],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Provider returned empty response");
  return { content };
}

async function anthropicComplete(options: CompletionOptions): Promise<CompletionResult> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Anthropic separates system from messages
  const systemMsg = options.messages.find((m) => m.role === "system");
  const nonSystem = options.messages.filter((m) => m.role !== "system");

  const response = await client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: systemMsg?.content as string | undefined,
    messages: nonSystem.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as string,
    })),
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Provider returned non-text response");
  return { content: block.text };
}

// ─── Streaming Types ─────────────────────────────────────────────────────────

export type StreamChunk = {
  type: "token" | "done" | "error";
  content?: string;
  stopReason?: string;
  error?: string;
};

export type StreamCompletionOptions = CompletionOptions & {
  onChunk: (chunk: StreamChunk) => void;
};

// ─── Streaming Provider ─────────────────────────────────────────────────────

export async function completeStream(options: StreamCompletionOptions): Promise<void> {
  // Validate maxTokens if explicitly provided
  if (options.maxTokens !== undefined) {
    validateMaxTokens(options.maxTokens);
  }

  switch (AI_PROVIDER) {
    case "openai":
      return openaiCompleteStream(options);
    case "anthropic":
      return anthropicCompleteStream(options);
    default:
      throw new Error(`Unknown AI provider: ${AI_PROVIDER}`);
  }
}

async function openaiCompleteStream(options: StreamCompletionOptions): Promise<void> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const stream = await client.chat.completions.create({
    model: options.model,
    messages: options.messages as Parameters<typeof client.chat.completions.create>[0]["messages"],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  });

  let stopReason: string | undefined;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    const finishReason = chunk.choices[0]?.finish_reason;

    if (delta?.content) {
      options.onChunk({ type: "token", content: delta.content });
    }

    if (finishReason) {
      stopReason = finishReason;
    }
  }

  options.onChunk({ type: "done", stopReason: stopReason ?? "end_turn" });
}

async function anthropicCompleteStream(options: StreamCompletionOptions): Promise<void> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Anthropic separates system from messages
  const systemMsg = options.messages.find((m) => m.role === "system");
  const nonSystem = options.messages.filter((m) => m.role !== "system");

  const stream = client.messages.stream({
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: typeof systemMsg?.content === "string" ? systemMsg.content : undefined,
    messages: nonSystem.map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string"
        ? m.content
        : m.content.map((part) => {
            if (part.type === "text") return { type: "text" as const, text: part.text };
            if (part.type === "image") {
              return {
                type: "image" as const,
                source: part.source as
                  | { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
                  | { type: "url"; url: string },
              };
            }
            // image_url (OpenAI format) — convert to Anthropic URL source
            if (part.type === "image_url") return {
              type: "image" as const,
              source: { type: "url" as const, url: part.image_url.url },
            };
            return { type: "text" as const, text: "" };
          }),
    })),
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      options.onChunk({ type: "token", content: event.delta.text });
    }
  }

  const finalMessage = await stream.finalMessage();
  options.onChunk({ type: "done", stopReason: finalMessage.stop_reason ?? "end_turn" });
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
