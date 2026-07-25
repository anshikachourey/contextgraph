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
 * Client-side pre-check before uploading to server.
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
 * Uploads a file through the server-side API which handles private storage.
 * Returns attachment metadata with storage path and signed URL.
 */
export async function uploadAttachment(
  file: File,
  conversationId: string,
): Promise<AttachmentMeta> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conversationId", conversationId);

  const res = await fetch("/api/attachments", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(errBody.error ?? `Upload failed (${res.status})`);
  }

  const data = await res.json();

  return {
    storagePath: data.storagePath,
    url: data.url,
    filename: data.filename,
    mimeType: data.mimeType,
    size: data.size,
  };
}

/**
 * Fetches fresh signed URLs for attachments that have storage paths.
 * Used when loading conversations to refresh expired URLs.
 */
export async function refreshAttachmentUrls(
  attachments: AttachmentMeta[],
): Promise<AttachmentMeta[]> {
  const pathsToRefresh = attachments.filter((a) => a.storagePath).map((a) => a.storagePath);

  if (pathsToRefresh.length === 0) return attachments;

  try {
    const res = await fetch(`/api/attachments?paths=${encodeURIComponent(pathsToRefresh.join(","))}`);
    if (!res.ok) return attachments; // Graceful fallback — keep existing URLs

    const { urls } = await res.json() as { urls: Record<string, string | null> };

    return attachments.map((a) => {
      if (a.storagePath && urls[a.storagePath]) {
        return { ...a, url: urls[a.storagePath]! };
      }
      return a;
    });
  } catch {
    return attachments; // Network error — keep existing URLs
  }
}
