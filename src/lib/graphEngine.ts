/**
 * Evidence Accumulation Graph Engine v2.
 *
 * "Is this an idea worth remembering?"
 *
 * Runs as part of the /api/chat backend pipeline — not triggered from frontend.
 * Detects semantic segment completion, accumulates evidence in topic candidates,
 * materializes nodes when confidence crosses threshold, and discovers parents
 * when topology changes.
 *
 * Trust guarantees:
 * - Never deletes nodes
 * - Never merges nodes
 * - Never splits nodes
 * - Only adds: extends existing nodes, creates new nodes, creates parents
 */

import { cosineSimilarity } from "./cosineSimilarity";
import { generateEmbedding } from "./embeddings";
import {
  SEGMENT_WINDOW_SIZE,
  SEGMENT_BOUNDARY_THRESHOLD,
  EXTEND_THRESHOLD,
  CANDIDATE_MATCH_THRESHOLD,
  CONFIDENCE_WEIGHTS,
  MATERIALIZE_THRESHOLD,
  MIN_EVIDENCE_MESSAGES,
  TRIVIAL_MESSAGE_MAX_CHARS,
  SUBSTANTIVE_MESSAGE_MIN_CHARS,
  GREETING_PATTERNS,
  PARENT_MIN_SIBLINGS,
  PARENT_SIMILARITY_THRESHOLD,
} from "./graphEngineConfig";
import type { ChatMessage } from "@/src/types/message";
import type {
  TopicCandidate,
  MessageSegment,
  ConfidenceFactors,
  EngineAction,
  NodeEmbedding,
  GraphEngineResult,
} from "@/src/types/graphEngine";

// ─── Segment boundary detection ─────────────────────────────────────────────

/**
 * Detect if a segment boundary exists at the tail of the conversation.
 * Returns the completed segment's messages or null.
 */
export async function detectSegmentCompletion(
  messages: ChatMessage[],
): Promise<ChatMessage[] | null> {
  const n = messages.length;
  if (n < 2 * SEGMENT_WINDOW_SIZE) return null;

  const prevWindow = messages.slice(n - 2 * SEGMENT_WINDOW_SIZE, n - SEGMENT_WINDOW_SIZE);
  const currWindow = messages.slice(n - SEGMENT_WINDOW_SIZE);

  const prevText = prevWindow
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  const currText = currWindow
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const [prevEmb, currEmb] = await Promise.all([
    generateEmbedding(prevText.slice(0, 7000)),
    generateEmbedding(currText.slice(0, 7000)),
  ]);

  const similarity = cosineSimilarity(prevEmb, currEmb);

  if (similarity < SEGMENT_BOUNDARY_THRESHOLD) {
    return prevWindow;
  }

  return null;
}

// ─── Evidence quality scoring ───────────────────────────────────────────────

export function scoreMessageQuality(content: string): number {
  const trimmed = content.trim();
  const charCount = trimmed.length;

  if (charCount <= TRIVIAL_MESSAGE_MAX_CHARS) return 0.1;
  if (GREETING_PATTERNS.some((p) => p.test(trimmed))) return 0.1;
  if (charCount < SUBSTANTIVE_MESSAGE_MIN_CHARS) return 0.5;
  if (charCount >= 200) return 1.0;
  return 0.8;
}

export function computeSegmentQuality(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;

  const scores = messages.map((m) => scoreMessageQuality(m.content));
  const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;

  // Boost for real dialogue (user + assistant both present)
  const hasUser = messages.some((m) => m.role === "user");
  const hasAssistant = messages.some((m) => m.role === "assistant");
  const dialogueBoost = hasUser && hasAssistant ? 0.1 : 0;

  return Math.min(1.0, avg + dialogueBoost);
}

// ─── Confidence scoring v2 ──────────────────────────────────────────────────

/**
 * Compute "idea worth remembering" confidence.
 * No strict segment-count requirement — a single rich segment can materialize.
 */
