"use client";

/**
 * Graph Dashboard page — feature-flag gated.
 *
 * NEXT_PUBLIC_GRAPH_WORKSPACES=true  → New DB-backed multi-workspace system
 * NEXT_PUBLIC_GRAPH_WORKSPACES=false → Legacy localStorage single-dashboard
 *
 * This is the only branching point. Shared components (V2NodeCard, graph-clipboard,
 * React Flow canvas, etc.) are used by both implementations unchanged.
 */

import LegacyGraphDashboard from "./LegacyGraphDashboard";
import GraphWorkspacesDashboard from "./GraphWorkspacesDashboard";

const GRAPH_WORKSPACES_ENABLED =
  process.env.NEXT_PUBLIC_GRAPH_WORKSPACES === "true";

export default function GraphDashboardPage() {
  if (GRAPH_WORKSPACES_ENABLED) {
    return <GraphWorkspacesDashboard />;
  }
  return <LegacyGraphDashboard />;
}
