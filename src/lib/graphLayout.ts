import Dagre from "@dagrejs/dagre";

type LayoutNode = {
  id: string;
  width: number;
  height: number;
};

type LayoutEdge = {
  source: string;
  target: string;
};

type PositionedNode = {
  id: string;
  x: number;
  y: number;
};

// Estimated node dimensions — matches the w-56 (224px) card + padding.
// Height is approximate; dagre uses it for spacing, not pixel-perfect rendering.
const DEFAULT_NODE_WIDTH = 240;
const DEFAULT_NODE_HEIGHT = 120;

/**
 * Compute dagre layout positions for a set of nodes and edges.
 *
 * Direction: top-to-bottom (TB) — conversation flows downward,
 * connected nodes spread horizontally so edges are clearly visible.
 *
 * Returns a map of node ID → { x, y } centre positions.
 * React Flow expects top-left coordinates, so the caller must subtract
 * half the node dimensions when applying positions.
 */
export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): PositionedNode[] {
  const g = new Dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep: 60, // horizontal spacing between siblings
    ranksep: 100, // vertical spacing between ranks
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: node.width, height: node.height });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  Dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    // Dagre returns centre coordinates.
    // Subtract half dimensions to get top-left (React Flow's coordinate system).
    return {
      id: node.id,
      x: pos.x - node.width / 2,
      y: pos.y - node.height / 2,
    };
  });
}

/**
 * Convenience wrapper that builds layout inputs from raw node/edge arrays.
 * Returns a position map: node ID → { x, y }.
 */
export function layoutGraph(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const layoutNodes: LayoutNode[] = nodeIds.map((id) => ({
    id,
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
  }));

  const positioned = computeLayout(layoutNodes, edges);

  const positionMap = new Map<string, { x: number; y: number }>();
  for (const p of positioned) {
    positionMap.set(p.id, { x: p.x, y: p.y });
  }
  return positionMap;
}
