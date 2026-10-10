/**
 * Task 5.3 — DB helper injected-client transition tests.
 *
 * Feature: google-oauth-authentication
 *
 * Verifies the Task 5 transition pattern end-to-end for a representative set of
 * refactored helpers:
 *   1. When a caller passes a client, the helper performs its reads/writes
 *      through THAT injected client (RLS-capable, user-scoped path).
 *   2. When a caller omits the client, the helper falls back to the LEGACY
 *      service-role client via `resolveDbClient` — preserving pre-cutover
 *      behavior with zero route changes.
 *
 * These assertions pin the behavior-neutrality guarantee: unconverted callers
 * (every current route) keep hitting the legacy client, while converted callers
 * (Tasks 10–13) get their injected client with no fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Spyable legacy service-role factory ─────────────────────────────────────
// `resolveDbClient` imports `createServerSupabaseClient` from this module; we
// mock it so the fallback path returns an identifiable sentinel client and we
// can assert whether it was constructed at all.

const legacyFrom = vi.fn();
const legacyRpc = vi.fn();
const legacyStorageFrom = vi.fn();
const createServerSupabaseClient = vi.fn(() => ({
  __kind: "legacy-service-role",
  from: legacyFrom,
  rpc: legacyRpc,
  storage: { from: legacyStorageFrom },
}));

vi.mock("@/src/lib/supabase/legacy-service-role", () => ({
  createServerSupabaseClient: () => createServerSupabaseClient(),
}));

// Avoid pulling real embeddings/OpenAI into the nodes.ts import graph.
vi.mock("@/src/lib/embeddings", () => ({
  generateEmbedding: vi.fn(async () => null),
  generateEvidenceSummary: vi.fn(async () => null),
  buildNodeEmbeddingText: vi.fn(() => "text"),
}));

import { listConversations } from "../conversations";
import { persistMessages } from "../messages";
import { loadEdges } from "../edges";
import { listGraphWorkspaces } from "../graph-workspaces";
import { loadActiveCandidates } from "../candidates";

// ─── Chainable Supabase-query mock ────────────────────────────────────────────

function chainMock(returnData: unknown = [], returnError: unknown = null) {
  const result = { data: returnData, error: returnError };
  const chain: Record<string, unknown> = {};
  for (const m of [
    "select",
    "insert",
    "update",
    "upsert",
    "delete",
    "eq",
    "is",
    "not",
    "in",
    "gt",
    "lt",
    "order",
    "limit",
    "range",
  ]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  Object.defineProperty(chain, "then", {
    value: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
    writable: true,
    configurable: true,
  });
  return chain;
}

/** Build an identifiable injected (user-scoped) client with spyable surfaces. */
function makeInjectedClient() {
  const from = vi.fn(() => chainMock());
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const storageFrom = vi.fn(() => ({
    list: vi.fn(async () => ({ data: [], error: null })),
    remove: vi.fn(async () => ({ data: null, error: null })),
    createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
  }));
  return {
    client: { __kind: "injected-user-scoped", from, rpc, storage: { from: storageFrom } },
    from,
    rpc,
    storageFrom,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  legacyFrom.mockReturnValue(chainMock());
});

describe("DB helpers use the injected client when provided", () => {
  it("listConversations reads through the injected client, not the legacy one", async () => {
    const injected = makeInjectedClient();
    await listConversations("ws-1", undefined, injected.client as any);

    expect(injected.from).toHaveBeenCalledWith("conversations");
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
    expect(legacyFrom).not.toHaveBeenCalled();
  });

  it("persistMessages writes through the injected client, not the legacy one", async () => {
    const injected = makeInjectedClient();
    await persistMessages(
      "conv-1",
      [{ id: "m1", role: "user", content: "hi" } as any],
      undefined,
      injected.client as any,
    );

    expect(injected.from).toHaveBeenCalledWith("messages");
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("loadEdges reads through the injected client, not the legacy one", async () => {
    const injected = makeInjectedClient();
    await loadEdges("conv-1", injected.client as any);

    expect(injected.from).toHaveBeenCalledWith("edges");
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("listGraphWorkspaces reads through the injected client, not the legacy one", async () => {
    const injected = makeInjectedClient();
    await listGraphWorkspaces("ws-1", injected.client as any);

    expect(injected.from).toHaveBeenCalledWith("graph_workspaces");
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("loadActiveCandidates reads through the injected client, not the legacy one", async () => {
    const injected = makeInjectedClient();
    await loadActiveCandidates("conv-1", injected.client as any);

    expect(injected.from).toHaveBeenCalledWith("topic_candidates");
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });
});

describe("DB helpers fall back to the legacy service-role client when none is injected", () => {
  it("listConversations uses the legacy client when no client is passed", async () => {
    await listConversations("ws-1");

    expect(createServerSupabaseClient).toHaveBeenCalledTimes(1);
    expect(legacyFrom).toHaveBeenCalledWith("conversations");
  });

  it("loadEdges uses the legacy client when no client is passed", async () => {
    await loadEdges("conv-1");

    expect(createServerSupabaseClient).toHaveBeenCalledTimes(1);
    expect(legacyFrom).toHaveBeenCalledWith("edges");
  });

  it("listGraphWorkspaces uses the legacy client when no client is passed", async () => {
    await listGraphWorkspaces("ws-1");

    expect(createServerSupabaseClient).toHaveBeenCalledTimes(1);
    expect(legacyFrom).toHaveBeenCalledWith("graph_workspaces");
  });
});
