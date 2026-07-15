/**
 * Pure display layout functions for the V2 normalized graph.
 *
 * Layouts each tree independently via Dagre, then packs trees into a forest grid.
 * No semantic content is inspected — only structural edges and tree membership.
 */

import Dagre from "@dagrejs/dagre";
import type { DisplayGraph, DisplayNode } from "./normalize-graph";

// ─── Constants ──────────────────────────────────────────────────────────────

const NODE_WIDTH = 260;
const NODE_HEIGHT = 100;
const TREE_GAP_X = 120;
const TREE_GAP_Y = 80;
const INTERNAL_NODESEP = 50;
const INTERNAL_RANKSEP = 90;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Position { x: number; y: number }

export interface LayoutResult {
  positions: Map<string, Position>;
  bounds: { width: number; height: number };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Layout the full display forest.
 * Each tree is laid out independently, then trees are packed into rows.
 */
export function layoutDisplayForest(graph: DisplayGraph): Map<string, Position> {
  if (graph.nodes.length === 0) return new Map();

  // Single-node graph: center it
  if (graph.nodes.length === 1) {
    const positions = new Map<string, Position>();
    positions.set(graph.nodes[0].objectId, { x: 0, y: 0 });
    return positions;
  }

  // Layout each tree independently
  const treeLayouts: Array<{ treeId: string; layout: LayoutResult; nodeCount: number }> = [];

  for (const tree of graph.trees) {
    const treeNodes = graph.nodes.filter((n) => tree.nodeIds.includes(n.objectId));
    if (treeNodes.length === 0) continue;

    const layout = layoutSingleTree(treeNodes);
    treeLayouts.push({ treeId: tree.treeId, layout, nodeCount: treeNodes.length });
  }

  // Sort trees: largest first for visual hierarchy stability
  treeLayouts.sort((a, b) => b.nodeCount - a.nodeCount);

  // Pack trees into rows
  return packTreesIntoForest(treeLayouts);
}

// ─── Single Tree Layout ─────────────────────────────────────────────────────

function layoutSingleTree(nodes: DisplayNode[]): LayoutResult {
  if (nodes.length === 1) {
    const positions = new Map<string, Position>();
    positions.set(nodes[0].objectId, { x: 0, y: 0 });
    return { positions, bounds: { width: NODE_WIDTH, height: NODE_HEIGHT } };
  }

  const g = new Dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: INTERNAL_NODESEP, ranksep: INTERNAL_RANKSEP, marginx: 0, marginy: 0 });

  for (const node of nodes) {
    g.setNode(node.objectId, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Add parent→child edges for layout
  const nodeIdSet = new Set(nodes.map((n) => n.objectId));
  for (const node of nodes) {
    if (node.parentId && nodeIdSet.has(node.parentId)) {
      g.setEdge(node.parentId, node.objectId);
    }
  }

  Dagre.layout(g);

  // Extract positions and compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rawPositions = new Map<string, Position>();

  for (const node of nodes) {
    const pos = g.node(node.objectId);
    if (pos) {
      const x = pos.x - NODE_WIDTH / 2;
      const y = pos.y - NODE_HEIGHT / 2;
      rawPositions.set(node.objectId, { x, y });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + NODE_WIDTH);
      maxY = Math.max(maxY, y + NODE_HEIGHT);
    }
  }

  // Normalize to (0,0) origin
  const positions = new Map<string, Position>();
  for (const [id, pos] of rawPositions) {
    positions.set(id, { x: pos.x - minX, y: pos.y - minY });
  }

  return { positions, bounds: { width: maxX - minX, height: maxY - minY } };
}

// ─── Forest Packing ─────────────────────────────────────────────────────────

function packTreesIntoForest(
  treeLayouts: Array<{ treeId: string; layout: LayoutResult; nodeCount: number }>,
): Map<string, Position> {
  if (treeLayouts.length === 0) return new Map();
  if (treeLayouts.length === 1) return treeLayouts[0].layout.positions;

  // Estimate target row width from total area
  const totalArea = treeLayouts.reduce((sum, t) => sum + t.layout.bounds.width * t.layout.bounds.height, 0);
  const targetWidth = Math.max(
    Math.sqrt(totalArea) * 1.5,
    treeLayouts.reduce((max, t) => Math.max(max, t.layout.bounds.width), 0),
  );

  // Pack into rows
  type Row = { trees: typeof treeLayouts; offsets: number[]; width: number; height: number };
  const rows: Row[] = [];
  let currentRow: Row = { trees: [], offsets: [], width: 0, height: 0 };

  for (const tree of treeLayouts) {
    const gap = currentRow.trees.length > 0 ? TREE_GAP_X : 0;
    const wouldBe = currentRow.width + gap + tree.layout.bounds.width;

    if (currentRow.trees.length > 0 && wouldBe > targetWidth) {
      rows.push(currentRow);
      currentRow = { trees: [], offsets: [], width: 0, height: 0 };
    }

    const xOffset = currentRow.width + (currentRow.trees.length > 0 ? TREE_GAP_X : 0);
    currentRow.offsets.push(xOffset);
    currentRow.trees.push(tree);
    currentRow.width = xOffset + tree.layout.bounds.width;
    currentRow.height = Math.max(currentRow.height, tree.layout.bounds.height);
  }
  if (currentRow.trees.length > 0) rows.push(currentRow);

  // Assemble final positions
  const positions = new Map<string, Position>();
  const maxRowWidth = Math.max(...rows.map((r) => r.width));
  let currentY = 0;

  for (const row of rows) {
    const rowOffsetX = (maxRowWidth - row.width) / 2;

    for (let i = 0; i < row.trees.length; i++) {
      const tree = row.trees[i];
      const treeX = rowOffsetX + row.offsets[i];
      const treeY = currentY + (row.height - tree.layout.bounds.height) / 2;

      for (const [id, pos] of tree.layout.positions) {
        positions.set(id, { x: treeX + pos.x, y: treeY + pos.y });
      }
    }

    currentY += row.height + TREE_GAP_Y;
  }

  // Center around origin for fitView
  const totalHeight = currentY - TREE_GAP_Y;
  const centerX = -maxRowWidth / 2;
  const centerY = -totalHeight / 2;

  for (const [id, pos] of positions) {
    positions.set(id, { x: pos.x + centerX, y: pos.y + centerY });
  }

  return positions;
}

