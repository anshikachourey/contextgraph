import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { requireSession, isAuthError } from "@/src/lib/auth";

/**
 * GET /api/graph-dashboard — Load the manual graph dashboard for the user's workspace.
 * POST /api/graph-dashboard — Save the full manual graph state (nodes + edges + positions).
 *
 * Persistence approach:
 * Uses a real conversation row (with a deterministic UUID per workspace) as the
 * owning entity for a v2_graph_snapshots record. The conversation is archived
 * so it's hidden from the sidebar. This satisfies the UUID FK constraint without
 * creating a separate table.
 *
 * Deterministic UUID per workspace:
 *   "owner"  → 00000000-0000-4000-a000-000000000001
 *   "demo"   → 00000000-0000-4000-a000-000000000002
 */

// Deterministic UUIDs for dashboard conversations (one per workspace)
const DASHBOARD_IDS: Record<string, string> = {
  owner: "00000000-0000-4000-a000-000000000001",
  demo: "00000000-0000-4000-a000-000000000002",
};

function getDashboardId(workspace: string): string {
  return DASHBOARD_IDS[workspace] || DASHBOARD_IDS["owner"];
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const workspace = (session as { workspace: string }).workspace || "owner";
  const dashboardId = getDashboardId(workspace);

  console.log(`[graph-dashboard GET] workspace=${workspace} dashboardId=${dashboardId}`);

  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("v2_graph_snapshots")
    .select("graph_payload")
    .eq("conversation_id", dashboardId)
    .maybeSingle();

  if (error) {
    console.error("[graph-dashboard GET] snapshot lookup error:", error.code, error.message);
    return NextResponse.json({ error: `Snapshot lookup failed: ${error.message}` }, { status: 500 });
  }

  if (!data || !data.graph_payload) {
    console.log("[graph-dashboard GET] no snapshot found, returning empty graph");
    return NextResponse.json({ nodes: [], edges: [], dashboardId });
  }

  const payload = data.graph_payload as { nodes?: unknown[]; edges?: unknown[] };
  const nodes = payload.nodes || [];
  const edges = payload.edges || [];
  console.log(`[graph-dashboard GET] loaded ${(nodes as unknown[]).length} nodes, ${(edges as unknown[]).length} edges`);

  return NextResponse.json({ nodes, edges, dashboardId });
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const workspace = (session as { workspace: string }).workspace || "owner";
  const dashboardId = getDashboardId(workspace);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const nodes = body.nodes as unknown[] | undefined;
  const edges = body.edges as unknown[] | undefined;

  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return NextResponse.json({ error: "nodes and edges arrays are required" }, { status: 400 });
  }

  console.log(`[graph-dashboard POST] workspace=${workspace} dashboardId=${dashboardId} nodes=${nodes.length} edges=${edges.length}`);

  const db = createServerSupabaseClient();
  const now = new Date().toISOString();

  // Step 1: Ensure the synthetic conversation row exists (satisfies UUID FK)
  const { error: convError } = await db
    .from("conversations")
    .upsert({
      id: dashboardId,
      title: "[Manual Graph Dashboard]",
      workspace_id: workspace,
      archived_at: now, // hidden from sidebar
    }, { onConflict: "id", ignoreDuplicates: true });

  if (convError) {
    console.error("[graph-dashboard POST] conversation upsert error:", convError.code, convError.message);
    return NextResponse.json({ error: `Conversation setup failed: ${convError.message}` }, { status: 500 });
  }

  // Step 2: Upsert the snapshot
  const payload = { nodes, edges };

  const { error: snapError } = await db
    .from("v2_graph_snapshots")
    .upsert({
      conversation_id: dashboardId,
      status: "ready",
      pipeline_version: "manual-dashboard-1.0",
      graph_payload: payload,
      diagnostics: { nodeCount: nodes.length, edgeCount: edges.length },
      generated_at: now,
      updated_at: now,
    }, { onConflict: "conversation_id" });

  if (snapError) {
    console.error("[graph-dashboard POST] snapshot upsert error:", snapError.code, snapError.message);
    return NextResponse.json({ error: `Snapshot save failed: ${snapError.message}` }, { status: 500 });
  }

  console.log(`[graph-dashboard POST] saved successfully`);
  return NextResponse.json({ status: "saved", dashboardId, nodeCount: nodes.length, edgeCount: edges.length });
}
