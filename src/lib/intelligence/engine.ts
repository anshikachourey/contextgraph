/**
 * GraphIntelligenceEngine v1 — Orchestrator.
 *
 * Called from /api/chat after messages are persisted.
 * Loads state, runs pure pipeline stages, collects mutations, persists batch.
 *
 * Soft-fail: if the engine fails, chat still works.
 * Incremental: only touches affected nodes, never full rebuild.
 * Deterministic: same state + same messages → same mutations.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { generateEmbedding } from "@/src/lib/embeddings";
import { parseJsonFromLLM, isTitleSummaryResponse } from "@/src/lib/llmJson";
import OpenAI from "openai";
import { WINDOW_SIZE } from "./config";
import {
  detectSegment,
  routeSegment,
  shouldMaterialize,
  computeConfidence,
  computeIncrementalEdges,
  computeMetrics,
  computeNewNodePosition,
  computeCentroid,
} from "./stages";
import { assignNodeToNeighborhood } from "./neighborhoods";
import type { ChatMessage } from "@/src/types/message";
import type {
  PipelineContext,
  NodeState,
  EdgeState,
  CandidateState,
  EngineState,
  GraphMutation,
  EngineResult,
} from "./types";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Run the GraphIntelligenceEngine for a conversation.
 * Called after messages are persisted.
 * Returns a result summary. Never throws — errors are caught and logged.
 */
