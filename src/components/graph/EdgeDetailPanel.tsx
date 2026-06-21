import type { SemanticEdge } from "@/src/types/edge";
import {
  STRONGLY_RELATED_THRESHOLD,
  POSSIBLY_RELATED_THRESHOLD,
} from "@/src/lib/similarityThresholds";

type EdgeDetailPanelProps = {
  edge: SemanticEdge;
  sourceTitle: string;
  targetTitle: string;
  onClose: () => void;
};

function scoreLabel(score: number): string {
  if (score >= STRONGLY_RELATED_THRESHOLD) return "strongly related";
  if (score >= POSSIBLY_RELATED_THRESHOLD) return "possibly related";
  return "likely distinct";
}

function scoreColor(score: number): string {
  if (score >= STRONGLY_RELATED_THRESHOLD) return "text-green-700";
  if (score >= POSSIBLY_RELATED_THRESHOLD) return "text-amber-700";
  return "text-gray-500";
}

export default function EdgeDetailPanel({
  edge,
  sourceTitle,
  targetTitle,
  onClose,
}: EdgeDetailPanelProps) {
  return (
    <div className="flex h-full flex-col border-t border-gray-200 bg-white">
      {/* Panel header */}
      <div className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Relationship
          </p>
          <h3 className="mt-0.5 text-base font-semibold leading-snug">
            {sourceTitle}{" "}
            <span className="font-normal text-gray-400">↔</span>{" "}
            {targetTitle}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="ml-4 mt-0.5 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
          aria-label="Close edge detail"
        >
          ✕
        </button>
      </div>

      {/* Explanation */}
      <div className="px-5">
        <p className="text-sm leading-relaxed text-gray-700">
          {edge.explanation || "No explanation available."}
        </p>
      </div>

      {/* Metadata */}
      <div className="mt-4 px-5 pb-5">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
          Details
        </p>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Similarity</span>
            <span className={`font-mono text-xs ${scoreColor(edge.similarityScore)}`}>
              {edge.similarityScore.toFixed(4)} — {scoreLabel(edge.similarityScore)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Type</span>
            <span className="text-gray-900">{edge.relationshipType}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Status</span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {edge.status}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
