import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAuthError } from "@/src/lib/auth";
import { resolveRequestDbClient, useRlsScopedAccess } from "@/src/lib/db/request-client";
import {
  listGraphWorkspaces,
  createGraphWorkspace,
  renameGraphWorkspace,
  deleteGraphWorkspace,
  getGraphWorkspace,
} from "@/src/lib/db/graph-workspaces";
import type { DbClient } from "@/src/lib/db/client";

/**
 * Verify the caller may act on a graph workspace.
 *
 * Flag-true (RLS): `getGraphWorkspace` runs under the user-scoped client, so a
 * non-member sees zero rows → null → caller translates to 404. No manual
 * workspace_id string comparison (RLS is the boundary).
 *
 * Flag-false (behavior-neutral): keep the legacy manual workspace_id check,
 * identical to the pre-feature implementation.
 *
 * Returns the workspace row when authorized, or null when it should 404.
 */
async function authorizeGraphWorkspace(
  id: string,
  sessionWorkspace: string,
  db: DbClient,
): Promise<{ workspace_id: string } | null> {
  const existing = await getGraphWorkspace(id, db);
  if (!existing) return null;
  if (!useRlsScopedAccess() && existing.workspace_id !== sessionWorkspace) {
    return null;
  }
  return existing;
}

/**
 * GET /api/graph-workspaces
 * List all graph workspaces for the current session's workspace.
 */
export async function GET(): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const db = await resolveRequestDbClient();

  try {
    const workspaces = await listGraphWorkspaces(session.workspace, db);
    return NextResponse.json(workspaces, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/graph-workspaces
 * Create a new graph workspace.
 * Body: { name: string }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const db = await resolveRequestDbClient();

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // Default name will be used
  }

  const name = typeof body.name === "string" && body.name.trim()
    ? body.name.trim()
    : "Untitled Graph";

  try {
    const workspace = await createGraphWorkspace(session.workspace, name, undefined, db);
    return NextResponse.json(
      { id: workspace.id, name: workspace.name },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH /api/graph-workspaces
 * Rename a graph workspace.
 * Body: { id: string, name: string }
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const db = await resolveRequestDbClient();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = body.id as string | undefined;
  const name = body.name as string | undefined;

  if (!id || !name?.trim()) {
    return NextResponse.json({ error: "id and name are required" }, { status: 400 });
  }

  // Verify ownership (RLS on flag-true, manual workspace_id on flag-false)
  try {
    const existing = await authorizeGraphWorkspace(id, session.workspace, db);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await renameGraphWorkspace(id, name.trim(), db);
    return NextResponse.json({ id, name: name.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/graph-workspaces
 * Delete a graph workspace (cascades to memberships, NOT to conversations).
 * Body: { id: string }
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const db = await resolveRequestDbClient();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = body.id as string | undefined;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Verify ownership (RLS on flag-true, manual workspace_id on flag-false)
  try {
    const existing = await authorizeGraphWorkspace(id, session.workspace, db);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await deleteGraphWorkspace(id, db);
    return NextResponse.json({ id, status: "deleted" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
