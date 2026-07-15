/**
 * Graph Normalization Layer.
 *
 * Transforms raw V2 objects + relationships into a canonical display graph:
 * - Exactly one canonical parent per non-root node
 * - No cycles
 * - No contradictory child_of directions
 * - Unrelated topics remain separate trees
 * - Semantic relationships preserved separately from hierarchy
 *
 * Does NOT modify the source relationships.
 * Produces a displayGraph structure for rendering.
 */

import type { ConversationalObject, Relationship, DerivedHierarchyNode, DerivedTree } from "./schemas";

// ─── Output Types ───────────────────────────────────────────────────────────

export interface DisplayNode {
  objectId: string;
  title: string;
  objectType: string;
  description: string;
  depth: number;
  parentId: string | null;
  childIds: string[];
  siblingIds: string[];
  treeId: string;
}

export interface DisplayGraph {
  nodes: DisplayNode[];
  trees: Array<{ treeId: string; rootId: string; nodeIds: string[] }>;
  semanticEdges: Array<{ id: string; source: string; target: string; type: string; explanation: string; confidence: number }>;
  structuralEdges: Array<{ id: string; source: string; target: string; type: string }>;
  diagnostics: NormalizationDiagnostics;
}

export interface NormalizationDiagnostics {
  totalObjects: number;
  totalRelationships: number;
  childOfRaw: number;
  childOfAfterDirectionFix: number;
  multiParentConflicts: number;
  cyclesRemoved: number;
  canonicalParentAssignments: number;
  roots: number;
  trees: number;
  maxDepth: number;
  rejectedChildOfs: Array<{ child: string; parent: string; reason: string }>;
}

// ─── Main Normalization Function ────────────────────────────────────────────

