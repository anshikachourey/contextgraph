/**
 * Negative cross-workspace tests — Batch 3 (Task 12.3): graph-workspaces & v2
 * (routes + RPC paths).
 *
 * Feature: google-oauth-authentication
 *
 * Same model as Batches 1–2. For graph-workspaces, RLS makes `getGraphWorkspace`
 * return null for a non-member → 404. For the v2 routes, the user-scoped client
 * returns zero rows and `requireConversationAccess` 404s before any `.rpc` runs,
 * so a non-member RPC invocation has no cross-workspace effect (Group (b)).
 *
 * Routes covered: graph-workspaces (PATCH/DELETE), graph-workspaces/[id]/load,
 * graph-workspaces/[id]/save, graph-workspaces/conversations (GET/POST),
 * v2/graph-snapshot (GET/POST incl. .rpc commit), v2/manual-node, v2/paste-nodes,
 * chat.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/src/lib/config/cutover", () => ({
  isSupabaseCutoverEnabled: () => true,
  AUTH_SUPABASE_CUTOVER_ENABLED: true,
}));

// Spy on .rpc so we can assert a non-member never triggers a cross-workspace RPC.
const rpcSpy = vi.fn(async () => ({ data: null, error: null }));

function rlsEmptyBuilder(): any {
  const notFound = { data: null, error: { code: "PGRST116", message: "Results contain 0 rows" } };
  const emptyList = { data: [], error: null };
  const builder: any = {};
  const chain = () => builder;
  for (const m of ["select", "eq", "is", "in", "not", "order", "limit", "update", "delete", "insert", "upsert"]) {
    builder[m] = vi.fn(chain);
  }
  builder.single = vi.fn(async () => notFound);
  builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  builder.then = (resolve: (v: unknown) => unknown) => resolve(emptyList);
  return builder;
}

function rlsClient(): any {
  return {
    from: vi.fn(() => rlsEmptyBuilder()),
    rpc: rpcSpy,
    storage: { from: vi.fn(() => ({})) },
    auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "non-member-user" } }, error: null })) },
  };
}

vi.mock("@/src/lib/supabase/server", () => ({
  createUserScopedClient: vi.fn(async () => rlsClient()),
}));
vi.mock("@/src/lib/supabase/legacy-service-role", () => ({
  createServerSupabaseClient: vi.fn(() => rlsClient()),
}));

vi.mock("@/src/lib/auth/session", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: vi.fn(async () => ({ workspace: "owner", iat: 0, exp: 9_999_999_999 })),
    getAuthClaims: vi.fn(async () => ({ userId: "non-member-user" })),
  };
});

// runV2GraphPlan should never be reached on the 404 path.
vi.mock("@/src/lib/intelligence-v2", () => ({
  runV2GraphPlan: vi.fn(async () => { throw new Error("should not run for a non-member"); }),
}));
vi.mock("@/src/lib/intelligence-v2/incremental/update-runner", () => ({
  triggerRecoveryOnce: vi.fn(),
  enqueueV2Update: vi.fn(),
}));
vi.mock("@/src/lib/ai/chat", () => ({ streamChatResponse: vi.fn(() => new ReadableStream()) }));

const GRAPH = "33333333-3333-4333-8333-333333333333"; // graph in ANOTHER workspace
const CONV = "44444444-4444-4444-8444-444444444444";  // conversation in ANOTHER workspace

function jsonReq(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(new URL(url), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("Batch 3 negative cross-workspace (flag-true / RLS)", () => {
  it("GET /api/graph-workspaces → empty list for a non-member", async () => {
    const { GET } = await import("@/app/api/graph-workspaces/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("PATCH /api/graph-workspaces (rename another ws graph) → 404", async () => {
    const { PATCH } = await import("@/app/api/graph-workspaces/route");
    const res = await PATCH(jsonReq("http://t/api/graph-workspaces", { id: GRAPH, name: "x" }, "PATCH"));
    expect(res.status).toBe(404);
  });

  it("DELETE /api/graph-workspaces (delete another ws graph) → 404", async () => {
    const { DELETE } = await import("@/app/api/graph-workspaces/route");
    const res = await DELETE(jsonReq("http://t/api/graph-workspaces", { id: GRAPH }, "DELETE"));
    expect(res.status).toBe(404);
  });

  it("GET /api/graph-workspaces/[id]/load (another ws graph) → 404", async () => {
    const { GET } = await import("@/app/api/graph-workspaces/[id]/load/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/graph-workspaces/${GRAPH}/load`)), {
      params: Promise.resolve({ id: GRAPH }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT /api/graph-workspaces/[id]/save (another ws graph) → 404", async () => {
    const { PUT } = await import("@/app/api/graph-workspaces/[id]/save/route");
    const res = await PUT(jsonReq(`http://t/api/graph-workspaces/${GRAPH}/save`, { nodes: [], edges: [] }, "PUT"), {
      params: Promise.resolve({ id: GRAPH }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/graph-workspaces/conversations (another ws graph) → 404", async () => {
    const { GET } = await import("@/app/api/graph-workspaces/conversations/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/graph-workspaces/conversations?graphId=${GRAPH}`)));
    expect(res.status).toBe(404);
  });

  it("POST /api/graph-workspaces/conversations (associate into another ws graph) → 404", async () => {
    const { POST } = await import("@/app/api/graph-workspaces/conversations/route");
    const res = await POST(jsonReq("http://t/api/graph-workspaces/conversations", { graphId: GRAPH, conversationId: CONV }));
    expect(res.status).toBe(404);
  });

  it("GET /api/v2/graph-snapshot (another ws conv) → 404, no RPC", async () => {
    const { GET } = await import("@/app/api/v2/graph-snapshot/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/v2/graph-snapshot?conversationId=${CONV}`)));
    expect(res.status).toBe(404);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("POST /api/v2/graph-snapshot (another ws conv) → 404, no cross-ws .rpc commit", async () => {
    const { POST } = await import("@/app/api/v2/graph-snapshot/route");
    const res = await POST(jsonReq("http://t/api/v2/graph-snapshot", { conversationId: CONV }));
    expect(res.status).toBe(404);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("POST /api/v2/manual-node (another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/v2/manual-node/route");
    const res = await POST(jsonReq("http://t/api/v2/manual-node", { action: "create_node", conversationId: CONV, title: "x" }));
    expect(res.status).toBe(404);
  });

  it("POST /api/v2/paste-nodes (another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/v2/paste-nodes/route");
    const res = await POST(jsonReq("http://t/api/v2/paste-nodes", {
      conversationId: CONV,
      nodes: [{ newObjectId: "o1", title: "t" }],
    }));
    expect(res.status).toBe(404);
  });

  it("POST /api/chat (another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(jsonReq("http://t/api/chat", {
      conversationId: CONV,
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(res.status).toBe(404);
  });
});
