import Dagre from "@dagrejs/dagre";

type LayoutEdge = {
  source: string;
  target: string;
};

type Position = { x: number; y: number };

// ═══════════════════════════════════════════════════════════════════════════════
// LAYOUT CONFIG — Tune these values to adjust graph density and readability.
// fitView scales the graph to fill the viewport, so the bounding box size
// directly determines perceived node scale. Smaller total layout = nodes
// appear larger. Balance: enough spacing for cluster visibility, not so much
// that fitView zooms out and makes everything tiny.
// ═══════════════════════════════════════════════════════════════════════════════

/** Estimated node card width (must match CSS: w-64 = 256px + padding). */
const NODE_WIDTH = 260;

/** Estimated node card height (title + summary + handles). */
const NODE_HEIGHT = 130;

/**
 * Horizontal spacing between sibling nodes WITHIN a cluster.
 * Keep tight — the edge line between them already signals the connection.
 */
const CLUSTER_NODESEP = 60;

/**
 * Depth (rank) spacing between connected nodes WITHIN a cluster.
 * Controls layer separation in the LR flow direction.
 */
const CLUSTER_RANKSEP = 90;

/**
 * Horizontal gap between blocks (clusters or isolates) in the grid.
 * Must be visibly larger than CLUSTER_NODESEP so clusters read as distinct groups.
 */
const BLOCK_GAP_X = 100;

/**
 * Vertical gap between rows of blocks.
 */
const BLOCK_GAP_Y = 100;

/**
 * Target row width multiplier for grid packing.
 * Applied to sqrt(totalArea). Lower = more rows, squarer canvas.
 * 1.6 balances landscape aspect ratio with compact bounding box.
 */
const TARGET_WIDTH_MULTIPLIER = 1.6;

// ═══════════════════════════════════════════════════════════════════════════════

// ─── Connected Components ───────────────────────────────────────────────────

function findConnectedComponents(
  nodeIds: string[],
  edges: LayoutEdge[],
): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    adj.set(id, new Set());
  }
  for (const edge of edges) {
    adj.get(edge.source)?.add(edge.target);
    adj.get(edge.target)?.add(edge.source);
  }

  const visited = new Set<string>();
  const components: string[][] = [];

  for (const id of nodeIds) {
    if (visited.has(id)) continue;
    const component: string[] = [];
    const queue = [id];
    visited.add(id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  return components;
}

// ─── Dagre Layout for a Single Cluster ──────────────────────────────────────

type Block = {
  nodePositions: Map<string, Position>;
  width: number;
  height: number;
};

function layoutCluster(nodeIds: string[], edges: LayoutEdge[]): Block {
  const g = new Dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: CLUSTER_NODESEP,
    ranksep: CLUSTER_RANKSEP,
    marginx: 0,
    marginy: 0,
  });

  for (const id of nodeIds) {
    g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    if (nodeIds.includes(edge.source) && nodeIds.includes(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  Dagre.layout(g);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const rawPositions = new Map<string, Position>();
  for (const id of nodeIds) {
    const pos = g.node(id);
    const x = pos.x - NODE_WIDTH / 2;
    const y = pos.y - NODE_HEIGHT / 2;
    rawPositions.set(id, { x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_WIDTH);
    maxY = Math.max(maxY, y + NODE_HEIGHT);
  }

  const nodePositions = new Map<string, Position>();
  for (const [id, pos] of rawPositions) {
    nodePositions.set(id, { x: pos.x - minX, y: pos.y - minY });
  }

  return {
    nodePositions,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function makeIsolatedBlock(nodeId: string): Block {
  const nodePositions = new Map<string, Position>();
  nodePositions.set(nodeId, { x: 0, y: 0 });
  return {
    nodePositions,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  };
}

// ─── Grid Packing ───────────────────────────────────────────────────────────

function packBlocks(blocks: Block[]): Map<string, Position> {
  if (blocks.length === 0) return new Map();

  const totalArea = blocks.reduce((sum, b) => sum + b.width * b.height, 0);
  const targetWidth = Math.max(
    Math.sqrt(totalArea) * TARGET_WIDTH_MULTIPLIER,
    blocks.reduce((max, b) => Math.max(max, b.width), 0),
  );

  type Row = { blocks: Block[]; offsets: number[]; width: number; height: number };
  const rows: Row[] = [];
  let currentRow: Row = { blocks: [], offsets: [], width: 0, height: 0 };

  for (const block of blocks) {
    const gap = currentRow.blocks.length > 0 ? BLOCK_GAP_X : 0;
    const wouldBeWidth = currentRow.width + gap + block.width;

    if (currentRow.blocks.length > 0 && wouldBeWidth > targetWidth) {
      rows.push(currentRow);
      currentRow = { blocks: [], offsets: [], width: 0, height: 0 };
    }

    const xOffset = currentRow.width + (currentRow.blocks.length > 0 ? BLOCK_GAP_X : 0);
    currentRow.offsets.push(xOffset);
    currentRow.blocks.push(block);
    currentRow.width = xOffset + block.width;
    currentRow.height = Math.max(currentRow.height, block.height);
  }
  if (currentRow.blocks.length > 0) rows.push(currentRow);

  const positions = new Map<string, Position>();
  let currentY = 0;
  const totalWidth = Math.max(...rows.map((r) => r.width));

  for (const row of rows) {
    const rowOffsetX = (totalWidth - row.width) / 2;

    for (let i = 0; i < row.blocks.length; i++) {
      const block = row.blocks[i];
      const blockX = rowOffsetX + row.offsets[i];
      const blockY = currentY + (row.height - block.height) / 2;

      for (const [id, pos] of block.nodePositions) {
        positions.set(id, {
          x: blockX + pos.x,
          y: blockY + pos.y,
        });
      }
    }

    currentY += row.height + BLOCK_GAP_Y;
  }

  // Centre around (0, 0) so fitView places it perfectly in viewport
  const totalHeight = currentY - BLOCK_GAP_Y;
  const centerOffsetX = -totalWidth / 2;
  const centerOffsetY = -totalHeight / 2;

  for (const [id, pos] of positions) {
    positions.set(id, {
      x: pos.x + centerOffsetX,
      y: pos.y + centerOffsetY,
    });
  }

  return positions;
}

// ─── Main Layout Function ───────────────────────────────────────────────────

/**
 * Presentation-quality knowledge map layout.
 *
 * Optimized for fullscreen/demo readability:
 * - Connected nodes form loose, readable clusters (dagre LR)
 * - Generous whitespace between all elements
 * - Grid packing fills the canvas in a balanced 2D arrangement
 * - Centred around origin for perfect fitView behaviour
 *
 * Tune the LAYOUT CONFIG constants at the top of this file
 * to adjust spacing without changing the algorithm.
 */
export function layoutGraph(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
): Map<string, Position> {
  if (nodeIds.length === 0) return new Map();

  const components = findConnectedComponents(nodeIds, edges);

  const blocks: Block[] = [];
  for (const component of components) {
    if (component.length >= 2) {
      blocks.push(layoutCluster(component, edges));
    } else {
      blocks.push(makeIsolatedBlock(component[0]));
    }
  }

  // Largest blocks first for visual hierarchy stability
  blocks.sort((a, b) => b.width * b.height - a.width * a.height);

  return packBlocks(blocks);
}
