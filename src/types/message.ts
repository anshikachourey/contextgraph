export type AttachmentMeta = {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
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
