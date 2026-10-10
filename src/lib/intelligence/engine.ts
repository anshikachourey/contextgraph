/**
 * GraphIntelligenceEngine v2 — Exchange-Based Incremental Segmentation.
 *
 * Architecture:
 * - Processes ONE exchange (user + assistant) per run.
 * - Maintains an open segment that grows via centroid update.
 * - When a new exchange diverges from the open segment, the segment freezes.
 * - Frozen segments are routed to candidates/nodes (existing pipeline).
 * - Cursor tracks progress — never rescans history.
 *
 * Called from /api/messages after persistence.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { generateEmbedding } from "@/src/lib/embeddings";
import { cosineSimilarity } from "@/src/lib/cosineSimilarity";
import { parseJsonFromLLM, isTitleSummaryResponse } from "@/src/lib/llmJson";
import { materializeNode as aiMaterializeNode, generateSemanticEdge as aiGenerateSemanticEdge, synthesizeLocalGraph as aiSynthesizeLocalGraph, checkExtendOrNewNode as aiCheckExtendOrNew } from "@/src/lib/ai";
import {
  STALE_PROMOTION_THRESHOLD,
  STALE_PROMOTION_RUNS,
  MIN_EVIDENCE_MESSAGES,
  MAX_SEGMENT_EXCHANGES,
} from "./config";
import {
  checkSegmentBoundary,
  updateSegmentCentroid,
  routeSegment,
  shouldMaterialize,
  checkMaterializationBlock,
  computeConfidence,
  computeIncrementalEdges,
  computeMetrics,
  computeNewNodePosition,
  computeCentroid,
} from "./stages";
import { assignNodeToNeighborhood } from "./neighborhoods";
import { evaluateMaterializationReadiness, MAX_LAYER_WAIT } from "./materialization-pipeline";
import { classifySegmentAction, checkTargetCompatibility } from "./action-classifier";
import { debugLog, infoLog, errorLog, emitPipelineLog } from "./logger";
import type { ChatMessage } from "@/src/types/message";
import type {
  PipelineContext,
  NodeState,
  EdgeState,
  CandidateState,
  SegmentData,
  EngineState,
  OpenSegmentState,
  GraphMutation,
  EngineResult,
} from "./types";

// ─── Structured Pipeline Log ────────────────────────────────────────────────

export interface PipelineLog {
  conversationId: string;
  timestamp: string;
  exchange: {
    userSnippet: string;
    assistantSnippet: string;
    embedding: boolean;
  } | null;
  stages: {
    conversation: {
      existingNodes: number;
      existingEdges: number;
      activeCandidates: number;
      engineRuns: number;
      openSegmentExchanges: number;
      cursor: string | null;
    };
    segmentation: {
      similarity: number | null;
      threshold: number | null;
      shouldClose: boolean;
      reason: string;
    };
    routing: {
      decision: string;
      candidateId: string | null;
      nodeId: string | null;
      confidence: number | null;
      segmentMessageCount: number;
    };
    materialization: {
      attempted: boolean;
      materialized: boolean;
      blocked: boolean;
      blockReason: string | null;
      nodeId: string | null;
      nodeTitle: string | null;
      linkedMessageCount: number;
    };
    edges: {
      added: number;
      removed: number;
    };
    neighborhoods: {
      assigned: boolean;
      neighborhoodId: string | null;
    };
    persistence: {
      totalNodesAfter: number;
      totalEdgesAfter: number;
      mutationsApplied: number;
    };
  };
  earlyExit: string | null;
  error: string | null;
}

function createEmptyLog(conversationId: string): PipelineLog {
  const log: any = {
    _v: "engine-v2.4",
    conversationId,
    timestamp: new Date().toISOString(),
    exchange: null,
    stages: {
      conversation: { existingNodes: 0, existingEdges: 0, activeCandidates: 0, engineRuns: 0, openSegmentExchanges: 0, cursor: null },
      segmentation: { similarity: null, threshold: null, shouldClose: false, reason: "" },
      routing: { decision: "none", candidateId: null, nodeId: null, confidence: null, segmentMessageCount: 0 },
      materialization: { attempted: false, materialized: false, blocked: false, blockReason: null, nodeId: null, nodeTitle: null, linkedMessageCount: 0 },
      edges: { added: 0, removed: 0 },
      neighborhoods: { assigned: false, neighborhoodId: null },
      persistence: { totalNodesAfter: 0, totalEdgesAfter: 0, mutationsApplied: 0 },
    },
    earlyExit: null,
    error: null,
  };
  return log as PipelineLog;
}

/**
 * Run the GraphIntelligenceEngine for a conversation.
 * Called from /api/messages after messages are persisted.
 * Processes the specified exchange (user + assistant).
 *
 * @param conversationId - The conversation to process
 * @param newMessageIds - The exact user + assistant message IDs just persisted
 */
