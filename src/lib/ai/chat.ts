/**
 * Chat completion — for conversational AI responses.
 */

import { complete, completeStream, type CompletionMessage, type StreamChunk } from "./provider";
import { CHAT_MODEL } from "./models";

export async function generateChatResponse(
  messages: CompletionMessage[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const result = await complete({
    model: CHAT_MODEL,
    messages,
    temperature: options?.temperature ?? 0.7,
    maxTokens: options?.maxTokens,
  });
  return result.content;
}

/**
 * Streaming chat response — returns a ReadableStream encoding
 * newline-delimited JSON chunks for progressive rendering.
 *
 * Wire format:
 *   {"type":"token","content":"Hello"}\n
 *   {"type":"token","content":" world"}\n
 *   {"type":"done","stopReason":"end_turn"}\n
 *
 * On error:
 *   {"type":"error","error":"Provider connection lost"}\n
 */
export function streamChatResponse(
  messages: CompletionMessage[],
  options?: { temperature?: number; maxTokens?: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      completeStream({
        model: CHAT_MODEL,
        messages,
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens,
        onChunk(chunk: StreamChunk) {
          let line: string;
          switch (chunk.type) {
            case "token":
              line = JSON.stringify({ type: "token", content: chunk.content });
              break;
            case "done":
              line = JSON.stringify({ type: "done", stopReason: chunk.stopReason });
              break;
            case "error":
              line = JSON.stringify({ type: "error", error: chunk.error });
              break;
          }
          controller.enqueue(encoder.encode(line + "\n"));

          if (chunk.type === "done" || chunk.type === "error") {
            controller.close();
          }
        },
      }).catch((err) => {
        // Handle unexpected errors from completeStream itself
        const errorLine = JSON.stringify({
          type: "error",
          error: err instanceof Error ? err.message : "Unknown streaming error",
        });
        try {
          controller.enqueue(encoder.encode(errorLine + "\n"));
          controller.close();
        } catch {
          // Stream may already be closed — nothing to do
        }
      });
    },
  });
}
