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
import ContextNodeCard, {
  type ContextFlowNode,
} from "./ContextNodeCard";

// Tell React Flow which component to use for our custom node type
const nodeTypes = { contextNode: ContextNodeCard };

// Arrange nodes in a simple top-to-bottom column layout.
// Later this can be replaced with a force-directed or dagre layout.
function buildFlowNodes(contextNodes: ContextNode[]): ContextFlowNode[] {
  return contextNodes.map((node, index) => ({
    id: node.id,
    type: "contextNode" as const,
    position: { x: 100, y: index * 180 },
    data: {
      title: node.title,
      summary: node.summary,
      messageCount: node.messageIds.length,
    },
  }));
}

type GraphCanvasProps = {
  contextNodes: ContextNode[];
  onNodeClick: (nodeId: string) => void;
};

export default function GraphCanvas({ contextNodes, onNodeClick }: GraphCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ContextFlowNode>(
    buildFlowNodes(contextNodes),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Keep the canvas in sync when new context nodes are created
  useEffect(() => {
    setNodes(buildFlowNodes(contextNodes));
  }, [contextNodes, setNodes]);

  // Allow users to draw edges between nodes manually
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
