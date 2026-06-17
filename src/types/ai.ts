// Types shared between API routes and the frontend fetch calls.
// Keeping them in src/types ensures both sides use the same contract.

export type GenerateNodeSuggestionRequest = {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
};

export type GenerateNodeSuggestionResponse = {
  title: string;
  summary: string;
};

export type GenerateNodeSuggestionError = {
  error: string;
};

// /api/chat
export type ChatRequest = {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
};

export type ChatResponse = {
  content: string;
};

export type ChatErrorResponse = {
  error: string;
};
