/**
 * Compute the cosine similarity between two vectors.
 * Returns a value in [-1, 1] where 1 = identical direction, 0 = orthogonal.
 *
 * OpenAI embeddings are already unit-normalized, so this is equivalent to
 * a dot product — but we compute it explicitly for correctness and testability.
 *
 * Throws if vectors have different lengths or are zero-length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector length mismatch: ${a.length} vs ${b.length}`,
    );
  }
  if (a.length === 0) {
    throw new Error("Cannot compute similarity of empty vectors");
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  if (magnitude === 0) return 0;

  return dot / magnitude;
}

export type SimilarityPair = {
  nodeAId: string;
  nodeATitle: string;
  nodeBId: string;
  nodeBTitle: string;
  score: number;
};

/**
 * Compute all pairwise cosine similarities for a list of nodes with embeddings.
 * Returns pairs sorted by score descending (most similar first).
 * Nodes without embeddings are skipped silently.
 */
export function computePairwiseSimilarities(
  nodes: Array<{ id: string; title: string; embedding: number[] | null; [key: string]: unknown }>,
): SimilarityPair[] {
  const withEmbeddings = nodes.filter(
    (n): n is { id: string; title: string; embedding: number[] } =>
      n.embedding !== null && n.embedding.length > 0,
  );

  const pairs: SimilarityPair[] = [];

  for (let i = 0; i < withEmbeddings.length; i++) {
    for (let j = i + 1; j < withEmbeddings.length; j++) {
      const a = withEmbeddings[i];
      const b = withEmbeddings[j];
      const score = cosineSimilarity(a.embedding, b.embedding);
      pairs.push({
        nodeAId: a.id,
        nodeATitle: a.title,
        nodeBId: b.id,
        nodeBTitle: b.title,
        score,
      });
    }
  }

  return pairs.sort((a, b) => b.score - a.score);
}