export async function runIntelligenceEngine(
  conversationId: string,
): Promise<EngineResult> {
  const result: EngineResult = {
    mutations: [],
    nodesExtended: 0,
    nodesCreated: 0,
    edgesAdded: 0,
    edgesRemoved: 0,
  };

  try {
    // ─── Load state ─────────────────────────────────────────────────────
    const ctx = await loadPipelineContext(conversationId);
    if (ctx.recentMessages.length < 2 * WINDOW_SIZE) return result;

    // ─── Stage 1: EMBED ─────────────────────────────────────────────────
    const currentWindow = ctx.recentMessages.slice(-WINDOW_SIZE);
    const windowText = currentWindow
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    const windowEmbedding = await generateEmbedding(windowText.slice(0, 7000));

    // Always store the window embedding for next run
    result.mutations.push({
      type: "update_engine_state",
      windowEmbedding,
      lastMessageId: ctx.newMessages[ctx.newMessages.length - 1]?.id ?? "",
      totalRuns: ctx.engineState.totalRuns + 1,
    });

    // ─── Stage 2: SEGMENT ───────────────────────────────────────────────
    const segmentResult = detectSegment(
      windowEmbedding,
      ctx.engineState.lastWindowEmbedding,
      ctx.recentMessages,
    );

    if (!segmentResult.segmentCompleted || !segmentResult.completedSegmentEmbedding) {
      // No boundary — store embedding and exit
      await persistMutations(conversationId, result.mutations, ctx);
      return result;
    }

    const segmentEmbedding = segmentResult.completedSegmentEmbedding;
    const segmentMessageIds = segmentResult.completedSegment!.map((m) => m.id);

    // ─── Stage 3: ROUTE ─────────────────────────────────────────────────
    const decision = routeSegment(
      segmentEmbedding,
      segmentMessageIds,
      ctx.nodes,
      ctx.candidates,
    );

    let affectedNodeId: string | null = null;
    let affectedNodeEmbedding: number[] | null = null;

    if (decision.type === "extend_node") {
      result.mutations.push({
        type: "extend_node",
        nodeId: decision.nodeId,
        messageIds: decision.messageIds,
      });
      result.nodesExtended++;
      affectedNodeId = decision.nodeId;
      affectedNodeEmbedding = ctx.nodes.find((n) => n.id === decision.nodeId)?.embedding ?? null;
      console.log(`[intelligence] Extended node ${decision.nodeId} with ${decision.messageIds.length} messages`);

    } else if (decision.type === "accumulate") {
      const candidate = ctx.candidates.find((c) => c.id === decision.candidateId);
      if (candidate) {
        const newSegments = [...candidate.segments, decision.segment];
        const newEmbedding = computeCentroid(newSegments);
        const confidence = computeConfidence(
          { ...candidate, segments: newSegments, embedding: newEmbedding },
          ctx.nodes,
        );

        result.mutations.push({
          type: "update_candidate",
          candidateId: decision.candidateId,
          segments: newSegments,
          embedding: newEmbedding,
          confidence,
        });

        // ─── Stage 4: MATERIALIZE check ─────────────────────────────────
        const updatedCandidate: CandidateState = {
          ...candidate,
          segments: newSegments,
          embedding: newEmbedding,
          confidence,
        };

        if (shouldMaterialize(updatedCandidate, ctx.nodes)) {
          const node = await materializeToNode(conversationId, updatedCandidate, ctx);
          if (node) {
            result.mutations.push(node.mutation);
            result.nodesCreated++;
            affectedNodeId = node.nodeId;
            affectedNodeEmbedding = node.embedding;
          }
        }
      }

    } else if (decision.type === "new_candidate") {
      const confidence = computeConfidence(
        { id: "", segments: [decision.segment], embedding: segmentEmbedding, confidence: 0 },
        ctx.nodes,
      );

      result.mutations.push({
        type: "create_candidate",
        segment: decision.segment,
        embedding: segmentEmbedding,
        confidence,
      });
      console.log(`[intelligence] New candidate (confidence: ${confidence.toFixed(2)})`);

      // Check if single rich segment should materialize immediately
      const tempCandidate: CandidateState = {
        id: "",
        segments: [decision.segment],
        embedding: segmentEmbedding,
        confidence,
      };
      if (shouldMaterialize(tempCandidate, ctx.nodes)) {
        const node = await materializeToNode(conversationId, tempCandidate, ctx);
        if (node) {
          result.mutations.push(node.mutation);
          result.nodesCreated++;
          affectedNodeId = node.nodeId;
          affectedNodeEmbedding = node.embedding;
        }
      }
    }

    // ─── Stage 5: RELATE (incremental edges for affected node) ──────────
    if (affectedNodeId && affectedNodeEmbedding && affectedNodeEmbedding.length > 0) {
      const { addEdges, removeEdgeIds } = computeIncrementalEdges(
        affectedNodeId,
        affectedNodeEmbedding,
        ctx.nodes,
        ctx.edges,
      );

      for (const edge of addEdges) {
        result.mutations.push({
          type: "add_edge",
          sourceNodeId: affectedNodeId,
          targetNodeId: edge.targetNodeId,
          similarity: edge.similarity,
          explanation: "", // LLM explanation deferred for v1
        });
        result.edgesAdded++;
      }

      for (const edgeId of removeEdgeIds) {
        result.mutations.push({ type: "remove_edge", edgeId });
        result.edgesRemoved++;
      }

      // ─── Stage 7: METRICS ─────────────────────────────────────────────
      const affectedNode = ctx.nodes.find((n) => n.id === affectedNodeId);
      if (affectedNode) {
        const metrics = computeMetrics(affectedNode, ctx.edges);
        result.mutations.push({
          type: "update_metrics",
          nodeId: affectedNodeId,
          importance: metrics.importance,
          stability: metrics.stability,
        });
      }
    }

    // ─── Stage 9: PERSIST ───────────────────────────────────────────────
    await persistMutations(conversationId, result.mutations, ctx);

  } catch (err) {
    console.error("[intelligence] Engine failed (non-fatal):", err);
  }

  return result;
}

// ─── State loading ──────────────────────────────────────────────────────────

