// Feature: google-oauth-authentication — schema / smoke tests (Task 3.8)
//
// Requirements: 5.2, 5.3, 22.1, 22.2
//
// Structural assertions that don't need a live DB:
//   - workspace_memberships is UNIQUE on (workspace_id, user_id) — composite,
//     NOT a per-workspace single-member constraint — so a workspace can hold
//     multiple memberships later (Req 22.1).
//   - No shared/team workspace UI or multi-member flow ships in this feature
//     (Req 22.2): only personal workspaces + owner self-membership exist.
//   - No Redis and no raw PostgreSQL connection pool are introduced (Req 5.2/5.3).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");

function readMigration(file: string): string {
  return fs.readFileSync(path.join(ROOT, "supabase/migrations", file), "utf8");
}

describe("workspace_memberships schema readiness (Req 22.1)", () => {
  const sql = readMigration("20260824000000_create_identity_workspace_tables.sql");

  it("is composite-unique on (workspace_id, user_id), not single-member", () => {
    expect(sql).toMatch(/UNIQUE\s*\(\s*workspace_id\s*,\s*user_id\s*\)/i);
    // Must NOT constrain to a single member per workspace.
    expect(sql).not.toMatch(/UNIQUE\s*\(\s*workspace_id\s*\)/i);
  });

  it("indexes memberships by user for fast per-user lookup", () => {
    expect(sql).toMatch(/idx_membership_by_user[\s\S]*workspace_memberships\s*\(\s*user_id\s*\)/i);
  });
});

describe("no shared-workspace UI / multi-member flow ships (Req 22.2)", () => {
  it("provisioning only ever creates a personal workspace with owner self-membership", () => {
    const trigger = readMigration("20260824000200_provisioning_trigger.sql");
    const rpc = readMigration("20260824000300_provision_self_rpc.sql");
    for (const sql of [trigger, rpc]) {
      expect(sql).toMatch(/kind\s*,\s*name\s*\)\s*VALUES\s*\([^)]*'personal'/i);
      expect(sql).toMatch(/role\s*\)\s*VALUES\s*\([^)]*'owner'/i);
      // No invitation / shared-member insertion.
      expect(sql).not.toMatch(/'shared'/i);
    }
  });

  it("ships no shared/team workspace screens", () => {
    const appDir = path.join(ROOT, "app");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".next") continue;
          if (/invite|team|shared[-_]?workspace|members?-management/i.test(e.name)) {
            offenders.push(path.relative(ROOT, full));
          }
          walk(full);
        }
      }
    };
    walk(appDir);
    expect(offenders).toEqual([]);
  });
});

describe("no Redis and no raw PG pool introduced (Req 5.2, 5.3)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  } as Record<string, string>;

  it("does not add a Redis client dependency", () => {
    const redisish = Object.keys(allDeps).filter((d) =>
      /(^|[-/])(redis|ioredis|upstash)/i.test(d),
    );
    expect(redisish).toEqual([]);
  });

  it("does not add a raw PostgreSQL pool dependency", () => {
    const pgPool = Object.keys(allDeps).filter((d) =>
      /^(pg|pg-pool|postgres|node-postgres|pg-promise|slonik)$/i.test(d),
    );
    expect(pgPool).toEqual([]);
  });

  it("the new auth scaffolding modules go through supabase clients, not raw sockets", () => {
    const files = [
      "src/lib/supabase/browser.ts",
      "src/lib/supabase/server.ts",
      "src/lib/supabase/service-role.ts",
      "src/lib/config/cutover.ts",
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src).not.toMatch(/require\(['"]pg['"]\)|from ['"]pg['"]|new Pool\(/);
      expect(src).not.toMatch(/from ['"]ioredis['"]|from ['"]redis['"]/);
    }
  });
});
