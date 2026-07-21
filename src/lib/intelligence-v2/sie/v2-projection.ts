/**
 * V2 Snapshot Projection — Projects SIE authoritative state to the V2
 * SnapshotPayload shape consumed by the React Flow UI.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POLICY: This module fills structurally required V2 fields with explicit
 * non-authoritative placeholders where the SIE design does not provide an
 * approved mapping. Fields that influence behavioral decisions (hierarchy
 * formation, filtering, conflict resolution) are flagged rather than
 * silently assigned invented values.
 *
 * The following mappings are NOT approved and are handled as documented:
 *
 * 1. BehavioralConfidenceBand → numeric confidence
 *    CONSEQUENTIAL: normalizeGraph uses confidence to resolve multi-parent
 *    conflicts. No approved mapping exists. Flagged — uses placeholder 1.0
 *    so all SIE parent relationships are treated equally (no invented ranking).
 *
 * 2. ObjectMaturity (proposition-count derived)
 *    NOT APPROVED. ObjectMaturity was explicitly retired in the SIE design.
 *    Uses constant "developing" — structurally required by the type system
 *    but never read for behavioral decisions by normalizeGraph or the UI
 *    renderer (only displayed as metadata).
 *
 * 3. Synthetic Thread per SemanticPacket
 *    NOT APPROVED. Threads are optional in the UI (uses ?. and fallback "").
 *    Empty array provided — no synthetic threads are invented.
 *
 * 4. ObjectType from most-common proposition type
 *    CONSEQUENTIAL: normalizeGraph uses objectType to filter "noise" and
 *    validate hierarchy direction. No approved type derivation exists.
 *    Flagged — uses "unresolved" (neutral: not filtered, passes all
 *    direction checks). Product decision required for a real mapping.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type {
  ConversationalObject,
  Proposition as V2Proposition,
  Thread,
  Relationship,
  DerivedHierarchyNode,
  DerivedTree,
  ObjectStatus,
} from "../schemas";

import type { SIEGraphState, PersistentConcern, Proposition, PropositionAssociation, SemanticPacket } from "./types";

// ─── V2SnapshotProjection — the exact SnapshotPayload shape ─────────────────

export interface V2SnapshotProjection {
  objects: ConversationalObject[];
  relationships: Relationship[];
  propositions: V2Proposition[];
  threads: Thread[];
  hierarchy: DerivedHierarchyNode[];
  trees: DerivedTree[];
}

// ─── Unapproved Mapping Flags ───────────────────────────────────────────────

/**
 * Fields that require a product decision before receiving a real value.
 * Each flag documents what the field does and why the current placeholder
 * was chosen to be behaviorally inert.
 */
export const UNAPPROVED_MAPPING_FLAGS = {
  /**
   * objectType: normalizeGraph filters "noise" and uses objectType in
   * isValidChildDirection(). "unresolved" is neutral — never filtered,
   * passes all direction validation. A real mapping requires product
   * judgment on how PersistentConcern semantics map to V2's 13 objectTypes.
   */
  objectType: "unresolved" as const,

  /**
   * maturity: ObjectMaturity was explicitly retired in the SIE design.
   * The V2 type system requires it but no code reads it for behavioral
   * decisions. "developing" is an arbitrary constant — product may choose
   * to remove this field from the UI or define a new derivation.
   */
  maturity: "developing" as const,

  /**
   * confidence (on parent relationships): normalizeGraph resolves
   * multi-parent conflicts by picking the highest-confidence edge.
   * No approved BehavioralConfidenceBand → numeric mapping exists.
   * Using 1.0 for all SIE parent relationships means they are treated
   * equally — if multiple parents exist, resolution falls through to
   * normalizeGraph's secondary heuristic (fewest propositions).
   * A real mapping requires product judgment.
   */
  parentRelationshipConfidence: 1.0 as const,

  /**
   * proposition confidence: displayed in UI but not used for structural
   * decisions by normalizeGraph. Placeholder 1.0 (non-authoritative).
   */
  propositionConfidence: 1.0 as const,
} as const;

// ─── Structurally Required: ConcernStatus → ObjectStatus ────────────────────
// This mapping IS approved: the design.md compatibility-record specifies it.

function mapConcernStatusToObjectStatus(status: string): ObjectStatus {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "DORMANT":
      return "deferred";
    case "RETIRED":
      return "resolved";
    case "MERGED":
      return "discarded";
    default:
      return "active";
  }
}