export async function runIntelligenceEngine(
  conversationId: string,
  newMessageIds?: { userMessageId: string; assistantMessageId: string },
): Promise<EngineResult> {
  console.log(">>> ENTER runIntelligenceEngine", { conversationId });

  const result: EngineResult = {
    mutations: [],
    nodesExtended: 0,
    nodesCreated: 0,
    edgesAdded: 0,
    edgesRemoved: 0,
  };

  const log = createEmptyLog(conversationId);

  try {
    // ─── Load context ───────────────────────────────────────────────────
    console.log(">>> Before loadPipelineContext");
    const ctx = await loadPipelineContext(conversationId, newMessageIds);
    console.log(">>> After loadPipelineContext:", {
      hasNewExchange: !!ctx.newExchange,
      openSegExchanges: ctx.engineState.openSegment?.exchangeCount ?? 0,
      cursor: ctx.engineState.cursor?.slice(0, 8) ?? null,
      nodes: ctx.nodes.length,
      candidates: ctx.candidates.length,
    });

    log.stages.conversation = {
      existingNodes: ctx.nodes.length,
      existingEdges: ctx.edges.length,
      activeCandidates: ctx.candidates.length,
      engineRuns: ctx.engineState.totalRuns,
      openSegmentExchanges: ctx.engineState.openSegment?.exchangeCount ?? 0,
      cursor: ctx.engineState.cursor,
    };

    if (!ctx.newExchange) {
      console.log(">>> EARLY RETURN: No new exchange found after cursor");
      log.earlyExit = "No new exchange found after cursor";
      emitPipelineLog(log);
      return result;
    }

    const { user, assistant } = ctx.newExchange;
    console.log(">>> Exchange found:", { userSnippet: user.content.slice(0, 40), assistantSnippet: assistant.content.slice(0, 40) });

    log.exchange = {
      userSnippet: user.content.slice(0, 80),
      assistantSnippet: assistant.content.slice(0, 80),
      embedding: false,
    };

    // ─── Stage 1: EMBED the exchange ────────────────────────────────────
    console.log(">>> Before embedding generation");
    const exchangeText = `User: ${user.content}\nAssistant: ${assistant.content}`;
    const exchangeEmbedding = await generateEmbedding(exchangeText.slice(0, 7000));
    const userEmbedding = await generateEmbedding(user.content.slice(0, 3000));
    console.log(">>> After embedding generation:", { exchangeDim: exchangeEmbedding.length, userDim: userEmbedding.length });
    log.exchange.embedding = true;

    // ─── Stage 2: SEGMENT — decide if open segment should close ─────────
    const openSeg = ctx.engineState.openSegment;

    let segmentFrozen = false;
    let frozenSegmentMessageIds: string[] = [];
    let frozenSegmentEmbedding: number[] = [];
    let newOpenSegment: OpenSegmentState;

    console.log(">>> Before segmentation decision");
    console.log("[engine] Segmentation:", {
      openSegIsNull: !openSeg,
      openSegExchangeCount: openSeg?.exchangeCount ?? 0,
    });

    if (!openSeg) {
      // No open segment — start one with this exchange
      console.log("[engine] → Starting fresh segment (no open segment)");
      newOpenSegment = {
        startMessageId: user.id,
        endMessageId: assistant.id,
        embedding: exchangeEmbedding,
        userEmbedding,
        lastUserEmbedding: userEmbedding,
        lastExchangeEmbedding: exchangeEmbedding,
        exchangeCount: 1,
      };
      log.stages.segmentation.reason = "No open segment — started new one";
    } else if (openSeg.exchangeCount >= MAX_SEGMENT_EXCHANGES) {
      // Max segment length reached — soft chapter boundary
      segmentFrozen = true;
      console.log("[engine] → SEGMENT FROZEN (max_segment_length):", { exchangeCount: openSeg.exchangeCount });

      frozenSegmentMessageIds = await getSegmentMessageIds(
        conversationId, openSeg.startMessageId, openSeg.endMessageId,
      );
      frozenSegmentEmbedding = openSeg.embedding;

      console.log("[engine] → Frozen segment:", { messageCount: frozenSegmentMessageIds.length, closeReason: "max_segment_length" });

      newOpenSegment = {
        startMessageId: user.id,
        endMessageId: assistant.id,
        embedding: exchangeEmbedding,
        userEmbedding,
        lastUserEmbedding: userEmbedding,
        lastExchangeEmbedding: exchangeEmbedding,
        exchangeCount: 1,
      };
      log.stages.segmentation.reason = `max_segment_length (${openSeg.exchangeCount} exchanges)`;
    } else {
      // Compare new user message against open segment's user centroid
      const boundary = checkSegmentBoundary(openSeg, userEmbedding);

      console.log("[engine] Boundary check:", {
        exchangeCountBefore: openSeg.exchangeCount,
        centroidUserSim: parseFloat(boundary.centroidUserSim.toFixed(4)),
        localUserSim: boundary.localUserSim !== null ? parseFloat(boundary.localUserSim.toFixed(4)) : null,
        centroidThreshold: boundary.centroidThreshold,
        localThreshold: boundary.localThreshold,
        shouldClose: boundary.shouldClose,
        reason: boundary.reason,
      });

      log.stages.segmentation.similarity = boundary.centroidUserSim;
      log.stages.segmentation.threshold = boundary.centroidThreshold;
      log.stages.segmentation.shouldClose = boundary.shouldClose;

      // ─── Segmentation instrumentation ───────────────────────────────
      const segmentationDiagnostic = {
        currentExchange: `User: ${user.content.slice(0, 60)}`,
        centroidUserSim: parseFloat(boundary.centroidUserSim.toFixed(4)),
        localUserSim: boundary.localUserSim !== null ? parseFloat(boundary.localUserSim.toFixed(4)) : null,
        centroidThreshold: boundary.centroidThreshold,
        localThreshold: boundary.localThreshold,
        exchangeCountBefore: openSeg.exchangeCount,
        decision: boundary.shouldClose ? "freeze" : "continue",
        reason: boundary.reason,
      };

      (log as any).segmentationDiagnostic = segmentationDiagnostic;
      log.stages.segmentation.reason = boundary.reason;
      // ─── End instrumentation ────────────────────────────────────────

      if (boundary.shouldClose) {
        // FREEZE the open segment
        segmentFrozen = true;
        console.log("[engine] → SEGMENT FROZEN. Collecting message IDs...");

        // Collect message IDs from the frozen segment
        frozenSegmentMessageIds = await getSegmentMessageIds(
          conversationId, openSeg.startMessageId, openSeg.endMessageId,
        );
        frozenSegmentEmbedding = openSeg.embedding;

        console.log("[engine] → Frozen segment:", { messageCount: frozenSegmentMessageIds.length });

        // Start a NEW open segment with the current exchange
        newOpenSegment = {
          startMessageId: user.id,
          endMessageId: assistant.id,
          embedding: exchangeEmbedding,
          userEmbedding,
          lastUserEmbedding: userEmbedding,
          lastExchangeEmbedding: exchangeEmbedding,
          exchangeCount: 1,
        };
      } else {
        // APPEND to open segment — update centroids
        const updatedEmbedding = updateSegmentCentroid(
          openSeg.embedding,
          openSeg.exchangeCount,
          exchangeEmbedding,
        );
        const updatedUserEmbedding = updateSegmentCentroid(
          openSeg.userEmbedding,
          openSeg.exchangeCount,
          userEmbedding,
        );

        newOpenSegment = {
          startMessageId: openSeg.startMessageId,
          endMessageId: assistant.id,
          embedding: updatedEmbedding,
          userEmbedding: updatedUserEmbedding,
          lastUserEmbedding: userEmbedding,
          lastExchangeEmbedding: exchangeEmbedding,
          exchangeCount: openSeg.exchangeCount + 1,
        };
      }
    }

    // Update engine state
    const newEngineState: EngineState = {
      cursor: assistant.id,
      openSegment: newOpenSegment,
      totalRuns: ctx.engineState.totalRuns + 1,
    };
    result.mutations.push({ type: "update_engine_state", engineState: newEngineState });

    // ─── Stage 3: ROUTE frozen segment ──────────────────────────────────
    let affectedNodeId: string | null = null;
    let affectedNodeEmbedding: number[] | null = null;

    console.log("[engine] Post-segmentation:", {
      segmentFrozen,
      frozenMessageCount: frozenSegmentMessageIds.length,
      willRoute: segmentFrozen && frozenSegmentMessageIds.length >= 2,
      activeCandidates: ctx.candidates.length,
    });

    // Log stuck candidates
    for (const cand of ctx.candidates) {
      const candMsgs = cand.segments.reduce((s, seg) => s + seg.messageIds.length, 0);
      const runsSinceTouch = ctx.engineState.totalRuns - (cand.lastTouchedRun ?? 0);
      if (runsSinceTouch >= 2) {
        console.log(`[candidate-lifecycle] ${cand.id} STUCK`, {
          runsWithoutProgress: runsSinceTouch,
          segmentCount: cand.segments.length,
          messageCount: candMsgs,
          confidence: parseFloat(cand.confidence.toFixed(3)),
          embeddingDim: Array.isArray(cand.embedding) ? cand.embedding.length : 0,
        });
      }
    }

    if (segmentFrozen && frozenSegmentMessageIds.length >= 2) {
      log.stages.routing.segmentMessageCount = frozenSegmentMessageIds.length;

      // ─── Action Classification (replaces pure cosine routing) ─────────
      const segmentText = await loadSegmentText(frozenSegmentMessageIds);
      const graphContext = {
        nodes: ctx.nodes.map((n) => ({ id: n.id, title: n.title, summary: n.summary })),
        candidates: ctx.candidates.map((c) => ({
          id: c.id,
          segmentCount: c.segments.length,
          messageCount: c.segments.reduce((s, seg) => s + seg.messageIds.length, 0),
        })),
      };

      const actionResult = await classifySegmentAction(segmentText, graphContext);

      console.log("[engine] Action classification:", {
        action: actionResult.action,
        targetId: actionResult.targetId?.slice(0, 8) ?? null,
        reasoning: actionResult.reasoning,
      });
      log.stages.routing.decision = actionResult.action;

      // Execute the classified action
      if (actionResult.action === "discard") {
        // No graph value — skip entirely
        console.log("[engine] → Segment discarded:", actionResult.reasoning);

      } else if (actionResult.action === "defer_decision") {
        // Not enough info — skip for now
        console.log("[engine] → Segment deferred:", actionResult.reasoning);

      } else if (actionResult.action === "extend_existing_node" || actionResult.action === "attach_as_supporting_evidence") {
        // Compatibility gate: verify shared proposition before extending
        const targetNode = actionResult.targetId
          ? ctx.nodes.find((n) => n.id === actionResult.targetId)
          : ctx.nodes[0];

        if (targetNode) {
          const targetDesc = `"${targetNode.title}" — ${targetNode.summary}`;
          const compat = await checkTargetCompatibility(segmentText, targetDesc);

          console.log("[engine] Compatibility gate (node):", {
            target: targetNode.title,
            compatible: compat.compatible,
            sharedIdea: compat.sharedIdea,
            reason: compat.reason,
          });

          if (compat.compatible) {
            result.mutations.push({
              type: "extend_node",
              nodeId: targetNode.id,
              messageIds: frozenSegmentMessageIds,
            });
            result.nodesExtended++;
            affectedNodeId = targetNode.id;
            affectedNodeEmbedding = targetNode.embedding;
            log.stages.routing.nodeId = targetNode.id;
            console.log("[engine] → Extended node:", targetNode.title);
          } else {
            // Incompatible — reclassify as discard or new candidate
            console.log("[engine] → Compatibility REJECTED. Deferring segment.");
            // Don't force a candidate — just discard or defer
          }
        }

      } else if (actionResult.action === "extend_existing_candidate") {
        // Compatibility gate for candidate extension
        const targetCandidate = actionResult.targetId
          ? ctx.candidates.find((c) => c.id === actionResult.targetId)
          : ctx.candidates[0];

        if (targetCandidate) {
          // Build target description from candidate's existing segments
          const candidateDesc = targetCandidate.segments.length > 0
            ? `Candidate with ${targetCandidate.segments.length} segments, ${targetCandidate.segments.reduce((s, seg) => s + seg.messageIds.length, 0)} messages`
            : "Emerging candidate";

          const compat = await checkTargetCompatibility(segmentText, candidateDesc);

          console.log("[engine] Compatibility gate (candidate):", {
            targetId: targetCandidate.id.slice(0, 8),
            compatible: compat.compatible,
            reason: compat.reason,
          });

          if (compat.compatible) {
            const segment: SegmentData = {
              messageIds: frozenSegmentMessageIds,
              embedding: frozenSegmentEmbedding,
              completedAt: new Date().toISOString(),
            };
            const newSegments = [...targetCandidate.segments, segment];
            const newEmbedding = computeCentroid(newSegments);
            const confidence = computeConfidence(
              { ...targetCandidate, segments: newSegments, embedding: newEmbedding },
              ctx.nodes,
            );

            result.mutations.push({
              type: "update_candidate",
              candidateId: targetCandidate.id,
              segments: newSegments,
              embedding: newEmbedding,
              confidence,
            });
            console.log(`[candidate-lifecycle] ${targetCandidate.id} ACCUMULATED (compatible)`, { confidence: confidence.toFixed(3) });
          } else {
            console.log("[engine] → Candidate compatibility REJECTED. Segment not attached.");
          }
        }

      } else if (actionResult.action === "create_new_candidate") {
        // Only this path enters the materialization pipeline
        // Fall through to existing routing logic for candidate creation + materialization check
        const confidence = computeConfidence(
          { id: "", segments: [{ messageIds: frozenSegmentMessageIds, embedding: frozenSegmentEmbedding, completedAt: new Date().toISOString() }], embedding: frozenSegmentEmbedding, confidence: 0, lastTouchedRun: null },
          ctx.nodes,
        );

        const segment: SegmentData = {
          messageIds: frozenSegmentMessageIds,
          embedding: frozenSegmentEmbedding,
          completedAt: new Date().toISOString(),
        };

        result.mutations.push({
          type: "create_candidate",
          segment,
          embedding: frozenSegmentEmbedding,
          confidence,
        });

        console.log(`[candidate-lifecycle] NEW CREATED`, {
          messageCount: frozenSegmentMessageIds.length,
          confidence: confidence.toFixed(3),
          reasoning: actionResult.reasoning,
        });

        // Immediate materialization check via three-layer pipeline
        const tempCandidate: CandidateState = {
          id: "", segments: [segment], embedding: frozenSegmentEmbedding, confidence, lastTouchedRun: null,
        };
        if (shouldMaterialize(tempCandidate, ctx.nodes)) {
          const candidateMessages = await loadCandidateMessages(tempCandidate);
          const pipelineResult = await evaluateMaterializationReadiness(candidateMessages, 0);
          if (pipelineResult.shouldMaterialize) {
            const node = await materializeToNode(conversationId, tempCandidate, ctx, pipelineResult.insightSeed);
            if (node) {
              result.mutations.push(node.mutation);
              result.nodesCreated++;
              affectedNodeId = node.nodeId;
              affectedNodeEmbedding = node.embedding;
              log.stages.materialization.materialized = true;
              log.stages.materialization.nodeId = node.nodeId;
              log.stages.materialization.nodeTitle = (node.mutation as any).title;
            }
          }
        }
      }
    }

    // ─── Stage 5: RELATE ────────────────────────────────────────────────
    if (affectedNodeId && affectedNodeEmbedding && affectedNodeEmbedding.length > 0) {
      const { addEdges, removeEdgeIds } = computeIncrementalEdges(
        affectedNodeId, affectedNodeEmbedding, ctx.nodes, ctx.edges,
      );

      for (const edge of addEdges) {
        // Generate semantic relationship via LLM (limit 3 per run for cost)
        let relationship_type = "related";
        let explanation = "";
        if (result.edgesAdded < 3) {
          const sourceNode = ctx.nodes.find((n) => n.id === affectedNodeId);
          const targetNode = ctx.nodes.find((n) => n.id === edge.targetNodeId);
          if (sourceNode && targetNode) {
            const semantic = await generateSemanticEdge(sourceNode, targetNode);
            if (semantic) {
              relationship_type = semantic.relationship_type;
              explanation = semantic.explanation;
              // Respect directionality
              if (semantic.direction === "b_to_a") {
                result.mutations.push({
                  type: "add_edge",
                  sourceNodeId: edge.targetNodeId,
                  targetNodeId: affectedNodeId,
                  similarity: edge.similarity,
                  relationship_type,
                  explanation,
                });
                result.edgesAdded++;
                continue;
              }
            }
          }
        }
        result.mutations.push({
          type: "add_edge",
          sourceNodeId: affectedNodeId,
          targetNodeId: edge.targetNodeId,
          similarity: edge.similarity,
          relationship_type,
          explanation,
        });
        result.edgesAdded++;
      }
      for (const edgeId of removeEdgeIds) {
        result.mutations.push({ type: "remove_edge", edgeId });
        result.edgesRemoved++;
      }

      log.stages.edges.added = result.edgesAdded;
      log.stages.edges.removed = result.edgesRemoved;

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

    // ─── Stage 6: STALE CANDIDATE PROMOTION ────────────────────────────
    // Check candidates that haven't grown for STALE_PROMOTION_RUNS.
    // Promote them if they meet the lower threshold.
    if (!segmentFrozen || !affectedNodeId) {
      // Only run stale promotion when the current turn didn't already materialize something
      const stalePromoted = await promoteStaleCandidates(
        conversationId, ctx, result, log,
      );
      if (stalePromoted) {
        // Update affected node for edge computation
        affectedNodeId = stalePromoted.nodeId;
        affectedNodeEmbedding = stalePromoted.embedding;
      }
    }

    // ─── Stage 7: GRAPH SYNTHESIS PASS ────────────────────────────────
    // After materialization, review local subgraph and improve coherence
    if (result.nodesCreated > 0 && affectedNodeId && ctx.nodes.length > 0) {
      const synthesisMutations = await runGraphSynthesisPass(
        affectedNodeId, ctx, result,
      );
      for (const m of synthesisMutations) {
        result.mutations.push(m);
      }
    }

    // ─── Stage 8: GRAPH BOOTSTRAP FALLBACK ─────────────────────────────
    // Truly idempotent: uses INSERT placeholder to claim, then populates.
    // Also skips if this run already created a node.
    if (result.nodesCreated === 0 && ctx.nodes.length === 0 &&
        !result.mutations.some((m) => m.type === "materialize")) {
      const db2 = createServerSupabaseClient();

      // Count existing nodes (fresh DB query)
      const { count } = await db2
        .from("nodes")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId);

      if ((count ?? 0) > 0) {
        console.log("[graph-bootstrap] skipped: node already exists in DB");
      } else {
        const { data: allMsgs } = await db2
          .from("messages")
          .select("id, role, content")
          .eq("conversation_id", conversationId)
          .is("parent_node_id", null)
          .order("created_at", { ascending: true });

        const substantiveUserMsgs = (allMsgs ?? []).filter(
          (m: any) => m.role === "user" && m.content.length > 20,
        );

        if (substantiveUserMsgs.length >= 4) {
          // Claim bootstrap slot with placeholder (blocks concurrent runs)
          const nodeId = crypto.randomUUID();
          const { error: claimErr } = await db2.from("nodes").insert({
            id: nodeId,
            conversation_id: conversationId,
            title: "__bootstrap_pending__",
            summary: "",
          });

          if (claimErr) {
            console.log("[graph-bootstrap] skipped: claim failed (concurrent run)");
          } else {
            // ─── USER-EVIDENCE-ONLY BOOTSTRAP ───────────────────────────
            // Only user messages are ground truth. Assistant messages are excluded.
            // Select a coherent cluster of user messages sharing one proposition.
            const allUserMsgs = (allMsgs ?? [])
              .filter((m: any) => m.role === "user" && m.content.length > 20) as Array<{ id: string; role: string; content: string }>;

            // Find the dominant coherent user thread:
            // Take the largest consecutive run of user messages that share a topic.
            // Exclude utility requests (translations, lookups, commands).
            const UTILITY_PATTERN = /^(translate|can you translate|look up|search|what is|find me|play|show me|open|send)/i;

            const substantiveUserMsgs = allUserMsgs.filter(
              (m) => !UTILITY_PATTERN.test(m.content.trim()),
            );

            if (substantiveUserMsgs.length < 2) {
              // Not enough substantive user content for a coherent node
              await db2.from("nodes").delete().eq("id", nodeId);
              console.log("[graph-bootstrap] skipped: insufficient substantive user messages after filtering");
            } else {
              // Format ONLY substantive user messages — no assistant text
              const userFormatted = substantiveUserMsgs
                .map((m) => `User: ${m.content}`)
                .join("\n")
                .slice(0, 3000);

              // Materialize with explicit user-provenance constraint
              const nodeResult = await aiMaterializeNode(
                userFormatted,
                "",
                null, // no insight seed
              );

              if (nodeResult) {
                const nodeEmbedding = await generateEmbedding(
                  `Title: ${nodeResult.title}\nSummary: ${nodeResult.summary}`,
                ).catch(() => [] as number[]);

                // Populate the placeholder
                await db2.from("nodes").update({
                  title: nodeResult.title,
                  summary: nodeResult.summary,
                  embedding: nodeEmbedding,
                }).eq("id", nodeId);

                // Link ONLY the substantive user messages (not assistant responses)
                const links = substantiveUserMsgs.map((m) => ({ node_id: nodeId, message_id: m.id }));
                await db2.from("node_messages").insert(links);

                result.nodesCreated++;
                affectedNodeId = nodeId;
                affectedNodeEmbedding = nodeEmbedding;
                console.log("[graph-bootstrap] created initial node:", nodeResult.title, "from", substantiveUserMsgs.length, "user messages");
              } else {
                await db2.from("nodes").delete().eq("id", nodeId);
                console.log("[graph-bootstrap] skipped: AI returned null");
              }
            }
          }
        } else {
          console.log("[graph-bootstrap] skipped:", substantiveUserMsgs.length, "msgs (need 4+)");
        }
      }
    }

    // ─── Stage 8b: PROACTIVE EDGE CREATION ───────────────────────────────
    // After any node is created/extended, connect it to related existing nodes
    if (affectedNodeId && affectedNodeEmbedding && affectedNodeEmbedding.length > 0) {
      const db3 = createServerSupabaseClient();
      const { data: allNodes } = await db3
        .from("nodes")
        .select("id, title, summary, embedding")
        .eq("conversation_id", conversationId)
        .neq("title", "__bootstrap_pending__");

      const otherNodes = (allNodes ?? [])
        .filter((n: any) => n.id !== affectedNodeId && Array.isArray(n.embedding) && n.embedding.length > 0);

      if (otherNodes.length > 0) {
        // Check existing edges
        const { data: existEdges } = await db3
          .from("edges")
          .select("source_node_id, target_node_id")
          .eq("conversation_id", conversationId);
        const edgeSet = new Set(
          (existEdges ?? []).map((e: any) => `${e.source_node_id}:${e.target_node_id}`),
        );

        // Get affected node's title/summary
        const affectedMutation = result.mutations.find(
          (m) => m.type === "materialize" && m.nodeId === affectedNodeId,
        ) as any;
        const affectedInfo = affectedMutation
          ? { title: affectedMutation.title, summary: affectedMutation.summary }
          : (allNodes ?? []).find((n: any) => n.id === affectedNodeId) as any ?? { title: "", summary: "" };

        // Top 2 neighbors by similarity
        const neighbors = otherNodes
          .map((n: any) => ({ ...n, sim: cosineSimilarity(affectedNodeEmbedding!, n.embedding) }))
          .sort((a: any, b: any) => b.sim - a.sim)
          .slice(0, 2);

        for (const nb of neighbors) {
          const pairA = `${affectedNodeId}:${nb.id}`;
          const pairB = `${nb.id}:${affectedNodeId}`;
          if (edgeSet.has(pairA) || edgeSet.has(pairB)) continue;

          const edgeResult = await aiGenerateSemanticEdge(
            affectedInfo.title, affectedInfo.summary,
            nb.title, nb.summary,
          );

          if (edgeResult && edgeResult.relationship_type && edgeResult.relationship_type !== "related") {
            const [src, tgt] = edgeResult.direction === "b_to_a"
              ? [nb.id, affectedNodeId]
              : [affectedNodeId, nb.id];

            result.mutations.push({
              type: "add_edge",
              sourceNodeId: src,
              targetNodeId: tgt,
              similarity: nb.sim,
              relationship_type: edgeResult.relationship_type,
              explanation: edgeResult.explanation,
            });
            result.edgesAdded++;
            console.log("[engine] Proactive edge:", affectedInfo.title, "→", nb.title, ":", edgeResult.relationship_type);
          }
        }
      }
    }

    // ─── Stage 9: PERSIST ───────────────────────────────────────────────
    console.log(">>> Pre-persist summary:", {
      mutationCount: result.mutations.length,
      mutationTypes: result.mutations.map((m) => m.type),
      nodesCreated: result.nodesCreated,
      nodesExtended: result.nodesExtended,
      edgesAdded: result.edgesAdded,
    });
    log.stages.persistence.mutationsApplied = result.mutations.length;
    log.stages.persistence.totalNodesAfter = ctx.nodes.length + result.nodesCreated;
    log.stages.persistence.totalEdgesAfter = ctx.edges.length + result.edgesAdded - result.edgesRemoved;
    await persistMutations(conversationId, result.mutations, ctx);

  } catch (err) {
    log.error = err instanceof Error ? err.message : String(err);
    console.error(">>> ENGINE CAUGHT ERROR:", err);
    errorLog("[engine] Engine failed (non-fatal):", err);
  }

  emitPipelineLog(log);
  return result;
}

