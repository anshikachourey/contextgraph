/**
 * Apply accepted mutations to an in-memory V2 snapshot.
 * Then recompute hierarchy deterministically.
 */

import { deriveHierarchy } from "../hierarchy";
import type { ConversationalObject, Relationship, Proposition, DerivedHierarchyNode } from "../schemas";
import type { V2Snapshot, GraphMutation, HierarchyDelta, ObjectDecision } from "./schemas";

/**
 * Apply mutations to a snapshot copy and return the updated graph + hierarchy delta.
 */
export function applyMutations(
  snapshot: V2Snapshot,
  mutations: GraphMutation[],
): { updatedGraph: V2Snapshot; hierarchyChanges: HierarchyDelta } {
  // Deep clone snapshot
  const updated: V2Snapshot = {
    conversationId: snapshot.conversationId,
    objects: snapshot.objects.map((o) => ({ ...o, propositionIds: [...o.propositionIds], threadIds: [...o.threadIds], supportingUtteranceIds: [...o.supportingUtteranceIds], contextualAssistantUtteranceIds: [...o.contextualAssistantUtteranceIds] })),
    relationships: snapshot.relationships.map((r) => ({ ...r, sourcePropositionIds: [...r.sourcePropositionIds] })),
    propositions: [...snapshot.propositions],
    threads: snapshot.threads.map((t) => ({ ...t, utteranceIds: [...t.utteranceIds], propositionIds: [...t.propositionIds] })),
    hierarchy: [...snapshot.hierarchy],
    trees: [...snapshot.trees],
  };

  // Apply each mutation
  for (const m of mutations) {
    switch (m.type) {
      case "add_proposition":
        if (m.afterState) {
          updated.propositions.push(m.afterState as unknown as Proposition);
        }
        break;

      case "create_object":
        if (m.afterState) {
          updated.objects.push(m.afterState as unknown as ConversationalObject);
        }
        break;

      case "update_object":
      case "add_object_proposition":
      case "transition_object_status": {
        const idx = updated.objects.findIndex((o) => o.objectId === m.targetId);
        if (idx >= 0 && m.afterState) {
          updated.objects[idx] = m.afterState as unknown as ConversationalObject;
        }
        break;
      }

      case "add_relationship":
        if (m.afterState) {
          updated.relationships.push(m.afterState as unknown as Relationship);
        }
        break;

      case "update_relationship": {
        const rIdx = updated.relationships.findIndex((r) => r.relationshipId === m.targetId);
        if (rIdx >= 0 && m.afterState) {
          updated.relationships[rIdx] = m.afterState as unknown as Relationship;
        }
        break;
      }

      case "remove_relationship": {
        updated.relationships = updated.relationships.filter((r) => r.relationshipId !== m.targetId);
        break;
      }

      case "continue_thread": {
        const tIdx = updated.threads.findIndex((t) => t.threadId === m.targetId);
        if (tIdx >= 0 && m.afterState) {
          updated.threads[tIdx] = m.afterState as unknown as typeof updated.threads[0];
        }
        break;
      }

      default:
        break;
    }
  }

  // Recompute hierarchy
  const previousHierarchy = snapshot.hierarchy;
  const { hierarchy: newHierarchy, trees: newTrees } = deriveHierarchy(updated.objects, updated.relationships);
  updated.hierarchy = newHierarchy;
  updated.trees = newTrees;

  // Compute delta
  const hierarchyChanges = computeHierarchyDelta(previousHierarchy, newHierarchy);

  return { updatedGraph: updated, hierarchyChanges };
}

function computeHierarchyDelta(
  before: DerivedHierarchyNode[],
  after: DerivedHierarchyNode[],
): HierarchyDelta {
  const beforeMap = new Map(before.map((h) => [h.objectId, h]));
  const afterMap = new Map(after.map((h) => [h.objectId, h]));

  const parentChanges: HierarchyDelta["parentChanges"] = [];
  const depthChanges: HierarchyDelta["depthChanges"] = [];
  const rootsBefore = before.filter((h) => h.depth === 0).map((h) => h.objectId);
  const rootsAfter = after.filter((h) => h.depth === 0).map((h) => h.objectId);

  for (const [id, afterNode] of afterMap) {
    const beforeNode = beforeMap.get(id);
    if (!beforeNode) continue;
    if (beforeNode.parentObjectId !== afterNode.parentObjectId) {
      parentChanges.push({ objectId: id, previousParent: beforeNode.parentObjectId, newParent: afterNode.parentObjectId });
    }
    if (beforeNode.depth !== afterNode.depth) {
      depthChanges.push({ objectId: id, previousDepth: beforeNode.depth, newDepth: afterNode.depth });
    }
  }

  return {
    parentChanges,
    depthChanges,
    rootsAdded: rootsAfter.filter((id) => !rootsBefore.includes(id)),
    rootsRemoved: rootsBefore.filter((id) => !rootsAfter.includes(id)),
    treesCreated: [],
    treesRemoved: [],
    cycleRejections: [],
  };
}
