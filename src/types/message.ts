export type AttachmentMeta = {
  /** Storage object path (e.g. "conv-id/uuid-filename.png"). Used for signed URL generation. */
  storagePath: string;
  /** Original filename for display */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Transient signed URL — generated on load, expires after a period. Not persisted to DB. */
  url: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: AttachmentMeta[] | null;
  // Timestamp from database — may not be present for optimistic messages
  createdAt?: string | null;
  // Branch fields — null for normal messages
  parentNodeId?: string | null;
  branchRootMessageId?: string | null;
};
