/**
 * Chat completion — for conversational AI responses.
 */

import { complete, type CompletionMessage } from "./provider";
import { CHAT_MODEL } from "./models";

export async function generateChatResponse(
  messages: CompletionMessage[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const result = await complete({
    model: CHAT_MODEL,
    messages,
    temperature: options?.temperature ?? 0.7,
    maxTokens: options?.maxTokens ?? 512,
  });
  return result.content;
}
