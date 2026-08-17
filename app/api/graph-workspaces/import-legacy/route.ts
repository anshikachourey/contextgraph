import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAuthError } from "@/src/lib/auth";
import {
  importLegacyGraphWorkspace,
  addConversationToGraph,
  type GraphPayloadV1,
  type PersistedNode,
} from "@/src/lib/db/graph-workspaces";

/**
 * POST /api/graph-workspaces/import-legacy
 *
 * Idempotent import of legacy dashboard data (from localStorage or the
 * fake-conversation DB path) into a proper graph_workspace.
 *
 * Uses `legacy_import_key` (UNIQUE constraint) to ensure the same legacy
 * dashboard is never imported twice, regardless of how many times the
 * client retries.
 *
 * Body: {
 *   nodes: PersistedNode[],
 *   edges: PersistedEdge[],
 *   source: "localStorage" | "db-legacy"
 * }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const nodes = body.nodes as unknown[] | undefined;
  const edges = body.edges as unknown[] | undefined;
  const source = body.source as string | undefined;

  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return NextResponse.json(
      { error: "nodes and edges arrays are required" },
      { status: 400 },
    );
  }

  if (source !== "localStorage" && source !== "db-legacy") {
    return NextResponse.json(
      { error: 'source must be "localStorage" or "db-legacy"' },
      { status: 400 },
    );
  }

  // Derive deterministic import key from workspace + source
  const legacyImportKey = `${source}:${session.workspace}`;

  const payload: GraphPayloadV1 = {
    nodes: nodes as PersistedNode[],
    edges: edges as unknown as GraphPayloadV1["edges"],
  };

  try {
    const { graphWorkspace, alreadyExisted } = await importLegacyGraphWorkspace(
      session.workspace,
      legacyImportKey,
      payload,
    );

    // Extract node-conversation associations and persist them
    if (!alreadyExisted) {
      const nodesWithConversations = (payload.nodes || []).filter(
        (n) => n.conversationId,
      );

      for (const node of nodesWithConversations) {
        try {
          await addConversationToGraph(
            graphWorkspace.id,
            node.conversationId!,
            node.id,
          );
        } catch (err) {
          // Non-fatal: conversation may have been deleted or FK violated.
          // Log and continue — the graph itself is already saved.
          console.warn(
            `[import-legacy] Failed to associate conversation ${node.conversationId} with node ${node.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    return NextResponse.json(
      {
        graphId: graphWorkspace.id,
        name: graphWorkspace.name,
        imported: !alreadyExisted,
        alreadyExisted,
      },
      { status: alreadyExisted ? 200 : 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[import-legacy] Import failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
