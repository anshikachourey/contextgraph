import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/src/lib/auth/session";

/**
 * Middleware responsibilities:
 * 1. Redirect unauthenticated page requests to /login
 * 2. Return 401 for unauthenticated API requests (except /api/auth/*)
 * 3. Gate /api/debug/* and /debug/* behind DEBUG_ENDPOINTS + owner workspace
 *
 * NOTE: Middleware is a session-existence check only. Route-level authorization
 * (workspace ownership of specific resources) is enforced inside each route handler.
 */
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // ─── Allow auth routes without session ────────────────────────────────
  if (path.startsWith("/api/auth") || path === "/login") {
    return NextResponse.next();
  }

  // ─── Allow static assets and Next.js internals ────────────────────────
  if (
    path.startsWith("/_next") ||
    path.startsWith("/favicon") ||
    path.endsWith(".ico")
  ) {
    return NextResponse.next();
  }

  // ─── Check session ────────────────────────────────────────────────────
  const session = await getSessionFromRequest(request);

  if (!session) {
    // API routes → 401 JSON
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Page routes → redirect to /login
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // ─── Debug routes: require owner + debug flag ─────────────────────────
  const isDebugRoute = path.startsWith("/api/debug") || path.startsWith("/debug");
  if (isDebugRoute) {
    const isDev = process.env.NODE_ENV === "development";
    const debugEnabled = process.env.DEBUG_ENDPOINTS === "true";

    if (!(isDev || debugEnabled)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Debug routes require owner workspace
    if (session.workspace !== "owner") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  // ─── Add Cache-Control: no-store for workspace-sensitive responses ────
  const response = NextResponse.next();
  if (path.startsWith("/api/")) {
    response.headers.set("Cache-Control", "no-store");
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