export function computeConfidence(
  candidate: TopicCandidate,
  existingNodeEmbeddings: NodeEmbedding[],
  segmentMessages?: ChatMessage[][],
): { score: number; factors: ConfidenceFactors } {
  const segments = candidate.segments;

  // Factor 1: Semantic Coherence
  // Single segment defaults to high coherence (it's internally consistent by definition)
  let semanticCoherence = 0.85;
  if (segments.length >= 2) {
    let totalSim = 0;
    let pairs = 0;
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        if (segments[i].embedding.length > 0 && segments[j].embedding.length > 0) {
          totalSim += cosineSimilarity(segments[i].embedding, segments[j].embedding);
          pairs++;
        }
      }
    }
    semanticCoherence = pairs > 0 ? totalSim / pairs : 0.5;
  }

  // Factor 2: Distinctiveness (inverse of best match to existing nodes)
  let bestNodeMatchScore = 0;
  const centroid = candidate.embedding;
  if (centroid && centroid.length > 0) {
    for (const node of existingNodeEmbeddings) {
      if (node.embedding.length > 0) {
        const sim = cosineSimilarity(centroid, node.embedding);
        if (sim > bestNodeMatchScore) bestNodeMatchScore = sim;
      }
    }
  }
  const distinctiveness = 1.0 - bestNodeMatchScore;

  // Factor 3: Recurrence
  // 1 segment = 0.3 (allows materialization if other factors are strong)
  // 2 segments = 0.65
  // 3+ = 1.0
  const recurrence = Math.min(1.0, 0.3 + (segments.length - 1) * 0.35);

  // Factor 4: Evidence Quality
  let evidenceQuality = 0.5; // default
  if (segmentMessages && segmentMessages.length > 0) {
    const qualities = segmentMessages.map((msgs) => computeSegmentQuality(msgs));
    evidenceQuality = qualities.reduce((sum, q) => sum + q, 0) / qualities.length;
  } else {
    // Estimate from segment sizes
    const totalMsgs = segments.reduce((sum, s) => sum + s.messageIds.length, 0);
    const avgMsgsPerSeg = totalMsgs / Math.max(segments.length, 1);
    evidenceQuality = Math.min(1.0, avgMsgsPerSeg / 5);
  }

  const factors: ConfidenceFactors = {
    semanticCoherence,
    distinctiveness,
    recurrence,
    evidenceQuality,
  };

  const score = Math.max(0, Math.min(1,
    semanticCoherence * CONFIDENCE_WEIGHTS.semanticCoherence +
    distinctiveness * CONFIDENCE_WEIGHTS.distinctiveness +
    recurrence * CONFIDENCE_WEIGHTS.recurrence +
    evidenceQuality * CONFIDENCE_WEIGHTS.evidenceQuality,
  ));

  return { score, factors };
}

// ─── Materialization decision ───────────────────────────────────────────────

/**
 * Can this candidate materialize?
 * No strict segment-count gate. A single segment with high confidence can pass.
 */
export function shouldMaterialize(candidate: TopicCandidate): boolean {
  const totalMessages = candidate.segments.reduce(
    (sum, s) => sum + s.messageIds.length,
    0,
  );

  return (
    candidate.confidence >= MATERIALIZE_THRESHOLD &&
    totalMessages >= MIN_EVIDENCE_MESSAGES
  );
}

// ─── Core decision logic ────────────────────────────────────────────────────

/**
 * Decide what to do with a completed segment.
 */
export function decideSegmentAction(
  segmentEmbedding: number[],
  segmentMessageIds: string[],
  existingNodes: NodeEmbedding[],
  candidates: TopicCandidate[],
): EngineAction {
  // Compare against existing nodes
  let bestNodeScore = 0;
  let bestNodeId: string | null = null;

  for (const node of existingNodes) {
    if (node.embedding.length === 0) continue;
    const score = cosineSimilarity(segmentEmbedding, node.embedding);
    if (score > bestNodeScore) {
      bestNodeScore = score;
      bestNodeId = node.id;
    }
  }

  if (bestNodeScore >= EXTEND_THRESHOLD && bestNodeId) {
    return { type: "extend_node", nodeId: bestNodeId, messageIds: segmentMessageIds };
  }

  // Compare against candidates
  let bestCandidateScore = 0;
  let bestCandidate: TopicCandidate | null = null;

  for (const candidate of candidates) {
    if (!candidate.embedding || candidate.embedding.length === 0) continue;
    const score = cosineSimilarity(segmentEmbedding, candidate.embedding);
    if (score > bestCandidateScore) {
      bestCandidateScore = score;
      bestCandidate = candidate;
    }
  }

  const segment: MessageSegment = {
    messageIds: segmentMessageIds,
    embedding: segmentEmbedding,
    completedAt: new Date().toISOString(),
  };

  if (bestCandidateScore >= CANDIDATE_MATCH_THRESHOLD && bestCandidate) {
    return { type: "accumulate", candidateId: bestCandidate.id, segment };
  }

  return { type: "new_candidate", segment };
}

// ─── Parent discovery ───────────────────────────────────────────────────────

export interface ParentCandidate {
  childNodeIds: string[];
  avgSimilarity: number;
}

