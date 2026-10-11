/**
 * Negative cross-workspace + gate tests — Batch 4 (Task 13.2): debug routes.
 *
 * Feature: google-oauth-authentication
 *
 * Debug routes are gated by `requireDebugAccess()`. The contract (Decision 1 /
 * Req 9) is:
 *   - non-member / insufficient-role  → 404
 *   - debug flag disabled outside dev → 404
 *   - CURRENT membership (live `has_debug_access()` lookup, NOT a JWT claim)
 *     drives the decision — a revoked role takes effect immediately with no
 *     token refresh.
 *
 * Part A exercises `requireDebugAccess()` directly on the flag-true path to
 * prove all three branches, including the revoke-with-no-refresh case.
 * Part B proves that when the gate denies, each debug route returns the gate's
 * 404 verbatim and never reads another workspace's data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Force the flag-true (current-membership) debug-gate path.
vi.mock("@/src/lib/config/cutover", () => ({
  isSupabaseCutoverEnabled: () => true,
  AUTH_SUPABASE_CUTOVER_ENABLED: true,
}));

// ─── Controllable user-scoped client: has_debug_access() + membership live ───
// `debugAccess` models the CURRENT membership role lookup (not a JWT claim).
const state = { debugAccess: false };

function userScopedClient(): any {
  const notFound = { data: null, error: { code: "PGRST116", message: "0 rows" } };
  const emptyList = { data: [], error: null };
  const builder: any = {};
  const chain = () => builder;
  for (const m of ["select", "eq", "is", "in", "not", "order", "limit", "update", "delete", "insert", "upsert"]) {
    builder[m] = vi.fn(chain);
  }
  builder.single = vi.fn(async () => notFound);
  builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  builder.then = (resolve: (v: unknown) => unknown) => resolve(emptyList);
  return {
    from: vi.fn(() => builder),
    // has_debug_access() reads CURRENT membership — returns the live state.
    rpc: vi.fn(async (name: string) =>
      name === "has_debug_access"
        ? { data: state.debugAccess, error: null }
        : { data: null, error: null },
    ),
    storage: { from: vi.fn(() => ({ list: vi.fn(async () => ({ data: [], error: null })) })) },
    auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "user" } }, error: null })) },
  };
}

vi.mock("@/src/lib/supabase/server", () => ({
  createUserScopedClient: vi.fn(async () => userScopedClient()),
}));
vi.mock("@/src/lib/supabase/legacy-service-role", () => ({
  createServerSupabaseClient: vi.fn(() => userScopedClient()),
}));

// migrate-engine-state (group d) uses the guarded service-role client — stub it.
vi.mock("@/src/lib/supabase/service-role", () => ({
  createServiceRoleClient: vi.fn(() => userScopedClient()),
}));

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(new URL(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CONV = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  state.debugAccess = false;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEBUG_ENDPOINTS", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Part A: the gate itself (requireDebugAccess) ────────────────────────────
describe("Batch 4 — requireDebugAccess gate (flag-true, current membership)", () => {
  it("non-member / insufficient current role → 404", async () => {
    state.debugAccess = false;
    const { requireDebugAccess } = await import("@/src/lib/auth/debug");
    const res = await requireDebugAccess();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("debug flag disabled outside dev → 404 (even for a member)", async () => {
    state.debugAccess = true;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEBUG_ENDPOINTS", "false");
    const { requireDebugAccess } = await import("@/src/lib/auth/debug");
    const res = await requireDebugAccess();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("member with current role + flag enabled → allowed (null)", async () => {
    state.debugAccess = true;
    const { requireDebugAccess } = await import("@/src/lib/auth/debug");
    expect(await requireDebugAccess()).toBeNull();
  });

  it("CURRENT membership drives the decision: revoke flips to 404 with NO token refresh", async () => {
    const { requireDebugAccess } = await import("@/src/lib/auth/debug");
    // Initially a member → allowed.
    state.debugAccess = true;
    expect(await requireDebugAccess()).toBeNull();
    // Role revoked server-side; same session/token (getClaims unchanged).
    state.debugAccess = false;
    const after = await requireDebugAccess();
    expect(after).not.toBeNull();
    expect(after!.status).toBe(404);
  });
});

// ─── Part B: routes return the gate's 404 when access is denied ──────────────
describe("Batch 4 — debug routes 404 for a non-member (gate denied)", () => {
  beforeEach(() => { state.debugAccess = false; });

  it("GET /api/debug/pipeline-health → 404", async () => {
    const { GET } = await import("@/app/api/debug/pipeline-health/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/debug/pipeline-health?id=${CONV}`)));
    expect(res.status).toBe(404);
  });

  it("GET /api/debug/candidates → 404", async () => {
    const { GET } = await import("@/app/api/debug/candidates/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/debug/candidates?id=${CONV}`)));
    expect(res.status).toBe(404);
  });

  it("GET /api/debug/engine-state → 404", async () => {
    const { GET } = await import("@/app/api/debug/engine-state/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/debug/engine-state?id=${CONV}`)));
    expect(res.status).toBe(404);
  });

  it("GET /api/debug/edge-candidates → 404", async () => {
    const { GET } = await import("@/app/api/debug/edge-candidates/route");
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("GET /api/debug/suggestions → 404", async () => {
    const { GET } = await import("@/app/api/debug/suggestions/route");
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("POST /api/debug/persist-edges → 404", async () => {
    const { POST } = await import("@/app/api/debug/persist-edges/route");
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it("GET /api/debug/topic-shifts → 404", async () => {
    const { GET } = await import("@/app/api/debug/topic-shifts/route");
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("POST /api/debug/migrate-engine-state (group d) → 404 (gate denies before privilege)", async () => {
    const { POST } = await import("@/app/api/debug/migrate-engine-state/route");
    const res = await POST();
    expect(res.status).toBe(404);
  });
});
