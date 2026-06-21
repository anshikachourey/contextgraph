"use client";

import { useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  BackgroundVariant,
  type Edge,
  type OnConnect,
} from "@xyflow/react";
import type { ContextNode } from "@/src/types/node";
import type { SemanticEdge } from "@/src/types/edge";
import { layoutGraph } from "@/src/lib/graphLayout";
import ContextNodeCard, {
  type ContextFlowNode,
} from "./ContextNodeCard";

// Tell React Flow which component to use for our custom node type
const nodeTypes = { contextNode: ContextNodeCard };

// Build React Flow nodes with dagre-computed positions.
// Connected nodes are positioned near each other; isolated nodes
// are stacked in a column at the end.
function buildFlowNodes(
  contextNodes: ContextNode[],
  semanticEdges: SemanticEdge[],
): ContextFlowNode[] {
  // Compute layout using semantic edges as graph structure
  const edges = semanticEdges.map((se) => ({
    source: se.sourceNodeId,
    target: se.targetNodeId,
  }));

  const positions = layoutGraph(
    contextNodes.map((n) => n.id),
    edges,
  );

  return contextNodes.map((node) => {
    const pos = positions.get(node.id) ?? { x: 100, y: 0 };
    return {
      id: node.id,
      type: "contextNode" as const,
      position: pos,
      data: {
        title: node.title,
        summary: node.summary,
        messageCount: node.messageIds.length,
      },
    };
  });
}

// Convert persisted semantic edges into React Flow edge objects.
// Suggested edges render as dashed + faint.
function buildFlowEdges(semanticEdges: SemanticEdge[]): Edge[] {
  return semanticEdges.map((se) => ({
    id: se.id,
    source: se.sourceNodeId,
    target: se.targetNodeId,
    type: "default",
    animated: false,
    style: {
      strokeDasharray: "5 5",
      stroke: "#94a3b8", // slate-400
      strokeWidth: 1.5,
      opacity: 0.7,
    },
    label: "",
  }));
}

type GraphCanvasProps = {
  contextNodes: ContextNode[];
  semanticEdges: SemanticEdge[];
  onNodeClick: (nodeId: string) => void;
};

export default function GraphCanvas({
  contextNodes,
  semanticEdges,
  onNodeClick,
}: GraphCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ContextFlowNode>(
    buildFlowNodes(contextNodes, semanticEdges),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    buildFlowEdges(semanticEdges),
  );

  // Recompute layout when nodes or edges change
  useEffect(() => {
    setNodes(buildFlowNodes(contextNodes, semanticEdges));
  }, [contextNodes, semanticEdges, setNodes]);

  useEffect(() => {
    setEdges(buildFlowEdges(semanticEdges));
  }, [semanticEdges, setEdges]);

  // Allow users to draw edges between nodes manually (kept for future use)
  const onConnect: OnConnect = useCallback(
    (connection) => setEdges((current) => addEdge(connection, current)),
    [setEdges],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={(_event, node) => onNodeClick(node.id)}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      proOptions={{ hideAttribution: true }}
      className="h-full w-full"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e5e7eb" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
