/**
 * Graph-related AI functions — node generation, edges, synthesis.
 *
 * These are the high-level domain functions the application calls.
 * They handle prompt construction and response parsing internally.
 */

import { complete, type CompletionMessage } from "./provider";
import { NODE_MODEL, EDGE_MODEL, GRAPH_SYNTHESIS_MODEL, SUMMARY_MODEL, STRUCTURE_MODEL } from "./models";
import { parseJsonFromLLM } from "@/src/lib/llmJson";

// ─── Node Materialization ───────────────────────────────────────────────────

export type MaterializeNodeResult = {
  title: string;
  summary: string;
};

export async function materializeNode(
  formattedMessages: string,
  neighborContext: string,
  insightSeed?: string | null,
): Promise<MaterializeNodeResult | null> {
  const insightGuidance = insightSeed
    ? `\nINSIGHT SEED (use this as the foundation — the conversation produced this specific realization):\n"${insightSeed}"\nBuild the title and summary around this insight. Do not ignore it.\n`
    : "";

  const systemPrompt = `You are synthesizing a knowledge graph node from a conversation segment. This node will represent what was REALIZED, LEARNED, or EMOTIONALLY UNDERSTOOD — not merely what was discussed.

Your job is to capture the INSIGHT — the underlying realization, emotional truth, or conceptual breakthrough that emerged from this exchange. Think of it as writing the title and abstract of an essay that captures the core idea.
${insightGuidance}
${neighborContext ? `EXISTING NEARBY NODES (differentiate from these — capture what's unique about THIS segment):\n${neighborContext}\n` : ""}Return JSON:
{
  "title": "<the core insight, realization, or emotional theme — max 80 chars — NOT a topic label>",
  "summary": "<what was concluded, learned, or understood — max 300 chars — answer 'What insight emerged?' not 'What was discussed?'>"
}

RULES:
- Titles should read like essay titles or personal realizations, not topic categories
- Summaries should articulate conclusions, not replay the conversation
- Capture emotional themes and personal reflections when present
- Focus on WHY something matters to the person, not just WHAT was said

BAD (topic labels): "Exploring Rock Music", "Discussion About Art Decline", "Understanding Personal Growth"
GOOD (insights): "Searching for Art That Feels Exciting Again", "Rock as the Sound of Authentic Emotion", "Building an Interesting Persona Through Distinct Taste"

BAD (summaries that replay): "They discussed how art has declined and talked about rock music"
GOOD (summaries that conclude): "A realization that mainstream art lost its emotional charge, leading to rock music as an art form that still provokes genuine feeling and becomes a foundation for personal identity"`;

  try {
    const result = await complete({
      model: NODE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `CONVERSATION SEGMENT:\n\n${formattedMessages}\n\nSynthesize the core insight into a knowledge graph node. Return JSON only.` },
      ],
      temperature: 0.6,
      maxTokens: 300,
    });

    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed.title !== "string" || typeof parsed.summary !== "string") {
      return null;
    }
    return { title: parsed.title, summary: parsed.summary };
  } catch {
    return null;
  }
}

// ─── Semantic Edge Generation ───────────────────────────────────────────────

export type SemanticEdgeResult = {
  relationship_type: string;
  explanation: string;
  direction: string;
};

export async function generateSemanticEdge(
  sourceTitle: string,
  sourceSummary: string,
  targetTitle: string,
  targetSummary: string,
): Promise<SemanticEdgeResult | null> {
  try {
    const result = await complete({
      model: EDGE_MODEL,
      messages: [
        {
          role: "system",
          content: `Two nodes in a knowledge graph represent ideas from the same conversation. Determine how they are conceptually related.

Return JSON:
{
  "relationship_type": "<verb phrase describing the relationship, e.g. 'led to exploration of', 'evolved into', 'emotionally connected to', 'inspired', 'contrasts with', 'became foundation for', 'deepened understanding of'>",
  "explanation": "<one sentence explaining the conceptual connection>",
  "direction": "a_to_b" | "b_to_a" | "bidirectional"
}

Rules:
- relationship_type should be a short verb phrase (2-5 words)
- explanation should be one clear sentence
- direction indicates flow: did A lead to B, or B to A, or mutual?
- Focus on conceptual/emotional evolution, not surface similarity`,
        },
        {
          role: "user",
          content: `Node A: "${sourceTitle}" — ${sourceSummary}\n\nNode B: "${targetTitle}" — ${targetSummary}\n\nHow are these ideas connected? Return JSON only.`,
        },
      ],
      temperature: 0.5,
      maxTokens: 150,
    });

    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed.relationship_type !== "string" || typeof parsed.explanation !== "string") {
      return null;
    }
    return {
      relationship_type: parsed.relationship_type as string,
      explanation: parsed.explanation as string,
      direction: (parsed.direction as string) ?? "a_to_b",
    };
  } catch {
    return null;
  }
}

// ─── Graph Synthesis Pass ───────────────────────────────────────────────────

export type SynthesisResult = {
  nodeImprovements: Array<{ nodeId: string; improvedTitle: string; improvedSummary: string }>;
  newEdges: Array<{ sourceNodeId: string; targetNodeId: string; relationship_type: string; explanation: string }>;
  removeEdgeIds: string[];
};

export async function synthesizeLocalGraph(
  newNodeFormatted: string,
  neighborsFormatted: string,
  edgesFormatted: string,
  nodeIds: { newNodeId: string; neighborIds: string[] },
): Promise<SynthesisResult | null> {
  try {
    const result = await complete({
      model: GRAPH_SYNTHESIS_MODEL,
      messages: [
        {
          role: "system",
          content: `You are reviewing a local section of a knowledge graph that represents how someone's ideas evolved during a conversation. Your goal: make it read like an externalized memory — capturing what was learned, realized, and how ideas evolved.

Return JSON:
{
  "nodeImprovements": [
    { "nodeId": "...", "improvedTitle": "...", "improvedSummary": "..." }
  ],
  "newEdges": [
    { "sourceNodeId": "...", "targetNodeId": "...", "relationship_type": "...", "explanation": "..." }
  ],
  "removeEdgeIds": []
}

Rules:
- Only improve nodes that are clearly shallow (topic labels, message replays, generic descriptions)
- Only add edges that explain meaningful conceptual evolution between ideas
- Do NOT improve nodes that already capture genuine insight
- If everything looks good, return empty arrays
- relationship_type should be a verb phrase (e.g., "led to", "evolved into", "became foundation for")
- Keep improvements concise — better titles max 80 chars, better summaries max 300 chars`,
        },
        {
          role: "user",
          content: `${newNodeFormatted}\n\nNEARBY EXISTING NODES:\n${neighborsFormatted}\n\nEXISTING EDGES:\n${edgesFormatted}\n\nThe new node ID is: "${nodeIds.newNodeId}"\nNeighbor IDs: ${nodeIds.neighborIds.map((id) => `"${id}"`).join(", ")}\n\nReview this subgraph. Return JSON only.`,
        },
      ],
      temperature: 0.5,
      maxTokens: 500,
    });

    const parsed = parseJsonFromLLM(result.content) as Record<string, unknown> | null;
    if (!parsed) return null;

    return {
      nodeImprovements: Array.isArray(parsed.nodeImprovements)
        ? (parsed.nodeImprovements as Array<Record<string, unknown>>).filter(
            (i) => i.nodeId && i.improvedTitle && i.improvedSummary,
          ).map((i) => ({
            nodeId: i.nodeId as string,
            improvedTitle: (i.improvedTitle as string).slice(0, 80),
            improvedSummary: (i.improvedSummary as string).slice(0, 300),
          }))
        : [],
      newEdges: Array.isArray(parsed.newEdges)
        ? (parsed.newEdges as Array<Record<string, unknown>>).filter(
            (e) => e.sourceNodeId && e.targetNodeId && e.relationship_type,
          ).map((e) => ({
            sourceNodeId: e.sourceNodeId as string,
            targetNodeId: e.targetNodeId as string,
            relationship_type: e.relationship_type as string,
            explanation: (e.explanation as string) ?? "",
          }))
        : [],
      removeEdgeIds: Array.isArray(parsed.removeEdgeIds)
        ? (parsed.removeEdgeIds as string[]).filter((id) => typeof id === "string")
        : [],
    };
  } catch {
    return null;
  }
}

// ─── Evidence Summary ───────────────────────────────────────────────────────

export async function generateEvidenceSummary(formattedMessages: string): Promise<string | null> {
  try {
    const result = await complete({
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content: `Summarize the key points from these conversation messages as a concise bullet-point list. Focus on facts, decisions, and insights — not the conversation structure. Max 5 bullet points.`,
        },
        { role: "user", content: formattedMessages },
      ],
      temperature: 0.3,
      maxTokens: 200,
    });
    return result.content;
  } catch {
    return null;
  }
}

// ─── Graph Summary ──────────────────────────────────────────────────────────

export async function generateGraphSummary(
  nodesFormatted: string,
  edgesFormatted: string,
): Promise<string | null> {
  try {
    const result = await complete({
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content: `You summarize knowledge graphs. Given a set of nodes and edges, produce a brief narrative (2-4 sentences) explaining what this person has been thinking about and how their ideas connect.`,
        },
        { role: "user", content: `Nodes:\n${nodesFormatted}\n\nEdges:\n${edgesFormatted}` },
      ],
      temperature: 0.5,
      maxTokens: 200,
    });
    return result.content;
  } catch {
    return null;
  }
}
