/**
 * Negative cross-workspace tests — Batch 1 (Task 10.2): conversations & messages.
 *
 * Feature: google-oauth-authentication
 *
 * These tests exercise the FLAG-TRUE (user-scoped / RLS) path of every Batch 1
 * route. They model RLS by mocking the user-scoped Supabase client so that a
 * NON-MEMBER of the target workspace sees ZERO ROWS for everything. The design
 * contract (Group (a) "negative cross-workspace test" column) requires that in
 * that situation each route returns 404 / empty and NEVER another workspace's
 * rows.
 *
 * How the flag-true path is driven:
 *   - `isSupabaseCutoverEnabled()` is mocked to return true, so
 *     `resolveRequestDbClient()` returns the user-scoped client and
 *     `requireConversationAccess()` takes its RLS branch (no manual workspace_id
 *     check — it relies on the client returning zero rows).
 *   - `createUserScopedClient()` is mocked to a query builder that models RLS:
 *     every `.single()` resolves to a not-found error and every list resolves to
 *     an empty array — exactly what a non-member's RLS-scoped query returns.
 *   - A valid Supabase session is present (getAuthClaims resolves a userId), so
 *     the failure is specifically the cross-workspace boundary, not auth.
 *
 * Routes covered: conversations, conversation, conversations/generate-title,
 * messages (GET+POST), messages/edit, conversation-node-positions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Flag: force the user-scoped (RLS) path ──────────────────────────────────
vi.mock("@/src/lib/config/cutover", () => ({
  isSupabaseCutoverEnabled: () => true,
  AUTH_SUPABASE_CUTOVER_ENABLED: true,
}));

// ─── A query builder that models RLS for a NON-MEMBER: zero rows everywhere ───
function rlsEmptyBuilder(): any {
  const notFound = { data: null, error: { code: "PGRST116", message: "Results contain 0 rows" } };
  const emptyList = { data: [], error: null };
  const builder: any = {};
  const chain = () => builder;
  // Chainable filters/selectors
  for (const m of ["select", "eq", "is", "in", "not", "order", "limit", "update", "delete", "insert", "upsert"]) {
    builder[m] = vi.fn(chain);
  }
  // Terminal: a non-member sees nothing
  builder.single = vi.fn(async () => notFound);
  builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  // Awaiting the builder itself (list queries) yields an empty array
  builder.then = (resolve: (v: unknown) => unknown) => resolve(emptyList);
  return builder;
}

function rlsClient(): any {
  return {
    from: vi.fn(() => rlsEmptyBuilder()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    storage: { from: vi.fn(() => ({ createSignedUrls: vi.fn(async () => ({ data: [], error: null })) })) },
    auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "non-member-user" } }, error: null })) },
  };
}

// ─── Supabase server module: user-scoped client models RLS ───────────────────
vi.mock("@/src/lib/supabase/server", () => ({
  createUserScopedClient: vi.fn(async () => rlsClient()),
}));
// ─── Legacy service-role bridge: pre-cutover fallback (same RLS model here) ───
vi.mock("@/src/lib/supabase/legacy-service-role", () => ({
  createServerSupabaseClient: vi.fn(() => rlsClient()),
}));

// ─── Session present (valid Supabase user) so we test the WS boundary, not auth.
vi.mock("@/src/lib/auth/session", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: vi.fn(async () => ({ workspace: "owner", iat: 0, exp: 9_999_999_999 })),
    getAuthClaims: vi.fn(async () => ({ userId: "non-member-user" })),
  };
});

// AI is never reached on the 404 path, but mock to be safe.
vi.mock("@/src/lib/ai", () => ({
  complete: vi.fn(async () => ({ content: "x" })),
  generateGraphSummary: vi.fn(async () => "x"),
}));

const CONV = "11111111-1111-4111-8111-111111111111"; // a conversation in ANOTHER workspace

function jsonReq(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(new URL(url), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("Batch 1 negative cross-workspace (flag-true / RLS)", () => {
  it("GET /api/conversations → empty list for a non-member", async () => {
    const { GET } = await import("@/app/api/conversations/route");
    const res = await GET(new NextRequest(new URL("http://t/api/conversations")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST /api/conversations (title update on another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/conversations/route");
    const res = await POST(jsonReq("http://t/api/conversations", { id: CONV, title: "x" }));
    expect(res.status).toBe(404);
  });

  it("GET /api/conversation?id=<other ws> → 404", async () => {
    const { GET } = await import("@/app/api/conversation/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/conversation?id=${CONV}`)));
    expect(res.status).toBe(404);
  });

  it("POST /api/conversations/generate-title → 404", async () => {
    const { POST } = await import("@/app/api/conversations/generate-title/route");
    const res = await POST(jsonReq("http://t/api/conversations/generate-title", { conversationId: CONV }));
    expect(res.status).toBe(404);
  });

  it("GET /api/messages?conversationId=<other ws> → 404", async () => {
    const { GET } = await import("@/app/api/messages/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/messages?conversationId=${CONV}`)));
    expect(res.status).toBe(404);
  });

  it("POST /api/messages (append to another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/messages/route");
    const res = await POST(jsonReq("http://t/api/messages", {
      conversationId: CONV,
      messages: [{ id: "m1", role: "user", content: "hi" }],
    }));
    expect(res.status).toBe(404);
  });

  it("POST /api/messages/edit (edit a message in another ws) → 404", async () => {
    const { POST } = await import("@/app/api/messages/edit/route");
    const res = await POST(jsonReq("http://t/api/messages/edit", { messageId: "m-other", content: "x" }));
    expect(res.status).toBe(404);
  });

  it("GET /api/conversation-node-positions?conversationId=<other ws> → 404", async () => {
    const { GET } = await import("@/app/api/conversation-node-positions/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/conversation-node-positions?conversationId=${CONV}`)));
    expect(res.status).toBe(404);
  });

  it("PUT /api/conversation-node-positions (write to another ws) → 404", async () => {
    const { PUT } = await import("@/app/api/conversation-node-positions/route");
    const res = await PUT(jsonReq("http://t/api/conversation-node-positions", {
      conversationId: CONV,
      positions: [{ nodeId: "n1", x: 1, y: 2 }],
    }, "PUT"));
    expect(res.status).toBe(404);
  });
});