async function loadPipelineContext(conversationId: string): Promise<PipelineContext> {
  const db = createServerSupabaseClient();

  // Load recent messages (last 20 — enough for windowing)
  const { data: msgData } = await db
    .from("messages")
    .select("id, role, content")
    .eq("conversation_id", conversationId)
    .is("parent_node_id", null)
    .order("created_at", { ascending: false })
    .limit(20);

  const recentMessages: ChatMessage[] = (msgData ?? [])
    .reverse()
    .map((m: { id: string; role: string; content: string }) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  // Last 2 messages are the new ones (user + assistant just persisted)
  const newMessages = recentMessages.slice(-2);

  // Load nodes with embeddings + positions
  const { data: nodeData } = await db
    .from("nodes")
    .select("id, title, summary, embedding, position_x, position_y, neighborhood_id, importance, stability")
    .eq("conversation_id", conversationId);

  // Load node_messages to get messageIds per node
  const nodeIds = (nodeData ?? []).map((n: { id: string }) => n.id);
  let nodeMsgMap = new Map<string, string[]>();
  if (nodeIds.length > 0) {
    const { data: nmData } = await db
      .from("node_messages")
      .select("node_id, message_id")
      .in("node_id", nodeIds);
    for (const nm of (nmData ?? []) as { node_id: string; message_id: string }[]) {
      const existing = nodeMsgMap.get(nm.node_id) ?? [];
      existing.push(nm.message_id);
      nodeMsgMap.set(nm.node_id, existing);
    }
  }

  const nodes: NodeState[] = (nodeData ?? []).map((n: any) => ({
    id: n.id,
    title: n.title,
    summary: n.summary,
    embedding: Array.isArray(n.embedding) ? n.embedding : null,
    messageIds: nodeMsgMap.get(n.id) ?? [],
    positionX: n.position_x,
    positionY: n.position_y,
    neighborhoodId: n.neighborhood_id,
    importance: n.importance ?? 0,
    stability: n.stability ?? 1,
  }));

  // Load edges
  const { data: edgeData } = await db
    .from("edges")
    .select("id, source_node_id, target_node_id, similarity_score")
    .eq("conversation_id", conversationId);

  const edges: EdgeState[] = (edgeData ?? []).map((e: any) => ({
    id: e.id,
    sourceNodeId: e.source_node_id,
    targetNodeId: e.target_node_id,
    similarityScore: e.similarity_score,
  }));

  // Load candidates
  const { data: candData } = await db
    .from("topic_candidates")
    .select("id, segments, embedding, confidence")
    .eq("conversation_id", conversationId)
    .eq("status", "accumulating");

  const candidates: CandidateState[] = (candData ?? []).map((c: any) => ({
    id: c.id,
    segments: Array.isArray(c.segments) ? c.segments : [],
    embedding: Array.isArray(c.embedding) ? c.embedding : null,
    confidence: c.confidence ?? 0,
  }));

  // Load engine state
  const { data: stateData } = await db
    .from("conversation_engine_state")
    .select("*")
    .eq("conversation_id", conversationId)
    .single();

  const engineState: EngineState = {
    lastWindowEmbedding: stateData?.last_window_embedding ?? null,
    lastProcessedMessageId: stateData?.last_processed_message_id ?? null,
    totalRuns: stateData?.total_engine_runs ?? 0,
  };

  return { conversationId, newMessages, recentMessages, nodes, edges, candidates, engineState };
}

// ─── Materialization helper ─────────────────────────────────────────────────

async function materializeToNode(
  conversationId: string,
  candidate: CandidateState,
  ctx: PipelineContext,
): Promise<{ mutation: GraphMutation; nodeId: string; embedding: number[] } | null> {
  const messageIds = [...new Set(candidate.segments.flatMap((s) => s.messageIds))];
  const linkedMessages = ctx.recentMessages.filter((m) => messageIds.includes(m.id));

  // If we can't find messages in recent, use what we have
  const messagesToSummarize = linkedMessages.length > 0
    ? linkedMessages
    : ctx.recentMessages.slice(-WINDOW_SIZE * 2);

  const formatted = messagesToSummarize
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

    const nodeId = crypto.randomUUID();
    const embedding = candidate.embedding ?? [];
    const position = computeNewNodePosition(embedding, ctx.nodes);

    const mutation: GraphMutation = {
      type: "materialize",
      candidateId: candidate.id,
      nodeId,
      title: parsed.title,
      summary: parsed.summary,
      messageIds,
      embedding,
      position,
    };

    console.log(`[intelligence] Materialized: "${parsed.title}"`);
    return { mutation, nodeId, embedding };
  } catch {
    return null;
  }
}

// ─── Mutation persistence ───────────────────────────────────────────────────

