export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  // Branch fields — null for normal messages
  parentNodeId?: string | null;
  branchRootMessageId?: string | null;
};
