import type { ContextNode } from "@/src/types/node";

export type OverlapResult = {
  // Non-null when the selected message set exactly matches an existing node.
  // The user is about to create a duplicate — open this node instead.
  exactDuplicate: ContextNode | null;
  // Nodes that share at least one (but not all) messages with the selection.
  // Creating a new node is legitimate; the user should be warned.
  overlappingNodes: ContextNode[];
};

/**
 * Compare a set of selected message IDs against all existing nodes.
 *
 * Exact duplicate: selected set is identical to a node's message set
 * (same size, same members — order doesn't matter).
 *
 * Partial overlap: at least one message ID appears in another node's
 * message set, but it's not an exact match.
 *
 * No relationship between nodes is assumed. A message appearing in
 * multiple nodes is correct and intentional (many-to-many model).
 */
export function checkNodeOverlap(
  selectedIds: string[],
  existingNodes: ContextNode[],
): OverlapResult {
  const selectedSet = new Set(selectedIds);
  const overlappingNodes: ContextNode[] = [];

  for (const node of existingNodes) {
    const nodeSet = new Set(node.messageIds);

    // Exact match: same size AND every selected ID is in the node's set
    const isExactDuplicate =
      selectedSet.size === nodeSet.size &&
      [...selectedSet].every((id) => nodeSet.has(id));

    if (isExactDuplicate) {
      // Return immediately — no need to check further
      return { exactDuplicate: node, overlappingNodes: [] };
    }

    // Partial overlap: any selected ID appears in this node
    const hasOverlap = [...selectedSet].some((id) => nodeSet.has(id));
    if (hasOverlap) {
      overlappingNodes.push(node);
    }
  }

  return { exactDuplicate: null, overlappingNodes };
}
