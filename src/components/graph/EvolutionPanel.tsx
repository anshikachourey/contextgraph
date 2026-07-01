import type { EvolutionSuggestion } from "@/src/types/evolution";

type EvolutionPanelProps = {
  suggestions: EvolutionSuggestion[];
  isLoading: boolean;
  onApply: (suggestion: EvolutionSuggestion) => void;
  onDismiss: (suggestion: EvolutionSuggestion) => void;
  onClose: () => void;
};

function actionLabel(action: EvolutionSuggestion["action"]): string {
  switch (action) {
    case "extend_node":
      return "Extend";
    case "suggest_merge":
      return "Merge";
    case "suggest_parent":
      return "Parent";
  }
}

function actionColor(action: EvolutionSuggestion["action"]): string {
  switch (action) {
    case "extend_node":
      return "bg-blue-100 text-blue-700";
    case "suggest_merge":
      return "bg-amber-100 text-amber-700";
    case "suggest_parent":
      return "bg-purple-100 text-purple-700";
  }
}

export default function EvolutionPanel({
  suggestions,
  isLoading,
  onApply,
  onDismiss,
  onClose,
}: EvolutionPanelProps) {
  return (
    <div className="flex h-full flex-col border-t border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Evolution
          </p>
          <h3 className="mt-0.5 text-base font-semibold leading-snug">
            Graph Suggestions
          </h3>
        </div>
        <button
          onClick={onClose}
          className="ml-4 mt-0.5 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
          aria-label="Close evolution panel"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {/* Loading */}
        {isLoading && (
          <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
            Analyzing graph evolution…
          </div>
        )}

        {/* Empty */}
        {!isLoading && suggestions.length === 0 && (
          <div className="py-8 text-center text-sm text-gray-400">
            No evolution suggestions. The graph looks up to date.
          </div>
        )}

        {/* Suggestions */}
        {!isLoading && suggestions.length > 0 && (
          <div className="space-y-3">
            {suggestions.map((s) => (
              <div
                key={s.id}
                className="rounded-xl border border-gray-200 bg-white p-3"
              >
                {/* Type badge + confidence */}
                <div className="flex items-center justify-between">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${actionColor(s.action)}`}
                  >
                    {actionLabel(s.action)}
                  </span>
                  <span className="text-xs text-gray-400">
                    {(s.confidence * 100).toFixed(0)}% confidence
                  </span>
                </div>

                {/* Reason */}
                <p className="mt-2 text-sm leading-relaxed text-gray-700">
                  {s.reason}
                </p>

                {/* Actions */}
                <div className="mt-3 flex gap-2">
                  {s.action === "extend_node" && (
                    <button
                      onClick={() => onApply(s)}
                      className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      Apply
                    </button>
                  )}
                  <button
                    onClick={() => onDismiss(s)}
                    className="rounded-lg px-3 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