export function normalizeGraph(
  objects: ConversationalObject[],
  relationships: Relationship[],
): DisplayGraph {
  const diag: NormalizationDiagnostics = {
    totalObjects: objects.length,
    totalRelationships: relationships.length,
    childOfRaw: 0,
    childOfAfterDirectionFix: 0,
    multiParentConflicts: 0,
    cyclesRemoved: 0,
    canonicalParentAssignments: 0,
    roots: 0,
    trees: 0,
    maxDepth: 0,
    rejectedChildOfs: [],
  };

  const activeObjects = objects.filter((o) => o.status !== "discarded" && o.objectType !== "noise");
  const objectMap = new Map(activeObjects.map((o) => [o.objectId, o]));
  const objectIds = new Set(activeObjects.map((o) => o.objectId));

  // Step 1: Collect all child_of relationships
  const rawChildOfs = relationships.filter((r) => r.type === "child_of" && r.status !== "removed");
  diag.childOfRaw = rawChildOfs.length;

  // Step 2: Validate and fix directions
  // child_of convention: source is child, target is parent
  // Validate: child should be narrower/more specific than parent
  const validChildOfs: Array<{ childId: string; parentId: string; confidence: number; relId: string }> = [];

  for (const rel of rawChildOfs) {
    if (!objectIds.has(rel.sourceObjectId) || !objectIds.has(rel.targetObjectId)) continue;
    if (rel.sourceObjectId === rel.targetObjectId) continue;

    const child = objectMap.get(rel.sourceObjectId)!;
    const parent = objectMap.get(rel.targetObjectId)!;

    // Direction validation: a child should have fewer or equal propositions to its parent
    // (narrower topic = fewer evidence points in most cases)
    // Also: factual/explanatory objects shouldn't be children of inquiries
    const directionValid = isValidChildDirection(child, parent);

    if (directionValid) {
      validChildOfs.push({ childId: rel.sourceObjectId, parentId: rel.targetObjectId, confidence: rel.confidence, relId: rel.relationshipId });
    } else {
      // Try reversed direction
      const reversedValid = isValidChildDirection(parent, child);
      if (reversedValid) {
        validChildOfs.push({ childId: rel.targetObjectId, parentId: rel.sourceObjectId, confidence: rel.confidence, relId: rel.relationshipId });
        diag.rejectedChildOfs.push({ child: rel.sourceObjectId, parent: rel.targetObjectId, reason: "direction reversed — child was broader than parent" });
      } else {
        // Neither direction works — reject entirely
        diag.rejectedChildOfs.push({ child: rel.sourceObjectId, parent: rel.targetObjectId, reason: "invalid in both directions" });
      }
    }
  }

  diag.childOfAfterDirectionFix = validChildOfs.length;

  // Step 3: Resolve multi-parent conflicts
  // For each child with multiple parents, pick the best one
  const parentCandidates = new Map<string, Array<{ parentId: string; confidence: number; relId: string }>>();
  for (const edge of validChildOfs) {
    const existing = parentCandidates.get(edge.childId) ?? [];
    existing.push({ parentId: edge.parentId, confidence: edge.confidence, relId: edge.relId });
    parentCandidates.set(edge.childId, existing);
  }

  const canonicalParentMap = new Map<string, string>();

  for (const [childId, candidates] of parentCandidates) {
    if (candidates.length === 1) {
      canonicalParentMap.set(childId, candidates[0].parentId);
      diag.canonicalParentAssignments++;
    } else {
      diag.multiParentConflicts++;
      // Pick best parent: highest confidence, then fewest propositions (most specific parent)
      const ranked = candidates.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        const parentA = objectMap.get(a.parentId);
        const parentB = objectMap.get(b.parentId);
        // Prefer the parent that is itself narrower (closer in scope)
        return (parentA?.propositionIds.length ?? 0) - (parentB?.propositionIds.length ?? 0);
      });

      canonicalParentMap.set(childId, ranked[0].parentId);
      diag.canonicalParentAssignments++;

      // Record rejected alternatives
      for (let i = 1; i < ranked.length; i++) {
        diag.rejectedChildOfs.push({ child: childId, parent: ranked[i].parentId, reason: `multi-parent conflict — chose ${ranked[0].parentId} (conf=${ranked[0].confidence})` });
      }
    }
  }

  // Step 4: Remove cycles
  const toRemove: string[] = [];
  for (const [childId] of canonicalParentMap) {
    const visited = new Set<string>();
    let current: string | undefined = childId;
    while (current && canonicalParentMap.has(current)) {
      if (visited.has(current)) {
        toRemove.push(childId);
        diag.cyclesRemoved++;
        break;
      }
      visited.add(current);
      current = canonicalParentMap.get(current);
    }
  }
  for (const id of toRemove) {
    diag.rejectedChildOfs.push({ child: id, parent: canonicalParentMap.get(id)!, reason: "cycle detected" });
    canonicalParentMap.delete(id);
  }

  // Step 5: Build hierarchy via BFS from roots
  const roots = activeObjects.filter((o) => !canonicalParentMap.has(o.objectId));
  diag.roots = roots.length;

  const childrenMap = new Map<string, string[]>();
  for (const [child, parent] of canonicalParentMap) {
    const existing = childrenMap.get(parent) ?? [];
    existing.push(child);
    childrenMap.set(parent, existing);
  }

  const displayNodes: DisplayNode[] = [];
  const trees: DisplayGraph["trees"] = [];

  for (const root of roots) {
    const treeId = root.objectId;
    const treeNodeIds: string[] = [];

    const queue: Array<{ id: string; depth: number; parentId: string | null }> = [
      { id: root.objectId, depth: 0, parentId: null },
    ];

    while (queue.length > 0) {
      const { id, depth, parentId } = queue.shift()!;
      const obj = objectMap.get(id);
      if (!obj) continue;

      treeNodeIds.push(id);
      if (depth > diag.maxDepth) diag.maxDepth = depth;

      const children = (childrenMap.get(id) ?? []).filter((c) => objectIds.has(c));
      const siblings = parentId
        ? (childrenMap.get(parentId) ?? []).filter((s) => s !== id)
        : [];

      displayNodes.push({
        objectId: id,
        title: obj.title,
        objectType: obj.objectType,
        description: obj.description,
        depth,
        parentId,
        childIds: children,
        siblingIds: siblings,
        treeId,
      });

      for (const child of children) {
        queue.push({ id: child, depth: depth + 1, parentId: id });
      }
    }

    trees.push({ treeId, rootId: root.objectId, nodeIds: treeNodeIds });
  }

  diag.trees = trees.length;

  // Step 6: Separate semantic and structural edges for display
  const structuralTypes = new Set(["child_of", "tangent_from", "diverged_from", "branch_from", "continued_from", "merged_from", "split_from"]);

  const semanticEdges = relationships
    .filter((r) => !structuralTypes.has(r.type) && objectIds.has(r.sourceObjectId) && objectIds.has(r.targetObjectId))
    .map((r) => ({
      id: r.relationshipId,
      source: r.sourceObjectId,
      target: r.targetObjectId,
      type: r.type,
      explanation: r.explanation,
      confidence: r.confidence,
    }));

  const structuralEdges = relationships
    .filter((r) => structuralTypes.has(r.type) && r.type !== "child_of" && objectIds.has(r.sourceObjectId) && objectIds.has(r.targetObjectId))
    .map((r) => ({
      id: r.relationshipId,
      source: r.sourceObjectId,
      target: r.targetObjectId,
      type: r.type,
    }));

  return { nodes: displayNodes, trees, semanticEdges, structuralEdges, diagnostics: diag };
}

