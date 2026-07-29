"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type NodeChange,
} from "@xyflow/react";
import { deriveConceptualMap, SYNTHETIC_ROOT_ID, type ConceptualMap, type MapNode } from "./derive-map";
import V2GraphCanvas from "../V2GraphCanvas";
import { normalizeGraph, type DisplayGraph, type DisplayNode } from "@/src/lib/intelligence-v2/normalize-graph";

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

// ─── Layout constants ───────────────────────────────────────────────────────

const CARD_WIDTH = 260;
const ROOT_WIDTH = 220;
const ROOT_HEIGHT = 100;
const H_GAP = 40;
const V_GAP = 120;

// ─── Custom React Flow node types ───────────────────────────────────────────

type RootNodeData = {
  title: string;
  objectCount: number;
  isSelected: boolean;
};

type ConceptNodeData = {
  title: string;
  description: string;
  objectType: string;
  descendantCount: number;
  isSelected: boolean;
  isQuieted: boolean;
};

type OverviewRootNode = Node<RootNodeData, "overviewRoot">;
type OverviewConceptNode = Node<ConceptNodeData, "overviewConcept">;
type OverviewFlowNode = OverviewRootNode | OverviewConceptNode;

function OverviewRootNodeCard({ data }: NodeProps<OverviewRootNode>) {
  return (
    <>
      <div
        className={`flex flex-col items-center gap-1 rounded-2xl border-2 px-8 py-5 transition-all cursor-pointer ${
          data.isSelected
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
        <span className="text-[15px] font-semibold text-gray-800">{data.title}</span>
        <span className="text-[12px] text-gray-500">{data.objectCount} concepts explored</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
    </>
  );
}

function OverviewConceptNodeCard({ data }: NodeProps<OverviewConceptNode>) {
  const color = TYPE_COLORS[data.objectType] ?? "#6b7280";
  const icon = TYPE_ICONS[data.objectType] ?? "•";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div
        className={`group w-64 rounded-xl border transition-all cursor-pointer ${
          data.isSelected
            ? "border-indigo-400 bg-indigo-50/50 shadow-md ring-2 ring-indigo-200"
            : data.isQuieted
              ? "border-gray-100 bg-gray-50/50 opacity-60"
              : "border-gray-200 bg-white shadow-sm hover:shadow-md hover:border-gray-300"
        }`}
      >
        {/* Type accent */}
        <div className="h-1 rounded-t-xl" style={{ backgroundColor: color }} />

        <div className="p-4">
          <div className="flex items-start gap-2">
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
              style={{ backgroundColor: color }}
            >
              {icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold leading-snug text-gray-800 line-clamp-2">
                {data.title}
              </p>
              <p className="mt-1 text-[11px] text-gray-500 line-clamp-1">
                {data.description}
              </p>
            </div>
          </div>

          {data.descendantCount > 0 && (
            <div className="mt-3">
              <span className="text-[10px] text-gray-400">
                {data.descendantCount} items
              </span>
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
    </>
  );
}

const overviewNodeTypes = {
  overviewRoot: OverviewRootNodeCard,
  overviewConcept: OverviewConceptNodeCard,
};

// ─── Component ──────────────────────────────────────────────────────────────

export default function ConceptualMapView({
  graphPayload,
  selectedNodeId,
  onNodeClick,
  onClearSelection,
}: ConceptualMapViewProps) {
  const [focusedObjectId, setFocusedObjectId] = useState<string | null>(null);

  // Derive the conceptual map from snapshot
  const map: ConceptualMap = useMemo(() => {
    return deriveConceptualMap(
      graphPayload.objects,
      graphPayload.hierarchy,
      graphPayload.relationships,
    );
  }, [graphPayload]);

  // Handle node selection (click without drag) — drills into the focused V2 graph
  const handleNodeSelect = useCallback((nodeId: string) => {
    if (nodeId === SYNTHETIC_ROOT_ID) {
      onClearSelection();
      return;
    }
    setFocusedObjectId(nodeId);
    onNodeClick(nodeId);
  }, [onNodeClick, onClearSelection]);

  // Reset to overview
  const handleResetOverview = useCallback(() => {
    setFocusedObjectId(null);
    onClearSelection();
  }, [onClearSelection]);

  // ─── Build React Flow nodes for the overview ────────────────────────────

  const overviewFlowNodes = useMemo((): OverviewFlowNode[] => {
    const flowNodes: OverviewFlowNode[] = [];
    const conceptCount = map.majorConceptIds.length;

    // Position root node centered above concepts
    const totalConceptsWidth = conceptCount * CARD_WIDTH + Math.max(0, conceptCount - 1) * H_GAP;
    const rootX = (totalConceptsWidth - ROOT_WIDTH) / 2;

    const rootNode = map.nodes.get(map.rootId);
    if (rootNode) {
      flowNodes.push({
        id: map.rootId,
        type: "overviewRoot",
        position: { x: Math.max(0, rootX), y: 0 },
        data: {
          title: rootNode.title,
          objectCount: graphPayload.objects.length,
          isSelected: selectedNodeId === map.rootId,
        },
      });
    }

    // Position concept cards in a row below the root
    map.majorConceptIds.forEach((conceptId, idx) => {
      const node = map.nodes.get(conceptId);
      if (!node) return;

      const x = idx * (CARD_WIDTH + H_GAP);
      const y = ROOT_HEIGHT + V_GAP;

      const isSelected = selectedNodeId === conceptId;
      const isQuieted = selectedNodeId !== null && selectedNodeId !== conceptId && selectedNodeId !== map.rootId;

      flowNodes.push({
        id: conceptId,
        type: "overviewConcept",
        position: { x, y },
        data: {
          title: node.title,
          description: node.description,
          objectType: node.objectType,
          descendantCount: node.descendantCount,
          isSelected,
          isQuieted,
        },
      });
    });

    return flowNodes;
  }, [map, graphPayload.objects.length, selectedNodeId]);

  // Build edges from root to each major concept + semantic edges between visible concepts
  const overviewFlowEdges = useMemo((): Edge[] => {
    const flowEdges: Edge[] = [];

    for (const conceptId of map.majorConceptIds) {
      flowEdges.push({
        id: `root-${conceptId}`,
        source: map.rootId,
        target: conceptId,
        type: "default",
        style: { stroke: "#cbd5e1", strokeWidth: 1.5, opacity: 0.6 },
      });
    }

    for (const edge of map.semanticEdges) {
      const sourceVisible = map.majorConceptIds.includes(edge.source) || edge.source === map.rootId;
      const targetVisible = map.majorConceptIds.includes(edge.target) || edge.target === map.rootId;
      if (sourceVisible && targetVisible) {
        flowEdges.push({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "default",
          label: edge.type.replace(/_/g, " "),
          labelStyle: { fontSize: 9, fill: "#94a3b8" },
          labelBgStyle: { fill: "#f8fafc", stroke: "#e2e8f0", strokeWidth: 0.5 },
          labelBgPadding: [4, 2] as [number, number],
          style: { stroke: "#a5b4fc", strokeWidth: 1, strokeDasharray: "4 4", opacity: 0.5 },
        });
      }
    }

    return flowEdges;
  }, [map]);

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState<OverviewFlowNode>(overviewFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(overviewFlowEdges);

  // Track dragged positions so they persist while overview is open
  const draggedPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevNodeIds = useRef<string>(overviewFlowNodes.map((n) => n.id).sort().join(","));

  // Sync nodes when data changes, preserving user-dragged positions
  useEffect(() => {
    const currentIds = overviewFlowNodes.map((n) => n.id).sort().join(",");
    const structureChanged = currentIds !== prevNodeIds.current;
    prevNodeIds.current = currentIds;

    if (structureChanged) {
      draggedPositions.current.clear();
      setNodes(overviewFlowNodes);
    } else {
      setNodes(overviewFlowNodes.map((node) => {
        const dragged = draggedPositions.current.get(node.id);
        return dragged ? { ...node, position: dragged } : node;
      }));
    }
  }, [overviewFlowNodes, setNodes]);

  useEffect(() => {
    setEdges(overviewFlowEdges);
  }, [overviewFlowEdges, setEdges]);

  // Distinguish drag from click: track whether pointer moved significantly
  const dragStartPos = useRef<{ id: string; x: number; y: number } | null>(null);
  const wasDragged = useRef(false);

  const handleNodesChange = useCallback((changes: NodeChange<OverviewFlowNode>[]) => {
    onNodesChange(changes);

    for (const change of changes) {
      if (change.type === "position") {
        if (change.dragging && change.position) {
          if (!dragStartPos.current || dragStartPos.current.id !== change.id) {
            dragStartPos.current = { id: change.id, x: change.position.x, y: change.position.y };
            wasDragged.current = false;
          } else {
            const dx = change.position.x - dragStartPos.current.x;
            const dy = change.position.y - dragStartPos.current.y;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
              wasDragged.current = true;
            }
          }
        }
        if (!change.dragging && change.position) {
          draggedPositions.current.set(change.id, change.position);
        }
      }
    }
  }, [onNodesChange]);

  // Click handler: only drill down if user didn't drag
  const handleNodeClick = useCallback((_: React.MouseEvent, node: OverviewFlowNode) => {
    if (wasDragged.current) {
      wasDragged.current = false;
      dragStartPos.current = null;
      return;
    }
    dragStartPos.current = null;
    handleNodeSelect(node.id);
  }, [handleNodeSelect]);

  // ─── Focused component: filter the real V2 graph to the focused subtree ───
  const focusedDisplayGraph: DisplayGraph | null = useMemo(() => {
    if (!focusedObjectId) return null;

    const fullGraph = normalizeGraph(
      graphPayload.objects as Parameters<typeof normalizeGraph>[0],
      graphPayload.relationships as Parameters<typeof normalizeGraph>[1],
    );

    const componentIds = new Set<string>();
    function collectSubtree(nodeId: string) {
      componentIds.add(nodeId);
      const node = fullGraph.nodes.find((n) => n.objectId === nodeId);
      if (node) {
        for (const childId of node.childIds) {
          collectSubtree(childId);
        }
      }
    }
    collectSubtree(focusedObjectId);

    const focusedNode = fullGraph.nodes.find((n) => n.objectId === focusedObjectId);
    if (focusedNode?.parentId) {
      componentIds.add(focusedNode.parentId);
    }

    const filteredNodes: DisplayNode[] = fullGraph.nodes.filter((n) => componentIds.has(n.objectId));
    const filteredSemanticEdges = fullGraph.semanticEdges.filter(
      (e) => componentIds.has(e.source) && componentIds.has(e.target),
    );
    const filteredStructuralEdges = fullGraph.structuralEdges.filter(
      (e) => componentIds.has(e.source) && componentIds.has(e.target),
    );

    return {
      nodes: filteredNodes,
      trees: fullGraph.trees.filter((t) => t.nodeIds.some((id) => componentIds.has(id))),
      semanticEdges: filteredSemanticEdges,
      structuralEdges: filteredStructuralEdges,
      diagnostics: { ...fullGraph.diagnostics, totalObjects: filteredNodes.length },
    };
  }, [focusedObjectId, graphPayload]);

  const focusedOverlapIds = useMemo(() => new Set<string>(), []);

  // ─── Focused view: render the real V2 graph for the selected component ───
  if (focusedObjectId && focusedDisplayGraph) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2 bg-white/80 backdrop-blur-sm shrink-0">
          <button
            onClick={handleResetOverview}
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium text-gray-600 transition hover:bg-gray-100 hover:text-gray-800"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to overview
          </button>
          <span className="text-[11px] text-gray-400">
            {focusedDisplayGraph.diagnostics.totalObjects} nodes in this branch
          </span>
        </div>
        <div className="flex-1">
          <V2GraphCanvas
            displayGraph={focusedDisplayGraph}
            overlapObjectIds={focusedOverlapIds}
            selectedNodeId={selectedNodeId}
            edgeMode="structure"
            onNodeClick={onNodeClick}
          />
        </div>
      </div>
    );
  }

  // ─── Overview rendered inside React Flow ──────────────────────────────────
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={overviewNodeTypes}
          nodesDraggable
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
          minZoom={0.3}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          className="h-full w-full"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e5e7eb" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
