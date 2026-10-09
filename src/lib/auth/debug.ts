/**
 * Authorization helper for debug routes (defense-in-depth; also checked in
 * middleware).
 *
 * Two behaviors, selected by the cutover flag so runtime behavior is unchanged
 * while `AUTH_SUPABASE_CUTOVER_ENABLED` is false:
 *
 *   - Flag ENABLED (post-cutover): verify the debug flag, then perform a
 *     CURRENT server-side membership+role lookup via the `auth.uid()`-bound
 *     `has_debug_access()` SQL helper through the user-scoped client. 404 unless
 *     the caller CURRENTLY holds the required role. The role is NEVER read from
 *     the JWT, so a membership/role change takes effect immediately rather than
 *     waiting for a token refresh (Req 9.2, 9.3). The helper takes no uid
 *     parameter — the subject is always `auth.uid()` inside the function body.
 *
 *   - Flag DISABLED (default today): the LEGACY owner-workspace gate — require a
 *     valid owner HMAC session AND the DEBUG_ENDPOINTS flag (or dev). Identical
 *     to the pre-feature implementation.
 */

import { NextResponse } from "next/server";
import { getSession } from "./session";
import { createUserScopedClient } from "@/src/lib/supabase/server";
import { isSupabaseCutoverEnabled } from "@/src/lib/config/cutover";

type AuthError = NextResponse<{ error: string }>;

/**
 * Gate access to a Debug_Route.
 * Returns null on success, or a 404 response to deny access.
 */
export async function requireDebugAccess(): Promise<AuthError | null> {
  const isDev = process.env.NODE_ENV === "development";
  const debugEnabled = process.env.DEBUG_ENDPOINTS === "true";

  // ─── Flag ENABLED: current-membership role check (Req 9) ───────────────────
  if (isSupabaseCutoverEnabled()) {
    // Debug flag must be enabled (or dev). 404 otherwise (Req 9.1).
    if (!(isDev || debugEnabled)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // CURRENT, live membership+role lookup bound to auth.uid(). The role is
    // read from live data, never the JWT (Req 9.2, 9.3).
    const client = await createUserScopedClient();
    const { data, error } = await client.rpc("has_debug_access");

    if (error || data !== true) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return null;
  }

  // ─── Flag DISABLED (default today): LEGACY owner-workspace gate ─────────────
  const session = await getSession();

  if (!session || session.workspace !== "owner") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(isDev || debugEnabled)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return null;
}