// ─── State loading ──────────────────────────────────────────────────────────

async function loadPipelineContext(
  conversationId: string,
  newMessageIds?: { userMessageId: string; assistantMessageId: string },
): Promise<PipelineContext> {
  const db = createServerSupabaseClient();

  // Load engine state
  debugLog("[engine] loading state for:", conversationId);

  const { data: stateData, error: stateError } = await db
    .from("conversation_engine_state")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  debugLog("[engine] state loaded", {
    hasData: stateData !== null,
    error: stateError?.message ?? null,
  });

  if (stateError) {
    errorLog("[engine] Failed to load engine state:", stateError.message);
  }

  const engineState: EngineState = {
    cursor: stateData?.cursor ?? null,
    openSegment: stateData?.open_segment ?? null,
    totalRuns: stateData?.total_engine_runs ?? 0,
  };

  debugLog("[engine] mapped state", {
    cursor: engineState.cursor,
    openSegmentNull: engineState.openSegment === null,
    openSegmentExchanges: engineState.openSegment?.exchangeCount ?? "N/A",
    totalRuns: engineState.totalRuns,
  });

  // ─── Resolve the new exchange ───────────────────────────────────────
  // Prefer explicit message IDs passed from the caller (guaranteed correct pairing).
  // Fallback to DB query only if not provided.
  let newExchange: PipelineContext["newExchange"] = null;

  if (newMessageIds) {
    // Load the exact messages by ID — guaranteed correct pairing
    const { data: pairData } = await db
      .from("messages")
      .select("id, role, content")
      .in("id", [newMessageIds.userMessageId, newMessageIds.assistantMessageId]);

    const pairMsgs = (pairData ?? []) as Array<{ id: string; role: string; content: string }>;
    const userMsg = pairMsgs.find((m) => m.id === newMessageIds.userMessageId);
    const assistantMsg = pairMsgs.find((m) => m.id === newMessageIds.assistantMessageId);

    if (userMsg && assistantMsg) {
      newExchange = {
        user: { id: userMsg.id, role: "user", content: userMsg.content },
        assistant: { id: assistantMsg.id, role: "assistant", content: assistantMsg.content },
      };
    }
  } else {
    // Fallback: find latest unprocessed exchange from DB
    if (engineState.cursor) {
      const { data: cursorMsg } = await db
        .from("messages")
        .select("created_at")
        .eq("id", engineState.cursor)
        .single();

      if (cursorMsg) {
        const { data: afterMsgs } = await db
          .from("messages")
          .select("id, role, content")
          .eq("conversation_id", conversationId)
          .is("parent_node_id", null)
          .gt("created_at", cursorMsg.created_at)
          .order("created_at", { ascending: true })
          .limit(10);

        const msgs = (afterMsgs ?? []) as Array<{ id: string; role: string; content: string }>;
        // Find the first user followed by first assistant (in order)
        const userMsg = msgs.find((m) => m.role === "user");
        if (userMsg) {
          const userIdx = msgs.indexOf(userMsg);
          const assistantMsg = msgs.slice(userIdx + 1).find((m) => m.role === "assistant");
          if (assistantMsg) {
            newExchange = {
              user: { id: userMsg.id, role: "user", content: userMsg.content },
              assistant: { id: assistantMsg.id, role: "assistant", content: assistantMsg.content },
            };
          }
        }
      }
    } else {
      // No cursor — get the last complete exchange
      const { data: recentMsgs } = await db
        .from("messages")
        .select("id, role, content")
        .eq("conversation_id", conversationId)
        .is("parent_node_id", null)
        .order("created_at", { ascending: false })
        .limit(10);

      const msgs = ((recentMsgs ?? []) as Array<{ id: string; role: string; content: string }>).reverse();
      for (let i = msgs.length - 2; i >= 0; i--) {
        if (msgs[i].role === "user" && msgs[i + 1]?.role === "assistant") {
          newExchange = {
            user: { id: msgs[i].id, role: "user", content: msgs[i].content },
            assistant: { id: msgs[i + 1].id, role: "assistant", content: msgs[i + 1].content },
          };
          break;
        }
      }
    }
  }

  // Load nodes with embeddings
  const { data: nodeData } = await db
    .from("nodes")
    .select("id, title, summary, embedding, position_x, position_y, neighborhood_id, importance, stability")
    .eq("conversation_id", conversationId);

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

  // Load active candidates
  const { data: candData } = await db
    .from("topic_candidates")
    .select("id, segments, embedding, confidence, last_touched_run")
    .eq("conversation_id", conversationId)
    .eq("status", "accumulating");

  const candidates: CandidateState[] = (candData ?? []).map((c: any) => ({
    id: c.id,
    segments: Array.isArray(c.segments) ? c.segments : [],
    embedding: Array.isArray(c.embedding) ? c.embedding : null,
    confidence: c.confidence ?? 0,
    lastTouchedRun: c.last_touched_run ?? null,
  }));

  return { conversationId, newExchange, nodes, edges, candidates, engineState };
}

