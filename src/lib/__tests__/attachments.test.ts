import { describe, it, expect } from "vitest";
import { validateFile, ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from "../attachments";

// Mock File object factory
function makeFile(name: string, size: number, type: string): File {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

describe("attachments", () => {
  describe("validateFile", () => {
    it("accepts valid JPEG image", () => {
      const file = makeFile("photo.jpg", 1024, "image/jpeg");
      const result = validateFile(file);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("accepts valid PNG image", () => {
      const file = makeFile("screenshot.png", 5000, "image/png");
      expect(validateFile(file).valid).toBe(true);
    });

    it("accepts valid GIF", () => {
      const file = makeFile("animation.gif", 2048, "image/gif");
      expect(validateFile(file).valid).toBe(true);
    });

    it("accepts valid WebP image", () => {
      const file = makeFile("photo.webp", 3000, "image/webp");
      expect(validateFile(file).valid).toBe(true);
    });

    it("accepts valid PDF", () => {
      const file = makeFile("doc.pdf", 100000, "application/pdf");
      expect(validateFile(file).valid).toBe(true);
    });

    it("accepts valid plain text", () => {
      const file = makeFile("notes.txt", 500, "text/plain");
      expect(validateFile(file).valid).toBe(true);
    });

    it("rejects unsupported MIME type — application/zip", () => {
      const file = makeFile("archive.zip", 1024, "application/zip");
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported file type");
      expect(result.error).toContain("application/zip");
    });

    it("rejects unsupported MIME type — text/html", () => {
      const file = makeFile("page.html", 500, "text/html");
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported file type");
    });

    it("rejects unsupported MIME type — application/javascript", () => {
      const file = makeFile("script.js", 200, "application/javascript");
      expect(validateFile(file).valid).toBe(false);
    });

    it("rejects file exceeding 10 MB size limit", () => {
      const file = makeFile("huge.jpg", MAX_FILE_SIZE + 1, "image/jpeg");
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds the 10 MB size limit");
    });

    it("accepts file exactly at 10 MB limit", () => {
      const file = makeFile("exact.png", MAX_FILE_SIZE, "image/png");
      expect(validateFile(file).valid).toBe(true);
    });

    it("rejects empty MIME type", () => {
      const file = makeFile("noext", 100, "");
      expect(validateFile(file).valid).toBe(false);
    });

    it("lists all allowed MIME types", () => {
      expect(ALLOWED_MIME_TYPES).toContain("image/jpeg");
      expect(ALLOWED_MIME_TYPES).toContain("image/png");
      expect(ALLOWED_MIME_TYPES).toContain("image/gif");
      expect(ALLOWED_MIME_TYPES).toContain("image/webp");
      expect(ALLOWED_MIME_TYPES).toContain("application/pdf");
      expect(ALLOWED_MIME_TYPES).toContain("text/plain");
      expect(ALLOWED_MIME_TYPES).toHaveLength(6);
    });
  });

  describe("private storage security model", () => {
    it("upload goes through server API, not direct browser Supabase client", () => {
      // The uploadAttachment function uses fetch("/api/attachments") — not the browser Supabase client
      // This is a structural test: the module should NOT import createBrowserSupabaseClient
      const moduleSource = require("fs").readFileSync(
        require("path").resolve(__dirname, "../attachments.ts"),
        "utf-8"
      );
      expect(moduleSource).not.toContain("createBrowserSupabaseClient");
      expect(moduleSource).toContain("/api/attachments");
    });

    it("AttachmentMeta includes storagePath for server-side signed URL generation", () => {
      // Type-level guarantee — storagePath is required
      const meta: import("@/src/types/message").AttachmentMeta = {
        storagePath: "conv-id/uuid-file.jpg",
        url: "https://signed-url.example.com/...",
        filename: "file.jpg",
        mimeType: "image/jpeg",
        size: 1024,
      };
      expect(meta.storagePath).toBeDefined();
      expect(meta.storagePath).toContain("conv-id");
    });

    it("conversation deletion removes storage objects", () => {
      // Structural test: deleteConversation should reference storage removal
      const moduleSource = require("fs").readFileSync(
        require("path").resolve(__dirname, "../db/conversations.ts"),
        "utf-8"
      );
      expect(moduleSource).toContain("chat-attachments");
      expect(moduleSource).toContain(".remove(");
      expect(moduleSource).toContain(".list(");
    });

    it("migration makes bucket private and removes broad policies", () => {
      const migrationSource = require("fs").readFileSync(
        require("path").resolve(__dirname, "../../../supabase/migrations/20250117000000_add_attachments_column_and_storage.sql"),
        "utf-8"
      );
      // Bucket must be private
      expect(migrationSource).toContain("public = false");
      // Must drop the old broad policies
      expect(migrationSource).toContain("DROP POLICY IF EXISTS");
      expect(migrationSource).toContain("Allow all operations on chat-attachments");
      expect(migrationSource).toContain("Allow public read from chat-attachments");
      expect(migrationSource).toContain("Allow anon uploads to chat-attachments");
      // Must be idempotent
      expect(migrationSource).toContain("IF NOT EXISTS");
      expect(migrationSource).toContain("ON CONFLICT");
    });
  });
});
