#!/usr/bin/env node
/**
 * Blocking CI static check — service-role import allowlist enforcement.
 *
 * Feature: google-oauth-authentication (Task 1.6)
 *
 * Statically scans `app/**` and `src/**` for any module that imports a
 * privileged, RLS-bypassing service-role PROVIDER and fails the build if that
 * importer is NOT on the service-role allowlist (Req 10.3, 10.5).
 *
 * ── TIGHTENED SCOPE (Task 14, hardening item 2) ─────────────────────────────
 *
 * The check now rejects BOTH service-role import styles anywhere outside the
 * allowlist:
 *   (a) the LEGACY bridge  — `@/src/lib/supabase/legacy-service-role`
 *       (`createServerSupabaseClient`). Earlier the legacy service-role client
 *       was constructed inline inside `supabase/server.ts`, so it escaped this
 *       check entirely. The service-role key is now reachable ONLY through the
 *       two provider modules below, so both are watched and the blind spot is
 *       closed.
 *   (b) the GUARDED factory — `@/src/lib/supabase/service-role`
 *       (`createServiceRoleClient`).
 *
 * Both match the `supabase/service-role` substring (the legacy bridge path
 * CONTAINS `service-role`), so a single family of patterns covers both; the
 * allowlist helper module `service-role-allowlist` is explicitly excluded via
 * negative lookahead.
 *
 * Because all ordinary request paths are converted, the ONLY allowlisted
 * importers are the UUID_Migration runner, the service-role boundary modules,
 * the requireDebugAccess()-gated schema-maintenance route, and the explicitly-
 * documented PRE-CUTOVER RESIDUAL bridges/engine internals (Task-17 blockers).
 *
 * Node 22, zero dependencies (uses only built-in fs/path).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ─── Load the allowlist (single source of truth) ────────────────────────────
// We parse the allowlist entries out of the TS module via a tiny regex so this
// plain .mjs script does not need a TS loader. Falls back to an inline mirror if
// parsing ever fails, and warns loudly so the drift is visible.
function loadAllowlist() {
  const allowlistPath = path.join(ROOT, "src/lib/supabase/service-role-allowlist.ts");
  try {
    const src = fs.readFileSync(allowlistPath, "utf8");
    const arrayMatch = src.match(/SERVICE_ROLE_ALLOWLIST[^=]*=\s*\[([\s\S]*?)\]/);
    if (arrayMatch) {
      const entries = [...arrayMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
      if (entries.length > 0) return entries;
    }
    console.warn("[check-service-role-usage] Could not parse allowlist array; using fallback.");
  } catch (err) {
    console.warn(`[check-service-role-usage] Could not read allowlist (${err.message}); using fallback.`);
  }
  return [
    // Group (d) — genuinely privileged / offline
    "src/lib/migration/uuid-migration.ts",
    "src/lib/supabase/service-role.ts",
    "src/lib/supabase/service-role-allowlist.ts",
    "src/lib/supabase/legacy-service-role.ts",
    "app/api/debug/migrate-engine-state/route.ts",
    // (d) background sweep + global-singleton maintenance (guarded factory)
    "src/lib/intelligence-v2/incremental/update-runner.ts",
    "src/lib/db/calibration.ts",
    // Flag-aware bridges (user-scoped on flag-true; hard-failing legacy on flag-false)
    "src/lib/db/request-client.ts",
    "src/lib/db/client.ts",
    "src/lib/auth/authorization.ts",
  ];
}

const ALLOWLIST = loadAllowlist();

function normalize(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
function stripExt(s) {
  return s.replace(/\.(mts|cts|tsx|ts|mjs|cjs|jsx|js)$/, "");
}
function isAllowlisted(relPath) {
  const cand = normalize(relPath);
  const candNoExt = stripExt(cand);
  return ALLOWLIST.some((allowed) => {
    const a = normalize(allowed);
    const aNoExt = stripExt(a);
    return (
      cand === a || cand.endsWith(`/${a}`) || candNoExt === aNoExt || candNoExt.endsWith(`/${aNoExt}`)
    );
  });
}

// The service-role PROVIDER module paths we are guarding. Matches BOTH:
//   - the guarded factory      ...supabase/service-role
//   - the legacy bridge        ...supabase/legacy-service-role
// while EXCLUDING the allowlist helper ...supabase/service-role-allowlist.
// The optional `legacy-` prefix is captured so both styles are flagged; the
// negative lookahead `(?!-allowlist)` keeps the allowlist helper import legal.
const SR = String.raw`supabase\/(?:legacy-)?service-role(?!-allowlist)`;
const IMPORT_PATTERNS = [
  new RegExp(String.raw`from\s+["'\`][^"'\`]*${SR}["'\`]`),
  new RegExp(String.raw`import\s*\(\s*["'\`][^"'\`]*${SR}["'\`]`),
  new RegExp(String.raw`require\(\s*["'\`][^"'\`]*${SR}["'\`]`),
];

const SCAN_DIRS = ["app", "src"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// The service-role boundary modules themselves. These ARE the provider layer,
// so they naturally reference the factory/allowlist/bridge. They are also on
// the allowlist proper, so this set is belt-and-suspenders.
const SELF_PATHS = new Set([
  "src/lib/supabase/service-role.ts",
  "src/lib/supabase/service-role-allowlist.ts",
  "src/lib/supabase/legacy-service-role.ts",
]);

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      yield* walk(full);
    } else if (SCAN_EXTS.has(path.extname(entry.name))) {
      // Test files are not request paths: they legitimately import the
      // service-role providers to VERIFY the guard/hard-fail behavior
      // (e.g. the cutover-mode proofs assert the legacy bridge throws).
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;
      yield full;
    }
  }
}

function importsServiceRole(contents) {
  return IMPORT_PATTERNS.some((re) => re.test(contents));
}

export function findViolations({ root = ROOT } = {}) {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(root, dir);
    for (const file of walk(abs)) {
      const rel = normalize(path.relative(root, file));
      if (SELF_PATHS.has(rel)) continue;
      const contents = fs.readFileSync(file, "utf8");
      if (importsServiceRole(contents) && !isAllowlisted(rel)) {
        violations.push(rel);
      }
    }
  }
  return violations.sort();
}

function main() {
  const violations = findViolations();
  if (violations.length > 0) {
    console.error(
      "\n✖ Service-role import check FAILED — the following request-path modules import the\n" +
        "  service-role factory but are NOT on the allowlist (src/lib/supabase/service-role-allowlist.ts):\n",
    );
    for (const v of violations) console.error(`    • ${v}`);
    console.error(
      "\n  Use createUserScopedClient() so RLS applies, or — if this is a genuinely privileged\n" +
        "  offline/system job — add it to the allowlist with an explicit, reviewed edit.\n",
    );
    process.exit(1);
  }
  console.log(
    `✓ Service-role import check passed — no non-allowlisted importer of the service-role factory ` +
      `(scanned ${SCAN_DIRS.join(", ")}).`,
  );
}

// Only run main() when executed directly (not when imported by the fixture test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
