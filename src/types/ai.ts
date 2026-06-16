// Types shared between the API route and the frontend fetch call.
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
