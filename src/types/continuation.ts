/**
 * Generic Continuation Origin — Version-agnostic.
 *
 * Represents the graph entity a user is continuing from,
 * regardless of whether it's a V1 node or V2 object.
 */

export interface ContinuationOrigin {
  sourceConversationId: string;
  sourceGraphVersion: "v1" | "v2";
  sourceEntityId: string;
  sourceEntityType: "node" | "object";
  sourceEntityTitle: string;
  sourceEntityDescription: string;
  sourceMessageIds: string[];
  activatedAt: string;
}

/**
 * Continuation provenance record — persisted with messages.
 * Answers: "Which graph entity did this exchange continue from?"
 */
export interface ContinuationProvenance {
  originEntityId: string;
  originGraphVersion: "v1" | "v2";
  originEntityType: "node" | "object";
  conversationId: string;
  messageIds: string[];
  createdAt: string;
  /** If the origin entity was later superseded, track the canonical successor */
  currentCanonicalEntityId: string | null;
}

/**
 * Build a ContinuationOrigin from a V1 node.
 */
export function buildV1Origin(
  conversationId: string,
  nodeId: string,
  nodeTitle: string,
  nodeSummary: string,
  linkedMessageIds: string[],
): ContinuationOrigin {
  return {
    sourceConversationId: conversationId,
    sourceGraphVersion: "v1",
    sourceEntityId: nodeId,
    sourceEntityType: "node",
    sourceEntityTitle: nodeTitle,
    sourceEntityDescription: nodeSummary,
    sourceMessageIds: linkedMessageIds,
    activatedAt: new Date().toISOString(),
  };
}

/**
 * Build a ContinuationOrigin from a V2 object.
 */
export function buildV2Origin(
  conversationId: string,
  objectId: string,
  objectTitle: string,
  objectDescription: string,
  sourceMessageIds: string[],
): ContinuationOrigin {
  return {
    sourceConversationId: conversationId,
    sourceGraphVersion: "v2",
    sourceEntityId: objectId,
    sourceEntityType: "object",
    sourceEntityTitle: objectTitle,
    sourceEntityDescription: objectDescription,
    sourceMessageIds,
    activatedAt: new Date().toISOString(),
  };
}
