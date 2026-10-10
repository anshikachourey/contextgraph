/**
 * Old-schema (pre-migration) production compatibility test.
 *
 * Feature: google-oauth-authentication
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 *
 * PR #8 passed CI (build + full unit suite) yet broke production at runtime: a
 * FLAG-FALSE request reached schema/RPCs that only exist AFTER the auth
 * migrations are applied. CI could not catch it because the unit suite mocks
 * Supabase with permissive stubs that happily answer any table/column/RPC — so
 * a query against a not-yet-created table looks fine in CI but 500s in prod,
 * where `AUTH_SUPABASE_CUTOVER_ENABLED=false` and the migrations are NOT applied.
 *
 * This test closes that gap. It installs a Supabase client stub that models the
 * REAL CURRENT PRODUCTION SCHEMA (the tables/RPCs that exist BEFORE any auth
 * migration) and HARD-FAILS the moment any code path touches a table, or calls
 * an RPC, that only exists post-migration. It then drives the auth branch's
 * actual request handlers with the cutover flag FALSE — the exact production
 * configuration — and asserts they never cross into post-migration schema.
 *
 * If a future edit makes a flag-false request path depend on `user_profiles`,
 * `account_workspaces`, `workspace_memberships`, `migration_runs`, or on the
 * `provision_self` / `has_debug_access` / `is_member*` / migration RPCs, this
 * test fails here instead of in production.
 *
 * NOTE: this validates the FLAG-FALSE (pre-cutover) contract specifically.
 * Flag-true paths legitimately use the new schema and are covered elsewhere.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Cutover flag FALSE: the production configuration ────────────────────────
vi.mock("@/src/lib/config/cutover", () => ({
  isSupabaseCutoverEnabled: () => false,
  AUTH_SUPABASE_CUTOVER_ENABLED: false,
}));

/**
 * Tables that EXIST in the current production database (before any auth
 * migration is applied). Sourced from the pre-auth migrations plus the
 * pre-version-control base tables the engine already uses in prod.
 */
const PRODUCTION_TABLES = new Set<string>([
  "conversations",
  "messages",
  "nodes",
  "node_messages",
  "edges",
  "neighborhoods",
  "topic_candidates",
  "conversation_engine_state",
  "conversation_node_positions",
  "graph_workspaces",
  "graph_workspace_conversations",
  "similarity_calibration",
]);

/**
 * Tables that ONLY exist AFTER the auth migrations (20260824*) are applied.
 * A flag-false request path must NEVER touch any of these in production.
 */
const POST_MIGRATION_TABLES = new Set<string>([
  "user_profiles",
  "account_workspaces",
  "workspace_memberships",
  "migration_runs",
]);

/**
 * RPCs that already exist in production (the V2/SIE engine uses them today).
 */
const PRODUCTION_RPCS = new Set<string>([
  "v2_commit_update",
  "v2_commit_identity_bundle",
  "v2_load_sie_identity_context",
  "sie_record_analyzed_result",
  "sie_renew_lease",
  "sie_mark_failed_retryable",
  "sie_supersede_request",
  "sie_reserve_request",
  "exec_sql",
]);

/**
 * RPCs introduced by the auth migrations. A flag-false request path must never
 * call any of these (they do not exist in the un-migrated production DB).
 */
const POST_MIGRATION_RPCS = new Set<string>([
  "provision_self",
  "provision_user",
  "has_debug_access",
  "is_member",
  "is_member_with_role",
  "migrate_owner_data_to_user",
  "assert_owner_migration_preflight_report",
]);

/** Columns on `conversations` that only exist post-migration (renamed/added). */
const POST_MIGRATION_CONVERSATION_COLUMNS = [
  "legacy_workspace_id",
  "account_workspace_id",
];

/**
 * Records every table/RPC the code under test touched, and THROWS the instant a
 * post-migration table or RPC is referenced — i.e. the exact failure prod saw.
 */
class OldSchemaViolation extends Error {}