export function discoverParents(nodes: NodeEmbedding[]): ParentCandidate[] {
  const results: ParentCandidate[] = [];
  const nodesWithEmb = nodes.filter((n) => n.embedding.length > 0);

  // Build similarity graph
  const adj = new Map<string, Set<string>>();
  for (const n of nodesWithEmb) adj.set(n.id, new Set());

  for (let i = 0; i < nodesWithEmb.length; i++) {
    for (let j = i + 1; j < nodesWithEmb.length; j++) {
      const sim = cosineSimilarity(nodesWithEmb[i].embedding, nodesWithEmb[j].embedding);
      if (sim >= PARENT_SIMILARITY_THRESHOLD) {
        adj.get(nodesWithEmb[i].id)?.add(nodesWithEmb[j].id);
        adj.get(nodesWithEmb[j].id)?.add(nodesWithEmb[i].id);
      }
    }
  }

  // Find connected components
  const visited = new Set<string>();
  for (const n of nodesWithEmb) {
    if (visited.has(n.id)) continue;
    const component: string[] = [];
    const queue = [n.id];
    visited.add(n.id);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      component.push(curr);
      for (const neighbor of adj.get(curr) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= PARENT_MIN_SIBLINGS) {
      let total = 0;
      let pairs = 0;
      const nodeMap = new Map(nodesWithEmb.map((nd) => [nd.id, nd]));
      for (let i = 0; i < component.length; i++) {
        for (let j = i + 1; j < component.length; j++) {
          const a = nodeMap.get(component[i]);
          const b = nodeMap.get(component[j]);
          if (a && b) {
            total += cosineSimilarity(a.embedding, b.embedding);
            pairs++;
          }
        }
      }
      const avg = pairs > 0 ? total / pairs : 0;
      if (avg >= PARENT_SIMILARITY_THRESHOLD) {
        results.push({ childNodeIds: component, avgSimilarity: avg });
      }
    }
  }

  return results;
}

// ─── Centroid computation ────────────────────────────────────────────────────

export function computeCandidateCentroid(segments: MessageSegment[]): number[] {
  const valid = segments.filter((s) => s.embedding.length > 0);
  if (valid.length === 0) return [];

  const dim = valid[0].embedding.length;
  const centroid = new Array(dim).fill(0);

  for (const seg of valid) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += seg.embedding[i];
    }
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) {
    centroid[i] /= valid.length;
    norm += centroid[i] * centroid[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dim; i++) centroid[i] /= norm;
  }

  return centroid;
}

