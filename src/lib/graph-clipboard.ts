/**
 * ContextGraph internal clipboard for cross-graph node/edge copy-paste.
 *
 * Design rules:
 * - Pasting creates new object IDs (never reuses/impersonates originals).
 * - Internal edges are preserved only when both endpoints are in the selection.
 * - Dangling edges (one endpoint outside selection) are omitted.
 * - Source lineage and provenance are retained as metadata.
 * - Relative positions are preserved; paste places near viewport center.
 * - Pasted nodes are independent USER_CREATED copies, not SIE semantic truth.
 * - Cross-graph copies do NOT become valid "Continue from node" origins
 *   unless the continuation contract explicitly supports them.
 * - Cross-workspace access is prevented by the paste API (server-side check).
 */

// ---------------------------------------------------------------------------
// Clipboard data types
// ---------------------------------------------------------------------------

export type ClipboardNode = {
  /** Original object ID (for provenance tracking, NOT reused on paste) */
  sourceObjectId: string;
  /** Source conversation ID */
  sourceConversationId: string;
  title: string;
  description: string;
  objectType: string;
  provenanceSummary: string;
  /** Relative position from selection centroid */
  relativeX: number;
  relativeY: number;
  /** Original supporting utterance IDs (informational lineage, not functional) */
  sourceUtteranceIds: string[];
};

export type ClipboardEdge = {
  /** Original relationship ID (for provenance, NOT reused on paste) */
  sourceRelationshipId: string;
  /** References sourceObjectId of the source node in the clipboard */
  sourceNodeOriginalId: string;
  /** References sourceObjectId of the target node in the clipboard */
  targetNodeOriginalId: string;
  type: string;
  explanation: string;
};

export type GraphClipboardData = {
  version: 1;
  /** Timestamp of when the copy was made */
  copiedAt: string;
  /** Workspace of the source (for cross-workspace prevention) */
  sourceWorkspace: string;
  nodes: ClipboardNode[];
  edges: ClipboardEdge[];
};

// ---------------------------------------------------------------------------
// In-memory clipboard store (survives across page navigations in the SPA)
// ---------------------------------------------------------------------------

let _clipboard: GraphClipboardData | null = null;

export function getGraphClipboard(): GraphClipboardData | null {
  return _clipboard;
}

export function setGraphClipboard(data: GraphClipboardData): void {
  _clipboard = data;
}

export function clearGraphClipboard(): void {
  _clipboard = null;
}

export function hasClipboardContent(): boolean {
  return _clipboard !== null && _clipboard.nodes.length > 0;
}

// ---------------------------------------------------------------------------
// Copy helper: builds clipboard data from a selection
// ---------------------------------------------------------------------------

export type CopyableNode = {
  objectId: string;
  title: string;
  description: string;
  objectType: string;
  provenanceSummary: string;
  supportingUtteranceIds?: string[];
  /** Position in the graph canvas (optional, for relative positioning) */
  x?: number;
  y?: number;
};

export type CopyableEdge = {
  relationshipId: string;
  sourceObjectId: string;
  targetObjectId: string;
  type: string;
  explanation: string;
};

export function copyNodesToClipboard(
  nodes: CopyableNode[],
  allEdges: CopyableEdge[],
  sourceConversationId: string,
  sourceWorkspace: string,
): GraphClipboardData {
  if (nodes.length === 0) {
    throw new Error("Cannot copy empty selection");
  }

  const selectedIds = new Set(nodes.map((n) => n.objectId));

  // Compute centroid for relative positioning
  const nodesWithPos = nodes.filter((n) => n.x !== undefined && n.y !== undefined);
  let centroidX = 0;
  let centroidY = 0;
  if (nodesWithPos.length > 0) {
    centroidX = nodesWithPos.reduce((sum, n) => sum + (n.x ?? 0), 0) / nodesWithPos.length;
    centroidY = nodesWithPos.reduce((sum, n) => sum + (n.y ?? 0), 0) / nodesWithPos.length;
  }

  // Build clipboard nodes with relative positions
  const clipboardNodes: ClipboardNode[] = nodes.map((n) => ({
    sourceObjectId: n.objectId,
    sourceConversationId,
    title: n.title,
    description: n.description,
    objectType: n.objectType,
    provenanceSummary: n.provenanceSummary,
    relativeX: (n.x ?? 0) - centroidX,
    relativeY: (n.y ?? 0) - centroidY,
    sourceUtteranceIds: n.supportingUtteranceIds ?? [],
  }));

  // Only include edges where BOTH endpoints are in the selection
  const clipboardEdges: ClipboardEdge[] = allEdges
    .filter((e) => selectedIds.has(e.sourceObjectId) && selectedIds.has(e.targetObjectId))
    .map((e) => ({
      sourceRelationshipId: e.relationshipId,
      sourceNodeOriginalId: e.sourceObjectId,
      targetNodeOriginalId: e.targetObjectId,
      type: e.type,
      explanation: e.explanation,
    }));

  const data: GraphClipboardData = {
    version: 1,
    copiedAt: new Date().toISOString(),
    sourceWorkspace,
    nodes: clipboardNodes,
    edges: clipboardEdges,
  };

  setGraphClipboard(data);
  return data;
}

