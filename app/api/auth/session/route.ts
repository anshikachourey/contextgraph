import { NextResponse } from "next/server";
import { getSession } from "@/src/lib/auth";

/**
 * GET /api/auth/session
 *
 * Returns the current session's workspace (for UI display only).
 * The workspace value is informational — all authorization happens server-side.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getSession();

  if (!session) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { authenticated: true, workspace: session.workspace },
    { headers: { "Cache-Control": "no-store" } },
  );
}
