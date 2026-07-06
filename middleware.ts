import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware that gates /api/debug/* and /debug/* routes only.
 * Returns 404 in production unless DEBUG_ENDPOINTS=true.
 */
export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Only apply blocking to debug routes
  const isDebugRoute = path.startsWith("/api/debug") || path.startsWith("/debug");
  if (!isDebugRoute) {
    return NextResponse.next();
  }

  const isDev = process.env.NODE_ENV === "development";
  const debugEnabled = process.env.DEBUG_ENDPOINTS === "true";

  if (isDev || debugEnabled) {
    return NextResponse.next();
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export const config = {
  matcher: ["/api/debug/:path*", "/debug/:path*"],
};
