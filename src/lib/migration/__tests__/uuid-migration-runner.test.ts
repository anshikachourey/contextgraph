/**
 * Unit tests for the UUID_Migration runner (Task 15.2) + the TypeScript
 * schema PREFLIGHT (Task 14 item 4, reworked in Task 17 item 4 to use an RPC).
 *
 * Feature: google-oauth-authentication
 *
 * These exercise the runner's gating (must have a well-formed real UUID) and the
 * TS preflight, which now runs through the read-only
 * `assert_owner_migration_preflight_report()` RPC (information_schema is NOT
 * exposed over PostgREST, so a direct catalog query cannot work). A stubbed
 * Supabase client models the RPC — no live Supabase/Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Preflight report the stub RPC returns for assert_owner_migration_preflight_report.
let preflightReport: { ok: boolean; missing: string[] } = { ok: true, missing: [] };
let preflightRpcError: { message: string } | null = null;

// Records every rpc(name, args) call so we can assert ordering / non-invocation.
const rpcCalls: Array<{ name: string; args: unknown }> = [];

function rpcImpl(name: string, args?: unknown) {
  rpcCalls.push({ name, args });
  if (name === "assert_owner_migration_preflight_report") {
    if (preflightRpcError) return Promise.resolve({ data: null, error: preflightRpcError });
    return Promise.resolve({ data: preflightReport, error: null });
  }
  if (name === "migrate_owner_data_to_user") {
    return Promise.resolve({ data: null, error: null });
  }
  return Promise.resolve({ data: null, error: null });
}

const rpcMock = vi.fn(rpcImpl);

function stubClient() {
  return { rpc: rpcMock };
}

vi.mock("@/src/lib/supabase/service-role", () => ({
  createServiceRoleClient: vi.fn(() => stubClient()),
}));

import { runOwnerUuidMigration, assertSchemaPreflight } from "../uuid-migration";

const GOOD_UUID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation(rpcImpl);
  rpcCalls.length = 0;
  preflightReport = { ok: true, missing: [] };
  preflightRpcError = null;
});

describe("runOwnerUuidMigration — UUID gating (Req 11.3)", () => {
  it("refuses a missing / malformed UUID and never calls any RPC", async () => {
    await expect(runOwnerUuidMigration("" as unknown as string)).rejects.toThrow(
      /well-formed real Supabase user UUID/,
    );
    await expect(runOwnerUuidMigration("not-a-uuid")).rejects.toThrow();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("runs the migration for a well-formed UUID when the schema is intact", async () => {
    const res = await runOwnerUuidMigration(GOOD_UUID);
    expect(res).toEqual({ targetUserId: GOOD_UUID, ok: true });
    // Preflight report RPC runs FIRST, then the mutating RPC.
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "assert_owner_migration_preflight_report",
      "migrate_owner_data_to_user",
    ]);
    expect(rpcMock).toHaveBeenCalledWith("migrate_owner_data_to_user", {
      target_user: GOOD_UUID,
    });
  });
});

describe("TS preflight (RPC-based) — fail-fast before mutation", () => {
  it("passes when the report says ok", async () => {
    await expect(assertSchemaPreflight(stubClient() as never)).resolves.toBeUndefined();
  });

  it("throws listing the missing object when the report says not-ok", async () => {
    preflightReport = { ok: false, missing: ["conversations.legacy_workspace_id text"] };
    await expect(assertSchemaPreflight(stubClient() as never)).rejects.toThrow(
      /conversations\.legacy_workspace_id/,
    );
  });

  it("aborts the runner BEFORE the mutating RPC when the schema has drifted", async () => {
    preflightReport = { ok: false, missing: ["graph_workspaces.account_workspace_id uuid"] };
    await expect(runOwnerUuidMigration(GOOD_UUID)).rejects.toThrow(/preflight FAILED/);
    // The mutating RPC must NOT have been invoked.
    expect(rpcCalls.some((c) => c.name === "migrate_owner_data_to_user")).toBe(false);
  });

  it("throws (fails closed) if the preflight report RPC errors", async () => {
    preflightRpcError = { message: "permission denied" };
    await expect(assertSchemaPreflight(stubClient() as never)).rejects.toThrow(
      /assert_owner_migration_preflight_report/,
    );
  });

  it("throws (fails closed) if the report shape is unexpected", async () => {
    preflightReport = { } as never;
    await expect(assertSchemaPreflight(stubClient() as never)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
