/**
 * AI Model Configuration.
 *
 * All model selections are driven by environment variables.
 * No hardcoded model names outside this file.
 */

export type AIProvider = "openai" | "anthropic";
export type EmbeddingProvider = "openai" | "voyage" | "jina";

// ─── Reasoning Models ───────────────────────────────────────────────────────

export const AI_PROVIDER = (process.env.AI_PROVIDER ?? "anthropic") as AIProvider;
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "claude-sonnet-4-6";
export const NODE_MODEL = process.env.NODE_MODEL ?? "claude-sonnet-4-6";
export const EDGE_MODEL = process.env.EDGE_MODEL ?? "claude-sonnet-4-6";
export const GRAPH_SYNTHESIS_MODEL = process.env.GRAPH_SYNTHESIS_MODEL ?? "claude-sonnet-4-6";
export const STRUCTURE_MODEL = process.env.STRUCTURE_MODEL ?? "claude-sonnet-4-6";
export const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? "claude-sonnet-4-6";

// ─── Embedding Models ───────────────────────────────────────────────────────

/**
 * IMPORTANT: Changing EMBEDDING_MODEL requires re-embedding ALL existing nodes
 * because different models produce different vector dimensions:
 * - text-embedding-3-small: 1536 dimensions
 * - text-embedding-3-large: 3072 dimensions
 * Use /api/debug/reembed-nodes after switching models.
 */
export const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER ?? "openai") as EmbeddingProvider;
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-large";
