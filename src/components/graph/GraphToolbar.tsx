type GraphToolbarProps = {
  isMaximized: boolean;
  hasNodes: boolean;
  hasMessages: boolean;
  isSummarizing: boolean;
  isStructuring: boolean;
  isEvolving: boolean;
  onSummarize: () => void;
  onStructure: () => void;
  onEvolve: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
};

export default function GraphToolbar({
  isMaximized,
  hasNodes,
  hasMessages,
  isSummarizing,
  isStructuring,
  isEvolving,
  onSummarize,
  onStructure,
  onEvolve,
  onToggleMaximize,
  onClose,
}: GraphToolbarProps) {
  const isBusy = isSummarizing || isStructuring || isEvolving;

  return (
    <div className="flex h-16 items-center justify-between border-b border-gray-200 px-5">
      <h2 className="font-semibold">Context Graph</h2>

      <div className="flex items-center gap-2">
        {hasMessages && (
          <button
            onClick={onStructure}
            disabled={isBusy}
            className="flex items-center gap-1.5 rounded-md px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-40"
          >
            {isStructuring ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                Structuring…
              </>
            ) : (
              <>⚡ Structure</>
            )}
          </button>
        )}

        {hasNodes && (
          <>
            <button
              onClick={onEvolve}
              disabled={isBusy}
              className="flex items-center gap-1.5 rounded-md px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-40"
            >
              {isEvolving ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                  Evolving…
                </>
              ) : (
                <>🔄 Evolve</>
              )}
            </button>

            <button
              onClick={onSummarize}
              disabled={isBusy}
              className="flex items-center gap-1.5 rounded-md px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-40"
            >
              {isSummarizing ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                  Summarizing…
                </>
              ) : (
                <>✦ Summarize</>
              )}
            </button>
          </>
        )}

        <button
          onClick={onToggleMaximize}
          className="rounded-md px-3 py-1 text-sm hover:bg-gray-100"
        >
          {isMaximized ? "Exit full screen" : "Maximize"}
        </button>

        <button
          onClick={onClose}
          className="rounded-md px-3 py-1 text-sm hover:bg-gray-100"
        >
          Close
        </button>
      </div>
    </div>
  );
}
