import type { ContextNode } from "@/src/types/node";

type NodeCardProps = {
  node: ContextNode;
};

export default function NodeCard({ node }: NodeCardProps) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="font-semibold">{node.title}</p>
      <p className="mt-2 text-sm text-gray-600">{node.summary}</p>
      <p className="mt-3 text-xs text-gray-400">
        {node.messageIds.length} linked message
        {node.messageIds.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}
