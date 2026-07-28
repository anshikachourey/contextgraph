/**
 * Conceptual Map Derivation
 *
 * Derives an explorable knowledge map from the existing V2 snapshot.
 * All logic is client-side and presentation-only — no mutations, no new IDs persisted.
 *
 * ─── Grouping & Ranking Signals ─────────────────────────────────────────────
 *
 * 1. MAJOR CONCEPTS (top-level branches):
 *    - All depth-0 root objects from the snapshot's `hierarchy` array.
 *    - If a single root exists, its depth-1 children become the major concepts.
 *    - Ranked by: proposition count (descending) → thread count → alphabetical title.
 *    - No fixed count enforced. The natural tree structure determines the number.
 *
 * 2. ROLE CLASSIFICATION (for visual hierarchy):
 *    Derived from `objectType` field on each ConversationalObject:
 *    - "position": inquiry, insight, decision, goal, preference
 *    - "evidence": explanation, plan, project, task
 *    - "objection": problem, comparison, unresolved
 *    - "other": noise, or unrecognized types
 *    These are presentation roles only — never persisted or used as IDs.
 *
 * 3. BRANCH CHILDREN:
 *    Direct children of a major concept in the hierarchy tree.
 *    Revealed one level at a time when the parent is expanded.
 *
 * 4. RELATIONSHIP INDICATORS:
 *    Semantic relationships (answers, supports, contrasts_with, etc.) shown
 *    only when both endpoints are currently visible.
 *
 * 5. CONVERSATION ROOT:
 *    A synthetic presentation node representing "This Conversation".
 *    Not a persisted object. Never used as a continuation origin.
 *    Connects to all major concepts as a visual anchor.
 */

export type PresentationRole = "position" | "evidence" | "objection" | "other";

export interface MapNode {
  /** Real object ID from the snapshot — used for selection, panel, continue */
  objectId: string;
  title: string;
  description: string;
  objectType: string;
  maturity: string;
  status: string;
  propositionCount: number;
  /** Depth in the conceptual map (0 = root/conversation, 1 = major concept, 2+ = details) */
  mapDepth: number;
  /** Classified presentation role */
  role: PresentationRole;
  /** Direct children IDs in the hierarchy */
  childIds: string[];
  /** Parent ID in the hierarchy (null for conversation root) */
  parentId: string | null;
  /** Number of total descendants (for showing counts on collapsed nodes) */
  descendantCount: number;
}

export interface ConceptualMap {
  /** The conversation root node (synthetic or real single-root) */
  rootId: string;
  /** All nodes indexed by objectId */
  nodes: Map<string, MapNode>;
  /** Major concept IDs (direct children of root) — ordered by rank */
  majorConceptIds: string[];
  /** Semantic edges available for rendering when both endpoints are visible */
  semanticEdges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    explanation: string;
    confidence: number;
  }>;
}

// ─── Input types matching the snapshot payload ──────────────────────────────

interface SnapshotObject {
  objectId: string;
  objectType: string;
  title: string;
  description: string;
  propositionIds: string[];
  threadIds: string[];
  maturity: string;
  status: string;
  supportingUtteranceIds: string[];
  contextualAssistantUtteranceIds: string[];
  provenanceSummary: string;
}

interface SnapshotHierarchyNode {
  objectId: string;
  depth: number;
  parentObjectId: string | null;
  childObjectIds: string[];
  treeId: string;
}

interface SnapshotRelationship {
  relationshipId: string;
  sourceObjectId: string;
  targetObjectId: string;
  type: string;
  family: string;
  confidence: number;
  explanation: string;
}

// ─── Derivation ─────────────────────────────────────────────────────────────

const SYNTHETIC_ROOT_ID = "__conversation_root__";

