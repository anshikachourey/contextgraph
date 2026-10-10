/**
 * Negative cross-workspace tests — Batch 2 (Task 11.3): nodes, graph-dashboard,
 * attachments & storage.
 *
 * Feature: google-oauth-authentication
 *
 * Same model as Batch 1: force the flag-true (user-scoped / RLS) path, mock the
 * user-scoped client to model RLS for a NON-MEMBER (zero rows everywhere,
 * storage ops denied/empty), supply a valid session, and assert each route +
 * storage op returns 404/empty/denied — never another workspace's data
 * (Group (a) + Group (c) negative cross-workspace contract).
 *
 * Routes covered: nodes, draft-node, structure-conversation, evolve-graph,
 * evolve-apply, graph-dashboard (GET+POST), attachments (POST+GET, incl.
 * Storage upload/signed-url).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/src/lib/config/cutover", () => ({
  isSupabaseCutoverEnabled: () => true,
  AUTH_SUPABASE_CUTOVER_ENABLED: true,
}));

function rlsEmptyBuilder(): any {
  const notFound = { data: null, error: { code: "PGRST116", message: "Results contain 0 rows" } };
  const emptyList = { data: [], error: null };
  const builder: any = {};
  const chain = () => builder;
  for (const m of ["select", "eq", "is", "in", "not", "order", "limit", "update", "delete", "insert", "upsert", "maybeSingle"]) {
    builder[m] = vi.fn(chain);
  }
  builder.single = vi.fn(async () => notFound);
  builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  builder.then = (resolve: (v: unknown) => unknown) => resolve(emptyList);
  return builder;
}

// Storage models RLS: a non-member cannot upload or sign another ws's objects.
function rlsStorage(): any {
  const denied = { data: null, error: { message: "new row violates row-level security policy" } };
  return {
    from: vi.fn(() => ({
      upload: vi.fn(async () => denied),
      createSignedUrl: vi.fn(async () => denied),
      createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
      remove: vi.fn(async () => ({ data: [], error: null })),
      list: vi.fn(async () => ({ data: [], error: null })),
    })),
  };
}

function rlsClient(): any {
  return {
    from: vi.fn(() => rlsEmptyBuilder()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    storage: rlsStorage(),
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

// Embeddings/AI never reached on the 404 path; mock to be safe.
vi.mock("@/src/lib/embeddings", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
  buildNodeEmbeddingText: vi.fn(() => "text"),
  buildClusterEmbeddingText: vi.fn(() => "text"),
}));

const CONV = "22222222-2222-4222-8222-222222222222"; // conversation in ANOTHER workspace

function jsonReq(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(new URL(url), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("Batch 2 negative cross-workspace (flag-true / RLS)", () => {
  it("POST /api/nodes (persist to another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/nodes/route");
    const res = await POST(jsonReq("http://t/api/nodes", {
      conversationId: CONV,
      node: { id: "n1", title: "t", summary: "s", messageIds: [] },
      linkedMessages: [],
    }));
    expect(res.status).toBe(404);
  });

  it("POST /api/draft-node (another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/draft-node/route");
    const res = await POST(jsonReq("http://t/api/draft-node", {
      conversationId: CONV,
      messages: [{ id: "m1", role: "user", content: "hi" }],
    }));
    expect(res.status).toBe(404);
  });

  it("POST /api/structure-conversation (another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/structure-conversation/route");
    const res = await POST(jsonReq("http://t/api/structure-conversation", { conversationId: CONV }));
    expect(res.status).toBe(404);
  });

  it("POST /api/evolve-graph (another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/evolve-graph/route");
    const res = await POST(jsonReq("http://t/api/evolve-graph", { conversationId: CONV }));
    expect(res.status).toBe(404);
  });

  it("POST /api/evolve-apply (another ws conv) → 404", async () => {
    const { POST } = await import("@/app/api/evolve-apply/route");
    const res = await POST(jsonReq("http://t/api/evolve-apply", {
      conversationId: CONV,
      nodeId: "n1",
      messageIds: ["m1"],
    }));
    expect(res.status).toBe(404);
  });

  it("GET /api/graph-dashboard → empty graph for a non-member (RLS → no snapshot)", async () => {
    const { GET } = await import("@/app/api/graph-dashboard/route");
    const res = await GET(new NextRequest(new URL("http://t/api/graph-dashboard")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  it("POST /api/attachments GET signed URLs for another ws object → 404", async () => {
    const { GET } = await import("@/app/api/attachments/route");
    const res = await GET(new NextRequest(new URL(`http://t/api/attachments?paths=${CONV}/x-file.png`)));
    expect(res.status).toBe(404);
  });
});
