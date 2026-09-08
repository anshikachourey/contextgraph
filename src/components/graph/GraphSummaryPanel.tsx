import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Banner } from "@astryxdesign/core/Banner";
import { Icon } from "@astryxdesign/core/Icon";

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
    <div className="flex h-full flex-col border-t border-[var(--border)] bg-[var(--surface)]">
      {/* Panel header */}
      <div className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Graph
          </p>
          <h3 className="mt-0.5 text-[16px] font-semibold leading-snug text-[var(--foreground)]">
            Conversation Summary
          </h3>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          label="Close summary"
          icon={<Icon icon="close" />}
          onClick={onClose}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {isLoading && <Spinner size="sm" label="Generating summary…" />}

        {error && <Banner status="error" collapsible={false} title={error} />}

        {summary && !isLoading && (
          <p className="text-[14px] leading-relaxed text-[var(--foreground)] whitespace-pre-line">
            {summary}
          </p>
        )}
      </div>
    </div>
  );
}
