import { IconButton } from "@astryxdesign/core/IconButton";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Icon } from "@astryxdesign/core/Icon";
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

function actionBadgeVariant(
  action: EvolutionSuggestion["action"],
): "blue" | "orange" | "purple" {
  switch (action) {
    case "extend_node":
      return "blue";
    case "suggest_merge":
      return "orange";
    case "suggest_parent":
      return "purple";
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
    <div className="flex h-full flex-col border-t border-[var(--border)] bg-[var(--surface)]">
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Evolution
          </p>
          <h3 className="mt-0.5 text-[16px] font-semibold leading-snug text-[var(--foreground)]">
            Graph Suggestions
          </h3>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          label="Close evolution panel"
          icon={<Icon icon="close" />}
          onClick={onClose}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {/* Loading */}
        {isLoading && (
          <div className="py-8">
            <Spinner size="sm" label="Analyzing graph evolution…" />
          </div>
        )}

        {/* Empty */}
        {!isLoading && suggestions.length === 0 && (
          <div className="py-8 text-center text-[14px] text-[var(--muted-foreground)]">
            No evolution suggestions. The graph looks up to date.
          </div>
        )}

        {/* Suggestions */}
        {!isLoading && suggestions.length > 0 && (
          <div className="space-y-3">
            {suggestions.map((s) => (
              <div
                key={s.id}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
              >
                {/* Type badge + confidence */}
                <div className="flex items-center justify-between">
                  <Badge variant={actionBadgeVariant(s.action)} label={actionLabel(s.action)} />
                  <span className="text-[11px] text-[var(--muted-foreground)]">
                    {(s.confidence * 100).toFixed(0)}% confidence
                  </span>
                </div>

                {/* Reason */}
                <p className="mt-2 text-[14px] leading-relaxed text-[var(--foreground)]">
                  {s.reason}
                </p>

                {/* Actions */}
                <div className="mt-3 flex gap-2">
                  {s.action === "extend_node" && (
                    <Button variant="primary" size="sm" label="Apply" onClick={() => onApply(s)} />
                  )}
                  <Button variant="ghost" size="sm" label="Dismiss" onClick={() => onDismiss(s)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
