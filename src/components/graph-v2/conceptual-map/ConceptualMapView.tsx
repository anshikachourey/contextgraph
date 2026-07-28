"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { deriveConceptualMap, SYNTHETIC_ROOT_ID, type ConceptualMap, type MapNode } from "./derive-map";

// ─── Types ──────────────────────────────────────────────────────────────────

type SnapshotPayload = {
  objects: Array<{
    objectId: string; objectType: string; title: string; description: string;
    propositionIds: string[]; threadIds: string[]; maturity: string; status: string;
    supportingUtteranceIds: string[]; contextualAssistantUtteranceIds: string[];
    provenanceSummary: string;
  }>;
  relationships: Array<{
    relationshipId: string; sourceObjectId: string; targetObjectId: string;
    type: string; family: string; confidence: number; explanation: string;
    sourcePropositionIds: string[];
  }>;
  hierarchy: Array<{
    objectId: string; depth: number; parentObjectId: string | null;
    childObjectIds: string[]; treeId: string;
  }>;
  trees: Array<{ treeId: string; rootObjectId: string; objectIds: string[] }>;
  propositions: Array<{
    propositionId: string; propositionType: string; normalizedContent: string;
    authoredBy: string; provenance: string; sourceUtteranceIds: string[];
  }>;
  threads: Array<{ threadId: string; subject: string }>;
};

type ConceptualMapViewProps = {
  graphPayload: SnapshotPayload;
  selectedNodeId: string | null;
  onNodeClick: (objectId: string) => void;
  onClearSelection: () => void;
};

// ─── Role styling ───────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  inquiry: "#3b82f6", insight: "#8b5cf6", problem: "#ef4444", task: "#f59e0b",
  decision: "#10b981", preference: "#ec4899", explanation: "#6366f1",
  plan: "#14b8a6", unresolved: "#6b7280", comparison: "#f97316",
  goal: "#22c55e", project: "#0ea5e9", noise: "#d1d5db", root: "#6366f1",
};

const TYPE_ICONS: Record<string, string> = {
  inquiry: "?", insight: "✦", problem: "!", task: "→", decision: "◆",
  preference: "♥", explanation: "≡", plan: "▤", unresolved: "…",
  comparison: "⇔", goal: "⊕", project: "▣", noise: "~", root: "◉",
};

// ─── Component ──────────────────────────────────────────────────────────────

