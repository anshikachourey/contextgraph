import { createBrowserSupabaseClient } from "@/src/lib/supabase/client";
import type { AttachmentMeta } from "@/src/types/message";

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
];

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const MAX_ATTACHMENTS = 5;

/**
 * Validates a file against allowed MIME types and size constraints.
 */
export function validateFile(file: File): { valid: boolean; error?: string } {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return {
      valid: false,
      error: `Unsupported file type "${file.type}". Allowed: JPEG, PNG, GIF, WebP, PDF, plain text.`,
    };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File "${file.name}" exceeds the 10 MB size limit (${(file.size / (1024 * 1024)).toFixed(1)} MB).`,
    };
  }

  return { valid: true };
}

/**
 * Uploads a file to Supabase Storage and returns attachment metadata.
 * Upload path: chat-attachments/{conversationId}/{uuid}-{filename}
 */
export async function uploadAttachment(
  file: File,
  conversationId: string,
): Promise<AttachmentMeta> {
  const supabase = createBrowserSupabaseClient();
  const uuid = crypto.randomUUID();
  // Sanitize filename: replace spaces and special chars with hyphens
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = `${conversationId}/${uuid}-${safeName}`;

  const { error, data } = await supabase.storage
    .from("chat-attachments")
    .upload(path, file, {
      contentType: file.type,
      upsert: false,
    });

  if (error) {
    console.error(`[attachments] Upload failed:`, {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      path,
      error,
    });
    throw new Error(`Upload failed for "${file.name}": ${error.message}`);
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("chat-attachments").getPublicUrl(path);

  return {
    url: publicUrl,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
  };
}