// ─── Direction Validation ───────────────────────────────────────────────────

/**
 * Is `child` a valid child of `parent`?
 * A child should be narrower/more specific. Heuristics:
 * - A factual/explanation object should not be child of an inquiry
 * - A broader object (more propositions) should not be child of a narrower one
 * - An object from a different thread should not be child_of (cross-thread hierarchy is weak)
 */
function isValidChildDirection(child: ConversationalObject, parent: ConversationalObject): boolean {
  // Rule 1: Factual/explanation objects are not naturally children of inquiries
  if ((child.objectType === "explanation" || child.objectType === "insight") && parent.objectType === "inquiry") {
    // An explanation/insight CAN be child of an inquiry if it's answering/exploring that inquiry
    // But a BROADER explanation shouldn't be child of a NARROWER inquiry
    if (child.propositionIds.length > parent.propositionIds.length * 1.5) {
      return false;
    }
  }

  // Rule 2: A child with dramatically more propositions than its parent is suspicious
  // (broader scope shouldn't be nested inside narrower scope)
  if (child.propositionIds.length > parent.propositionIds.length * 2) {
    return false;
  }

  // Rule 3: Cross-thread child_of is generally invalid unless threads share ancestry
  const childThreads = new Set(child.threadIds);
  const parentThreads = new Set(parent.threadIds);
  const sharedThread = [...childThreads].some((t) => parentThreads.has(t));
  if (!sharedThread) {
    return false;
  }

  return true;
}

// ─── Textual Forest Printer ─────────────────────────────────────────────────

/**
 * Print the normalized forest as indented text.
 * Useful for debugging and acceptance testing.
 */
export function printForest(graph: DisplayGraph): string {
  const lines: string[] = [];
  const nodeMap = new Map(graph.nodes.map((n) => [n.objectId, n]));

  for (const tree of graph.trees) {
    const root = nodeMap.get(tree.rootId);
    if (!root) continue;

    lines.push(`🌳 Tree: ${tree.treeId} (${tree.nodeIds.length} nodes)`);
    printSubtree(root, nodeMap, graph, 1, lines);
    lines.push("");
  }

  lines.push(`--- Summary ---`);
  lines.push(`Roots: ${graph.diagnostics.roots}`);
  lines.push(`Trees: ${graph.diagnostics.trees}`);
  lines.push(`Max depth: ${graph.diagnostics.maxDepth}`);
  lines.push(`Semantic edges: ${graph.semanticEdges.length}`);
  lines.push(`Structural edges: ${graph.structuralEdges.length}`);
  lines.push(`Multi-parent conflicts resolved: ${graph.diagnostics.multiParentConflicts}`);
  lines.push(`Cycles removed: ${graph.diagnostics.cyclesRemoved}`);
  if (graph.diagnostics.rejectedChildOfs.length > 0) {
    lines.push(`Rejected child_of edges:`);
    for (const r of graph.diagnostics.rejectedChildOfs) {
      lines.push(`  ${r.child} → ${r.parent}: ${r.reason}`);
    }
  }

  return lines.join("\n");
}

function printSubtree(
  node: DisplayNode,
  nodeMap: Map<string, DisplayNode>,
  graph: DisplayGraph,
  indent: number,
  lines: string[],
): void {
  const prefix = "  ".repeat(indent);
  const typeTag = `[${node.objectType}]`;
  lines.push(`${prefix}${typeTag} ${node.title}`);

  // Print semantic connections briefly
  const connections = graph.semanticEdges.filter(
    (e) => e.source === node.objectId || e.target === node.objectId,
  );
  if (connections.length > 0) {
    const connTypes = [...new Set(connections.map((c) => c.type))].join(", ");
    lines.push(`${prefix}  ↔ ${connections.length} semantic: ${connTypes}`);
  }

  // Print children
  for (const childId of node.childIds) {
    const child = nodeMap.get(childId);
    if (child) printSubtree(child, nodeMap, graph, indent + 1, lines);
  }
}
