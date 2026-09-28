import type { ContextNode } from "@/src/types/node";

type NodeCardProps = {
  node: ContextNode;
};

export default function NodeCard({ node }: NodeCardProps) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
      <p className="font-semibold text-[var(--foreground)]">{node.title}</p>
      <p className="mt-2 text-sm text-[var(--muted-foreground)]">{node.summary}</p>
      <p className="mt-3 text-xs text-[var(--muted-foreground)]">
        {node.messageIds.length} linked message
        {node.messageIds.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}