function productionSchemaClient() {
  const touchedTables: string[] = [];
  const calledRpcs: string[] = [];

  const builder = (table: string): any => {
    const emptyList = { data: [], error: null };
    const notFound = { data: null, error: { code: "PGRST116", message: "0 rows" } };
    const chain = () => b;
    const b: any = {};
    // When a row is inserted/upserted, echo it back from `.single()` so
    // insert().select().single() behaves like real PostgREST (RETURNING row).
    let insertedRow: Record<string, unknown> | null = null;
    for (const m of [
      "select", "eq", "neq", "is", "in", "not", "or", "order", "limit",
      "range", "update", "delete", "insert", "upsert", "contains",
    ]) {
      b[m] = vi.fn((...args: unknown[]) => {
        // Guard against reading a renamed/added column on `conversations`.
        if (table === "conversations") {
          const asText = JSON.stringify(args);
          for (const col of POST_MIGRATION_CONVERSATION_COLUMNS) {
            if (asText.includes(col)) {
              throw new OldSchemaViolation(
                `Flag-false path referenced post-migration column conversations.${col}`,
              );
            }
          }
        }
        if ((m === "insert" || m === "upsert") && args[0] != null) {
          const payload = Array.isArray(args[0]) ? args[0][0] : args[0];
          insertedRow = {
            id: "00000000-0000-4000-8000-000000000001",
            created_at: new Date(0).toISOString(),
            updated_at: null,
            ...(payload as Record<string, unknown>),
          };
        }
        return chain();
      });
    }
    b.single = vi.fn(async () =>
      insertedRow ? { data: insertedRow, error: null } : notFound,
    );
    b.maybeSingle = vi.fn(async () =>
      insertedRow ? { data: insertedRow, error: null } : { data: null, error: null },
    );
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(insertedRow ? { data: [insertedRow], error: null } : emptyList);
    return b;
  };

  const client: any = {
    from: vi.fn((table: string) => {
      touchedTables.push(table);
      if (POST_MIGRATION_TABLES.has(table)) {
        throw new OldSchemaViolation(
          `Flag-false path queried post-migration table "${table}" (absent in production)`,
        );
      }
      if (!PRODUCTION_TABLES.has(table)) {
        throw new OldSchemaViolation(
          `Flag-false path queried unknown table "${table}" (not in the production schema model)`,
        );
      }
      return builder(table);
    }),
    rpc: vi.fn(async (fn: string) => {
      calledRpcs.push(fn);
      if (POST_MIGRATION_RPCS.has(fn)) {
        throw new OldSchemaViolation(
          `Flag-false path called post-migration RPC "${fn}" (absent in production)`,
        );
      }
      if (!PRODUCTION_RPCS.has(fn)) {
        throw new OldSchemaViolation(
          `Flag-false path called unknown RPC "${fn}" (not in the production schema model)`,
        );
      }
      return { data: null, error: null };
    }),
    storage: {
      from: vi.fn(() => ({
        createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
        createSignedUrl: vi.fn(async () => ({ data: null, error: null })),
        upload: vi.fn(async () => ({ data: null, error: null })),
        remove: vi.fn(async () => ({ data: null, error: null })),
        download: vi.fn(async () => ({ data: null, error: null })),
      })),
    },
    // getClaims must NOT be used on the flag-false path (legacy HMAC session is).
    auth: {
      getClaims: vi.fn(async () => {
        throw new OldSchemaViolation(
          "Flag-false path called supabase.auth.getClaims() (Supabase identity is pre-cutover-only)",
        );
      }),
    },
    __touchedTables: touchedTables,
    __calledRpcs: calledRpcs,
  };
  return client;
}

// The flag-false data path uses the legacy service-role bridge. Point BOTH the
// legacy bridge and the user-scoped factory at the production-schema model.
vi.mock("@/src/lib/supabase/legacy-service-role", () => ({
  createServerSupabaseClient: vi.fn(() => productionSchemaClient()),
}));
vi.mock("@/src/lib/supabase/server", () => ({
  createUserScopedClient: vi.fn(async () => productionSchemaClient()),
}));

