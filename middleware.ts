import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSessionFromRequest, getAuthClaims } from "@/src/lib/auth/session";
import { isSupabaseCutoverEnabled } from "@/src/lib/config/cutover";

/**
 * Middleware responsibilities (both legacy and Supabase paths):
 * 1. Redirect unauthenticated page requests to /login
 * 2. Return 401 (+ no-store) for unauthenticated API requests (except auth routes)
 * 3. Gate Debug_Routes behind the debug flag + membership/role
 *
 * GATING: the entire NEW Supabase SSR path is behind
 * `AUTH_SUPABASE_CUTOVER_ENABLED`. While the flag is false, middleware behaves
 * EXACTLY as the legacy HMAC `cg_session` middleware — this is the core of the
 * "behavior-neutral while flag false" guarantee.
 */
export async function middleware(request: NextRequest) {
  if (isSupabaseCutoverEnabled()) {
    return supabaseMiddleware(request);
  }
  return legacyMiddleware(request);
}

// ─── Shared path classification ───────────────────────────────────────────────

function isAuthRoute(path: string): boolean {
  return (
    path.startsWith("/api/auth") ||
    path.startsWith("/auth") ||
    path === "/login"
  );
}

function isStaticAsset(path: string): boolean {
  return (
    path.startsWith("/_next") ||
    path.startsWith("/favicon") ||
    path.endsWith(".ico")
  );
}

function isDebugRoute(path: string): boolean {
  return path.startsWith("/api/debug") || path.startsWith("/debug");
}

// ─── NEW: Supabase SSR middleware (active only when the flag is enabled) ────────

async function supabaseMiddleware(request: NextRequest): Promise<NextResponse> {
  const path = request.nextUrl.pathname;

  // Build a response up-front so the SSR client can write refreshed cookies to it.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          // Write refreshed auth cookies to the outgoing response (Req 3.1/3.3).
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Identity-only claims through the SSR client (Req 8.4, 4.1).
  const claims = await getAuthClaims(supabase);

  // Allow auth/callback namespace + /login and static assets without a session
  // (Req 8.3, 20.4).
  if (isAuthRoute(path) || isStaticAsset(path)) {
    return withApiNoStore(response, path);
  }

  // No claims: API → 401 + no-store; page → redirect /login (Req 8.1, 8.2).
  if (!claims) {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Debug_Route ONLY incurs a DB check: flag + CURRENT membership/role (Req 9).
  // Non-debug paths stay identity-claims only (lightweight; Req 5).
  if (isDebugRoute(path)) {
    const isDev = process.env.NODE_ENV === "development";
    const debugEnabled = process.env.DEBUG_ENDPOINTS === "true";

    if (!(isDev || debugEnabled)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { data, error } = await supabase.rpc("has_debug_access");
    if (error || data !== true) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  return withApiNoStore(response, path);
}

/** Adds `Cache-Control: no-store` for any `/api/*` response. */
function withApiNoStore(response: NextResponse, path: string): NextResponse {
  if (path.startsWith("/api/")) {
    response.headers.set("Cache-Control", "no-store");
  }
  return response;
}

// ─── LEGACY: owner/demo HMAC middleware (active while the flag is false) ────────
//
// Retained UNCHANGED from the pre-feature implementation so behavior is
// identical today. Removed as part of Task 17 together with the HMAC login.

async function legacyMiddleware(request: NextRequest): Promise<NextResponse> {
  const path = request.nextUrl.pathname;

  // Allow auth routes without session (legacy namespace: /api/auth + /login).
  if (path.startsWith("/api/auth") || path === "/login") {
    return NextResponse.next();
  }

  if (isStaticAsset(path)) {
    return NextResponse.next();
  }

  const session = await getSessionFromRequest(request);

  if (!session) {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (isDebugRoute(path)) {
    const isDev = process.env.NODE_ENV === "development";
    const debugEnabled = process.env.DEBUG_ENDPOINTS === "true";

    if (!(isDev || debugEnabled)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (session.workspace !== "owner") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

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