export function deriveConceptualMap(
  objects: SnapshotObject[],
  hierarchy: SnapshotHierarchyNode[],
  relationships: SnapshotRelationship[],
): ConceptualMap {
  const objectMap = new Map(objects.map((o) => [o.objectId, o]));
  const hierMap = new Map(hierarchy.map((h) => [h.objectId, h]));

  // Find tree roots (depth 0 in hierarchy)
  const treeRoots = hierarchy.filter((h) => h.depth === 0);

  // Determine major concepts
  let majorConceptIds: string[];
  let rootId: string;

  if (treeRoots.length === 1) {
    // Single root — its children are the major concepts
    rootId = treeRoots[0].objectId;
    majorConceptIds = treeRoots[0].childObjectIds.filter((id) => objectMap.has(id));
  } else if (treeRoots.length > 1) {
    // Multiple roots — they ARE the major concepts under a synthetic root
    rootId = SYNTHETIC_ROOT_ID;
    majorConceptIds = treeRoots.map((r) => r.objectId);
  } else {
    // No hierarchy — all objects are major concepts under synthetic root
    rootId = SYNTHETIC_ROOT_ID;
    majorConceptIds = objects.map((o) => o.objectId);
  }

  // Rank major concepts: proposition count desc → thread count desc → title alpha
  majorConceptIds.sort((a, b) => {
    const objA = objectMap.get(a);
    const objB = objectMap.get(b);
    if (!objA || !objB) return 0;
    const propDiff = objB.propositionIds.length - objA.propositionIds.length;
    if (propDiff !== 0) return propDiff;
    const threadDiff = objB.threadIds.length - objA.threadIds.length;
    if (threadDiff !== 0) return threadDiff;
    return objA.title.localeCompare(objB.title);
  });

  // Build the node map
  const nodes = new Map<string, MapNode>();

  // Add conversation root
  if (rootId === SYNTHETIC_ROOT_ID) {
    nodes.set(SYNTHETIC_ROOT_ID, {
      objectId: SYNTHETIC_ROOT_ID,
      title: "Conversation",
      description: `${objects.length} concepts explored`,
      objectType: "root",
      maturity: "stable",
      status: "active",
      propositionCount: 0,
      mapDepth: 0,
      role: "other",
      childIds: majorConceptIds,
      parentId: null,
      descendantCount: objects.length,
    });
  }

  // Compute descendant counts
  function countDescendants(objectId: string): number {
    const hier = hierMap.get(objectId);
    if (!hier || hier.childObjectIds.length === 0) return 0;
    let count = hier.childObjectIds.length;
    for (const childId of hier.childObjectIds) {
      count += countDescendants(childId);
    }
    return count;
  }

  // Add all real objects as map nodes
  for (const obj of objects) {
    const hier = hierMap.get(obj.objectId);
    const childIds = hier?.childObjectIds.filter((id) => objectMap.has(id)) ?? [];

    // Determine mapDepth relative to the conceptual map root
    let mapDepth: number;
    if (obj.objectId === rootId) {
      mapDepth = 0;
    } else if (majorConceptIds.includes(obj.objectId)) {
      mapDepth = 1;
    } else {
      // Compute relative depth
      const hierDepth = hier?.depth ?? 0;
      if (rootId === SYNTHETIC_ROOT_ID) {
        mapDepth = hierDepth + 1; // roots become depth 1
      } else {
        mapDepth = hierDepth; // already relative to the real root
      }
    }

    // Determine parent in the conceptual map
    let parentId: string | null;
    if (obj.objectId === rootId) {
      parentId = null;
    } else if (majorConceptIds.includes(obj.objectId)) {
      parentId = rootId;
    } else {
      parentId = hier?.parentObjectId ?? null;
    }

    nodes.set(obj.objectId, {
      objectId: obj.objectId,
      title: obj.title,
      description: obj.description,
      objectType: obj.objectType,
      maturity: obj.maturity,
      status: obj.status,
      propositionCount: obj.propositionIds.length,
      mapDepth,
      role: classifyRole(obj.objectType),
      childIds,
      parentId,
      descendantCount: countDescendants(obj.objectId),
    });
  }

  // Filter semantic edges
  const semanticEdges = relationships
    .filter((r) => r.family === "semantic" && r.confidence > 0.3)
    .map((r) => ({
      id: r.relationshipId,
      source: r.sourceObjectId,
      target: r.targetObjectId,
      type: r.type,
      explanation: r.explanation,
      confidence: r.confidence,
    }));

  return { rootId, nodes, majorConceptIds, semanticEdges };
}

function classifyRole(objectType: string): PresentationRole {
  switch (objectType) {
    case "inquiry":
    case "insight":
    case "decision":
    case "goal":
    case "preference":
      return "position";
    case "explanation":
    case "plan":
    case "project":
    case "task":
      return "evidence";
    case "problem":
    case "comparison":
    case "unresolved":
      return "objection";
    default:
      return "other";
  }
}

export { SYNTHETIC_ROOT_ID };