// Legacy owner HMAC session present (this is how prod authenticates flag-false).
vi.mock("@/src/lib/auth/session", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: vi.fn(async () => ({ workspace: "owner", iat: 0, exp: 9_999_999_999 })),
    getSessionFromRequest: vi.fn(async () => ({ workspace: "owner", iat: 0, exp: 9_999_999_999 })),
  };
});

// AI is irrelevant to schema access; stub it so routes that touch it don't error.
vi.mock("@/src/lib/ai", () => ({
  complete: vi.fn(async () => ({ content: "x" })),
  generateGraphSummary: vi.fn(async () => "x"),
}));

const CONV = "11111111-1111-4111-8111-111111111111";

function jsonReq(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(new URL(url), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("old-schema compatibility (flag false, un-migrated production schema)", () => {
  it("GET /api/conversations lists against production schema only", async () => {
    const { GET } = await import("@/app/api/conversations/route");
    const res = await GET(new NextRequest(new URL("http://t/api/conversations")));
    // 200 (empty) is the healthy result; a schema violation would have thrown.
    expect(res.status).toBe(200);
  });

  it("GET /api/conversations?archived=true uses production schema only", async () => {
    const { GET } = await import("@/app/api/conversations/route");
    const res = await GET(
      new NextRequest(new URL("http://t/api/conversations?archived=true")),
    );
    expect(res.status).toBe(200);
  });

  it("POST /api/conversations (create) uses production schema only", async () => {
    const { POST } = await import("@/app/api/conversations/route");
    const res = await POST(jsonReq("http://t/api/conversations", { title: "Hi" }));
    expect([200, 201]).toContain(res.status);
  });

  it("GET /api/conversation?id=... loads via production schema only", async () => {
    const { GET } = await import("@/app/api/conversation/route");
    const res = await GET(
      new NextRequest(new URL(`http://t/api/conversation?id=${CONV}`)),
    );
    // Not found (no rows) is fine; the point is no post-migration access.
    expect([200, 404]).toContain(res.status);
  });

  it("GET /api/messages?conversationId=... reads via production schema only", async () => {
    const { GET } = await import("@/app/api/messages/route");
    const res = await GET(
      new NextRequest(new URL(`http://t/api/messages?conversationId=${CONV}`)),
    );
    expect([200, 404]).toContain(res.status);
  });

  it("GET /api/graph-workspaces lists via production schema only", async () => {
    const { GET } = await import("@/app/api/graph-workspaces/route");
    const res = await GET(new NextRequest(new URL("http://t/api/graph-workspaces")));
    expect([200, 404]).toContain(res.status);
  });

  it("requireConversationAccess (flag false) checks conversations.workspace_id, not the renamed column", async () => {
    const { requireConversationAccess } = await import("@/src/lib/auth/authorization");
    const session = { workspace: "owner", iat: 0, exp: 9_999_999_999 } as const;
    // No row → 404; crucially, selecting `legacy_workspace_id`/`account_workspace_id`
    // would throw OldSchemaViolation before returning.
    const result = await requireConversationAccess(CONV, session as any);
    // It returns a NextResponse (404) because the model returns no row.
    expect(result).toBeTruthy();
  });

  it("the production schema model itself rejects a post-migration table (self-check)", () => {
    const client = productionSchemaClient();
    expect(() => client.from("account_workspaces")).toThrow(/post-migration table/);
    expect(() => client.from("workspace_memberships")).toThrow(/post-migration table/);
  });

  it("the production schema model itself rejects a post-migration RPC (self-check)", async () => {
    const client = productionSchemaClient();
    await expect(client.rpc("provision_self")).rejects.toThrow(/post-migration RPC/);
    await expect(client.rpc("has_debug_access")).rejects.toThrow(/post-migration RPC/);
  });

  it("the production schema model allows a pre-existing engine RPC (self-check)", async () => {
    const client = productionSchemaClient();
    await expect(client.rpc("v2_commit_update")).resolves.toEqual({
      data: null,
      error: null,
    });
  });
});