async function persistMutations(
  conversationId: string,
  mutations: GraphMutation[],
  ctx?: PipelineContext,
): Promise<void> {
  const db = createServerSupabaseClient();

  for (const m of mutations) {
    try {
      switch (m.type) {
        case "extend_node": {
          const links = m.messageIds.map((mid) => ({
            node_id: m.nodeId,
            message_id: mid,
          }));
          await db.from("node_messages").upsert(links, {
            onConflict: "node_id,message_id",
            ignoreDuplicates: true,
          });
          break;
        }
        case "create_candidate": {
          await db.from("topic_candidates").insert({
            id: crypto.randomUUID(),
            conversation_id: conversationId,
            status: "accumulating",
            segments: [m.segment],
            embedding: m.embedding,
            confidence: m.confidence,
          });
          break;
        }
        case "update_candidate": {
          await db.from("topic_candidates").update({
            segments: m.segments,
            embedding: m.embedding,
            confidence: m.confidence,
            last_updated_at: new Date().toISOString(),
          }).eq("id", m.candidateId);
          break;
        }
        case "materialize": {
          // Use persistNode which generates canonical embedding + evidence summary
          const linkedMsgs = ctx?.recentMessages?.filter(
            (msg: any) => m.messageIds.includes(msg.id),
          ) ?? [];
          
          const nodeForPersist = {
            id: m.nodeId,
            title: m.title,
            summary: m.summary,
            messageIds: m.messageIds,
          };
          
          // persistNode handles: evidence_summary + canonical embedding + DB insert + node_messages
          const { persistNode: persistNodeFn } = await import("@/src/lib/db/nodes");
          await persistNodeFn(conversationId, nodeForPersist, linkedMsgs, { createdBy: "ai" });

          // Set position (persistNode doesn't handle this)
          await db.from("nodes").update({
            position_x: m.position.x,
            position_y: m.position.y,
          }).eq("id", m.nodeId);

          // Mark candidate as materialized
          if (m.candidateId) {
            await db.from("topic_candidates").update({
              status: "materialized",
              materialized_node_id: m.nodeId,
            }).eq("id", m.candidateId);
          }
          // Assign to neighborhood (reload the fresh embedding from persistNode)
          const { data: freshNode } = await db
            .from("nodes")
            .select("embedding")
            .eq("id", m.nodeId)
            .single();
          const freshEmbedding = Array.isArray(freshNode?.embedding) ? freshNode.embedding as number[] : m.embedding;
          
          if (freshEmbedding && freshEmbedding.length > 0) {
            try {
              await assignNodeToNeighborhood(
                conversationId,
                m.nodeId,
                freshEmbedding,
                m.title,
              );
            } catch (err) {
              console.error("[intelligence] Neighborhood assignment failed:", err);
            }
          }
          break;
        }
        case "add_edge": {
          const [source, target] = m.sourceNodeId < m.targetNodeId
            ? [m.sourceNodeId, m.targetNodeId]
            : [m.targetNodeId, m.sourceNodeId];
          await db.from("edges").upsert({
            conversation_id: conversationId,
            source_node_id: source,
            target_node_id: target,
            relationship_type: "related",
            status: "suggested",
            similarity_score: m.similarity,
            explanation: m.explanation,
          }, {
            onConflict: "conversation_id,source_node_id,target_node_id",
            ignoreDuplicates: true,
          });
          break;
        }
        case "remove_edge": {
          await db.from("edges").delete().eq("id", m.edgeId);
          break;
        }
        case "update_metrics": {
          await db.from("nodes").update({
            importance: m.importance,
            stability: m.stability,
          }).eq("id", m.nodeId);
          break;
        }
        case "update_engine_state": {
          await db.from("conversation_engine_state").upsert({
            conversation_id: conversationId,
            last_window_embedding: m.windowEmbedding,
            last_processed_message_id: m.lastMessageId,
            total_engine_runs: m.totalRuns,
            last_engine_run_at: new Date().toISOString(),
          }, { onConflict: "conversation_id" });
          break;
        }
      }
    } catch (err) {
      console.error(`[intelligence] Mutation ${m.type} failed:`, err);
      // Continue with other mutations — partial success is acceptable
    }
  }
}
