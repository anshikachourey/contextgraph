// Server Component — runs at request time on the server.
// Access at /debug/similarity
// Not linked from the main UI — navigate directly during development.

import { loadLatestConversation } from "@/src/lib/db/conversations";
import { loadNodesWithEmbeddings } from "@/src/lib/db/nodes";
import { computePairwiseSimilarities } from "@/src/lib/cosineSimilarity";
import {
  STRONGLY_RELATED_THRESHOLD,
  POSSIBLY_RELATED_THRESHOLD,
} from "@/src/lib/similarityThresholds";
import SuggestedEdgesPanel from "@/src/components/debug/SuggestedEdgesPanel";

function scoreColor(score: number): string {
  if (score >= STRONGLY_RELATED_THRESHOLD) return "text-green-700";
  if (score >= POSSIBLY_RELATED_THRESHOLD) return "text-amber-700";
  return "text-gray-500";
}

export default async function SimilarityDebugPage() {
  let conversationId: string | null = null;
  let conversationTitle = "—";
  let errorMessage: string | null = null;
  let pairs: Awaited<ReturnType<typeof computePairwiseSimilarities>> = [];
  let nodeRows: Awaited<ReturnType<typeof loadNodesWithEmbeddings>> = [];
  let totalNodes = 0;

  try {
    const data = await loadLatestConversation();

    if (!data) {
      errorMessage = "No conversations found. Create a conversation first.";
    } else {
      conversationId = data.conversation.id;
      conversationTitle = data.conversation.title;
      totalNodes = data.nodes.length;

      nodeRows = await loadNodesWithEmbeddings(conversationId);
      pairs = computePairwiseSimilarities(nodeRows);
    }
  } catch (err) {
    errorMessage =
      err instanceof Error ? err.message : "Failed to load similarity data.";
  }

  const nodesWithEmbeddings = nodeRows.filter((n) => n.embedding !== null).length;
  const nodesWithEvidence = nodeRows.filter((n) => n.evidenceSummary !== null).length;
  const needsMoreNodes = nodesWithEmbeddings < 2;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      {/* Page header */}
      <div className="mb-8">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          Debug · Internal
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Node Similarity</h1>
        <p className="mt-1 text-sm text-gray-500">
          Pairwise cosine similarity between structured node embeddings
          (Title + Summary + Evidence). Thresholds below are provisional —
          calibrated from early debug data, not final production values.
        </p>
      </div>

      {/* Error state */}
      {errorMessage && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {!errorMessage && (
        <>
          {/* Conversation summary bar */}
          <div className="mb-8 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
            <p className="font-medium text-gray-700">{conversationTitle}</p>
            <div className="mt-1 flex gap-4 text-gray-500">
              <span>{totalNodes} node{totalNodes === 1 ? "" : "s"} total</span>
              <span>{nodesWithEvidence} with evidence</span>
              <span>{nodesWithEmbeddings} embedded</span>
            </div>
          </div>

          {/* ── Node Status ─────────────────────────────────────────────── */}
          <section className="mb-10">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Node Status
            </h2>

            {nodeRows.length === 0 ? (
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                No nodes yet. Create context nodes in the main app first.
              </div>
            ) : (
              <div className="space-y-3">
                {nodeRows.map((node) => (
                  <div
                    key={node.id}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <p className="font-medium text-gray-900">{node.title}</p>
                      <div className="flex shrink-0 gap-1.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            node.evidenceSummary
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {node.evidenceSummary ? "evidence ✓" : "no evidence"}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            node.embedding
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-500"
                          }`}
                        >
                          {node.embedding ? "embedded ✓" : "not embedded"}
                        </span>
                      </div>
                    </div>

                    {node.evidenceSummary ? (
                      <div className="mt-2 border-t border-gray-100 pt-2">
                        <p className="mb-1 text-xs font-medium text-gray-400">
                          Evidence summary
                        </p>
                        <p className="whitespace-pre-line text-xs leading-relaxed text-gray-600">
                          {node.evidenceSummary}
                        </p>
                      </div>
                    ) : (
                      <p className="mt-1.5 text-xs text-amber-600">
                        Created before evidence-summary pipeline was added.
                        Embedding uses title + summary only — similarity scores
                        for this node will be less precise.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Pairwise Similarity ─────────────────────────────────────── */}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Pairwise Similarity
            </h2>

            {needsMoreNodes ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-6">
                <p className="font-medium text-amber-900">
                  Not enough embedded nodes to compute similarity.
                </p>
                <p className="mt-2 text-sm text-amber-800">
                  You have{" "}
                  <span className="font-semibold">{nodesWithEmbeddings}</span>{" "}
                  embedded node{nodesWithEmbeddings === 1 ? "" : "s"}.
                  Similarity requires at least{" "}
                  <span className="font-semibold">2</span>.
                </p>
                <p className="mt-3 text-sm text-amber-700">
                  Go to the main app and create{" "}
                  {nodesWithEmbeddings === 0 ? "2 or more" : "1 more"} context
                  node{nodesWithEmbeddings === 0 ? "s" : ""}. Nodes created
                  after the evidence-summary migration will have full
                  structured embeddings. Then reload this page.
                </p>
              </div>
            ) : pairs.length === 0 ? (
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                No similarity pairs found.
              </div>
            ) : (
              <>
                <div className="overflow-hidden rounded-xl border border-gray-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                        <th className="px-4 py-3">Node A</th>
                        <th className="px-4 py-3">Node B</th>
                        <th className="px-4 py-3 text-right">Score</th>
                        <th className="px-4 py-3 text-right">Label</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pairs.map((pair, i) => (
                        <tr
                          key={`${pair.nodeAId}-${pair.nodeBId}`}
                          className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}
                        >
                          <td className="px-4 py-3 font-medium text-gray-900">
                            {pair.nodeATitle}
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-900">
                            {pair.nodeBTitle}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span
                              className={`font-mono text-xs ${scoreColor(pair.score)}`}
                            >
                              {pair.score.toFixed(4)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-xs">
                            <span className={scoreColor(pair.score)}>
                              {pair.score >= STRONGLY_RELATED_THRESHOLD
                                ? "strongly related"
                                : pair.score >= POSSIBLY_RELATED_THRESHOLD
                                  ? "possibly related"
                                  : "likely distinct"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Legend */}
                <div className="mt-3 space-y-1 text-xs text-gray-400">
                  <p className="font-medium text-gray-500">
                    Provisional thresholds (based on early debug data, not final):
                  </p>
                  <div className="flex gap-5">
                    <span>
                      <span className="font-mono text-green-700">
                        ≥ {STRONGLY_RELATED_THRESHOLD.toFixed(2)}
                      </span>{" "}
                      strongly related
                    </span>
                    <span>
                      <span className="font-mono text-amber-700">
                        ≥ {POSSIBLY_RELATED_THRESHOLD.toFixed(2)}
                      </span>{" "}
                      possibly related
                    </span>
                    <span>
                      <span className="font-mono text-gray-500">
                        &lt; {POSSIBLY_RELATED_THRESHOLD.toFixed(2)}
                      </span>{" "}
                      likely distinct
                    </span>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* ── Suggested Edges (on-demand, client component) ───────────── */}
          {!needsMoreNodes && <SuggestedEdgesPanel />}
        </>
      )}
    </main>
  );
}
