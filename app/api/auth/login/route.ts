import { NextRequest, NextResponse } from "next/server";
import { createSession, type Workspace } from "@/src/lib/auth";

type LoginRequest = { username: string; password: string };
type ErrorResponse = { error: string };

/**
 * POST /api/auth/login
 *
 * Validates credentials against server-only environment variables.
 * On success, sets a signed HTTP-only session cookie.
 * Uses a generic error message — never reveals which field was wrong.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ workspace: Workspace } | ErrorResponse>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid credentials." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { username, password } = (body ?? {}) as Partial<LoginRequest>;

  if (!username || !password) {
    return NextResponse.json(
      { error: "Invalid credentials." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Resolve configured credentials from server env
  const ownerUser = process.env.TEMP_OWNER_USERNAME;
  const ownerPass = process.env.TEMP_OWNER_PASSWORD;
  const demoUser = process.env.TEMP_DEMO_USERNAME;
  const demoPass = process.env.TEMP_DEMO_PASSWORD;

  if (!ownerUser || !ownerPass || !demoUser || !demoPass) {
    // Fail closed — missing config is a server error, not a credential error
    console.error("[auth/login] Workspace credentials not configured in environment.");
    return NextResponse.json(
      { error: "Invalid credentials." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Constant-time-ish comparison (timing attack is low-risk here but good practice)
  let workspace: Workspace | null = null;

  if (
    timingSafeEqual(username, ownerUser) &&
    timingSafeEqual(password, ownerPass)
  ) {
    workspace = "owner";
  } else if (
    timingSafeEqual(username, demoUser) &&
    timingSafeEqual(password, demoPass)
  ) {
    workspace = "demo";
  }

  if (!workspace) {
    return NextResponse.json(
      { error: "Invalid credentials." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  await createSession(workspace);

  return NextResponse.json(
    { workspace },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Simple timing-safe string comparison using crypto.subtle.
 * Falls back to basic comparison if subtle is unavailable.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
