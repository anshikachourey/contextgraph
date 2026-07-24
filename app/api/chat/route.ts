import { NextRequest, NextResponse } from "next/server";
import { streamChatResponse } from "@/src/lib/ai/chat";
import { validateMaxTokens, MaxTokensValidationError } from "@/src/lib/ai/provider";
import { buildMultimodalContent } from "@/src/lib/ai/multimodal";
import { AI_PROVIDER } from "@/src/lib/ai/models";
import type { ChatErrorResponse } from "@/src/types/ai";
import type { AttachmentMeta } from "@/src/types/message";

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
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." } satisfies ChatErrorResponse,
      { status: 400 },
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).messages)
  ) {
    return NextResponse.json(
      { error: "Request body must contain a messages array." } satisfies ChatErrorResponse,
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const messages = b.messages as Array<{ role: "user" | "assistant"; content: string; attachments?: AttachmentMeta[] }>;
  const branchContext = b.branchContext as BranchContext | undefined;
  const conversationId = b.conversationId as string | undefined;
  
  // Attachments can come either on the last message or as a top-level field
  const topLevelAttachments = b.attachments as AttachmentMeta[] | undefined;
  if (topLevelAttachments && topLevelAttachments.length > 0 && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg.attachments || lastMsg.attachments.length === 0) {
      lastMsg.attachments = topLevelAttachments;
    }
  }

  if (messages.length === 0) {
    return NextResponse.json(
      { error: "messages array must not be empty." } satisfies ChatErrorResponse,
      { status: 400 },
    );
  }

  // Validate maxTokens if provided
  const rawMaxTokens = b.maxTokens;
  let maxTokens: number | undefined;
  if (rawMaxTokens !== undefined) {
    try {
      maxTokens = validateMaxTokens(rawMaxTokens);
    } catch (err) {
      if (err instanceof MaxTokensValidationError) {
        return NextResponse.json(
          { error: err.message } satisfies ChatErrorResponse,
          { status: 400 },
        );
      }
      throw err;
    }
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

  // If the last user message has attachments, format them as multimodal content
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.attachments && lastMessage.attachments.length > 0) {
    const multimodalParts: Array<{ type: string; [key: string]: unknown }> = [
      { type: "text", text: lastMessage.content || "Describe this image" },
    ];

    for (const attachment of lastMessage.attachments) {
      if (attachment.mimeType.startsWith("image/")) {
        try {
          // Fetch the image and convert to base64 for Anthropic
          const imgResponse = await fetch(attachment.url);
          const arrayBuffer = await imgResponse.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString("base64");
          
          if (AI_PROVIDER === "anthropic") {
            multimodalParts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: attachment.mimeType,
                data: base64,
              },
            });
          } else {
            // OpenAI: use data URL
            multimodalParts.push({
              type: "image_url",
              image_url: { url: `data:${attachment.mimeType};base64,${base64}` },
            });
          }
        } catch (err) {
          console.warn(`[chat] Failed to fetch image for multimodal:`, err);
          multimodalParts.push({
            type: "text",
            text: `[Attached image: ${attachment.filename} — could not be loaded]`,
          });
        }
      } else {
        multimodalParts.push({
          type: "text",
          text: `[Attached file: ${attachment.filename}] Content available at: ${attachment.url}`,
        });
      }
    }

    // Update the last user message in llmMessages with multimodal content parts
    const lastLlmMessage = llmMessages[llmMessages.length - 1];
    if (lastLlmMessage && lastLlmMessage.role === "user") {
      lastLlmMessage.content = multimodalParts as any;
    }
  }

  // Generate streaming assistant response
  const sourceStream = streamChatResponse(llmMessages, { maxTokens });

  // Wrap the stream to intercept "done" chunks and log max_tokens warnings
  const wrappedStream = sourceStream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // Pass through the chunk as-is
        controller.enqueue(chunk);

        // Try to parse the chunk to check for stop_reason: "max_tokens"
        try {
          const text = new TextDecoder().decode(chunk);
          const lines = text.split("\n").filter((line) => line.trim().length > 0);
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.type === "done" && parsed.stopReason === "max_tokens") {
              console.warn(
                `[chat] Response truncated by max_tokens limit.`,
                {
                  conversationId: conversationId ?? "unknown",
                  maxTokens: maxTokens ?? 4096,
                },
              );
            }
          }
        } catch {
          // Parsing failure is non-critical — stream continues
        }
      },
    }),
  );

  return new Response(wrappedStream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
