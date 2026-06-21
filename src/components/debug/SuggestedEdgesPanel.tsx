"use client";

import { useState } from "react";
import type { SuggestedEdge } from "@/src/types/edge";
import {
  STRONGLY_RELATED_THRESHOLD,
  POSSIBLY_RELATED_THRESHOLD,
} from "@/src/lib/similarityThresholds";

type SuggestionsResponse = {
  suggestions: SuggestedEdge[];
  nodeNames: Record<string, string>;
};

type PersistResponse = {
  persisted: number;
  total: number;
};

function scoreColor(score: number): string {
  if (score >= STRONGLY_RELATED_THRESHOLD) return "text-green-700";
  if (score >= POSSIBLY_RELATED_THRESHOLD) return "text-amber-700";
  return "text-gray-500";
}

export default function SuggestedEdgesPanel() {
  const [suggestions, setSuggestions] = useState<SuggestedEdge[] | null>(null);
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isPersisting, setIsPersisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [persistResult, setPersistResult] = useState<string | null>(null);

  async function handleGenerate() {
    setIsLoading(true);
    setError(null);
    setPersistResult(null);

    try {
      const response = await fetch("/api/debug/suggestions");
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "Failed to generate suggestions.");
        return;
      }

      const result = data as SuggestionsResponse;
      setSuggestions(result.suggestions);
      setNodeNames(result.nodeNames);
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handlePersist() {
    setIsPersisting(true);
    setError(null);
    setPersistResult(null);

    try {
      const response = await fetch("/api/debug/persist-edges", {
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "Failed to persist edges.");
        return;
      }

      const result = data as PersistResponse;
      setPersistResult(
        `Done. ${result.persisted} edge${result.persisted === 1 ? "" : "s"} persisted (${result.total} strongly related total). Old suggested edges were cleared and regenerated.`,
      );
    } catch {
      setError("Network error during persist. Check your connection.");
    } finally {
      setIsPersisting(false);
    }
  }

  const hasStrongSuggestions =
    suggestions !== null &&
    suggestions.some((s) => s.similarity >= STRONGLY_RELATED_THRESHOLD);

  return (
    <section className="mt-10">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Suggested Semantic Relationships
      </h2>

      <p className="mb-4 text-xs text-gray-500">
        Generates LLM explanations for each candidate edge on-demand. Each click
        costs ~1 API call per candidate pair above the similarity threshold.
        Persisting clears all previously suggested edges and writes fresh ones.
      </p>

      {/* Action buttons */}
      <div className="mb-4 flex gap-3">
        <button
          onClick={handleGenerate}
          disabled={isLoading || isPersisting}
          className="flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLoading ? (
            <>
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
              Generating…
            </>
          ) : (
            <>✦ Generate suggestions</>
          )}
        </button>

        <button
          onClick={handlePersist}
          disabled={isPersisting || isLoading}
          className="flex items-center gap-2 rounded-xl border border-green-300 bg-green-50 px-4 py-2 text-sm font-medium text-green-800 transition hover:bg-green-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPersisting ? (
            <>
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-green-400 border-t-transparent" />
              Persisting…
            </>
          ) : (
            <>↓ Persist suggested edges</>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Persist success */}
      {persistResult && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {persistResult}
        </div>
      )}

      {/* Results */}
      {suggestions !== null && (
        <>
          {suggestions.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
              No candidate edges above the similarity threshold. Create more
              related nodes to see suggestions.
            </div>
          ) : (
            <div className="space-y-3">
              {suggestions.map((edge) => (
                <div
                  key={`${edge.sourceNodeId}-${edge.targetNodeId}`}
                  className={`rounded-xl border bg-white px-4 py-3 ${
                    edge.similarity >= STRONGLY_RELATED_THRESHOLD
                      ? "border-green-200"
                      : "border-gray-200"
                  }`}
                >
                  {/* Node pair header */}
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-gray-900">
                      {nodeNames[edge.sourceNodeId] ?? edge.sourceNodeId}
                    </span>
                    <span className="text-gray-400">↔</span>
                    <span className="font-medium text-gray-900">
                      {nodeNames[edge.targetNodeId] ?? edge.targetNodeId}
                    </span>
                    <span
                      className={`ml-auto font-mono text-xs ${scoreColor(edge.similarity)}`}
                    >
                      {edge.similarity.toFixed(4)}
                    </span>
                  </div>

                  {/* Explanation */}
                  <p className="mt-2 text-sm leading-relaxed text-gray-600">
                    {edge.explanation}
                  </p>

                  {/* Threshold label */}
                  {edge.similarity >= STRONGLY_RELATED_THRESHOLD && (
                    <p className="mt-1.5 text-xs font-medium text-green-700">
                      ↑ Will be persisted as graph edge
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
