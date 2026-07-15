/**
 * Retrieve compact local graph context for incremental decision-making.
 * Uses embeddings for semantic retrieval + deterministic structural retrieval.
 */

import { embed } from "@/src/lib/ai";
import type { Proposition, ConversationalObject, Thread } from "../schemas";
import type { V2Snapshot, RetrievedContext } from "./schemas";

const TOP_K_SEMANTIC = 5;

/**
 * Retrieve relevant context from the existing snapshot for decision-making.
 */
export async function retrieveContext(
  newPropositions: Proposition[],
  snapshot: V2Snapshot,
): Promise<{ context: RetrievedContext; embeddingCalls: number }> {
  let embeddingCalls = 0;
  const reasons: string[] = [];

  // Build query text from new propositions
  const queryText = newPropositions.map((p) => p.normalizedContent).join(". ");

  // Determine active thread
  const activeThread = snapshot.threads.length > 0
    ? snapshot.threads[snapshot.threads.length - 1]
    : null;

  // Retrieve objects in the active thread
  const threadObjectIds = new Set(
    activeThread ? snapshot.objects.filter((o) => o.threadIds.includes(activeThread.threadId)).map((o) => o.objectId) : [],
  );

  // Semantic retrieval via embeddings
  let semanticNeighbors: Array<{ object: ConversationalObject; similarity: number; reason: string }> = [];

  if (snapshot.objects.length > 0 && queryText.length > 0) {
    try {
      const queryEmb = await embed(queryText);
      embeddingCalls++;

      const objectEmbeddings: Array<{ obj: ConversationalObject; emb: number[] }> = [];
      for (const obj of snapshot.objects) {
        const objText = `${obj.objectType}: ${obj.title}. ${obj.description}`;
        const objEmb = await embed(objText);
        embeddingCalls++;
        objectEmbeddings.push({ obj, emb: objEmb });
      }

      const scored = objectEmbeddings.map(({ obj, emb }) => ({
        object: obj,
        similarity: cosineSim(queryEmb, emb),
        reason: "semantic_similarity",
      })).sort((a, b) => b.similarity - a.similarity);

      semanticNeighbors = scored.slice(0, TOP_K_SEMANTIC).filter((s) => s.similarity > 0.3);
      reasons.push(`semantic: retrieved ${semanticNeighbors.length} of ${snapshot.objects.length}`);
    } catch {
      reasons.push("semantic retrieval failed");
    }
  }

  // Objects sharing the active thread
  const recentObjects = snapshot.objects.filter((o) => threadObjectIds.has(o.objectId));
  reasons.push(`thread-local: ${recentObjects.length} objects`);

  // Unresolved inquiries
  const unresolvedInquiries = snapshot.objects.filter(
    (o) => (o.objectType === "inquiry" || o.objectType === "unresolved") && o.status === "active",
  );
  reasons.push(`unresolved: ${unresolvedInquiries.length}`);

  // Recently updated (last 5 objects by position)
  const recentlyUpdated = snapshot.objects.slice(-5);

  // Deduplicate
  const retrievedIds = new Set<string>();
  const allRetrieved: ConversationalObject[] = [];
  for (const obj of [...recentObjects, ...semanticNeighbors.map((s) => s.object), ...unresolvedInquiries, ...recentlyUpdated]) {
    if (!retrievedIds.has(obj.objectId)) {
      retrievedIds.add(obj.objectId);
      allRetrieved.push(obj);
    }
  }

  return {
    context: {
      activeThread,
      recentObjects,
      semanticNeighbors,
      unresolvedInquiries,
      recentlyUpdated,
      retrievalDiagnostics: {
        objectsConsidered: snapshot.objects.length,
        objectsRetrieved: allRetrieved.length,
        threadsConsidered: snapshot.threads.length,
        threadsRetrieved: activeThread ? 1 : 0,
        reasons,
      },
    },
    embeddingCalls,
  };
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
