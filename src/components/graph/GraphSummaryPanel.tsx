type GraphSummaryPanelProps = {
  summary: string | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
};

export default function GraphSummaryPanel({
  summary,
  isLoading,
  error,
  onClose,
}: GraphSummaryPanelProps) {
  return (
    <div className="flex h-full flex-col border-t border-gray-200 bg-white">
      {/* Panel header */}
      <div className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Graph
          </p>
          <h3 className="mt-0.5 text-base font-semibold leading-snug">
            Conversation Summary
          </h3>
        </div>
        <button
          onClick={onClose}
          className="ml-4 mt-0.5 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
          aria-label="Close summary"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
            Generating summary…
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        {summary && !isLoading && (
          <p className="text-sm leading-relaxed text-gray-700 whitespace-pre-line">
            {summary}
          </p>
        )}
      </div>
    </div>
  );
}
