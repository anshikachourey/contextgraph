import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware that gates all /api/debug/* and /debug/* routes.
 * Returns 404 in production unless DEBUG_ENDPOINTS=true.
 */
export function middleware(request: NextRequest) {
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
