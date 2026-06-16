"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

// The data shape stored on each React Flow node
export type ContextNodeData = {
  title: string;
  summary: string;
  messageCount: number;
};

// React Flow calls this component to render each node on the canvas
export default function ContextNodeCard({
  data,
  selected,
}: NodeProps<ContextNodeData>) {
  return (
    <>
      {/* Target handle — where edges arrive (top) */}
      <Handle type="target" position={Position.Top} />

      <div
        className={`w-56 rounded-2xl border bg-white p-4 shadow-sm transition ${
          selected ? "border-black ring-2 ring-black" : "border-gray-200"
        }`}
      >
        <p className="font-semibold leading-snug">{data.title}</p>
        <p className="mt-2 text-sm text-gray-600 line-clamp-3">{data.summary}</p>
        <p className="mt-3 text-xs text-gray-400">
          {data.messageCount} linked message
          {data.messageCount === 1 ? "" : "s"}
        </p>
      </div>

      {/* Source handle — where edges leave (bottom) */}
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}
