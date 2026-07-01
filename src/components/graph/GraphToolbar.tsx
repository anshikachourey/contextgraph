"use client";

import { useDevMode } from "@/src/hooks/useDevMode";

type GraphToolbarProps = {
  isMaximized: boolean;
  hasNodes: boolean;
  isSummarizing: boolean;
  onSummarize: () => void;
  // Dev mode actions (hidden from normal UI)
  onStructure?: () => void;
  onEvolve?: () => void;
  isStructuring?: boolean;
  isEvolving?: boolean;
  // Layout
  onToggleMaximize: () => void;
  onClose: () => void;
};

export default function GraphToolbar({
  isMaximized,
  hasNodes,
  isSummarizing,
  onSummarize,
  onStructure,
  onEvolve,
  isStructuring = false,
  isEvolving = false,
  onToggleMaximize,
  onClose,
}: GraphToolbarProps) {
  const devMode = useDevMode();

  return (
    <div className="flex h-16 items-center justify-between border-b border-gray-200 px-5">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Context Graph</h2>
        {devMode && (
          <span className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700">
            DEV
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Dev-only debug tools */}
        {devMode && hasNodes && onStructure && (
          <button
            onClick={onStructure}
            disabled={isStructuring || isEvolving || isSummarizing}
            className="flex items-center gap-1.5 rounded-md px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-40"
          >
            {isStructuring ? "Structuring…" : "⚙ Structure"}
          </button>
        )}
        {devMode && hasNodes && onEvolve && (
          <button
            onClick={onEvolve}
            disabled={isStructuring || isEvolving || isSummarizing}
            className="flex items-center gap-1.5 rounded-md px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-40"
          >
            {isEvolving ? "Evolving…" : "⚡ Evolve"}
          </button>
        )}

        {/* Always visible */}
        {hasNodes && (
          <button
            onClick={onSummarize}
            disabled={isSummarizing}
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
