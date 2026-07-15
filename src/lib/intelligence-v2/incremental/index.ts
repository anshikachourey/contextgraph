/**
 * Incremental V2 Engine — Main Orchestrator.
 *
 * Given an existing snapshot and new messages, produces the minimal
 * set of graph mutations to incorporate new content.
 */

import { buildUtterances } from "../utterances";
import { extractNewPropositions } from "./extract-new-propositions";
import { retrieveContext } from "./retrieve-context";
import { decideObjectAction } from "./decide-object-action";
import { decidePlacement } from "./decide-relationships";
import { applyMutations } from "./apply-mutations";
import type { Utterance, ConversationalObject, Relationship, Proposition } from "../schemas";
import type {
  V2Snapshot, IncrementalResult, IncrementalDiagnostics,
  GraphMutation, ObjectDecision, HierarchyDelta,
} from "./schemas";

export type { V2Snapshot, IncrementalResult, IncrementalDiagnostics } from "./schemas";

interface IncrementalInput {
  conversationId: string;
  snapshot: V2Snapshot;
  newMessages: Array<{
    id: string; role: string; content: string; conversation_id: string;
    created_at: string; parent_node_id: string | null; branch_root_message_id: string | null;
  }>;
}

/**
 * Run the incremental V2 update.
 * Does NOT call the full recompute pipeline.
 */