// ─── Main Projection Function ───────────────────────────────────────────────

/**
 * Projects the SIE authoritative graph state to the V2 SnapshotPayload shape
 * consumed by the React Flow UI.
 *
 * Rules:
 * - PersistentConcern → ConversationalObject
 * - Active PRIMARY_OWNER associations → object.propositionIds
 * - Canonical parenthood → child_of Relationships (no invented edges)
 * - Threads: empty array (no synthetic threads invented without approval)
 * - ObjectMaturity: constant placeholder (retired concept)
 * - ObjectType: "unresolved" placeholder (requires product decision)
 * - Confidence: 1.0 placeholder (requires product decision)
 */
export function projectToV2Snapshot(sieState: SIEGraphState): V2SnapshotProjection {
  const { concerns, propositions, associations, packets } = sieState;

  // Index: active PRIMARY_OWNER associations grouped by concern_id
  const primaryOwnerByConcern = new Map<string, string[]>();
  // Index: supporting associations grouped by concern_id
  const supportingByConcern = new Map<string, string[]>();

  for (const assoc of associations) {
    if (assoc.semantic_state !== "ACTIVE") continue;

    if (assoc.role === "PRIMARY_OWNER") {
      const existing = primaryOwnerByConcern.get(assoc.concern_id) ?? [];
      existing.push(assoc.proposition_id);
      primaryOwnerByConcern.set(assoc.concern_id, existing);
    } else {
      const existing = supportingByConcern.get(assoc.concern_id) ?? [];
      existing.push(assoc.proposition_id);
      supportingByConcern.set(assoc.concern_id, existing);
    }
  }

  // Index: propositions by ID
  const propositionById = new Map<string, Proposition>();
  for (const prop of propositions) {
    propositionById.set(prop.proposition_id, prop);
  }

  // ─── Project Concerns to ConversationalObjects ────────────────────────────

  const objects: ConversationalObject[] = concerns.map((concern) => {
    const ownedPropIds = primaryOwnerByConcern.get(concern.concern_id) ?? [];
    const supportingPropIds = supportingByConcern.get(concern.concern_id) ?? [];

    // Collect supporting utterance IDs
    const supportingUtteranceIds = new Set<string>();
    for (const propId of [...ownedPropIds, ...supportingPropIds]) {
      const prop = propositionById.get(propId);
      if (prop) {
        for (const msgId of prop.source_message_ids) {
          supportingUtteranceIds.add(msgId);
        }
      }
    }

    // Collect contextual assistant utterance IDs
    const contextualAssistantUtteranceIds = new Set<string>();
    for (const propId of ownedPropIds) {
      const prop = propositionById.get(propId);
      if (prop && prop.speaker_role.toLowerCase() === "assistant") {
        for (const msgId of prop.source_message_ids) {
          contextualAssistantUtteranceIds.add(msgId);
        }
      }
    }

    return {
      objectId: concern.concern_id,
      objectType: UNAPPROVED_MAPPING_FLAGS.objectType,
      title: concern.display_title,
      description: concern.current_summary,
      propositionIds: ownedPropIds,
      threadIds: [], // No synthetic threads — requires product decision
      supportingUtteranceIds: Array.from(supportingUtteranceIds),
      contextualAssistantUtteranceIds: Array.from(contextualAssistantUtteranceIds),
      maturity: UNAPPROVED_MAPPING_FLAGS.maturity,
      status: mapConcernStatusToObjectStatus(concern.status),
      provenanceSummary: concern.identity_summary,
    };
  });

  // ─── Project Parent Hierarchy to child_of Relationships ───────────────────

  const relationships: Relationship[] = [];
  for (const concern of concerns) {
    if (concern.canonical_parent_id && concern.parent_resolution_state === "PARENT_ASSIGNED") {
      relationships.push({
        relationshipId: `rel-parent-${concern.concern_id}`,
        sourceObjectId: concern.concern_id,
        targetObjectId: concern.canonical_parent_id,
        type: "child_of",
        family: "structural",
        sourcePropositionIds: [],
        provenance: "sie_parent_hierarchy",
        confidence: UNAPPROVED_MAPPING_FLAGS.parentRelationshipConfidence,
        createdBy: "system",
        status: "active",
        visualClass: "structural",
        explanation: `${concern.display_title} is a child of its canonical parent.`,
      });
    }
  }

  // ─── Project SIE Propositions to V2 Proposition subset ────────────────────

  const v2Propositions: V2Proposition[] = propositions
    .filter((p) => p.semantic_state === "ACTIVE")
    .map((prop) => ({
      propositionId: prop.proposition_id,
      propositionType: prop.proposition_type.toLowerCase() as V2Proposition["propositionType"],
      normalizedContent: prop.canonical_meaning,
      sourceUtteranceIds: prop.source_message_ids,
      authoredBy: prop.speaker_role.toLowerCase() as "user" | "assistant",
      provenance: prop.provenance.toLowerCase() as V2Proposition["provenance"],
      confirmedByUser: false,
      confidence: UNAPPROVED_MAPPING_FLAGS.propositionConfidence,
      status: "active" as const,
      supersedesPropositionId: prop.supersedes_proposition_id ?? null,
    }));

  // ─── Derive Hierarchy from parent chain ───────────────────────────────────

  const parentMap = new Map<string, string | null>();
  const childrenMap = new Map<string, string[]>();

  for (const concern of concerns) {
    const parentId =
      concern.parent_resolution_state === "PARENT_ASSIGNED"
        ? concern.canonical_parent_id ?? null
        : null;
    parentMap.set(concern.concern_id, parentId);

    if (parentId) {
      const children = childrenMap.get(parentId) ?? [];
      children.push(concern.concern_id);
      childrenMap.set(parentId, children);
    }
  }

  // Identify root concerns
  const rootConcernIds = concerns
    .filter(
      (c) =>
        c.parent_resolution_state === "ROOT_CONFIRMED" ||
        (c.parent_resolution_state === "PARENT_DEFERRED" && !c.canonical_parent_id)
    )
    .map((c) => c.concern_id);

  // Compute depth via BFS
  const depthMap = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = rootConcernIds.map((id) => ({
    id,
    depth: 0,
  }));
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depthMap.has(id)) continue;
    depthMap.set(id, depth);
    const children = childrenMap.get(id) ?? [];
    for (const childId of children) {
      if (!depthMap.has(childId)) {
        queue.push({ id: childId, depth: depth + 1 });
      }
    }
  }
  // Orphan nodes get depth 0
  for (const concern of concerns) {
    if (!depthMap.has(concern.concern_id)) {
      depthMap.set(concern.concern_id, 0);
    }
  }

  // Build trees
  const trees: DerivedTree[] = [];
  const nodeToTreeId = new Map<string, string>();

  function collectTreeNodes(rootId: string): string[] {
    const nodes: string[] = [rootId];
    const childStack = [...(childrenMap.get(rootId) ?? [])];
    while (childStack.length > 0) {
      const nodeId = childStack.pop()!;
      nodes.push(nodeId);
      childStack.push(...(childrenMap.get(nodeId) ?? []));
    }
    return nodes;
  }

  for (const rootId of rootConcernIds) {
    const treeId = `tree-${rootId}`;
    const treeNodes = collectTreeNodes(rootId);
    for (const nodeId of treeNodes) {
      nodeToTreeId.set(nodeId, treeId);
    }
    trees.push({ treeId, rootObjectId: rootId, objectIds: treeNodes, bridges: [] });
  }

  // Orphan/deferred nodes get their own single-node tree
  for (const concern of concerns) {
    if (!nodeToTreeId.has(concern.concern_id)) {
      const treeId = `tree-${concern.concern_id}`;
      nodeToTreeId.set(concern.concern_id, treeId);
      trees.push({ treeId, rootObjectId: concern.concern_id, objectIds: [concern.concern_id], bridges: [] });
    }
  }

  // Build hierarchy nodes
  const hierarchy: DerivedHierarchyNode[] = concerns.map((concern) => {
    const children = childrenMap.get(concern.concern_id) ?? [];
    const parentId = parentMap.get(concern.concern_id) ?? null;
    const treeId = nodeToTreeId.get(concern.concern_id) ?? `tree-${concern.concern_id}`;
    const depth = depthMap.get(concern.concern_id) ?? 0;

    let siblingIds: string[] = [];
    if (parentId) {
      siblingIds = (childrenMap.get(parentId) ?? []).filter(
        (id) => id !== concern.concern_id
      );
    }

    return {
      objectId: concern.concern_id,
      treeId,
      depth,
      parentObjectId: parentId,
      childObjectIds: children,
      siblingObjectIds: siblingIds,
    };
  });

  return {
    objects,
    relationships,
    propositions: v2Propositions,
    threads: [], // No synthetic threads — requires product decision
    hierarchy,
    trees,
  };
}
