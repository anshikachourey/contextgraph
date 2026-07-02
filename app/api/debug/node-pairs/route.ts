import { NextRequest, NextResponse } from "next/server";
import { loadLatestConversation } from "@/src/lib/db/conversations";
import { loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { cosineSimilarity } from "@/src/lib/cosineSimilarity";
import { buildNodeEmbeddingText } from "@/src/lib/embeddings";
import { STRONGLY_RELATED_THRESHOLD } from "@/src/lib/similarityThresholds";
import {
  INTERNAL_ADJACENCY_THRESHOLD,
} from "@/src/lib/intelligence/neighborhoodDetection";

/**
 * GET /api/debug/node-pairs?q=cinephile
 *
 * Dev-only: shows pairwise similarity between nodes whose titles
 * match the search query. Includes embedding source text for diagnosis.
 *
 * Usage:
 *   curl "http://localhost:3000/api/debug/node-pairs?q=cinephile"
 *   curl "http://localhost:3000/api/debug/node-pairs?q=marketing"
 */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.toLowerCase() ?? "";

  try {
    const data = await loadLatestConversation();
    if (!data) {
      return NextResponse.json({ error: "No conversation found." }, { status: 404 });
    }

    const rawNodes = await loadNodesWithEmbeddings(data.conversation.id);

    // Filter nodes matching query (case-insensitive title search)
    const matchingNodes = query
      ? rawNodes.filter((n) => n.title.toLowerCase().includes(query))
      : rawNodes;

    if (matchingNodes.length === 0) {
      return NextResponse.json({
        query,
        matchCount: 0,
        message: `No nodes found matching "${query}". Available titles: ${rawNodes.map((n) => n.title).join(", ")}`,
      });
    }

    // Node details with embedding source info
    const nodeDetails = matchingNodes.map((n) => {
      const canonicalText = buildNodeEmbeddingText(n.title, n.summary, n.evidenceSummary);
      return {
        id: n.id,
        title: n.title,
        summary: n.summary,
        evidenceSummary: n.evidenceSummary,
        hasEmbedding: n.embedding !== null && n.embedding.length > 0,
        embeddingDimensions: n.embedding?.length ?? 0,
        embeddingTextPreview: canonicalText.slice(0, 300),
        embeddingTextFields: {
          hasTitle: true,
          hasSummary: !!n.summary?.trim(),
          hasEvidence: !!n.evidenceSummary?.trim(),
        },
      };
    });

    // Pairwise similarities between matching nodes
    type PairInfo = {
      sourceTitle: string;
      targetTitle: string;
      similarity: number | null;
      hasEmbeddings: boolean;
      wouldPassInternalThreshold: boolean;
      wouldPassVisibleThreshold: boolean;
    };

    const pairs: PairInfo[] = [];

    for (let i = 0; i < matchingNodes.length; i++) {
      for (let j = i + 1; j < matchingNodes.length; j++) {
        const a = matchingNodes[i];
        const b = matchingNodes[j];

        const bothHaveEmb =
          a.embedding !== null && a.embedding.length > 0 &&
          b.embedding !== null && b.embedding.length > 0;

        let similarity: number | null = null;
        if (bothHaveEmb) {
          similarity = Math.round(cosineSimilarity(a.embedding!, b.embedding!) * 10000) / 10000;
        }

        pairs.push({
          sourceTitle: a.title,
          targetTitle: b.title,
          similarity,
          hasEmbeddings: bothHaveEmb,
          wouldPassInternalThreshold: similarity !== null && similarity >= INTERNAL_ADJACENCY_THRESHOLD,
          wouldPassVisibleThreshold: similarity !== null && similarity >= STRONGLY_RELATED_THRESHOLD,
        });
      }
    }

    pairs.sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1));

    return NextResponse.json({
      query,
      matchCount: matchingNodes.length,
      thresholds: {
        internalAdjacency: INTERNAL_ADJACENCY_THRESHOLD,
        visibleEdge: STRONGLY_RELATED_THRESHOLD,
      },
      nodes: nodeDetails,
      pairs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
