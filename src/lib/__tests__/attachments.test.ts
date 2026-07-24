import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS,
  validateFile,
  uploadAttachment,
} from "../attachments";

// Mock the Supabase client
vi.mock("@/src/lib/supabase/client", () => ({
  createBrowserSupabaseClient: vi.fn(),
}));

import { createBrowserSupabaseClient } from "@/src/lib/supabase/client";

function makeFile(name: string, size: number, type: string): File {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

describe("attachments constants", () => {
  it("exports correct ALLOWED_MIME_TYPES", () => {
    expect(ALLOWED_MIME_TYPES).toEqual([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
    ]);
  });

  it("exports MAX_FILE_SIZE as 10MB", () => {
    expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
  });

  it("exports MAX_ATTACHMENTS as 5", () => {
    expect(MAX_ATTACHMENTS).toBe(5);
  });
});

describe("validateFile", () => {
  it("accepts a valid JPEG image under 10MB", () => {
    const file = makeFile("photo.jpg", 5 * 1024 * 1024, "image/jpeg");
    expect(validateFile(file)).toEqual({ valid: true });
  });

  it("accepts a valid PNG image", () => {
    const file = makeFile("screenshot.png", 1024, "image/png");
    expect(validateFile(file)).toEqual({ valid: true });
  });

  it("accepts a valid PDF file", () => {
    const file = makeFile("doc.pdf", 2 * 1024 * 1024, "application/pdf");
    expect(validateFile(file)).toEqual({ valid: true });
  });

  it("accepts a valid plain text file", () => {
    const file = makeFile("notes.txt", 512, "text/plain");
    expect(validateFile(file)).toEqual({ valid: true });
  });

  it("rejects an unsupported MIME type", () => {
    const file = makeFile("archive.zip", 1024, "application/zip");
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported file type");
    expect(result.error).toContain("application/zip");
  });

  it("rejects a file exceeding 10MB", () => {
    const file = makeFile("bigfile.png", 11 * 1024 * 1024, "image/png");
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("exceeds the 10 MB size limit");
  });

  it("accepts a file exactly at 10MB", () => {
    const file = makeFile("exact.png", 10 * 1024 * 1024, "image/png");
    expect(validateFile(file)).toEqual({ valid: true });
  });

  it("rejects file with unsupported type even if size is valid", () => {
    const file = makeFile("script.js", 100, "application/javascript");
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported file type");
  });
});

describe("uploadAttachment", () => {
  const mockUpload = vi.fn();
  const mockGetPublicUrl = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    const mockStorage = {
      from: vi.fn().mockReturnValue({
        upload: mockUpload,
        getPublicUrl: mockGetPublicUrl,
      }),
    };
    vi.mocked(createBrowserSupabaseClient).mockReturnValue({
      storage: mockStorage,
    } as any);
  });

  it("uploads file to correct path and returns metadata", async () => {
    mockUpload.mockResolvedValue({ error: null });
    mockGetPublicUrl.mockReturnValue({
      data: { publicUrl: "https://storage.example.com/chat-attachments/conv-1/uuid-photo.jpg" },
    });

    const file = makeFile("photo.jpg", 5000, "image/jpeg");
    const result = await uploadAttachment(file, "conv-1");

    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^conv-1\/[a-f0-9-]+-photo\.jpg$/),
      file,
      { contentType: "image/jpeg", upsert: false },
    );

    expect(result).toEqual({
      url: "https://storage.example.com/chat-attachments/conv-1/uuid-photo.jpg",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 5000,
    });
  });

  it("throws an error when upload fails", async () => {
    mockUpload.mockResolvedValue({
      error: { message: "Bucket not found" },
    });

    const file = makeFile("doc.pdf", 1024, "application/pdf");

    await expect(uploadAttachment(file, "conv-2")).rejects.toThrow(
      'Upload failed for "doc.pdf": Bucket not found',
    );
  });
});
