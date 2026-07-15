"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type Edge,
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
  edgeMode: EdgeMode;
  onNodeClick: (objectId: string) => void;
};

export default function V2GraphCanvas({
  displayGraph,
  overlapObjectIds,
  selectedNodeId,
  edgeMode,
  onNodeClick,
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

  const [nodes, setNodes, onNodesChange] = useNodesState<V2FlowNode>(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flowEdges);

  useEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes]);
  useEffect(() => { setEdges(flowEdges); }, [flowEdges, setEdges]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: V2FlowNode) => onNodeClick(node.id),
    [onNodeClick],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
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
