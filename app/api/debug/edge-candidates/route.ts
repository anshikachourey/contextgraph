import { NextResponse } from "next/server";
import { loadLatestConversation } from "@/src/lib/db/conversations";
import { loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { loadEdges } from "@/src/lib/db/edges";
import { cosineSimilarity } from "@/src/lib/cosineSimilarity";
import { STRONGLY_RELATED_THRESHOLD } from "@/src/lib/similarityThresholds";

/**
 * GET /api/debug/edge-candidates
 *
 * Dev-only: computes ALL pairwise node similarities and shows
 * which pairs have existing edges, which would pass threshold,
 * and which are "near misses." Useful for diagnosing edge sparsity.
 */
export async function GET() {
  try {
    const data = await loadLatestConversation();
    if (!data) {
      return NextResponse.json({ error: "No conversation found." }, { status: 404 });
    }

    const conversationId = data.conversation.id;
    const rawNodes = await loadNodesWithEmbeddings(conversationId);
    const rawEdges = await loadEdges(conversationId);

    // Build existing edge lookup (canonical pairs)
    const existingEdgeSet = new Set<string>();
    for (const e of rawEdges) {
      const key = e.sourceNodeId < e.targetNodeId
        ? `${e.sourceNodeId}|${e.targetNodeId}`
        : `${e.targetNodeId}|${e.sourceNodeId}`;
      existingEdgeSet.add(key);
    }

    // Compute all pairwise similarities
    const nodesWithEmb = rawNodes.filter((n) => n.embedding !== null && n.embedding!.length > 0);

    type Pair = {
      sourceId: string;
      sourceTitle: string;
      targetId: string;
      targetTitle: string;
      similarity: number;
      existingEdge: boolean;
      wouldPassCurrentThreshold: boolean;
    };

    const pairs: Pair[] = [];

    for (let i = 0; i < nodesWithEmb.length; i++) {
      for (let j = i + 1; j < nodesWithEmb.length; j++) {
        const a = nodesWithEmb[i];
        const b = nodesWithEmb[j];
        const sim = cosineSimilarity(a.embedding!, b.embedding!);

        const canonKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;

        pairs.push({
          sourceId: a.id,
          sourceTitle: a.title,
          targetId: b.id,
          targetTitle: b.title,
          similarity: Math.round(sim * 10000) / 10000,
          existingEdge: existingEdgeSet.has(canonKey),
          wouldPassCurrentThreshold: sim >= STRONGLY_RELATED_THRESHOLD,
        });
      }
    }

    // Sort by similarity descending
    pairs.sort((a, b) => b.similarity - a.similarity);

    // Summary stats
    const aboveThreshold = pairs.filter((p) => p.wouldPassCurrentThreshold).length;
    const withExistingEdge = pairs.filter((p) => p.existingEdge).length;
    const nearMisses = pairs.filter(
      (p) => !p.wouldPassCurrentThreshold && p.similarity >= STRONGLY_RELATED_THRESHOLD - 0.10,
    ).length;

    return NextResponse.json({
      conversationTitle: data.conversation.title,
      totalNodes: rawNodes.length,
      nodesWithEmbeddings: nodesWithEmb.length,
      nodesWithoutEmbeddings: rawNodes.length - nodesWithEmb.length,
      totalPairs: pairs.length,
      existingEdges: rawEdges.length,
      pairsAboveThreshold: aboveThreshold,
      pairsWithExistingEdge: withExistingEdge,
      missingEdges: aboveThreshold - withExistingEdge,
      nearMisses,
      currentThreshold: STRONGLY_RELATED_THRESHOLD,
      // Top 30 pairs for inspection
      topPairs: pairs.slice(0, 30),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Edge candidate analysis failed: ${message}` },
      { status: 500 },
    );
  }
}
