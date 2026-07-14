/**
 * V2 Layer 4b: Emergent Hierarchy Derivation.
 *
 * Hierarchy is derived deterministically from validated structural relationships.
 * No LLM calls. Only child_of creates parent-child structure.
 */

import type {
  ConversationalObject, Relationship, DerivedHierarchyNode, DerivedTree,
} from "./schemas";

// Re-export relationship generation from the new module
export { generateRelationships } from "./relationships";
export type { RelationshipDiagnostics, RelationshipResult } from "./relationships";

export interface HierarchyDiagnostics {
  childOfAccepted: number;
  childOfRejectedCycles: number;
  childOfRejectedInvalid: number;
  parentMapEntries: number;
  rootCount: number;
  treeCount: number;
  maxDepth: number;
}

/**
 * Derive hierarchy (trees, depth, parent-child) from structural relationships.
 * No LLM — purely deterministic graph traversal.
 * Only child_of creates parent-child structure.
 */
export function deriveHierarchy(
  objects: ConversationalObject[],
  relationships: Relationship[],
): { hierarchy: DerivedHierarchyNode[]; trees: DerivedTree[]; diagnostics: HierarchyDiagnostics } {
  const diag: HierarchyDiagnostics = {
    childOfAccepted: 0,
    childOfRejectedCycles: 0,
    childOfRejectedInvalid: 0,
    parentMapEntries: 0,
    rootCount: 0,
    treeCount: 0,
    maxDepth: 0,
  };

  const activeObjects = objects.filter((o) => o.status !== "discarded" && o.objectType !== "noise");
  if (activeObjects.length === 0) return { hierarchy: [], trees: [], diagnostics: diag };

  const objectIds = new Set(activeObjects.map((o) => o.objectId));

  // Build parent map from child_of relationships only
  const parentMap = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "child_of" && rel.status !== "removed") {
      if (objectIds.has(rel.sourceObjectId) && objectIds.has(rel.targetObjectId)) {
        parentMap.set(rel.sourceObjectId, rel.targetObjectId);
        diag.childOfAccepted++;
      } else {
        diag.childOfRejectedInvalid++;
      }
    }
  }

  // Detect and remove cycles
  const toRemove: string[] = [];
  for (const [child] of parentMap) {
    const visited = new Set<string>();
    let current: string | undefined = child;
    while (current && parentMap.has(current)) {
      if (visited.has(current)) {
        toRemove.push(child);
        break;
      }
      visited.add(current);
      current = parentMap.get(current);
    }
  }
  for (const child of toRemove) {
    parentMap.delete(child);
    diag.childOfRejectedCycles++;
    diag.childOfAccepted--;
  }

  diag.parentMapEntries = parentMap.size;

  // Find roots (objects with no parent)
  const roots = activeObjects.filter((o) => !parentMap.has(o.objectId));
  diag.rootCount = roots.length;

  // Build children lookup
  const childrenMap = new Map<string, string[]>();
  for (const [child, parent] of parentMap) {
    const existing = childrenMap.get(parent) ?? [];
    existing.push(child);
    childrenMap.set(parent, existing);
  }

  const hierarchy: DerivedHierarchyNode[] = [];
  const trees: DerivedTree[] = [];

  for (const root of roots) {
    const treeId = root.objectId;
    const treeObjectIds: string[] = [];

    const queue: Array<{ id: string; depth: number; parentId: string | null }> = [
      { id: root.objectId, depth: 0, parentId: null },
    ];

    while (queue.length > 0) {
      const { id, depth, parentId } = queue.shift()!;
      if (!objectIds.has(id)) continue;
      treeObjectIds.push(id);

      if (depth > diag.maxDepth) diag.maxDepth = depth;

      const children = (childrenMap.get(id) ?? []).filter((c) => objectIds.has(c));
      const siblings = parentId
        ? (childrenMap.get(parentId) ?? []).filter((s) => s !== id && objectIds.has(s))
        : [];

      hierarchy.push({
        objectId: id,
        treeId,
        depth,
        parentObjectId: parentId,
        childObjectIds: children,
        siblingObjectIds: siblings,
      });

      for (const child of children) {
        queue.push({ id: child, depth: depth + 1, parentId: id });
      }
    }

    // Cross-tree bridges (non-child_of relationships spanning trees)
    const bridges = relationships
      .filter((r) =>
        r.type !== "child_of" &&
        ((treeObjectIds.includes(r.sourceObjectId) && !treeObjectIds.includes(r.targetObjectId)) ||
         (treeObjectIds.includes(r.targetObjectId) && !treeObjectIds.includes(r.sourceObjectId))),
      )
      .map((r) => ({
        targetTreeId: treeObjectIds.includes(r.sourceObjectId) ? r.targetObjectId : r.sourceObjectId,
        relation: r.type,
        explanation: r.explanation,
      }));

    trees.push({ treeId, rootObjectId: root.objectId, objectIds: treeObjectIds, bridges });
  }

  diag.treeCount = trees.length;

  return { hierarchy, trees, diagnostics: diag };
}