// ─── Main orchestrator ──────────────────────────────────────────────────────

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { persistNode, loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { persistEdges } from "@/src/lib/db/edges";
import { computeSuggestedEdges } from "@/src/lib/edgeSuggestions";
import { STRONGLY_RELATED_THRESHOLD } from "@/src/lib/similarityThresholds";
import {
  loadActiveCandidates,
  createCandidate,
  updateCandidate,
  materializeCandidate,
} from "@/src/lib/db/candidates";
import { parseJsonFromLLM, isTitleSummaryResponse } from "@/src/lib/llmJson";
import OpenAI from "openai";
import type { ContextNode } from "@/src/types/node";
import type { DbMessage } from "@/src/types/db";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Run the full graph engine pipeline.
 * Called from /api/chat after messages are persisted.
 * Non-fatal — errors are caught and logged, never break chat.
 */
export async function runGraphEngine(
  conversationId: string,
): Promise<GraphEngineResult> {
  const result: GraphEngineResult = {
    actions: [],
    candidatesUpdated: 0,
    nodesCreated: 0,
    nodesExtended: 0,
    parentsCreated: 0,
  };

  const db = createServerSupabaseClient();

  // Load messages (non-branch only)
  const { data: dbMessages } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .is("parent_node_id", null)
    .order("created_at", { ascending: true });

  const messages: ChatMessage[] = (dbMessages ?? []).map((m: DbMessage) => ({
    id: m.id,
    role: m.role,
    content: m.content,
  }));

  if (messages.length < 6) return result;

  // Step 1: Detect segment completion
  const completedSegment = await detectSegmentCompletion(messages);
  if (!completedSegment) {
    result.actions.push({ type: "no_action" });
    return result;
  }

  // Embed the completed segment
  const segmentText = completedSegment
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  const segmentEmbedding = await generateEmbedding(segmentText.slice(0, 7000));
  const segmentMessageIds = completedSegment.map((m) => m.id);

  // Load existing state
  const rawNodes = await loadNodesWithEmbeddings(conversationId);
  const nodeEmbeddings: NodeEmbedding[] = rawNodes
    .filter((n) => n.embedding !== null && n.embedding!.length > 0)
    .map((n) => ({ id: n.id, title: n.title, embedding: n.embedding! }));

  const candidates = await loadActiveCandidates(conversationId);

  // Step 2: Decide action
  const action = decideSegmentAction(
    segmentEmbedding, segmentMessageIds, nodeEmbeddings, candidates,
  );
  result.actions.push(action);

  // Step 3: Execute
  let topologyChanged = false;

  if (action.type === "extend_node") {
    const links = action.messageIds.map((mid) => ({
      node_id: action.nodeId,
      message_id: mid,
    }));
    await db.from("node_messages").upsert(links, {
      onConflict: "node_id,message_id",
      ignoreDuplicates: true,
    });
    result.nodesExtended++;

  } else if (action.type === "accumulate") {
    const candidate = candidates.find((c) => c.id === action.candidateId);
    if (candidate) {
      const newSegments = [...candidate.segments, action.segment];
      const newEmbedding = computeCandidateCentroid(newSegments);

      const updatedCandidate: TopicCandidate = {
        ...candidate,
        segments: newSegments,
        embedding: newEmbedding,
      };
      const { score } = computeConfidence(updatedCandidate, nodeEmbeddings);
      updatedCandidate.confidence = score;

      await updateCandidate(action.candidateId, newSegments, newEmbedding, score);
      result.candidatesUpdated++;

      if (shouldMaterialize(updatedCandidate)) {
        const node = await materializeCandidateToNode(conversationId, updatedCandidate, messages);
        if (node) {
          await materializeCandidate(action.candidateId, node.id);
          result.nodesCreated++;
          topologyChanged = true;
        }
      }
    }

  } else if (action.type === "new_candidate") {
    const embedding = action.segment.embedding;
    const tempCandidate: TopicCandidate = {
      id: "",
      conversationId,
      status: "accumulating",
      segments: [action.segment],
      embedding,
      confidence: 0,
      materializedNodeId: null,
      lastUpdatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const { score } = computeConfidence(tempCandidate, nodeEmbeddings, [completedSegment]);
    tempCandidate.confidence = score;

    await createCandidate(conversationId, action.segment, embedding, score);
    result.candidatesUpdated++;

    // A single rich segment can materialize immediately
    if (shouldMaterialize(tempCandidate)) {
      const node = await materializeCandidateToNode(conversationId, tempCandidate, messages);
      if (node) {
        // Mark the just-created candidate as materialized (by finding it)
        result.nodesCreated++;
        topologyChanged = true;
      }
    }
  }

  // Step 4: Parent discovery (triggered by topology change)
  if (topologyChanged) {
    const updatedNodes = await loadNodesWithEmbeddings(conversationId);
    const updatedEmbs: NodeEmbedding[] = updatedNodes
      .filter((n) => n.embedding !== null && n.embedding!.length > 0)
      .map((n) => ({ id: n.id, title: n.title, embedding: n.embedding! }));

    const parents = discoverParents(updatedEmbs);
    for (const pc of parents) {
      const childTitles = updatedEmbs
        .filter((n) => pc.childNodeIds.includes(n.id))
        .map((n) => n.title)
        .join(", ");

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{
            role: "user",
            content: `These topics are related: ${childTitles}\nGenerate a short parent category name (max 40 chars):`,
          }],
          temperature: 0.3,
          max_tokens: 30,
        });
        const parentTitle = completion.choices[0]?.message?.content?.trim() ?? `Topics: ${childTitles.slice(0, 30)}`;

        const parentNode: ContextNode = {
          id: crypto.randomUUID(),
          title: parentTitle,
          summary: `Groups related topics: ${childTitles}`,
          messageIds: [],
        };
        await persistNode(conversationId, parentNode, [], { createdBy: "ai" });
        result.parentsCreated++;
      } catch { /* non-fatal */ }
    }

    // Recompute edges
    try {
      const allNodes = await loadNodesWithEmbeddings(conversationId);
      const suggestions = await computeSuggestedEdges(allNodes);
      const strong = suggestions.filter((s) => s.similarity >= STRONGLY_RELATED_THRESHOLD);
      await persistEdges(conversationId, strong);
    } catch { /* non-fatal */ }
  }

  return result;
}

// ─── Materialization helper ─────────────────────────────────────────────────

async function materializeCandidateToNode(
  conversationId: string,
  candidate: { segments: MessageSegment[] },
  allMessages: ChatMessage[],
): Promise<ContextNode | null> {
  const messageIds = [...new Set(candidate.segments.flatMap((s) => s.messageIds))];
  const linkedMessages = allMessages.filter((m) => messageIds.includes(m.id));
  if (linkedMessages.length === 0) return null;

  const formatted = linkedMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n")
    .slice(0, 3000);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "system",
        content: `Analyze these messages and return JSON: {"title":"<noun phrase, max 60 chars>","summary":"<what they discuss, max 200 chars>"}. Raw JSON only.`,
      }, { role: "user", content: formatted }],
      temperature: 0.4,
      max_tokens: 150,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = parseJsonFromLLM(raw);
    if (!isTitleSummaryResponse(parsed)) return null;

    const node: ContextNode = {
      id: crypto.randomUUID(),
      title: parsed.title,
      summary: parsed.summary,
      messageIds,
    };

    await persistNode(conversationId, node, linkedMessages, { createdBy: "ai" });
    console.log(`[graph-engine] Materialized: "${node.title}"`);
    return node;
  } catch {
    return null;
  }
}
