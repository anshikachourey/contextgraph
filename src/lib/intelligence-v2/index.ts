/**
 * V2 ContextGraph Intelligence Engine — Canonical Implementation.
 *
 * Derivation chain: Utterance → Proposition → Thread → Object → Relationship → Hierarchy
 * Shadow mode: reads messages, produces plan, persists nothing.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { buildUtterances } from "./utterances";
import { extractPropositions } from "./propositions";
import { formThreads } from "./threads";
import { formObjects } from "./objects";
import { generateRelationships, deriveHierarchy } from "./hierarchy";
import { validateGraphPlan } from "./validator";
import type { V2GraphPlan, Relationship } from "./schemas";

export type { V2GraphPlan } from "./schemas";

export interface LayerDiagnostics {
  layer: string;
  inputCount: number;
  outputCount: number;
  rejectedCount: number;
  rejectionReasons: string[];
  elapsedMs: number;
}

/**
 * Run the full V2 canonical pipeline on a conversation.
 * Returns the complete derivation chain + validated plan + layer diagnostics.
 */
export async function runV2GraphPlan(conversationId: string, options?: { maxMessageSeq?: number }): Promise<V2GraphPlan & { _diagnostics: LayerDiagnostics[] }> {
  const diagnostics: LayerDiagnostics[] = [];
  const db = createServerSupabaseClient();

  // Load main-thread messages, optionally bounded by message_seq
  let msgData: Array<Record<string, unknown>> | null = null;
  let dbError: { message: string } | null = null;

  if (options?.maxMessageSeq !== undefined) {
    // Try with message_seq filter first
    const { data, error } = await db
      .from("messages")
      .select("id, role, content, conversation_id, created_at, parent_node_id, branch_root_message_id")
      .eq("conversation_id", conversationId)
      .is("parent_node_id", null)
      .lte("message_seq", options.maxMessageSeq)
      .order("created_at", { ascending: true });

    if (error && error.message?.includes("does not exist")) {
      // message_seq column doesn't exist — fall back to loading all messages
      const { data: fallbackData, error: fallbackError } = await db
        .from("messages")
        .select("id, role, content, conversation_id, created_at, parent_node_id, branch_root_message_id")
        .eq("conversation_id", conversationId)
        .is("parent_node_id", null)
        .order("created_at", { ascending: true });
      msgData = fallbackData as Array<Record<string, unknown>> | null;
      dbError = fallbackError;
    } else {
      msgData = data as Array<Record<string, unknown>> | null;
      dbError = error;
    }
  } else {
    const { data, error } = await db
      .from("messages")
      .select("id, role, content, conversation_id, created_at, parent_node_id, branch_root_message_id")
      .eq("conversation_id", conversationId)
      .is("parent_node_id", null)
      .order("created_at", { ascending: true });
    msgData = data as Array<Record<string, unknown>> | null;
    dbError = error;
  }

  if (dbError) {
    throw new Error(`Database query failed: ${dbError.message}`);
  }

  const messages = (msgData ?? []) as Array<{
    id: string; role: string; content: string; conversation_id: string;
    created_at: string; parent_node_id: string | null; branch_root_message_id: string | null;
  }>;

  if (messages.length < 2) {
    return { ...emptyPlan(conversationId), _diagnostics: [{ layer: "messages", inputCount: messages.length, outputCount: 0, rejectedCount: 0, rejectionReasons: ["fewer than 2 messages"], elapsedMs: 0 }] };
  }

  // Layer 0: Build utterances
  let t0 = Date.now();
  const utterances = buildUtterances(messages, conversationId);
  diagnostics.push({ layer: "utterances", inputCount: messages.length, outputCount: utterances.length, rejectedCount: 0, rejectionReasons: [], elapsedMs: Date.now() - t0 });

  // Layer 1: Extract propositions
  t0 = Date.now();
  const { propositions, diagnostics: propDiag } = await extractPropositions(utterances);
  diagnostics.push({ layer: "propositions", inputCount: utterances.length, outputCount: propositions.length, rejectedCount: propDiag.rejectedCount, rejectionReasons: propDiag.rejectionReasons, elapsedMs: Date.now() - t0 });

  // Layer 2: Form threads
  t0 = Date.now();
  const { threads, diagnostics: threadDiag } = await formThreads(utterances, propositions);
  diagnostics.push({ layer: "threads", inputCount: utterances.length, outputCount: threads.length, rejectedCount: threadDiag.rejectedCount, rejectionReasons: threadDiag.rejectionReasons, elapsedMs: Date.now() - t0 });

  // Layer 3: Form objects
  t0 = Date.now();
  const { objects, diagnostics: objDiag } = await formObjects(propositions, threads);
  diagnostics.push({ layer: "objects", inputCount: propositions.length, outputCount: objects.length, rejectedCount: objDiag.totalRejectedDrafts, rejectionReasons: objDiag.failedThreads.map((t) => `thread ${t} failed`), elapsedMs: Date.now() - t0 });

  // Layer 4a: Generate relationships
  t0 = Date.now();
  const { relationships: allRelationships, diagnostics: relDiag } = await generateRelationships(objects, propositions);
  diagnostics.push({ layer: "relationships", inputCount: objects.length, outputCount: allRelationships.length, rejectedCount: relDiag.totalRejected, rejectionReasons: relDiag.rejectedReasons, elapsedMs: Date.now() - t0 });

  // Separate by family
  const semanticRelationships = allRelationships.filter((r) => r.family === "semantic");
  const structuralRelationships = allRelationships.filter((r) => r.family === "structural");
  const manualRelationships: Relationship[] = [];

  // Layer 4b: Derive hierarchy deterministically
  t0 = Date.now();
  const { hierarchy: derivedHierarchy, trees, diagnostics: hierDiag } = deriveHierarchy(objects, allRelationships);
  diagnostics.push({ layer: "hierarchy", inputCount: allRelationships.length, outputCount: derivedHierarchy.length, rejectedCount: hierDiag.childOfRejectedCycles + hierDiag.childOfRejectedInvalid, rejectionReasons: [], elapsedMs: Date.now() - t0 });

  // Collect metadata
  const unsupportedClaims = objects
    .filter((o) => o.supportingUtteranceIds.length === 0 && o.status !== "discarded")
    .map((o) => `"${o.title}" — no user utterance support`);

  const supersededPropositions = propositions.filter((p) => p.status === "superseded");

  // Build plan
  const plan: V2GraphPlan = {
    conversationId,
    timestamp: new Date().toISOString(),
    utterances,
    propositions,
    threads,
    objects,
    semanticRelationships,
    structuralRelationships,
    manualRelationships,
    derivedHierarchy,
    trees,
    unsupportedClaims,
    supersededPropositions,
    validationResults: [],
    proposedOperations: [],
  };

  // Validate
  plan.validationResults = validateGraphPlan(plan);

  return { ...plan, _diagnostics: diagnostics };
}

function emptyPlan(conversationId: string): V2GraphPlan {
  return {
    conversationId,
    timestamp: new Date().toISOString(),
    utterances: [],
    propositions: [],
    threads: [],
    objects: [],
    semanticRelationships: [],
    structuralRelationships: [],
    manualRelationships: [],
    derivedHierarchy: [],
    trees: [],
    unsupportedClaims: [],
    supersededPropositions: [],
    validationResults: [],
    proposedOperations: [],
  };
}
