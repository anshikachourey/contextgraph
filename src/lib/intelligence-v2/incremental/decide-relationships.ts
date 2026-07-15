/**
 * Decide relationship placement for newly created objects.
 * Only called when create_object is the primary decision.
 */

import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";
import type { ConversationalObject } from "../schemas";
import type { PlacementResult, RetrievedContext } from "./schemas";

/**
 * Determine how a new object connects to the existing graph.
 */
export async function decidePlacement(
  newObjectTitle: string,
  newObjectType: string,
  newPropositionSummary: string,
  context: RetrievedContext,
): Promise<{ placement: PlacementResult; llmCalls: number }> {
  const contextObjects = getUniqueObjects(context);

  if (contextObjects.length === 0) {
    return {
      placement: {
        placement: "independent_root",
        targetObjectId: null,
        relationshipType: null,
        supportingPropositionIds: [],
        confidence: 1.0,
        explanation: "No existing objects to connect to",
      },
      llmCalls: 0,
    };
  }

  const objectsFormatted = contextObjects.map((o) =>
    `[${o.objectId}] ${o.objectType}: "${o.title}"`,
  ).join("\n");

  const userContent = `NEW OBJECT: [${newObjectType}] "${newObjectTitle}"
Content: ${newPropositionSummary}

EXISTING OBJECTS:
${objectsFormatted}

How should the new object connect to the graph?`;

  const result = await complete({
    model: NODE_MODEL,
    messages: [
      { role: "system", content: PLACEMENT_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.1,
    maxTokens: 500,
  });

  try {
    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown>;
    const placement: PlacementResult = {
      placement: normalizePlacement(parsed.placement as string),
      targetObjectId: (parsed.targetObjectId as string) ?? null,
      relationshipType: (parsed.relationshipType as string as PlacementResult["relationshipType"]) ?? null,
      supportingPropositionIds: Array.isArray(parsed.supportingPropositionIds) ? (parsed.supportingPropositionIds as string[]) : [],
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.6,
      explanation: (parsed.explanation as string) ?? "",
    };
    return { placement, llmCalls: 1 };
  } catch {
    return {
      placement: {
        placement: "independent_root",
        targetObjectId: null,
        relationshipType: null,
        supportingPropositionIds: [],
        confidence: 0.3,
        explanation: "Parse failed — defaulting to independent root",
      },
      llmCalls: 1,
    };
  }
}

function getUniqueObjects(context: RetrievedContext): ConversationalObject[] {
  const seen = new Set<string>();
  const result: ConversationalObject[] = [];
  for (const o of [...context.recentObjects, ...context.semanticNeighbors.map((s) => s.object), ...context.unresolvedInquiries]) {
    if (!seen.has(o.objectId)) { seen.add(o.objectId); result.push(o); }
  }
  return result;
}

function normalizePlacement(raw: string): PlacementResult["placement"] {
  const valid: PlacementResult["placement"][] = ["child_of", "sibling_via_shared_parent", "tangent_from", "diverged_from", "continued_from", "branch_from", "cross_tree_bridge", "independent_root", "defer_placement"];
  return valid.includes(raw as PlacementResult["placement"]) ? (raw as PlacementResult["placement"]) : "independent_root";
}

const PLACEMENT_PROMPT = `Decide how a new conversational object connects to existing objects.

Placements:
- child_of: new object is a sub-aspect/sub-question of an existing object
- tangent_from: user digressed temporarily from an active object
- diverged_from: conversation moved to unrelated territory
- continued_from: user resumed a dormant object
- cross_tree_bridge: explicit connection across separate trees
- independent_root: no supported structural relationship

Rules:
- child_of requires the new object to be genuinely NARROWER than the target
- Temporal adjacency alone does NOT justify child_of
- When uncertain, prefer independent_root over forced hierarchy

Return JSON:
{
  "placement": "<placement_type>",
  "targetObjectId": "<object ID to connect to, or null>",
  "relationshipType": "<child_of|tangent_from|diverged_from|continued_from|null>",
  "supportingPropositionIds": [],
  "confidence": <0-1>,
  "explanation": "<why>"
}`;