export default function ConceptualMapView({
  graphPayload,
  selectedNodeId,
  onNodeClick,
  onClearSelection,
}: ConceptualMapViewProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Derive the conceptual map from snapshot
  const map: ConceptualMap = useMemo(() => {
    return deriveConceptualMap(
      graphPayload.objects,
      graphPayload.hierarchy,
      graphPayload.relationships,
    );
  }, [graphPayload]);

  // Handle node expansion (one level at a time)
  const handleExpand = useCallback((nodeId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        // Collapse: remove this node and all its descendants from expanded
        next.delete(nodeId);
        const removeDescendants = (id: string) => {
          const node = map.nodes.get(id);
          if (node) {
            for (const childId of node.childIds) {
              next.delete(childId);
              removeDescendants(childId);
            }
          }
        };
        removeDescendants(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, [map]);

  // Handle node selection (click)
  const handleNodeSelect = useCallback((nodeId: string) => {
    if (nodeId === SYNTHETIC_ROOT_ID) {
      onClearSelection();
      setBreadcrumbs([]);
      return;
    }

    onNodeClick(nodeId);

    // Build breadcrumb path
    const path: string[] = [];
    let current = nodeId;
    while (current) {
      path.unshift(current);
      const node = map.nodes.get(current);
      if (!node || !node.parentId || node.parentId === SYNTHETIC_ROOT_ID) break;
      current = node.parentId;
    }
    setBreadcrumbs(path);

    // Auto-expand path to this node
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const id of path) {
        const node = map.nodes.get(id);
        if (node && node.childIds.length > 0) {
          next.add(id);
        }
      }
      return next;
    });
  }, [map, onNodeClick, onClearSelection]);

  // Reset to overview
  const handleResetOverview = useCallback(() => {
    setExpandedIds(new Set());
    setBreadcrumbs([]);
    onClearSelection();
  }, [onClearSelection]);

  // Compute which nodes are currently visible
  const visibleNodeIds = useMemo(() => {
    const visible = new Set<string>();
    visible.add(map.rootId);

    // Major concepts are always visible
    for (const id of map.majorConceptIds) {
      visible.add(id);
    }

    // Children of expanded nodes are visible
    function revealChildren(parentId: string) {
      if (!expandedIds.has(parentId)) return;
      const node = map.nodes.get(parentId);
      if (!node) return;
      for (const childId of node.childIds) {
        visible.add(childId);
        revealChildren(childId); // recursively reveal expanded children
      }
    }

    for (const id of map.majorConceptIds) {
      revealChildren(id);
    }

    return visible;
  }, [map, expandedIds]);

  // Visible semantic edges (both endpoints must be visible)
  const visibleEdges = useMemo(() => {
    return map.semanticEdges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
    );
  }, [map.semanticEdges, visibleNodeIds]);

  // Root node
  const rootNode = map.nodes.get(map.rootId);

  return (
    <div ref={containerRef} className="flex h-full flex-col overflow-hidden bg-gradient-to-br from-slate-50 to-white">
      {/* Breadcrumb + Reset */}
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2 bg-white/80 backdrop-blur-sm">
        <button
          onClick={handleResetOverview}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Overview
        </button>
        {breadcrumbs.length > 0 && (
          <div className="flex items-center gap-1 text-[11px] text-gray-400">
            {breadcrumbs.map((id, idx) => {
              const node = map.nodes.get(id);
              if (!node) return null;
              return (
                <span key={id} className="flex items-center gap-1">
                  <span className="text-gray-300">›</span>
                  <button
                    onClick={() => handleNodeSelect(id)}
                    className={`rounded px-1.5 py-0.5 transition hover:bg-gray-100 ${
                      idx === breadcrumbs.length - 1 ? "font-medium text-gray-700" : "text-gray-500"
                    }`}
                  >
                    {node.title.length > 20 ? node.title.slice(0, 20) + "…" : node.title}
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Map content */}
      <div className="flex-1 overflow-auto p-6">
        {/* Conversation root */}
        {rootNode && (
          <div className="mb-8 flex justify-center">
            <RootCard
              node={rootNode}
              isSelected={selectedNodeId === rootNode.objectId}
              objectCount={graphPayload.objects.length}
              onClick={() => handleNodeSelect(rootNode.objectId)}
            />
          </div>
        )}

        {/* Major concepts grid */}
        <div className="flex flex-wrap justify-center gap-4 mb-6">
          {map.majorConceptIds.map((conceptId) => {
            const node = map.nodes.get(conceptId);
            if (!node) return null;
            const isExpanded = expandedIds.has(conceptId);
            const isSelected = selectedNodeId === conceptId;
            const isInSelectedPath = breadcrumbs.includes(conceptId);
            const isUnrelated = selectedNodeId !== null && !isInSelectedPath && selectedNodeId !== conceptId;

            return (
              <div key={conceptId} className="flex flex-col items-center">
                <ConceptCard
                  node={node}
                  isExpanded={isExpanded}
                  isSelected={isSelected}
                  isQuieted={isUnrelated}
                  onSelect={() => handleNodeSelect(conceptId)}
                  onExpand={() => handleExpand(conceptId)}
                />

                {/* Expanded children (one level) */}
                {isExpanded && (
                  <div className="mt-3 ml-4 space-y-2 border-l-2 border-gray-200 pl-4 transition-all">
                    {node.childIds.map((childId) => {
                      const child = map.nodes.get(childId);
                      if (!child) return null;
                      const childExpanded = expandedIds.has(childId);
                      const childSelected = selectedNodeId === childId;

                      return (
                        <div key={childId}>
                          <ChildCard
                            node={child}
                            isExpanded={childExpanded}
                            isSelected={childSelected}
                            onSelect={() => handleNodeSelect(childId)}
                            onExpand={() => handleExpand(childId)}
                          />

                          {/* Second-level children */}
                          {childExpanded && child.childIds.length > 0 && (
                            <div className="mt-2 ml-4 space-y-1.5 border-l border-gray-100 pl-3">
                              {child.childIds.map((grandchildId) => {
                                const grandchild = map.nodes.get(grandchildId);
                                if (!grandchild) return null;
                                return (
                                  <LeafCard
                                    key={grandchildId}
                                    node={grandchild}
                                    isSelected={selectedNodeId === grandchildId}
                                    onSelect={() => handleNodeSelect(grandchildId)}
                                    onExpand={() => handleExpand(grandchildId)}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Visible semantic edges (shown as connection indicators) */}
        {visibleEdges.length > 0 && selectedNodeId && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-gray-400">
              Connections
            </p>
            <div className="flex flex-wrap gap-2">
              {visibleEdges
                .filter((e) => e.source === selectedNodeId || e.target === selectedNodeId)
                .slice(0, 8)
                .map((edge) => {
                  const otherId = edge.source === selectedNodeId ? edge.target : edge.source;
                  const otherNode = map.nodes.get(otherId);
                  if (!otherNode) return null;
                  return (
                    <button
                      key={edge.id}
                      onClick={() => handleNodeSelect(otherId)}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] transition hover:border-indigo-300 hover:shadow-sm"
                    >
                      <span className="text-gray-400">{edge.type.replace(/_/g, " ")}</span>
                      <span className="font-medium text-gray-700 truncate max-w-[120px]">
                        {otherNode.title}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Card Components ────────────────────────────────────────────────────────

function RootCard({
  node,
  isSelected,
  objectCount,
  onClick,
}: {
  node: MapNode;
  isSelected: boolean;
  objectCount: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-2xl border-2 px-8 py-5 transition-all ${
        isSelected
          ? "border-indigo-500 bg-indigo-50 shadow-lg shadow-indigo-100"
          : "border-gray-200 bg-white shadow-sm hover:border-indigo-300 hover:shadow-md"
      }`}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-indigo-600">
          <circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><circle cx="18" cy="6" r="2" />
          <path d="M6 8v8M8 6h8M16 18H8" />
        </svg>
      </div>
      <span className="text-[15px] font-semibold text-gray-800">{node.title}</span>
      <span className="text-[12px] text-gray-500">{objectCount} concepts explored</span>
    </button>
  );
}

function ConceptCard({
  node,
  isExpanded,
  isSelected,
  isQuieted,
  onSelect,
  onExpand,
}: {
  node: MapNode;
  isExpanded: boolean;
  isSelected: boolean;
  isQuieted: boolean;
  onSelect: () => void;
  onExpand: () => void;
}) {
  const color = TYPE_COLORS[node.objectType] ?? "#6b7280";
  const icon = TYPE_ICONS[node.objectType] ?? "•";

  return (
    <div
      className={`group w-64 rounded-xl border transition-all ${
        isSelected
          ? "border-indigo-400 bg-indigo-50/50 shadow-md ring-2 ring-indigo-200"
          : isQuieted
            ? "border-gray-100 bg-gray-50/50 opacity-60"
            : "border-gray-200 bg-white shadow-sm hover:shadow-md hover:border-gray-300"
      }`}
    >
      {/* Type accent */}
      <div className="h-1 rounded-t-xl" style={{ backgroundColor: color }} />

      <div className="p-4">
        {/* Header */}
        <button onClick={onSelect} className="w-full text-left">
          <div className="flex items-start gap-2">
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
              style={{ backgroundColor: color }}
            >
              {icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold leading-snug text-gray-800 line-clamp-2">
                {node.title}
              </p>
              <p className="mt-1 text-[11px] text-gray-500 line-clamp-1">
                {node.description}
              </p>
            </div>
          </div>
        </button>

        {/* Footer: expand toggle + count */}
        {node.childIds.length > 0 && (
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[10px] text-gray-400">
              {node.descendantCount} items
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onExpand(); }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
            >
              {isExpanded ? (
                <>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15" /></svg>
                  Collapse
                </>
              ) : (
                <>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
                  Expand
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChildCard({
  node,
  isExpanded,
  isSelected,
  onSelect,
  onExpand,
}: {
  node: MapNode;
  isExpanded: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onExpand: () => void;
}) {
  const color = TYPE_COLORS[node.objectType] ?? "#6b7280";
  const icon = TYPE_ICONS[node.objectType] ?? "•";

  return (
    <div
      className={`rounded-lg border transition-all ${
        isSelected
          ? "border-indigo-300 bg-indigo-50/40 shadow-sm"
          : "border-gray-150 bg-white hover:border-gray-300 hover:shadow-sm"
      }`}
    >
      <button onClick={onSelect} className="flex w-full items-start gap-2 p-3 text-left">
        <span
          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
          style={{ backgroundColor: color }}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium leading-snug text-gray-700 line-clamp-1">
            {node.title}
          </p>
          <p className="mt-0.5 text-[10px] text-gray-400 line-clamp-1">{node.description}</p>
        </div>
        {node.childIds.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); onExpand(); }}
            className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </button>
    </div>
  );
}

function LeafCard({
  node,
  isSelected,
  onSelect,
  onExpand,
}: {
  node: MapNode;
  isSelected: boolean;
  onSelect: () => void;
  onExpand: () => void;
}) {
  const color = TYPE_COLORS[node.objectType] ?? "#6b7280";

  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition ${
        isSelected ? "bg-indigo-50 ring-1 ring-indigo-200" : "hover:bg-gray-50"
      }`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-[11px] text-gray-600 truncate flex-1">{node.title}</span>
      {node.childIds.length > 0 && (
        <span
          onClick={(e) => { e.stopPropagation(); onExpand(); }}
          className="text-[10px] text-gray-400 hover:text-gray-600"
        >
          +{node.childIds.length}
        </span>
      )}
    </button>
  );
}