export async function runIncrementalV2Update(input: IncrementalInput): Promise<IncrementalResult> {
  const startTime = Date.now();
  let llmCalls = 0;
  let embeddingCalls = 0;

  const { conversationId, snapshot, newMessages } = input;

  // Step 1: Build new utterances
  const newUtterances = buildUtterances(newMessages, conversationId);

  // Step 2: Extract propositions from new utterances only
  const propStartIdx = snapshot.propositions.length;
  const allUtterances = [
    ...snapshot.threads.flatMap((t) => t.utteranceIds.map((uid) => ({ utteranceId: uid } as Utterance))),
    ...newUtterances,
  ];
  const { propositions: newPropositions, llmCalls: propCalls } = await extractNewPropositions(
    newUtterances, allUtterances, propStartIdx,
  );
  llmCalls += propCalls;

  // Step 3: Retrieve local graph context
  const { context: retrievedContext, embeddingCalls: embCalls } = await retrieveContext(newPropositions, snapshot);
  embeddingCalls += embCalls;

  // Step 4: Decide object action
  const { decision, llmCalls: decisionCalls } = await decideObjectAction(newPropositions, retrievedContext);
  llmCalls += decisionCalls;

  const decisions: ObjectDecision[] = [decision];

  // Step 5: Build mutations
  const proposedMutations: GraphMutation[] = [];
  let mutationIdx = 0;

  // Always add new propositions
  for (const prop of newPropositions) {
    proposedMutations.push({
      mutationId: `mut-${mutationIdx++}`,
      type: "add_proposition",
      targetId: prop.propositionId,
      beforeState: null,
      afterState: prop as unknown as Record<string, unknown>,
      sourceUtteranceIds: prop.sourceUtteranceIds,
      sourcePropositionIds: [prop.propositionId],
      reason: "New proposition extracted from new utterance",
      confidence: prop.confidence,
      provenance: "deterministic",
    });
  }

  // Update active thread with new utterances
  if (retrievedContext.activeThread) {
    const updatedThread = {
      ...retrievedContext.activeThread,
      utteranceIds: [...retrievedContext.activeThread.utteranceIds, ...newUtterances.map((u) => u.utteranceId)],
      propositionIds: [...retrievedContext.activeThread.propositionIds, ...newPropositions.map((p) => p.propositionId)],
    };
    proposedMutations.push({
      mutationId: `mut-${mutationIdx++}`,
      type: "continue_thread",
      targetId: retrievedContext.activeThread.threadId,
      beforeState: retrievedContext.activeThread as unknown as Record<string, unknown>,
      afterState: updatedThread as unknown as Record<string, unknown>,
      sourceUtteranceIds: newUtterances.map((u) => u.utteranceId),
      sourcePropositionIds: newPropositions.map((p) => p.propositionId),
      reason: "Thread continues with new utterances",
      confidence: 1.0,
      provenance: "deterministic",
    });
  }

  // Apply the object decision
  const newPropIds = newPropositions.map((p) => p.propositionId);

  switch (decision.action) {
    case "extend_object":
    case "add_evidence":
    case "revise_object": {
      if (decision.targetObjectId) {
        const existingObj = snapshot.objects.find((o) => o.objectId === decision.targetObjectId);
        if (existingObj) {
          const updatedObj: ConversationalObject = {
            ...existingObj,
            propositionIds: [...existingObj.propositionIds, ...newPropIds],
            supportingUtteranceIds: [...new Set([...existingObj.supportingUtteranceIds, ...newUtterances.filter((u) => u.author === "user").map((u) => u.utteranceId)])],
            contextualAssistantUtteranceIds: [...new Set([...existingObj.contextualAssistantUtteranceIds, ...newUtterances.filter((u) => u.author === "assistant").map((u) => u.utteranceId)])],
            maturity: existingObj.propositionIds.length + newPropIds.length >= 8 ? "stable" : existingObj.propositionIds.length + newPropIds.length >= 3 ? "developing" : "nascent",
          };
          if (decision.action === "revise_object") {
            updatedObj.description = `${existingObj.description} [revised]`;
          }
          proposedMutations.push({
            mutationId: `mut-${mutationIdx++}`,
            type: "update_object",
            targetId: existingObj.objectId,
            beforeState: existingObj as unknown as Record<string, unknown>,
            afterState: updatedObj as unknown as Record<string, unknown>,
            sourceUtteranceIds: newUtterances.map((u) => u.utteranceId),
            sourcePropositionIds: newPropIds,
            reason: `${decision.action}: ${decision.explanation}`,
            confidence: decision.confidence,
            provenance: "llm_generated",
          });
        }
      }
      break;
    }

    case "resolve_object": {
      if (decision.targetObjectId) {
        const existingObj = snapshot.objects.find((o) => o.objectId === decision.targetObjectId);
        if (existingObj) {
          const resolvedObj: ConversationalObject = {
            ...existingObj,
            propositionIds: [...existingObj.propositionIds, ...newPropIds],
            status: "resolved",
            maturity: "stable",
          };
          proposedMutations.push({
            mutationId: `mut-${mutationIdx++}`,
            type: "transition_object_status",
            targetId: existingObj.objectId,
            beforeState: existingObj as unknown as Record<string, unknown>,
            afterState: resolvedObj as unknown as Record<string, unknown>,
            sourceUtteranceIds: newUtterances.map((u) => u.utteranceId),
            sourcePropositionIds: newPropIds,
            reason: `resolve_object: ${decision.explanation}`,
            confidence: decision.confidence,
            provenance: "llm_generated",
          });
        }
      }
      break;
    }

    case "create_object": {
      const draft = decision.newObjectDraft;
      if (draft) {
        const newObjectId = `obj-${snapshot.objects.length}`;
        const userProps = newPropositions.filter((p) => p.authoredBy === "user" && (p.provenance === "direct" || p.provenance === "paraphrase"));
        const newObj: ConversationalObject = {
          objectId: newObjectId,
          objectType: (draft.objectType as ConversationalObject["objectType"]) ?? "unresolved",
          title: draft.title,
          description: draft.description,
          propositionIds: newPropIds,
          threadIds: retrievedContext.activeThread ? [retrievedContext.activeThread.threadId] : [],
          supportingUtteranceIds: [...new Set(userProps.flatMap((p) => p.sourceUtteranceIds))],
          contextualAssistantUtteranceIds: [...new Set(newPropositions.filter((p) => p.authoredBy === "assistant").flatMap((p) => p.sourceUtteranceIds))],
          maturity: newPropIds.length >= 3 ? "developing" : "nascent",
          status: "active",
          provenanceSummary: `Created incrementally from ${newPropIds.length} new propositions`,
        };

        proposedMutations.push({
          mutationId: `mut-${mutationIdx++}`,
          type: "create_object",
          targetId: newObjectId,
          beforeState: null,
          afterState: newObj as unknown as Record<string, unknown>,
          sourceUtteranceIds: newUtterances.map((u) => u.utteranceId),
          sourcePropositionIds: newPropIds,
          reason: `create_object: ${decision.explanation}`,
          confidence: decision.confidence,
          provenance: "llm_generated",
        });

        // Decide placement
        const propSummary = newPropositions.map((p) => p.normalizedContent).join(". ");
        const { placement, llmCalls: placeCalls } = await decidePlacement(
          draft.title, draft.objectType, propSummary, retrievedContext,
        );
        llmCalls += placeCalls;

        if (placement.targetObjectId && placement.relationshipType) {
          const relId = `rel-${snapshot.relationships.length}`;
          const newRel: Relationship = {
            relationshipId: relId,
            sourceObjectId: newObjectId,
            targetObjectId: placement.targetObjectId,
            type: placement.relationshipType,
            family: ["child_of", "tangent_from", "diverged_from", "continued_from", "branch_from"].includes(placement.relationshipType) ? "structural" : "semantic",
            sourcePropositionIds: placement.supportingPropositionIds.length > 0 ? placement.supportingPropositionIds : newPropIds.slice(0, 2),
            provenance: "incremental_placement",
            confidence: placement.confidence,
            createdBy: "system",
            status: "proposed",
            visualClass: placement.relationshipType === "child_of" ? "structural" : placement.relationshipType === "tangent_from" || placement.relationshipType === "diverged_from" ? "weak" : "semantic",
            explanation: placement.explanation,
          };

          proposedMutations.push({
            mutationId: `mut-${mutationIdx++}`,
            type: "add_relationship",
            targetId: relId,
            beforeState: null,
            afterState: newRel as unknown as Record<string, unknown>,
            sourceUtteranceIds: newUtterances.map((u) => u.utteranceId),
            sourcePropositionIds: newPropIds,
            reason: `placement: ${placement.placement} → ${placement.targetObjectId}`,
            confidence: placement.confidence,
            provenance: "llm_generated",
          });
        }
      }
      break;
    }

    case "defer":
    case "discard":
    default:
      break;
  }

  // Validate mutations (basic validation)
  const acceptedMutations: GraphMutation[] = [];
  const rejectedMutations: Array<{ mutation: GraphMutation; reason: string }> = [];

  for (const m of proposedMutations) {
    const rejection = validateMutation(m, snapshot);
    if (rejection) {
      rejectedMutations.push({ mutation: m, reason: rejection });
    } else {
      acceptedMutations.push(m);
    }
  }

  // Apply accepted mutations
  const { updatedGraph, hierarchyChanges } = applyMutations(snapshot, acceptedMutations);

  // Build diagnostics
  const prevRoots = snapshot.hierarchy.filter((h) => h.depth === 0).length;
  const newRoots = updatedGraph.hierarchy.filter((h) => h.depth === 0).length;
  const prevMaxDepth = Math.max(0, ...snapshot.hierarchy.map((h) => h.depth));
  const newMaxDepth = Math.max(0, ...updatedGraph.hierarchy.map((h) => h.depth));

  const decisionCounts: Record<string, number> = {};
  for (const d of decisions) {
    decisionCounts[d.action] = (decisionCounts[d.action] ?? 0) + 1;
  }

  const diagnostics: IncrementalDiagnostics = {
    newUtteranceCount: newUtterances.length,
    newPropositionCount: newPropositions.length,
    retrievedObjectCount: retrievedContext.retrievalDiagnostics.objectsRetrieved,
    primaryDecisionsByType: decisionCounts,
    objectsCreated: acceptedMutations.filter((m) => m.type === "create_object").length,
    objectsUpdated: acceptedMutations.filter((m) => m.type === "update_object").length,
    objectsResolved: acceptedMutations.filter((m) => m.type === "transition_object_status").length,
    objectsReopened: 0,
    relationshipsAdded: acceptedMutations.filter((m) => m.type === "add_relationship").length,
    relationshipsChanged: acceptedMutations.filter((m) => m.type === "update_relationship").length,
    relationshipsRemoved: acceptedMutations.filter((m) => m.type === "remove_relationship").length,
    rootsBefore: prevRoots,
    rootsAfter: newRoots,
    maxDepthBefore: prevMaxDepth,
    maxDepthAfter: newMaxDepth,
    hierarchyChanges: hierarchyChanges.parentChanges.length + hierarchyChanges.depthChanges.length,
    llmCalls,
    embeddingCalls,
    runtimeMs: Date.now() - startTime,
  };

  return {
    newUtterances,
    newPropositions,
    retrievedContext,
    decisions,
    proposedMutations,
    acceptedMutations,
    rejectedMutations,
    updatedGraph,
    hierarchyChanges,
    diagnostics,
  };
}

function validateMutation(m: GraphMutation, snapshot: V2Snapshot): string | null {
  // Basic validation
  if (m.type === "update_object" || m.type === "transition_object_status" || m.type === "add_object_proposition") {
    if (!snapshot.objects.some((o) => o.objectId === m.targetId)) {
      return `Target object ${m.targetId} not found in snapshot`;
    }
  }
  if (m.type === "update_relationship" || m.type === "remove_relationship") {
    if (!snapshot.relationships.some((r) => r.relationshipId === m.targetId)) {
      return `Target relationship ${m.targetId} not found in snapshot`;
    }
  }
  if (m.type === "add_relationship" && m.afterState) {
    const rel = m.afterState as unknown as Relationship;
    if (rel.sourceObjectId === rel.targetObjectId) {
      return "Self-relationship rejected";
    }
  }
  return null;
}
