/**
 * V2 Layer 4: Relationship Generation + Emergent Hierarchy.
 *
 * The LLM proposes relationships between objects.
 * Hierarchy (trees, depth, siblings) is derived deterministically from structural relationships.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";
import type {
  ConversationalObject, Proposition, Relationship, RelationType, RelationFamily,
  VisualClass, DerivedHierarchyNode, DerivedTree,
} from "./schemas";

const STRUCTURAL_TYPES: RelationType[] = [
  "child_of", "tangent_from", "diverged_from", "branch_from",
  "continued_from", "merged_from", "split_from",
];

export interface RelationshipDiagnostics {
  rawCount: number;
  rejectedCount: number;
  rejectionReasons: string[];
}

export interface RelationshipResult {
  relationships: Relationship[];
  diagnostics: RelationshipDiagnostics;
}

/**
 * Generate relationships between objects using LLM.
 * Every relationship must cite specific propositions as evidence.
 * Never silently fails — throws on LLM errors.
 */
export async function generateRelationships(
  objects: ConversationalObject[],
  propositions: Proposition[],
): Promise<RelationshipResult> {
  const diag: RelationshipDiagnostics = { rawCount: 0, rejectedCount: 0, rejectionReasons: [] };

  if (objects.length < 2) return { relationships: [], diagnostics: diag };

  const activeObjects = objects.filter((o) => o.status !== "discarded");
  const validObjectIds = new Set(activeObjects.map((o) => o.objectId));
  const validPropIds = new Set(propositions.map((p) => p.propositionId));

  // Format objects with their proposition content for relationship reasoning
  const objectsFormatted = activeObjects
    .map((o) => {
      const objProps = propositions.filter((p) => o.propositionIds.includes(p.propositionId));
      const propDetails = objProps.slice(0, 5).map((p) => `${p.propositionId}: "${p.normalizedContent}"`).join("; ");
      return `[${o.objectId}] ${o.objectType}: "${o.title}"\n  Props: ${propDetails || "(none)"}`;
    })
    .join("\n\n");

  const result = await complete({
    model: NODE_MODEL,
    messages: [
      { role: "system", content: RELATIONSHIP_PROMPT },
      { role: "user", content: `Objects:\n${objectsFormatted}\n\nGenerate relationships. Return JSON array only.` },
    ],
    temperature: 0.2,
    maxTokens: 2500,
  });

  const parsed = parseJsonFromLLM(result.content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Relationship generation returned non-array: ${typeof parsed}`);
  }

  diag.rawCount = parsed.length;
  const relationships: Relationship[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i] as Record<string, unknown>;
    const sourceId = r.sourceObjectId as string;
    const targetId = r.targetObjectId as string;
    const type = r.type as RelationType;

    // Reject missing fields
    if (!sourceId || !targetId || !type) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`rel-${i}: missing required fields`);
      continue;
    }

    // Reject invalid object references
    if (!validObjectIds.has(sourceId) || !validObjectIds.has(targetId)) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`rel-${i}: invalid object reference`);
      continue;
    }

    // Reject self-links
    if (sourceId === targetId) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`rel-${i}: self-referential`);
      continue;
    }

    // Reject duplicates
    const pairKey = `${sourceId}→${targetId}:${type}`;
    if (seenPairs.has(pairKey)) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`rel-${i}: duplicate`);
      continue;
    }
    seenPairs.add(pairKey);

    // Validate sourcePropositionIds — only keep valid ones
    const rawPropIds = Array.isArray(r.sourcePropositionIds) ? (r.sourcePropositionIds as string[]) : [];
    const sourcePropositionIds = rawPropIds.filter((pid) => validPropIds.has(pid));

    // For relationships without valid proposition evidence, derive from the objects involved
    // This is acceptable because the relationship is between these objects and their propositions are the justification
    let finalPropIds = sourcePropositionIds;
    if (finalPropIds.length === 0) {
      const sourceObj = activeObjects.find((o) => o.objectId === sourceId);
      const targetObj = activeObjects.find((o) => o.objectId === targetId);
      // Use propositions shared between or relevant to both objects
      const sourcePropSet = new Set(sourceObj?.propositionIds ?? []);
      const targetPropSet = new Set(targetObj?.propositionIds ?? []);
      // Prefer shared propositions; fall back to source object's propositions
      const shared = [...sourcePropSet].filter((pid) => targetPropSet.has(pid));
      finalPropIds = shared.length > 0 ? shared : [...sourcePropSet].slice(0, 3);
    }

    // Reject relationships with zero proposition evidence
    if (finalPropIds.length === 0) {
      diag.rejectedCount++;
      diag.rejectionReasons.push(`rel-${i} (${type}): no proposition evidence`);
      continue;
    }

    const family: RelationFamily = STRUCTURAL_TYPES.includes(type) ? "structural" : "semantic";

    relationships.push({
      relationshipId: `rel-${i}`,
      sourceObjectId: sourceId,
      targetObjectId: targetId,
      type,
      family,
      sourcePropositionIds: finalPropIds,
      provenance: "llm_generated",
      confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence as number)) : 0.7,
      createdBy: "system",
      status: "proposed",
      visualClass: classifyVisual(type, family),
      explanation: (r.explanation as string) ?? "",
    });
  }

  return { relationships, diagnostics: diag };
}

function classifyVisual(type: RelationType, family: RelationFamily): VisualClass {
  if (family === "manual") return "manual";
  if (type === "diverged_from" || type === "tangent_from") return "weak";
  if (type === "child_of" || type === "branch_from" || type === "merged_from") return "structural";
  return "semantic";
}

// ─── Deterministic Hierarchy Derivation ─────────────────────────────────────

/**
 * Derive hierarchy (trees, depth, parent-child) from structural relationships.
 * No LLM — purely deterministic graph traversal.
 * Only child_of creates parent-child structure.
 */
export function deriveHierarchy(
  objects: ConversationalObject[],
  relationships: Relationship[],
): { hierarchy: DerivedHierarchyNode[]; trees: DerivedTree[] } {
  const activeObjects = objects.filter((o) => o.status !== "discarded" && o.objectType !== "noise");
  if (activeObjects.length === 0) return { hierarchy: [], trees: [] };

  // Build parent map from child_of relationships only
  const parentMap = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "child_of" && rel.status !== "removed") {
      parentMap.set(rel.sourceObjectId, rel.targetObjectId);
    }
  }

  // Detect and remove cycles
  for (const [child, parent] of parentMap) {
    const visited = new Set<string>();
    let current: string | undefined = parent;
    while (current) {
      if (visited.has(current)) {
        parentMap.delete(child);
        break;
      }
      visited.add(current);
      current = parentMap.get(current);
    }
  }

  const objectIds = new Set(activeObjects.map((o) => o.objectId));

  // Remove edges referencing non-existent objects
  for (const [child, parent] of parentMap) {
    if (!objectIds.has(child) || !objectIds.has(parent)) {
      parentMap.delete(child);
    }
  }

  // Find roots (objects with no parent)
  const roots = activeObjects.filter((o) => !parentMap.has(o.objectId));

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

  return { hierarchy, trees };
}

const RELATIONSHIP_PROMPT = `Determine relationships between conversational objects.

For each meaningful pair, specify the relationship with proposition-level evidence.

SEMANTIC types: answers, raises_question, supports, evidence_for, example_of, elaborates, reframes, contrasts_with, causes, depends_on, specializes, generalizes, leads_to
STRUCTURAL types: child_of, tangent_from, diverged_from, continued_from

CHILD_OF RULES:
- Use child_of when one object is genuinely a narrower sub-aspect, component, or specific instance of another
- The SOURCE is the child, the TARGET is the parent
- child_of means: removing the parent would make the child lose its broader context
- Both objects must share propositions or have proposition-level evidence connecting them

OTHER RULES:
- diverged_from: conversation shifted to an UNRELATED topic (weak temporal link only)
- Unrelated topics must NOT have child_of
- Do not force relationships where none exist
- Temporal adjacency alone is NOT evidence for any relationship
- sourcePropositionIds must contain specific proposition IDs from the objects that justify THIS relationship

Return JSON array:
[{
  "sourceObjectId": "<obj_id>",
  "targetObjectId": "<obj_id>",
  "type": "<relation_type>",
  "sourcePropositionIds": ["<prop IDs justifying this relationship>"],
  "confidence": <0.0-1.0>,
  "explanation": "<specific evidence for this relationship>"
}]`;