// ─── Edge Building (pure) ───────────────────────────────────────────────────

import type { Edge } from "@xyflow/react";

export type EdgeMode = "structure" | "local" | "all";

export function buildVisibleEdges(
  graph: DisplayGraph,
  mode: EdgeMode,
  selectedNodeId: string | null,
): Edge[] {
  const edges: Edge[] = [];

  // Canonical hierarchy edges
  for (const node of graph.nodes) {
    if (node.parentId) {
      edges.push({
        id: `hier-${node.parentId}-${node.objectId}`,
        source: node.parentId,
        target: node.objectId,
        type: "default",
        style: { stroke: "#334155", strokeWidth: 2, opacity: 0.85 },
      });
    }
  }

  // Structural non-hierarchy edges
  for (const e of graph.structuralEdges) {
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "default",
      label: e.type.replace(/_/g, " "),
      labelStyle: { fontSize: 9, fill: "#94a3b8" },
      labelBgStyle: { fill: "#f8fafc", stroke: "#e2e8f0", strokeWidth: 0.5 },
      labelBgPadding: [4, 2] as [number, number],
      style: { stroke: "#cbd5e1", strokeWidth: 1, strokeDasharray: "4 4", opacity: 0.5 },
      markerEnd: { type: "arrowclosed" as const, width: 10, height: 10, color: "#cbd5e1" },
    });
  }

  // Semantic edges based on mode
  if (mode === "all") {
    for (const e of graph.semanticEdges) {
      edges.push(makeSemanticEdge(e, 0.35));
    }
  } else if (mode === "local" && selectedNodeId) {
    for (const e of graph.semanticEdges) {
      if (e.source === selectedNodeId || e.target === selectedNodeId) {
        edges.push(makeSemanticEdge(e, 0.7));
      }
    }
  }

  return edges;
}

function makeSemanticEdge(e: DisplayGraph["semanticEdges"][0], opacity: number): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: "default",
    label: e.type.replace(/_/g, " "),
    labelStyle: { fontSize: 8, fill: "#7c3aed" },
    labelBgStyle: { fill: "#faf5ff", stroke: "#e9d5ff", strokeWidth: 0.5 },
    labelBgPadding: [3, 1] as [number, number],
    style: { stroke: "#8b5cf6", strokeWidth: 1, opacity, strokeDasharray: "3 3" },
    markerEnd: { type: "arrowclosed" as const, width: 10, height: 10, color: "#8b5cf6" },
  };
}

// ─── Node Building (pure) ───────────────────────────────────────────────────

import type { V2FlowNode } from "@/src/components/graph-v2/V2NodeCard";

export function buildFlowNodes(
  graph: DisplayGraph,
  positions: Map<string, Position>,
  selectedNodeId: string | null,
  overlapIds: Set<string>,
): V2FlowNode[] {
  return graph.nodes.map((node) => {
    const pos = positions.get(node.objectId) ?? { x: 0, y: 0 };
    const isSelected = node.objectId === selectedNodeId;
    const isNeighbor = selectedNodeId
      ? node.parentId === selectedNodeId ||
        node.childIds.includes(selectedNodeId) ||
        graph.semanticEdges.some(
          (e) =>
            (e.source === selectedNodeId && e.target === node.objectId) ||
            (e.target === selectedNodeId && e.source === node.objectId),
        )
      : false;
    const isFaded = selectedNodeId !== null && !isSelected && !isNeighbor;

    return {
      id: node.objectId,
      type: "v2Node" as const,
      position: pos,
      data: {
        title: node.title,
        objectType: node.objectType,
        description: node.description,
        maturity: "developing",
        status: "active",
        propositionCount: 0,
        depth: node.depth,
        hasOverlap: overlapIds.has(node.objectId),
      },
      style: isFaded ? { opacity: 0.3 } : undefined,
    };
  });
}

/**
 * Get the IDs of nodes in the local semantic neighborhood of the selected node.
 */
export function getLocalSemanticNeighborhood(
  graph: DisplayGraph,
  selectedNodeId: string,
): Set<string> {
  const neighbors = new Set<string>();
  neighbors.add(selectedNodeId);

  // Parent and children
  const node = graph.nodes.find((n) => n.objectId === selectedNodeId);
  if (node) {
    if (node.parentId) neighbors.add(node.parentId);
    for (const cid of node.childIds) neighbors.add(cid);
  }

  // Semantic neighbors
  for (const e of graph.semanticEdges) {
    if (e.source === selectedNodeId) neighbors.add(e.target);
    if (e.target === selectedNodeId) neighbors.add(e.source);
  }

  return neighbors;
}
