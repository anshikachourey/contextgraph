import { NextResponse } from "next/server";
import { loadLatestConversation } from "@/src/lib/db/conversations";
import { loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { loadEdges } from "@/src/lib/db/edges";
import {
  detectNeighborhoodsFromEmbeddings,
  INTERNAL_ADJACENCY_THRESHOLD,
  INTERNAL_ADJACENCY_TOP_K,
  MIN_NEIGHBORHOOD_COHERENCE,
  MIN_PAIRWISE_SIM_IN_NEIGHBORHOOD,
  type NeighborhoodNode,
} from "@/src/lib/intelligence/neighborhoodDetection";

/**
 * GET /api/debug/neighborhoods
 *
 * Dev-only: runs neighborhood detection with top-K adjacency + coherence guard.
 */
export async function GET() {
  try {
    const data = await loadLatestConversation();
    if (!data) {
      return NextResponse.json({ error: "No conversation found." }, { status: 404 });
    }

    const conversationId = data.conversation.id;
    const rawNodes = await loadNodesWithEmbeddings(conversationId);
    const nodes: NeighborhoodNode[] = rawNodes.map((n) => ({
      id: n.id,
      embedding: n.embedding,
    }));

    const visibleEdges = await loadEdges(conversationId);
    const { assignments, internalEdgeCount } = detectNeighborhoodsFromEmbeddings(nodes);

    const titleMap = new Map(rawNodes.map((n) => [n.id, n.title]));

    const response = assignments.map((nb) => ({
      neighborhoodId: nb.neighborhoodId,
      size: nb.nodeIds.length,
      nodeTitles: nb.nodeIds.map((id) => titleMap.get(id) ?? id),
      avgPairwiseSimilarity: Math.round(nb.avgPairwiseSimilarity * 1000) / 1000,
      minPairwiseSimilarity: Math.round(nb.minPairwiseSimilarity * 1000) / 1000,
      internalEdgesUsed: nb.internalEdgesUsed,
      hasCentroid: nb.centroidEmbedding.length > 0,
    }));

    return NextResponse.json({
      conversationTitle: data.conversation.title,
      totalNodes: nodes.length,
      nodesWithEmbeddings: nodes.filter((n) => n.embedding && n.embedding.length > 0).length,
      config: {
        internalAdjacencyThreshold: INTERNAL_ADJACENCY_THRESHOLD,
        topK: INTERNAL_ADJACENCY_TOP_K,
        minNeighborhoodCoherence: MIN_NEIGHBORHOOD_COHERENCE,
        minPairwiseSimInNeighborhood: MIN_PAIRWISE_SIM_IN_NEIGHBORHOOD,
      },
      internalEdgeCount,
      visibleEdgeCount: visibleEdges.length,
      neighborhoodCount: assignments.length,
      neighborhoods: response,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Neighborhood detection failed: ${message}` },
      { status: 500 },
    );
  }
}
