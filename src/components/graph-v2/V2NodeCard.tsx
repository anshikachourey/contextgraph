"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

export type V2NodeData = {
  title: string;
  objectType: string;
  description: string;
  maturity: string;
  status: string;
  propositionCount: number;
  depth: number;
  hasOverlap: boolean;
};

export type V2FlowNode = Node<V2NodeData, "v2Node">;

const TYPE_COLORS: Record<string, string> = {
  inquiry: "#3b82f6",
  insight: "#8b5cf6",
  problem: "#ef4444",
  task: "#f59e0b",
  decision: "#10b981",
  preference: "#ec4899",
  explanation: "#6366f1",
  plan: "#14b8a6",
  unresolved: "#6b7280",
  comparison: "#f97316",
  goal: "#22c55e",
  project: "#0ea5e9",
  noise: "#d1d5db",
};

const TYPE_ICONS: Record<string, string> = {
  inquiry: "?",
  insight: "✦",
  problem: "!",
  task: "→",
  decision: "◆",
  preference: "♥",
  explanation: "≡",
  plan: "▤",
  unresolved: "…",
  comparison: "⇔",
  goal: "⊕",
  project: "▣",
  noise: "~",
};

export default function V2NodeCard({ data, selected }: NodeProps<V2FlowNode>) {
  const color = TYPE_COLORS[data.objectType] ?? "#6b7280";
  const icon = TYPE_ICONS[data.objectType] ?? "•";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-slate-400 !w-2 !h-2" />

      <div
        className={`relative w-64 overflow-hidden rounded-xl border transition-all ${
          selected
            ? "border-purple-600 ring-4 ring-purple-200 shadow-lg shadow-purple-100 scale-[1.02]"
            : "border-gray-200 shadow-sm hover:shadow-md"
        }`}
        style={{ backgroundColor: selected ? "#faf5ff" : "white" }}
      >
        {/* Type accent bar */}
        <div className="h-1 w-full" style={{ backgroundColor: color }} />

        <div className="p-4">
          <div className="flex items-start gap-2">
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs font-bold text-white"
              style={{ backgroundColor: color }}
            >
              {icon}
            </span>
            <p className="text-sm font-semibold leading-snug line-clamp-2">{data.title}</p>
          </div>

          <p className="mt-2 text-xs text-gray-500 line-clamp-2">{data.description}</p>

          <div className="mt-2 flex items-center gap-2 text-[10px] text-gray-400">
            <span className="rounded bg-gray-100 px-1.5 py-0.5">{data.objectType}</span>
            <span>{data.propositionCount} props</span>
            {data.hasOverlap && (
              <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-yellow-700">overlap</span>
            )}
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-slate-400 !w-2 !h-2" />
    </>
  );
}
