/**
 * Multimodal Message Formatting.
 *
 * Transforms attachment metadata into provider-specific content parts
 * for inclusion in model API requests.
 */

import type { AttachmentMeta } from "@/src/types/message";

// ─── Content Part Types ──────────────────────────────────────────────────────

export type TextContentPart = {
  type: "text";
  text: string;
};

export type OpenAIImageContentPart = {
  type: "image_url";
  image_url: { url: string };
};

export type AnthropicImageContentPart = {
  type: "image";
  source: { type: "url"; url: string; media_type: string };
};

export type ContentPart =
  | TextContentPart
  | OpenAIImageContentPart
  | AnthropicImageContentPart;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function buildImagePart(
  attachment: AttachmentMeta,
  provider: "openai" | "anthropic",
): OpenAIImageContentPart | AnthropicImageContentPart {
  if (provider === "openai") {
    return {
      type: "image_url",
      image_url: { url: attachment.url },
    };
  }

  return {
    type: "image",
    source: {
      type: "url",
      url: attachment.url,
      media_type: attachment.mimeType,
    },
  };
}

function buildFilePart(attachment: AttachmentMeta): TextContentPart {
  return {
    type: "text",
    text: `[Attached file: ${attachment.filename}] Content available at: ${attachment.url}`,
  };
}

// ─── Main Function ───────────────────────────────────────────────────────────

/**
 * Builds provider-native multimodal content parts from text and attachments.
 *
 * - The user's text is always the first content part.
 * - Image attachments become provider-specific image blocks.
 * - PDF/text attachments become text content parts referencing the URL.
 */
export function buildMultimodalContent(
  textContent: string,
  attachments: AttachmentMeta[],
  provider: "openai" | "anthropic",
): ContentPart[] {
  const parts: ContentPart[] = [];

  // Always include the user's text as the first content part
  parts.push({ type: "text", text: textContent });

  for (const attachment of attachments) {
    if (isImageMimeType(attachment.mimeType)) {
      parts.push(buildImagePart(attachment, provider));
    } else {
      parts.push(buildFilePart(attachment));
    }
  }

  return parts;
}
