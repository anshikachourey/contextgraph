/**
 * Backward-compatible rename deployment-order invariant (Task 17 hardening item 5).
 *
 * Feature: google-oauth-authentication
 *
 * Encodes, as a static assertion over the SQL migrations, the exact safe
 * deployment sequence for the `conversations.workspace_id →
 * legacy_workspace_id` transition, so a future edit that reintroduces a bare
 * hard-rename (which would break the deployed app the instant it lands, before
 * the new code deploys) — or that moves the destructive drop back into the
 * auto-applied directory — fails CI.
 *
 * The invariant:
 *   1. The additive migration (20260824000100) must NOT rename workspace_id.
 *   2. It must ADD legacy_workspace_id, BACKFILL it, and install a bidirectional
 *      SYNC TRIGGER so both columns coexist and stay identical (step 1).
 *   3. The DROP of workspace_id must NOT live in `supabase/migrations/` at all
 *      (otherwise `supabase db push` would apply it immediately, alongside the
 *      additive step-1 migration, destroying backward compatibility before the
 *      new code deploys). It must instead live in the deferred/post-cutover
 *      location (`supabase/migrations-deferred/post-cutover/`), applied MANUALLY
 *      as a new normally-sequenced migration only after the preconditions hold
 *      (step 3, applied only after the new code is deployed — step 2).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFERRED_DIR = path.resolve(MIGRATIONS_DIR, "..", "migrations-deferred", "post-cutover");

/**
 * Read a SQL file with `--` line comments stripped, so assertions about what the
 * SQL DOES (vs. what the explanatory header says it deliberately avoids) are not
 * confused by prose that mentions the forbidden statement.
 */
const readFrom = (dir: string, name: string) =>
  fs
    .readFileSync(path.join(dir, name), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

const ADDITIVE = "20260824000100_reparent_graphs_conversations.sql";
const CLEANUP = "20260824000800_drop_conversations_workspace_id.sql";

describe("safe rename deployment order — conversations.workspace_id", () => {
  const additive = readFrom(MIGRATIONS_DIR, ADDITIVE);
  const cleanup = readFrom(DEFERRED_DIR, CLEANUP);

  it("the additive migration does NOT hard-rename workspace_id (would break the live app)", () => {
    expect(additive).not.toMatch(/RENAME\s+COLUMN\s+workspace_id/i);
  });

  it("the additive migration ADDS legacy_workspace_id as an additive column", () => {
    expect(additive).toMatch(
      /ALTER TABLE conversations\s+ADD COLUMN IF NOT EXISTS legacy_workspace_id TEXT/i,
    );
  });

  it("the additive migration BACKFILLS legacy_workspace_id from workspace_id", () => {
    expect(additive).toMatch(
      /UPDATE conversations\s+SET legacy_workspace_id = workspace_id/i,
    );
  });

  it("the additive migration installs a BIDIRECTIONAL sync trigger keeping both columns identical", () => {
    expect(additive).toMatch(/CREATE OR REPLACE FUNCTION public\.sync_conversations_legacy_workspace_id/i);
    expect(additive).toMatch(/CREATE TRIGGER trg_sync_conversations_legacy_workspace_id\s+BEFORE INSERT OR UPDATE ON conversations/i);
    // Both mirror directions are present (workspace_id→legacy and legacy→workspace_id).
    expect(additive).toMatch(/NEW\.legacy_workspace_id\s*:=\s*NEW\.workspace_id/);
    expect(additive).toMatch(/NEW\.workspace_id\s*:=\s*NEW\.legacy_workspace_id/);
  });

  it("the additive migration does NOT drop workspace_id (coexistence is required during rollout)", () => {
    expect(additive).not.toMatch(/DROP\s+COLUMN\s+(IF EXISTS\s+)?workspace_id/i);
  });

  it("the destructive DROP is NOT present in supabase/migrations/ (so `db push` won't auto-apply it)", () => {
    // No file in the auto-applied migrations dir may contain the destructive
    // workspace_id drop — that is the whole point of deferring it.
    const autoApplied = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(autoApplied).not.toContain(CLEANUP);
    for (const f of autoApplied) {
      const sql = readFrom(MIGRATIONS_DIR, f);
      expect(
        sql,
        `${f} must not drop conversations.workspace_id (deferred to post-cutover)`,
      ).not.toMatch(/ALTER TABLE conversations DROP COLUMN IF EXISTS workspace_id/i);
    }
  });

  it("the deferred drop DOES exist in the post-cutover deferred location", () => {
    const deferredPath = path.join(DEFERRED_DIR, CLEANUP);
    expect(fs.existsSync(deferredPath)).toBe(true);
  });

  it("the deferred migration performs the drop AND removes the sync trigger", () => {
    expect(cleanup).toMatch(/ALTER TABLE conversations DROP COLUMN IF EXISTS workspace_id/i);
    expect(cleanup).toMatch(/DROP TRIGGER IF EXISTS trg_sync_conversations_legacy_workspace_id/i);
    expect(cleanup).toMatch(/DROP FUNCTION IF EXISTS public\.sync_conversations_legacy_workspace_id/i);
  });

  it("the deferred drop migration sorts STRICTLY AFTER the additive one (ordering guarantee)", () => {
    const additiveTs = ADDITIVE.match(/^(\d+)/)![1];
    const cleanupTs = CLEANUP.match(/^(\d+)/)![1];
    expect(Number(cleanupTs)).toBeGreaterThan(Number(additiveTs));
  });

  it("the drop lives in a DIFFERENT file than the additive step (never bundled)", () => {
    expect(ADDITIVE).not.toEqual(CLEANUP);
    // The additive file must not contain the drop; the cleanup file must not
    // contain the additive add/backfill — the two steps stay strictly separate.
    expect(cleanup).not.toMatch(/ADD COLUMN IF NOT EXISTS legacy_workspace_id/i);
  });
});