// ─── Helper: get message IDs in a range ─────────────────────────────────────

async function getSegmentMessageIds(
  conversationId: string,
  startMessageId: string,
  endMessageId: string,
): Promise<string[]> {
  const db = createServerSupabaseClient();

  // Get timestamps for range boundaries
  const { data: startMsg } = await db
    .from("messages")
    .select("created_at")
    .eq("id", startMessageId)
    .single();

  const { data: endMsg } = await db
    .from("messages")
    .select("created_at")
    .eq("id", endMessageId)
    .single();

  if (!startMsg || !endMsg) return [];

  const { data: msgs } = await db
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .is("parent_node_id", null)
    .gte("created_at", startMsg.created_at)
    .lte("created_at", endMsg.created_at)
    .order("created_at", { ascending: true });

  return (msgs ?? []).map((m: { id: string }) => m.id);
}

// ─── Materialization helper ─────────────────────────────────────────────────

async function materializeToNode(
  conversationId: string,
  candidate: CandidateState,
  ctx: PipelineContext,
  insightSeed?: string | null,
): Promise<{ mutation: GraphMutation; nodeId: string; embedding: number[] } | null> {
  const messageIds = [...new Set(candidate.segments.flatMap((s) => s.messageIds))];

  // Load the actual messages for LLM summarization
  const db = createServerSupabaseClient();
  const { data: msgData } = await db
    .from("messages")
    .select("id, role, content")
    .in("id", messageIds)
    .order("created_at", { ascending: true });

  const linkedMessages = (msgData ?? []) as Array<{ id: string; role: string; content: string }>;

  const formatted = linkedMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n")
    .slice(0, 4000);

  if (!formatted) return null;

  // ─── Graph-aware context: load nearest neighbor nodes ─────────────
  let neighborContext = "";
  if (candidate.embedding && candidate.embedding.length > 0 && ctx.nodes.length > 0) {
    const scored = ctx.nodes
      .filter((n) => n.embedding && n.embedding.length > 0)
      .map((n) => ({
        title: n.title,
        summary: n.summary,
        sim: cosineSimilarity(candidate.embedding!, n.embedding!),
      }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3);

    if (scored.length > 0) {
      neighborContext = scored
        .map((n) => `• "${n.title}" — ${n.summary}`)
        .join("\n");
    }
  }

  // ─── Generate node title/summary via AI abstraction ────────────────
  try {
    const result = await aiMaterializeNode(formatted, neighborContext, insightSeed);
    if (!result) return null;

    const nodeId = crypto.randomUUID();
    const embedding = candidate.embedding ?? [];
    const position = computeNewNodePosition(embedding, ctx.nodes);

    const mutation: GraphMutation = {
      type: "materialize",
      candidateId: candidate.id,
      nodeId,
      title: result.title,
      summary: result.summary,
      messageIds,
      embedding,
      position,
    };

    infoLog("[engine] Node materialized", { title: result.title, nodeId });
    return { mutation, nodeId, embedding };
  } catch {
    return null;
  }
}

// ─── Helper: load formatted messages for a candidate ────────────────────────

async function loadSegmentText(messageIds: string[]): Promise<string> {
  if (messageIds.length === 0) return "";
  const db = createServerSupabaseClient();
  const { data: msgData } = await db
    .from("messages")
    .select("role, content")
    .in("id", messageIds)
    .order("created_at", { ascending: true });
  if (!msgData || msgData.length === 0) return "";
  return (msgData as Array<{ role: string; content: string }>)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n")
    .slice(0, 4000);
}

async function loadCandidateMessages(candidate: CandidateState): Promise<string> {
  const messageIds = [...new Set(candidate.segments.flatMap((s) => s.messageIds))];
  if (messageIds.length === 0) return "";

  const db = createServerSupabaseClient();
  const { data: msgData } = await db
    .from("messages")
    .select("role, content")
    .in("id", messageIds)
    .order("created_at", { ascending: true });

  if (!msgData || msgData.length === 0) return "";

  return (msgData as Array<{ role: string; content: string }>)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n")
    .slice(0, 4000);
}

// ─── Semantic Edge Generation ───────────────────────────────────────────────

async function generateSemanticEdge(
  sourceNode: NodeState,
  targetNode: NodeState,
): Promise<{ relationship_type: string; explanation: string; direction: string } | null> {
  return aiGenerateSemanticEdge(
    sourceNode.title,
    sourceNode.summary,
    targetNode.title,
    targetNode.summary,
  );
}

// ─── Graph Synthesis Pass ───────────────────────────────────────────────────

async function runGraphSynthesisPass(
  newNodeId: string,
  ctx: PipelineContext,
  result: EngineResult,
): Promise<GraphMutation[]> {
  const mutations: GraphMutation[] = [];

  // Find the new node's data from the materialize mutation
  const materializeMutation = result.mutations.find(
    (m) => m.type === "materialize" && m.nodeId === newNodeId,
  ) as Extract<GraphMutation, { type: "materialize" }> | undefined;

  if (!materializeMutation) return mutations;

  // Get nearest neighbors from existing nodes
  const newEmbedding = materializeMutation.embedding;
  if (!newEmbedding || newEmbedding.length === 0) return mutations;

  const neighbors = ctx.nodes
    .filter((n) => n.embedding && n.embedding.length > 0)
    .map((n) => ({
      ...n,
      sim: cosineSimilarity(newEmbedding, n.embedding!),
    }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3);

  if (neighbors.length === 0) return mutations;

  // Format the local subgraph for LLM review
  const newNodeFormatted = `NEW NODE:\nTitle: "${materializeMutation.title}"\nSummary: "${materializeMutation.summary}"`;

  const neighborsFormatted = neighbors
    .map((n) => `• "${n.title}" — ${n.summary}`)
    .join("\n");

  // Find existing edges in this subgraph
  const subgraphNodeIds = new Set([newNodeId, ...neighbors.map((n) => n.id)]);
  const localEdges = ctx.edges.filter(
    (e) => subgraphNodeIds.has(e.sourceNodeId) && subgraphNodeIds.has(e.targetNodeId),
  );
  const edgesFormatted = localEdges.length > 0
    ? localEdges.map((e) => {
        const src = neighbors.find((n) => n.id === e.sourceNodeId);
        const tgt = neighbors.find((n) => n.id === e.targetNodeId);
        return `• "${src?.title ?? "New Node"}" → "${tgt?.title ?? "New Node"}" (${e.similarityScore.toFixed(2)})`;
      }).join("\n")
    : "None yet";

  try {
    const synthesisResult = await aiSynthesizeLocalGraph(
      newNodeFormatted,
      neighborsFormatted,
      edgesFormatted,
      { newNodeId, neighborIds: neighbors.map((n) => n.id) },
    );

    if (!synthesisResult) return mutations;

    // Process node improvements
    for (const imp of synthesisResult.nodeImprovements) {
      if (subgraphNodeIds.has(imp.nodeId)) {
        mutations.push({
          type: "update_node_content",
          nodeId: imp.nodeId,
          title: imp.improvedTitle,
          summary: imp.improvedSummary,
        });
      }
    }

    // Process new edges
    for (const edge of synthesisResult.newEdges) {
      if (subgraphNodeIds.has(edge.sourceNodeId) && subgraphNodeIds.has(edge.targetNodeId)) {
        mutations.push({
          type: "add_edge",
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          similarity: 0.5,
          relationship_type: edge.relationship_type,
          explanation: edge.explanation,
        });
      }
    }

    // Process edge removals
    for (const edgeId of synthesisResult.removeEdgeIds) {
      if (localEdges.some((e) => e.id === edgeId)) {
        mutations.push({ type: "remove_edge", edgeId });
      }
    }

    if (mutations.length > 0) {
      infoLog("[engine] Synthesis pass", {
        improvements: mutations.filter((m) => m.type === "update_node_content").length,
        newEdges: mutations.filter((m) => m.type === "add_edge").length,
        removedEdges: mutations.filter((m) => m.type === "remove_edge").length,
      });
    }
  } catch {
    // Non-fatal — synthesis is optional enhancement
  }

  return mutations;
}

// ─── Stale Candidate Promotion ──────────────────────────────────────────────

async function promoteStaleCandidates(
  conversationId: string,
  ctx: PipelineContext,
  result: EngineResult,
  log: PipelineLog,
): Promise<{ nodeId: string; embedding: number[] } | null> {
  const currentRun = ctx.engineState.totalRuns;
  const candidatesChecked: string[] = [];
  let promoted: { nodeId: string; embedding: number[] } | null = null;

  for (const candidate of ctx.candidates) {
    const totalMessages = candidate.segments.reduce(
      (sum, s) => sum + s.messageIds.length, 0,
    );
    const touchedRun = candidate.lastTouchedRun ?? 0;
    const runsSinceTouch = currentRun - touchedRun;
    const isStale = runsSinceTouch >= STALE_PROMOTION_RUNS;

    candidatesChecked.push(candidate.id);

    if (!isStale) continue;
    if (totalMessages < MIN_EVIDENCE_MESSAGES) continue;
    if (candidate.confidence < STALE_PROMOTION_THRESHOLD) continue;

    // Pass block checks
    const blockCheck = checkMaterializationBlock(candidate);
    if (blockCheck.blocked) continue;

    // Promote this candidate — run pipeline first
    const candidateMessages = await loadCandidateMessages(candidate);
    const pipelineResult = await evaluateMaterializationReadiness(candidateMessages, runsSinceTouch);

    if (!pipelineResult.shouldMaterialize) {
      debugLog("[engine] Stale candidate pipeline blocked", {
        candidateId: candidate.id,
        state: pipelineResult.layer1.state,
      });
      continue;
    }

    infoLog("[engine] Stale promotion", {
      candidateId: candidate.id,
      confidence: parseFloat(candidate.confidence.toFixed(3)),
      messages: totalMessages,
      staleRuns: runsSinceTouch,
      insightSeed: pipelineResult.insightSeed,
    });

    const node = await materializeToNode(conversationId, candidate, ctx, pipelineResult.insightSeed);
    if (node) {
      result.mutations.push(node.mutation);
      result.nodesCreated++;
      promoted = { nodeId: node.nodeId, embedding: node.embedding };

      log.stages.materialization.materialized = true;
      log.stages.materialization.nodeId = node.nodeId;
      log.stages.materialization.nodeTitle = (node.mutation as any).title;
      log.stages.materialization.linkedMessageCount = totalMessages;

      // Only promote one per run to keep things controlled
      break;
    }
  }

  if (candidatesChecked.length > 0) {
    (log as any).stalePromotion = {
      candidatesChecked: candidatesChecked.length,
      promoted: promoted !== null,
      promotedNodeId: promoted?.nodeId ?? null,
    };
  }

  return promoted;
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
            last_touched_run: ctx?.engineState?.totalRuns ?? 0,
          });
          break;
        }
        case "update_candidate": {
          await db.from("topic_candidates").update({
            segments: m.segments,
            embedding: m.embedding,
            confidence: m.confidence,
            last_updated_at: new Date().toISOString(),
            last_touched_run: ctx?.engineState?.totalRuns ?? 0,
          }).eq("id", m.candidateId);
          break;
        }
        case "block_candidate": {
          await db.from("topic_candidates").update({
            status: "blocked",
            last_updated_at: new Date().toISOString(),
          }).eq("id", m.candidateId);
          break;
        }
        case "materialize": {
          // Load linked messages for persistNode
          const linkedMsgData = await db
            .from("messages")
            .select("id, role, content")
            .in("id", m.messageIds)
            .order("created_at", { ascending: true });

          const linkedMsgs = ((linkedMsgData.data ?? []) as Array<{ id: string; role: string; content: string }>)
            .map((msg) => ({ id: msg.id, role: msg.role as "user" | "assistant", content: msg.content }));

          const nodeForPersist = {
            id: m.nodeId,
            title: m.title,
            summary: m.summary,
            messageIds: m.messageIds,
          };

          const { persistNode: persistNodeFn } = await import("@/src/lib/db/nodes");
          await persistNodeFn(conversationId, nodeForPersist, linkedMsgs, { createdBy: "ai" });

          await db.from("nodes").update({
            position_x: m.position.x,
            position_y: m.position.y,
          }).eq("id", m.nodeId);

          if (m.candidateId) {
            await db.from("topic_candidates").update({
              status: "materialized",
              materialized_node_id: m.nodeId,
            }).eq("id", m.candidateId);
          }

          // Neighborhood assignment
          const { data: freshNode } = await db
            .from("nodes")
            .select("embedding")
            .eq("id", m.nodeId)
            .single();
          const freshEmbedding = Array.isArray(freshNode?.embedding) ? freshNode.embedding as number[] : m.embedding;

          if (freshEmbedding && freshEmbedding.length > 0) {
            try {
              await assignNodeToNeighborhood(conversationId, m.nodeId, freshEmbedding, m.title);
              // Log would go here but we don't have access to log in this scope
            } catch (err) {
              errorLog("[engine] Neighborhood assignment failed:", err);
            }
          }
          break;
        }
        case "add_edge": {
          // Respect directionality from the mutation (source/target already set by caller)
          await db.from("edges").upsert({
            conversation_id: conversationId,
            source_node_id: m.sourceNodeId,
            target_node_id: m.targetNodeId,
            relationship_type: m.relationship_type || "related",
            status: "suggested",
            similarity_score: m.similarity,
            explanation: m.explanation,
          }, {
            onConflict: "conversation_id,source_node_id,target_node_id",
            ignoreDuplicates: false,
          });
          break;
        }
        case "remove_edge": {
          await db.from("edges").delete().eq("id", m.edgeId);
          break;
        }
        case "update_node_content": {
          await db.from("nodes").update({
            title: m.title,
            summary: m.summary,
          }).eq("id", m.nodeId);
          debugLog("[engine] Node content updated", { nodeId: m.nodeId, title: m.title });
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
          const { data: upsertResult, error: upsertError } = await db
            .from("conversation_engine_state")
            .upsert({
              conversation_id: conversationId,
              cursor: m.engineState.cursor,
              open_segment: m.engineState.openSegment,
              total_engine_runs: m.engineState.totalRuns,
              last_engine_run_at: new Date().toISOString(),
            }, { onConflict: "conversation_id" })
            .select()
            .single();

          if (upsertError) {
            errorLog("[engine] Engine state upsert FAILED:", upsertError.message);
          } else {
            debugLog("[engine] state saved", {
              cursor: upsertResult?.cursor,
              runs: upsertResult?.total_engine_runs,
            });
          }
          break;
        }
      }
    } catch (err) {
      errorLog(`[engine] Mutation ${m.type} failed:`, err);
    }
  }
}
