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
  isSelected: boolean;
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

export default function V2NodeCard({ data }: NodeProps<V2FlowNode>) {
  const color = TYPE_COLORS[data.objectType] ?? "#6b7280";
  const icon = TYPE_ICONS[data.objectType] ?? "•";
  const isSelected = data.isSelected;

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !border-2"
        style={{ background: "var(--surface)", borderColor: "var(--muted-foreground)" }}
      />

      <div
        className="relative w-64 overflow-hidden rounded-xl border transition-all"
        style={{
          backgroundColor: "var(--surface)",
          borderColor: isSelected ? "var(--accent)" : "var(--border)",
          boxShadow: isSelected
            ? "0 0 0 3px var(--accent-light), 0 8px 24px rgba(0,0,0,0.12)"
            : "0 1px 3px rgba(0,0,0,0.08)",
        }}
      >
        {/* Type accent bar — semantic category color */}
        <div className="h-1 w-full" style={{ backgroundColor: color }} />

        <div className="p-4">
          <div className="flex items-start gap-2">
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-bold text-white"
              style={{ backgroundColor: color }}
            >
              {icon}
            </span>
            <p className="text-[13px] font-semibold leading-snug line-clamp-2 text-[var(--foreground)]">
              {data.title}
            </p>
          </div>

          {data.description && (
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted-foreground)] line-clamp-2">
              {data.description}
            </p>
          )}

          <div className="mt-2.5 flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
            <span className="rounded-md border border-[var(--border)] bg-[var(--muted)] px-1.5 py-0.5 font-medium capitalize">
              {data.objectType}
            </span>
            <span className="tabular-nums">{data.propositionCount} props</span>
            {data.hasOverlap && (
              <span
                className="rounded-md px-1.5 py-0.5 font-medium"
                style={{ backgroundColor: "var(--accent-light)", color: "var(--accent)" }}
              >
                overlap
              </span>
            )}
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !border-2"
        style={{ background: "var(--surface)", borderColor: "var(--muted-foreground)" }}
      />
    </>
  );
}
