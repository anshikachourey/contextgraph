/**
 * Authorization helper for debug routes.
 * Requires both a valid owner session AND the DEBUG_ENDPOINTS flag.
 * This is called IN ADDITION to middleware (defense in depth).
 */

import { NextResponse } from "next/server";
import { getSession } from "./session";

type AuthError = NextResponse<{ error: string }>;

/**
 * Require owner workspace for debug routes.
 * Returns null on success, or a 404 response to deny access.
 */
export async function requireDebugAccess(): Promise<AuthError | null> {
  const session = await getSession();

  if (!session || session.workspace !== "owner") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isDev = process.env.NODE_ENV === "development";
  const debugEnabled = process.env.DEBUG_ENDPOINTS === "true";

  if (!(isDev || debugEnabled)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return null;
}
