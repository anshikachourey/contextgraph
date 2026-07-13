import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { buildUtterances } from "@/src/lib/intelligence-v2/utterances";
import { extractPropositions } from "@/src/lib/intelligence-v2/propositions";
import { formThreads } from "@/src/lib/intelligence-v2/threads";
import { formObjects } from "@/src/lib/intelligence-v2/objects";
import { generateRelationships, deriveHierarchy } from "@/src/lib/intelligence-v2/hierarchy";
import { validateGraphPlan } from "@/src/lib/intelligence-v2/validator";
import { complete } from "@/src/lib/ai";
import { NODE_MODEL } from "@/src/lib/ai/models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";
import type { V2GraphPlan, Relationship, ConversationalObject, Proposition } from "@/src/lib/intelligence-v2/schemas";

export const maxDuration = 120;

/**
 * GET /api/debug/v2-trace?id=<conversationId>
 *
 * Full pipeline instrumentation endpoint.
 * Runs the real pipeline and captures every intermediate artifact.
 * Does NOT modify behaviour — only observes.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("id");

  if (!conversationId) {
    return NextResponse.json({ error: "id query parameter is required" }, { status: 400 });
  }

  try {
    const trace: Record<string, unknown> = {};

    const db = createServerSupabaseClient();

    // ─── STAGE: Messages ────────────────────────────────────────────────
    const { data: msgData, error: dbError } = await db
      .from("messages")
      .select("id, role, content, conversation_id, created_at, parent_node_id, branch_root_message_id")
      .eq("conversation_id", conversationId)
      .is("parent_node_id", null)
      .order("created_at", { ascending: true });

    if (dbError) {
      return NextResponse.json({ error: `DB error: ${dbError.message}` }, { status: 500 });
    }

    const messages = (msgData ?? []) as Array<{
      id: string; role: string; content: string; conversation_id: string;
      created_at: string; parent_node_id: string | null; branch_root_message_id: string | null;
    }>;

    trace["01_messages"] = {
      count: messages.length,
      items: messages.map((m) => ({
        id: m.id,
        role: m.role,
        contentPreview: m.content.slice(0, 100),
      })),
    };

    if (messages.length < 2) {
      trace["ABORT"] = "fewer than 2 messages";
      return NextResponse.json(trace);
    }

    // ─── STAGE: Utterances ──────────────────────────────────────────────
    const utterances = buildUtterances(messages, conversationId);

    trace["02_utterances"] = {
      count: utterances.length,
      items: utterances.map((u) => ({
        utteranceId: u.utteranceId,
        author: u.author,
        temporalPosition: u.temporalPosition,
        contentPreview: u.rawContent.slice(0, 80),
      })),
    };

    // ─── STAGE: Propositions ────────────────────────────────────────────
    const { propositions, diagnostics: propDiag } = await extractPropositions(utterances);

    trace["03_propositions"] = {
      count: propositions.length,
      rejected: propDiag.rejectedCount,
      rejectionReasons: propDiag.rejectionReasons,
      batchCount: propDiag.batchCount,
      batchDiagnostics: propDiag.batchDiagnostics,
      items: propositions.map((p) => ({
        propositionId: p.propositionId,
        type: p.propositionType,
        authoredBy: p.authoredBy,
        provenance: p.provenance,
        content: p.normalizedContent,
        sourceUtteranceIds: p.sourceUtteranceIds,
      })),
    };

    // ─── STAGE: Threads ─────────────────────────────────────────────────
    const { threads, diagnostics: threadDiag } = await formThreads(utterances, propositions);

    trace["04_threads"] = {
      count: threads.length,
      rejected: threadDiag.rejectedCount,
      rejectionReasons: threadDiag.rejectionReasons,
      items: threads.map((t) => ({
        threadId: t.threadId,
        subject: t.subject,
        utteranceCount: t.utteranceIds.length,
        propositionIds: t.propositionIds,
      })),
    };

    // ─── STAGE: Objects ─────────────────────────────────────────────────
    const { objects, diagnostics: objDiag } = await formObjects(propositions, threads);

    trace["05_objects"] = {
      count: objects.length,
      rejected: objDiag.rejectedCount,
      rejectionReasons: objDiag.rejectionReasons,
      items: objects.map((o) => ({
        objectId: o.objectId,
        objectType: o.objectType,
        title: o.title,
        status: o.status,
        propositionIds: o.propositionIds,
        threadIds: o.threadIds,
        supportingUtteranceIds: o.supportingUtteranceIds,
        contextualAssistantUtteranceIds: o.contextualAssistantUtteranceIds,
      })),
    };

    // ─── STAGE: Raw Relationship LLM Call (INSTRUMENTATION) ─────────────
    // Replicate the exact prompt from generateRelationships to capture raw output
    const activeObjects = objects.filter((o) => o.status !== "discarded");
    const validObjectIds = new Set(activeObjects.map((o) => o.objectId));
    const validPropIds = new Set(propositions.map((p) => p.propositionId));

    const objectsFormatted = activeObjects
      .map((o) => {
        const objProps = propositions.filter((p) => o.propositionIds.includes(p.propositionId));
        const propDetails = objProps.slice(0, 5).map((p) => `${p.propositionId}: "${p.normalizedContent}"`).join("; ");
        return `[${o.objectId}] ${o.objectType}: "${o.title}"\n  Props: ${propDetails || "(none)"}`;
      })
      .join("\n\n");

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

    let rawLlmRelationshipResponse = "";
    let rawParsed: unknown[] = [];

    if (activeObjects.length >= 2) {
      const llmResult = await complete({
        model: NODE_MODEL,
        messages: [
          { role: "system", content: RELATIONSHIP_PROMPT },
          { role: "user", content: `Objects:\n${objectsFormatted}\n\nGenerate relationships. Return JSON array only.` },
        ],
        temperature: 0.2,
        maxTokens: 2500,
      });

      rawLlmRelationshipResponse = llmResult.content;

      try {
        const parsed = parseJsonFromLLM(llmResult.content);
        rawParsed = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        rawParsed = [];
      }
    }

    trace["06_raw_llm_relationship_response"] = {
      rawText: rawLlmRelationshipResponse,
      parsedCount: rawParsed.length,
      parsedItems: rawParsed,
      childOfInRaw: (rawParsed as Array<Record<string, unknown>>).filter(
        (r) => r.type === "child_of"
      ),
      childOfCountInRaw: (rawParsed as Array<Record<string, unknown>>).filter(
        (r) => r.type === "child_of"
      ).length,
      promptSentToLLM: {
        system: RELATIONSHIP_PROMPT,
        user: `Objects:\n${objectsFormatted}\n\nGenerate relationships. Return JSON array only.`,
      },
    };

    // ─── STAGE: Validated Relationships (via actual generateRelationships) ──
    const { relationships: allRelationships, diagnostics: relDiag } = await generateRelationships(objects, propositions);

    const childOfAccepted = allRelationships.filter((r) => r.type === "child_of");
    const structuralAccepted = allRelationships.filter((r) => r.family === "structural");
    const semanticAccepted = allRelationships.filter((r) => r.family === "semantic");

    trace["07_validated_relationships"] = {
      totalAccepted: allRelationships.length,
      semanticCount: semanticAccepted.length,
      structuralCount: structuralAccepted.length,
      childOfCount: childOfAccepted.length,
      items: allRelationships.map((r) => ({
        relationshipId: r.relationshipId,
        sourceObjectId: r.sourceObjectId,
        targetObjectId: r.targetObjectId,
        type: r.type,
        family: r.family,
        sourcePropositionIds: r.sourcePropositionIds,
        confidence: r.confidence,
        explanation: r.explanation,
      })),
    };

    trace["08_rejected_relationships"] = {
      rejectedCount: relDiag.rejectedCount,
      rejectionReasons: relDiag.rejectionReasons,
    };

    // ─── STAGE: Relationships passed into deriveHierarchy ───────────────
    // This is exactly what deriveHierarchy receives
    const relationshipsForHierarchy = allRelationships;
    const childOfForHierarchy = relationshipsForHierarchy.filter((r) => r.type === "child_of");

    trace["09_relationships_into_deriveHierarchy"] = {
      totalRelationships: relationshipsForHierarchy.length,
      childOfRelationships: childOfForHierarchy.length,
      childOfDetails: childOfForHierarchy.map((r) => ({
        relationshipId: r.relationshipId,
        source: r.sourceObjectId,
        target: r.targetObjectId,
        status: r.status,
        confidence: r.confidence,
      })),
    };

    // ─── STAGE: deriveHierarchy internals (manual trace) ────────────────
    // Replicate deriveHierarchy logic to observe parentMap
    const activeForHierarchy = objects.filter((o) => o.status !== "discarded" && o.objectType !== "noise");
    const objectIdsSet = new Set(activeForHierarchy.map((o) => o.objectId));

    const parentMap = new Map<string, string>();
    for (const rel of relationshipsForHierarchy) {
      if (rel.type === "child_of" && rel.status !== "removed") {
        parentMap.set(rel.sourceObjectId, rel.targetObjectId);
      }
    }

    const parentMapBeforeCycleCheck = Object.fromEntries(parentMap);

    // Cycle detection (same logic as deriveHierarchy)
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

    const parentMapAfterCycleCheck = Object.fromEntries(parentMap);

    // Remove edges to non-existent objects
    for (const [child, parent] of parentMap) {
      if (!objectIdsSet.has(child) || !objectIdsSet.has(parent)) {
        parentMap.delete(child);
      }
    }

    const parentMapFinal = Object.fromEntries(parentMap);

    trace["10_parentMap"] = {
      beforeCycleCheck: parentMapBeforeCycleCheck,
      afterCycleCheck: parentMapAfterCycleCheck,
      afterObjectExistenceCheck: parentMapFinal,
      activeObjectIds: [...objectIdsSet],
    };

    // ─── STAGE: Derived Hierarchy ───────────────────────────────────────
    const { hierarchy, trees } = deriveHierarchy(objects, allRelationships);

    trace["11_derived_hierarchy"] = {
      hierarchyNodeCount: hierarchy.length,
      treeCount: trees.length,
      maxDepth: Math.max(0, ...hierarchy.map((h) => h.depth)),
      roots: hierarchy.filter((h) => h.depth === 0).map((h) => ({
        objectId: h.objectId,
        treeId: h.treeId,
        childObjectIds: h.childObjectIds,
      })),
      nonRoots: hierarchy.filter((h) => h.depth > 0).map((h) => ({
        objectId: h.objectId,
        depth: h.depth,
        parentObjectId: h.parentObjectId,
        treeId: h.treeId,
      })),
      trees: trees.map((t) => ({
        treeId: t.treeId,
        rootObjectId: t.rootObjectId,
        objectIds: t.objectIds,
        bridgeCount: t.bridges.length,
      })),
    };

    // ─── STAGE: Validation ──────────────────────────────────────────────
    const plan: V2GraphPlan = {
      conversationId,
      timestamp: new Date().toISOString(),
      utterances,
      propositions,
      threads,
      objects,
      semanticRelationships: semanticAccepted,
      structuralRelationships: structuralAccepted,
      manualRelationships: [],
      derivedHierarchy: hierarchy,
      trees,
      unsupportedClaims: [],
      supersededPropositions: [],
      validationResults: [],
      proposedOperations: [],
    };

    const validationResults = validateGraphPlan(plan);

    trace["12_validation"] = {
      totalResults: validationResults.length,
      failures: validationResults.filter((r) => !r.valid).map((r) => ({
        targetId: r.targetId,
        errors: r.errors,
        warnings: r.warnings,
      })),
    };

    // ─── FINAL DIAGNOSIS ────────────────────────────────────────────────
    const childOfInRaw = (rawParsed as Array<Record<string, unknown>>).filter(
      (r) => r.type === "child_of"
    ).length;
    const childOfInValidated = childOfAccepted.length;
    const childOfInParentMap = Object.keys(parentMapFinal).length;
    const maxDepth = Math.max(0, ...hierarchy.map((h) => h.depth));

    let diagnosis = "";
    if (childOfInRaw === 0) {
      diagnosis = "A) The LLM never generated child_of relationships.";
    } else if (childOfInRaw > 0 && childOfInValidated === 0) {
      diagnosis = "B) The LLM generated child_of but the validator rejected all of them.";
    } else if (childOfInValidated > 0 && childOfInParentMap === 0) {
      diagnosis = "C/D) child_of relationships passed validation but deriveHierarchy did not use them (cycle removal or object existence check).";
    } else if (childOfInParentMap > 0 && maxDepth === 0) {
      diagnosis = "D) parentMap has entries but hierarchy is still flat — BFS traversal bug.";
    } else if (maxDepth > 0) {
      diagnosis = "SUCCESS: Hierarchy has depth > 0.";
    } else {
      diagnosis = "UNKNOWN: Unexpected state.";
    }

    trace["13_diagnosis"] = {
      childOfInRawLLMOutput: childOfInRaw,
      childOfAfterValidation: childOfInValidated,
      childOfInParentMap: childOfInParentMap,
      maxHierarchyDepth: maxDepth,
      conclusion: diagnosis,
    };

    return NextResponse.json(trace);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: `Trace failed: ${message}`, stack }, { status: 500 });
  }
}
