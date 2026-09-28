import { IconButton } from "@astryxdesign/core/IconButton";
import { Badge } from "@astryxdesign/core/Badge";
import { Icon } from "@astryxdesign/core/Icon";
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
  if (score >= STRONGLY_RELATED_THRESHOLD) return "text-green-600 dark:text-green-400";
  if (score >= POSSIBLY_RELATED_THRESHOLD) return "text-amber-600 dark:text-amber-400";
  return "text-[var(--muted-foreground)]";
}

export default function EdgeDetailPanel({
  edge,
  sourceTitle,
  targetTitle,
  onClose,
}: EdgeDetailPanelProps) {
  return (
    <div className="flex h-full flex-col border-t border-[var(--border)] bg-[var(--surface)]">
      {/* Panel header */}
      <div className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Relationship
          </p>
          <h3 className="mt-0.5 text-[16px] font-semibold leading-snug text-[var(--foreground)]">
            {sourceTitle}{" "}
            <span className="font-normal text-[var(--muted-foreground)]">↔</span>{" "}
            {targetTitle}
          </h3>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          label="Close edge detail"
          icon={<Icon icon="close" />}
          onClick={onClose}
        />
      </div>

      {/* Explanation */}
      <div className="px-5">
        <p className="text-[14px] leading-relaxed text-[var(--foreground)]">
          {edge.explanation || "No explanation available."}
        </p>
      </div>

      {/* Metadata */}
      <div className="mt-4 px-5 pb-5">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Details
        </p>
        <div className="space-y-2 text-[14px]">
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Similarity</span>
            <span className={`font-mono text-[12px] ${scoreColor(edge.similarityScore)}`}>
              {edge.similarityScore.toFixed(4)} — {scoreLabel(edge.similarityScore)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Type</span>
            <span className="text-[var(--foreground)]">{edge.relationshipType}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--muted-foreground)]">Status</span>
            <Badge variant="neutral" label={edge.status} />
          </div>
        </div>
      </div>
    </div>
  );
}
