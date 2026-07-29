/**
 * Server-only authorization helpers for workspace-scoped data access.
 *
 * These enforce that:
 * 1. A valid session exists (fail → 401)
 * 2. The requested resource belongs to the caller's workspace (fail → 404)
 *
 * Never import this file from client components.
 */

import { NextResponse } from "next/server";
import { getSession, type SessionPayload, type Workspace } from "./session";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";

type AuthError = NextResponse<{ error: string }>;

/**
 * Require a valid session. Returns the session payload or a 401 JSON response.
 */
export async function requireSession(): Promise<SessionPayload | AuthError> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return session;
}

/**
 * Verify that a conversation belongs to the caller's workspace.
 * Returns the workspace or a 404 JSON response.
 *
 * Cross-workspace requests return 404 (not 403) to avoid leaking existence.
 */
export async function requireConversationAccess(
  conversationId: string,
  session: SessionPayload,
): Promise<Workspace | AuthError> {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("conversations")
    .select("workspace_id")
    .eq("id", conversationId)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (data.workspace_id !== session.workspace) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return session.workspace;
}

/**
 * Helper type guard: checks if the result is an error response.
 */
export function isAuthError(
  result: SessionPayload | Workspace | AuthError,
): result is AuthError {
  return result instanceof NextResponse;
}
