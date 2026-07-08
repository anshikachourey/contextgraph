/**
 * AI Abstraction Layer — Public API.
 *
 * Nothing outside this folder should import provider SDKs directly.
 * The rest of the application uses these domain functions.
 */

// Core provider
export { complete, embed } from "./provider";
export type { CompletionMessage, CompletionOptions, CompletionResult } from "./provider";

// Config
export { AI_PROVIDER, EMBEDDING_PROVIDER, CHAT_MODEL, NODE_MODEL, EDGE_MODEL, GRAPH_SYNTHESIS_MODEL, EMBEDDING_MODEL } from "./models";

// Domain functions — Chat
export { generateChatResponse } from "./chat";

// Domain functions — Graph
export { materializeNode, generateSemanticEdge, synthesizeLocalGraph, generateEvidenceSummary, generateGraphSummary } from "./graph";
export type { MaterializeNodeResult, SemanticEdgeResult, SynthesisResult } from "./graph";

// Domain functions — Embeddings
export { buildNodeEmbeddingText } from "./embeddings";
