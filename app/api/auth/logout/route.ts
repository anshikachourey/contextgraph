import { NextResponse } from "next/server";
import { destroySession } from "@/src/lib/auth";

/**
 * POST /api/auth/logout
 *
 * Clears the session cookie.
 */
export async function POST(): Promise<NextResponse<{ ok: true }>> {
  await destroySession();
  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
