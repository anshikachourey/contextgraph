/**
 * AI Model Configuration.
 *
 * All model selections are driven by environment variables.
 * No hardcoded model names outside this file.
 */

export type AIProvider = "openai" | "anthropic";
export type EmbeddingProvider = "openai" | "voyage" | "jina";

// ─── Reasoning Models ───────────────────────────────────────────────────────

export const AI_PROVIDER = (process.env.AI_PROVIDER ?? "openai") as AIProvider;
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "gpt-4o-mini";
export const NODE_MODEL = process.env.NODE_MODEL ?? "gpt-4o-mini";
export const EDGE_MODEL = process.env.EDGE_MODEL ?? "gpt-4o-mini";
export const GRAPH_SYNTHESIS_MODEL = process.env.GRAPH_SYNTHESIS_MODEL ?? "gpt-4o-mini";
export const STRUCTURE_MODEL = process.env.STRUCTURE_MODEL ?? "gpt-4o-mini";
export const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? "gpt-4o-mini";

// ─── Embedding Models ───────────────────────────────────────────────────────

export const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER ?? "openai") as EmbeddingProvider;
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
