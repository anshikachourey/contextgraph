"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { nodeColorFromNeighborhood } from "@/src/lib/neighborhoodColor";

// The data payload stored on each React Flow node
export type ContextNodeData = {
  title: string;
  summary: string;
  messageCount: number;
  continuationCount: number;
  neighborhoodHue: number | null;
  hierarchyDepth: number;
};

// Full React Flow node type — data shape + type discriminator
export type ContextFlowNode = Node<ContextNodeData, "contextNode">;

export default function ContextNodeCard({
  data,
  selected,
}: NodeProps<ContextFlowNode>) {
  const colors = nodeColorFromNeighborhood(data.neighborhoodHue, data.hierarchyDepth);

  // Visual weight: nodes with more messages appear slightly larger
  const isSubstantial = data.messageCount >= 4;

  // Border class: selected > neighborhood color > default
  const borderClass = selected
    ? "border-black ring-2 ring-black shadow-md"
    : colors
      ? "shadow-sm hover:shadow-md transition-shadow"
      : "border-gray-200 shadow-sm hover:shadow-md transition-shadow";

  // Inline border style when neighborhood color is active
  const cardStyle = !selected && colors
    ? { borderColor: colors.borderColor, borderWidth: "2px" }
    : undefined;

  // Width varies slightly by importance
  const widthClass = isSubstantial ? "w-72" : "w-64";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-slate-400 !w-2 !h-2" />

      <div
        className={`relative ${widthClass} overflow-hidden rounded-2xl border bg-white ${borderClass}`}
        style={cardStyle}
      >
        {/* Neighborhood accent bar — stronger color */}
        {colors && !selected && (
          <div
            className="h-1.5 w-full"
            style={{ backgroundColor: colors.accentColor }}
          />
        )}

        <div className="p-5 pt-4">
          <p className="text-base font-semibold leading-snug">{data.title}</p>
          <p className="mt-2 text-sm text-gray-600 line-clamp-3">{data.summary}</p>
          <div className="mt-3 flex items-center gap-3">
            <span className="inline-flex items-center gap-1 text-xs text-gray-400">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              {data.messageCount}
            </span>
            {data.continuationCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-purple-500">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                {data.continuationCount}
              </span>
            )}
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-slate-400 !w-2 !h-2" />
    </>
  );
}