// ---------------------------------------------------------------------------
// Paste helper: generates new IDs and positions for the target graph
// ---------------------------------------------------------------------------

export type PastedNode = {
  newObjectId: string;
  title: string;
  description: string;
  objectType: string;
  /** Absolute position in the target graph */
  x: number;
  y: number;
  /** Provenance metadata */
  provenance: {
    copiedFrom: string; // original objectId
    copiedFromConversation: string;
    copiedAt: string;
    originalProvenance: string;
  };
  sourceUtteranceIds: string[];
};

export type PastedEdge = {
  newRelationshipId: string;
  sourceObjectId: string; // new ID of source
  targetObjectId: string; // new ID of target
  type: string;
  explanation: string;
  provenance: {
    copiedFrom: string; // original relationshipId
    copiedAt: string;
  };
};

export type PasteResult = {
  nodes: PastedNode[];
  edges: PastedEdge[];
};

/**
 * Prepare paste data from the clipboard for a target location.
 *
 * @param viewportCenterX - X center of the current viewport in the target graph
 * @param viewportCenterY - Y center of the current viewport in the target graph
 * @param targetWorkspace - The workspace of the target graph (for access check)
 * @returns PasteResult with new IDs, or null if clipboard is empty or cross-workspace
 */
export function preparePaste(
  viewportCenterX: number,
  viewportCenterY: number,
  targetWorkspace: string,
): PasteResult | null {
  const clipboard = getGraphClipboard();
  if (!clipboard || clipboard.nodes.length === 0) return null;

  // Prevent cross-workspace paste
  if (clipboard.sourceWorkspace !== targetWorkspace) {
    return null;
  }

  // Generate new IDs and map old→new
  const idMap = new Map<string, string>();
  for (const node of clipboard.nodes) {
    idMap.set(node.sourceObjectId, crypto.randomUUID());
  }

  // Build pasted nodes with new IDs and absolute positions
  const pastedNodes: PastedNode[] = clipboard.nodes.map((n) => ({
    newObjectId: idMap.get(n.sourceObjectId)!,
    title: n.title,
    description: n.description,
    objectType: n.objectType,
    x: viewportCenterX + n.relativeX,
    y: viewportCenterY + n.relativeY,
    provenance: {
      copiedFrom: n.sourceObjectId,
      copiedFromConversation: n.sourceConversationId,
      copiedAt: clipboard.copiedAt,
      originalProvenance: n.provenanceSummary,
    },
    sourceUtteranceIds: n.sourceUtteranceIds,
  }));

  // Build pasted edges — only those whose both endpoints have new IDs
  const pastedEdges: PastedEdge[] = clipboard.edges
    .filter((e) => idMap.has(e.sourceNodeOriginalId) && idMap.has(e.targetNodeOriginalId))
    .map((e) => ({
      newRelationshipId: crypto.randomUUID(),
      sourceObjectId: idMap.get(e.sourceNodeOriginalId)!,
      targetObjectId: idMap.get(e.targetNodeOriginalId)!,
      type: e.type,
      explanation: e.explanation,
      provenance: {
        copiedFrom: e.sourceRelationshipId,
        copiedAt: clipboard.copiedAt,
      },
    }));

  return { nodes: pastedNodes, edges: pastedEdges };
}
