"use client";

import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
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
    <div className="flex h-16 items-center justify-between border-b border-[var(--border)] px-5">
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-semibold text-[var(--foreground)]">Context Graph</h2>
        {devMode && <Badge variant="warning" label="DEV" />}
      </div>

      <div className="flex items-center gap-2">
        {/* Dev-only debug tools */}
        {devMode && hasNodes && onStructure && (
          <Button
            variant="ghost"
            size="sm"
            label={isStructuring ? "Structuring…" : "⚙ Structure"}
            isDisabled={isStructuring || isEvolving || isSummarizing}
            onClick={onStructure}
          />
        )}
        {devMode && hasNodes && onEvolve && (
          <Button
            variant="ghost"
            size="sm"
            label={isEvolving ? "Evolving…" : "⚡ Evolve"}
            isDisabled={isStructuring || isEvolving || isSummarizing}
            onClick={onEvolve}
          />
        )}

        {/* Always visible */}
        {hasNodes && (
          <Button
            variant="ghost"
            size="sm"
            label={isSummarizing ? "Summarizing…" : "✦ Summarize"}
            isLoading={isSummarizing}
            isDisabled={isSummarizing}
            onClick={onSummarize}
          />
        )}

        <Button
          variant="ghost"
          size="sm"
          label={isMaximized ? "Exit full screen" : "Maximize"}
          onClick={onToggleMaximize}
        />
        <Button variant="ghost" size="sm" label="Close" onClick={onClose} />
      </div>
    </div>
  );
}
