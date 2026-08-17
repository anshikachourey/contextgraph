"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  SelectionMode,
  type Edge,
  type Connection,
  type OnSelectionChangeParams,
  type NodeChange,
} from "@xyflow/react";
import V2NodeCard, { type V2FlowNode } from "./V2NodeCard";
import type { DisplayGraph } from "@/src/lib/intelligence-v2/normalize-graph";
import {
  layoutDisplayForest,
  buildVisibleEdges,
  buildFlowNodes,
  type EdgeMode,
} from "@/src/lib/intelligence-v2/display-layout";

export type { EdgeMode } from "@/src/lib/intelligence-v2/display-layout";

const nodeTypes = { v2Node: V2NodeCard };

type V2GraphCanvasProps = {
  displayGraph: DisplayGraph;
  overlapObjectIds: Set<string>;
  selectedNodeId: string | null;
  selectedEdgeId?: string | null;
  edgeMode: EdgeMode;
  onNodeClick: (objectId: string) => void;
  onEdgeClick?: (edgeId: string) => void;
  onConnect?: (connection: Connection) => void;
  onSelectionChange?: (params: OnSelectionChangeParams) => void;
  panOnDrag?: boolean;
  /** Conversation ID for position persistence. If provided, user-dragged positions are saved. */
  conversationId?: string;
  /** Pre-loaded saved positions from DB. Keys are objectIds, values are {x, y}. */
  savedPositions?: Map<string, { x: number; y: number }>;
};

export default function V2GraphCanvas({
  displayGraph,
  overlapObjectIds,
  selectedNodeId,
  selectedEdgeId,
  edgeMode,
  onNodeClick,
  onEdgeClick,
  onConnect,
  onSelectionChange,
  panOnDrag = true,
  conversationId,
  savedPositions,
}: V2GraphCanvasProps) {
  // Auto-layout positions
  const autoPositions = useMemo(() => layoutDisplayForest(displayGraph), [displayGraph]);

  // Merge: saved positions override auto-layout for existing nodes
  const positions = useMemo(() => {
    if (!savedPositions || savedPositions.size === 0) return autoPositions;
    const merged = new Map(autoPositions);
    for (const [nodeId, pos] of savedPositions) {
      if (merged.has(nodeId)) {
        merged.set(nodeId, pos);
      }
    }
    return merged;
  }, [autoPositions, savedPositions]);

  const flowNodes = useMemo(
    () => buildFlowNodes(displayGraph, positions, selectedNodeId, overlapObjectIds),
    [displayGraph, positions, selectedNodeId, overlapObjectIds],
  );

  const flowEdges = useMemo(
    () => buildVisibleEdges(displayGraph, edgeMode, selectedNodeId),
    [displayGraph, edgeMode, selectedNodeId],
  );

  // Derive display edges: base styles from flowEdges + selection overlay from selectedEdgeId.
  const displayEdges = useMemo(() => {
    if (!selectedEdgeId) return flowEdges;
    return flowEdges.map((e) =>
      e.id === selectedEdgeId
        ? { ...e, selected: true, animated: true, style: { ...e.style, stroke: "#6366f1", strokeWidth: 3 } }
        : { ...e, selected: false, animated: false }
    );
  }, [flowEdges, selectedEdgeId]);

  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<V2FlowNode>(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(displayEdges);

  useEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes]);
  useEffect(() => { setEdges(displayEdges); }, [displayEdges, setEdges]);

  // ─── Position persistence on drag stop ──────────────────────────────────
  const pendingPositionSaves = useRef<Map<string, { x: number; y: number }>>(new Map());
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPositionSaves = useCallback(() => {
    if (!conversationId || pendingPositionSaves.current.size === 0) return;

    const positions = Array.from(pendingPositionSaves.current.entries()).map(([nodeId, pos]) => ({
      nodeId,
      x: pos.x,
      y: pos.y,
    }));
    pendingPositionSaves.current.clear();

    fetch("/api/conversation-node-positions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, positions }),
    }).catch((err) => {
      console.error("[V2GraphCanvas] Failed to save node positions:", err);
    });
  }, [conversationId]);

  const handleNodesChange = useCallback((changes: NodeChange<V2FlowNode>[]) => {
    onNodesChangeInternal(changes);

    if (!conversationId) return;

    // Detect drag-end events (position change with dragging=false)
    for (const change of changes) {
      if (change.type === "position" && !change.dragging && change.position) {
        pendingPositionSaves.current.set(change.id, change.position);
      }
    }

    // Debounce the save to batch multiple simultaneous drag-end events
    if (pendingPositionSaves.current.size > 0) {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(flushPositionSaves, 300);
    }
  }, [onNodesChangeInternal, conversationId, flushPositionSaves]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        flushPositionSaves();
      }
    };
  }, [flushPositionSaves]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: V2FlowNode) => onNodeClick(node.id),
    [onNodeClick],
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => onEdgeClick?.(edge.id),
    [onEdgeClick],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={handleNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      onEdgeClick={handleEdgeClick}
      onConnect={onConnect}
      onSelectionChange={onSelectionChange}
      panOnDrag={panOnDrag}
      selectionOnDrag={!panOnDrag}
      selectionMode={SelectionMode.Partial}
      multiSelectionKeyCode="Meta"
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
      minZoom={0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      className="h-full w-full"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e5e7eb" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
