/**
 * Unit tests for multimodal.ts — buildMultimodalContent.
 */
import { describe, it, expect } from "vitest";
import { buildMultimodalContent } from "../multimodal";
import type { AttachmentMeta } from "@/src/types/message";

describe("buildMultimodalContent", () => {
  const textContent = "Describe this image";

  // ─── Text-only (no attachments) ────────────────────────────────────────────

  it("returns only the text part when no attachments are provided", () => {
    const result = buildMultimodalContent(textContent, [], "openai");
    expect(result).toEqual([{ type: "text", text: textContent }]);
  });

  it("always includes the user text as the first content part", () => {
    const attachment: AttachmentMeta = {
      url: "https://storage.example.com/photo.png",
      filename: "photo.png",
      mimeType: "image/png",
      size: 1024,
    };
    const result = buildMultimodalContent(textContent, [attachment], "openai");
    expect(result[0]).toEqual({ type: "text", text: textContent });
  });

  // ─── Image attachments: OpenAI format ──────────────────────────────────────

  it("formats image attachments as image_url parts for OpenAI", () => {
    const attachment: AttachmentMeta = {
      url: "https://storage.example.com/photo.jpg",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 2048,
    };
    const result = buildMultimodalContent(textContent, [attachment], "openai");
    expect(result[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://storage.example.com/photo.jpg" },
    });
  });

  it("handles multiple image attachments for OpenAI", () => {
    const attachments: AttachmentMeta[] = [
      { url: "https://s.com/a.png", filename: "a.png", mimeType: "image/png", size: 100 },
      { url: "https://s.com/b.gif", filename: "b.gif", mimeType: "image/gif", size: 200 },
    ];
    const result = buildMultimodalContent(textContent, attachments, "openai");
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({ type: "image_url", image_url: { url: "https://s.com/a.png" } });
    expect(result[2]).toEqual({ type: "image_url", image_url: { url: "https://s.com/b.gif" } });
  });

  // ─── Image attachments: Anthropic format ───────────────────────────────────

  it("formats image attachments as image blocks for Anthropic", () => {
    const attachment: AttachmentMeta = {
      url: "https://storage.example.com/photo.webp",
      filename: "photo.webp",
      mimeType: "image/webp",
      size: 5000,
    };
    const result = buildMultimodalContent(textContent, [attachment], "anthropic");
    expect(result[1]).toEqual({
      type: "image",
      source: {
        type: "url",
        url: "https://storage.example.com/photo.webp",
        media_type: "image/webp",
      },
    });
  });

  it("uses the correct media_type from the attachment mimeType for Anthropic", () => {
    const attachment: AttachmentMeta = {
      url: "https://s.com/pic.png",
      filename: "pic.png",
      mimeType: "image/png",
      size: 1000,
    };
    const result = buildMultimodalContent(textContent, [attachment], "anthropic");
    const imagePart = result[1];
    expect(imagePart).toHaveProperty("type", "image");
    if (imagePart.type === "image") {
      expect(imagePart.source.media_type).toBe("image/png");
    }
  });

  // ─── PDF/text attachments ──────────────────────────────────────────────────

  it("formats PDF attachments as text content parts with file reference", () => {
    const attachment: AttachmentMeta = {
      url: "https://storage.example.com/doc.pdf",
      filename: "doc.pdf",
      mimeType: "application/pdf",
      size: 50000,
    };
    const result = buildMultimodalContent(textContent, [attachment], "openai");
    expect(result[1]).toEqual({
      type: "text",
      text: "[Attached file: doc.pdf] Content available at: https://storage.example.com/doc.pdf",
    });
  });

  it("formats plain text attachments as text content parts with file reference", () => {
    const attachment: AttachmentMeta = {
      url: "https://storage.example.com/notes.txt",
      filename: "notes.txt",
      mimeType: "text/plain",
      size: 500,
    };
    const result = buildMultimodalContent(textContent, [attachment], "anthropic");
    expect(result[1]).toEqual({
      type: "text",
      text: "[Attached file: notes.txt] Content available at: https://storage.example.com/notes.txt",
    });
  });

  // ─── Mixed attachments ─────────────────────────────────────────────────────

  it("handles a mix of image and non-image attachments", () => {
    const attachments: AttachmentMeta[] = [
      { url: "https://s.com/photo.jpg", filename: "photo.jpg", mimeType: "image/jpeg", size: 3000 },
      { url: "https://s.com/report.pdf", filename: "report.pdf", mimeType: "application/pdf", size: 10000 },
      { url: "https://s.com/diagram.png", filename: "diagram.png", mimeType: "image/png", size: 2000 },
    ];
    const result = buildMultimodalContent(textContent, attachments, "openai");

    expect(result).toHaveLength(4); // 1 text + 3 attachments
    expect(result[0]).toEqual({ type: "text", text: textContent });
    expect(result[1]).toEqual({ type: "image_url", image_url: { url: "https://s.com/photo.jpg" } });
    expect(result[2]).toEqual({
      type: "text",
      text: "[Attached file: report.pdf] Content available at: https://s.com/report.pdf",
    });
    expect(result[3]).toEqual({ type: "image_url", image_url: { url: "https://s.com/diagram.png" } });
  });

  it("all attachments are represented in the output", () => {
    const attachments: AttachmentMeta[] = [
      { url: "https://s.com/a.jpg", filename: "a.jpg", mimeType: "image/jpeg", size: 100 },
      { url: "https://s.com/b.pdf", filename: "b.pdf", mimeType: "application/pdf", size: 200 },
      { url: "https://s.com/c.txt", filename: "c.txt", mimeType: "text/plain", size: 300 },
      { url: "https://s.com/d.png", filename: "d.png", mimeType: "image/png", size: 400 },
      { url: "https://s.com/e.webp", filename: "e.webp", mimeType: "image/webp", size: 500 },
    ];
    const result = buildMultimodalContent(textContent, attachments, "anthropic");
    // 1 text part + 5 attachment parts = 6 total
    expect(result).toHaveLength(6);
  });
});
