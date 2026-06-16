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
  type Node,
  type Edge,
  type OnConnect,
} from "@xyflow/react";
import type { ContextNode } from "@/src/types/node";
import ContextNodeCard, { type ContextNodeData } from "./ContextNodeCard";

// Tell React Flow which component to use for our custom node type
const nodeTypes = { contextNode: ContextNodeCard };

// Arrange nodes in a simple top-to-bottom column layout.
// Later this can be replaced with a force-directed or dagre layout.
function buildFlowNodes(contextNodes: ContextNode[]): Node<ContextNodeData>[] {
  return contextNodes.map((node, index) => ({
    id: node.id,
    type: "contextNode",
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
};

export default function GraphCanvas({ contextNodes }: GraphCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ContextNodeData>>(
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
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      className="h-full w-full"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e5e7eb" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
