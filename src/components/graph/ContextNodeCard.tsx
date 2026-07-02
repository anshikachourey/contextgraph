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

  // Border class: selected > neighborhood color > default gray
  const borderClass = selected
    ? "border-black ring-2 ring-black"
    : colors
      ? ""
      : "border-gray-200";

  // Inline border style when neighborhood color is active
  const cardStyle = !selected && colors
    ? { borderColor: colors.borderColor, borderWidth: "2px" }
    : undefined;

  return (
    <>
      <Handle type="target" position={Position.Top} />

      <div
        className={`relative w-64 overflow-hidden rounded-2xl border bg-white shadow-sm transition ${borderClass}`}
        style={cardStyle}
      >
        {/* Subtle top accent bar — identifies neighborhood family */}
        {colors && !selected && (
          <div
            className="h-1 w-full"
            style={{ backgroundColor: colors.accentColor }}
          />
        )}

        <div className="p-5 pt-4">
          <p className="text-base font-semibold leading-snug">{data.title}</p>
          <p className="mt-2 text-sm text-gray-600 line-clamp-3">{data.summary}</p>
          <p className="mt-3 text-xs text-gray-400">
            {data.messageCount} linked message
            {data.messageCount === 1 ? "" : "s"}
          </p>
          {data.continuationCount > 0 && (
            <p className="mt-1.5 text-xs text-purple-500">
              {data.continuationCount} continuation
              {data.continuationCount === 1 ? "" : "s"}
            </p>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} />
    </>
  );
}
