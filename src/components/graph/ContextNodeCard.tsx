"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

// The data payload stored on each React Flow node
export type ContextNodeData = {
  title: string;
  summary: string;
  messageCount: number;
  continuationCount: number;
};

// Full React Flow node type — data shape + type discriminator
export type ContextFlowNode = Node<ContextNodeData, "contextNode">;

// React Flow calls this component to render each node on the canvas
export default function ContextNodeCard({
  data,
  selected,
}: NodeProps<ContextFlowNode>) {
  return (
    <>
      {/* Target handle — where edges arrive (top) */}
      <Handle type="target" position={Position.Top} />

      <div
        className={`w-64 rounded-2xl border bg-white p-5 shadow-sm transition ${
          selected ? "border-black ring-2 ring-black" : "border-gray-200"
        }`}
      >
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

      {/* Source handle — where edges leave (bottom) */}
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}
