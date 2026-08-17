"use client";

import { useCallback, useEffect, useMemo } from "react";
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
}: V2GraphCanvasProps) {
  const positions = useMemo(() => layoutDisplayForest(displayGraph), [displayGraph]);

  const flowNodes = useMemo(
    () => buildFlowNodes(displayGraph, positions, selectedNodeId, overlapObjectIds),
    [displayGraph, positions, selectedNodeId, overlapObjectIds],
  );

  const flowEdges = useMemo(
    () => buildVisibleEdges(displayGraph, edgeMode, selectedNodeId),
    [displayGraph, edgeMode, selectedNodeId],
  );

  // Derive display edges: base styles from flowEdges + selection overlay from selectedEdgeId.
  // This never mutates the canonical edge styles — selection is purely derived UI state.
  const displayEdges = useMemo(() => {
    if (!selectedEdgeId) return flowEdges;
    return flowEdges.map((e) =>
      e.id === selectedEdgeId
        ? { ...e, selected: true, animated: true, style: { ...e.style, stroke: "#6366f1", strokeWidth: 3 } }
        : { ...e, selected: false, animated: false }
    );
  }, [flowEdges, selectedEdgeId]);

  const [nodes, setNodes, onNodesChange] = useNodesState<V2FlowNode>(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(displayEdges);

  useEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes]);
  useEffect(() => { setEdges(displayEdges); }, [displayEdges, setEdges]);

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
      onNodesChange={onNodesChange}
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
