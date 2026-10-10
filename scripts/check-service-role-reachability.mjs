#!/usr/bin/env node
/**
 * Static reachability proof for the service-role allowlist (Task 14, item 3).
 *
 * Feature: google-oauth-authentication
 *
 * GOAL: prove that the GENUINELY-OFFLINE / privileged service-role modules are
 * NOT reachable from an ordinary request path. "Ordinary request path" = every
 * `app/api/**\/route.ts` entrypoint MINUS the explicitly-privileged ones (the
 * requireDebugAccess()-gated schema-maintenance route).
 *
 * Approach (a) from the task: build the transitive static-import graph starting
 * from each ordinary route entrypoint and assert that none reaches an
 * OFFLINE_SINK module.
 *
 * ── Sink classification ───────────────────────────────────────────────────────
 *
 * OFFLINE_SINKS — MUST be unreachable from any ordinary route:
 *   - src/lib/migration/uuid-migration.ts
 *       The one-time owner migration runner. Invoked manually with the real UUID.
 *   - src/lib/jobs/storage-cleanup.ts (if present)
 *       Scheduled bulk/system storage cleanup; no user session.
 *
 * PRIVILEGED_ROUTE_ENTRYPOINTS — routes that are themselves privileged (gated by
 * requireDebugAccess) and are allowed to construct the service-role client. They
 * are EXCLUDED from the set of ordinary entrypoints, and we separately assert no
 * OTHER ordinary route transitively imports them:
 *   - app/api/debug/migrate-engine-state/route.ts
 *
 * ── Recovery sweep & calibration (handled by the companion assertion test) ────
 * The background recovery sweep (recoverAbandonedWork/triggerRecoveryOnce in
 * update-runner.ts) and calibration.ts are PRE-CUTOVER RESIDUALS reachable from
 * request paths today; their offline/global-scope justification is asserted in
 * `src/lib/migration/__tests__/service-role-reachability.test.ts` rather than
 * here (this script proves the strict OFFLINE_SINK unreachability).
 *
 * Node 22, zero deps (fs/path only). Also exports helpers for the Vitest proof.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCAN_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Modules that MUST be unreachable from any ordinary request route. */
export const OFFLINE_SINKS = [
  "src/lib/migration/uuid-migration.ts",
  "src/lib/jobs/storage-cleanup.ts",
];

/** Privileged route entrypoints excluded from the "ordinary" set. */
export const PRIVILEGED_ROUTE_ENTRYPOINTS = [
  "app/api/debug/migrate-engine-state/route.ts",
];

function norm(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

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
    } else {
      yield full;
    }
  }
}

/** All ordinary route entrypoints (app/api/**\/route.ts minus privileged). */
export function findOrdinaryRouteEntrypoints(root = ROOT) {
  const privileged = new Set(PRIVILEGED_ROUTE_ENTRYPOINTS.map(norm));
  const routes = [];
  for (const file of walk(path.join(root, "app", "api"))) {
    const rel = norm(path.relative(root, file));
    if (/\/route\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(rel) && !privileged.has(rel)) {
      routes.push(rel);
    }
  }
  return routes.sort();
}

/** Resolve a module specifier imported from `fromRel` to a workspace-rel path. */
function resolveSpecifier(spec, fromRel, root) {
  let base;
  if (spec.startsWith("@/")) {
    base = spec.slice(2); // "@/" aliases the workspace root
  } else if (spec.startsWith(".")) {
    base = norm(path.posix.join(path.posix.dirname(fromRel), spec));
  } else {
    return null; // bare package import — not part of our source graph
  }

  // Try direct file + extensions + index files.
  const candidates = [];
  if (/\.[a-z]+$/.test(base)) candidates.push(base);
  for (const ext of SCAN_EXTS) candidates.push(base + ext);
  for (const ext of SCAN_EXTS) candidates.push(norm(path.posix.join(base, "index" + ext)));

  for (const c of candidates) {
    if (fs.existsSync(path.join(root, c))) return c;
  }
  return null;
}

const IMPORT_RE =
  /(?:import|export)\s+(?:[\s\S]*?from\s+)?["'`]([^"'`]+)["'`]|import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

/** Static import specifiers referenced by a file (incl. dynamic import()). */
function readImports(absFile) {
  let src;
  try {
    src = fs.readFileSync(absFile, "utf8");
  } catch {
    return [];
  }
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * Compute the set of workspace-rel modules transitively reachable (via static
 * AND dynamic imports) from `entryRel`.
 */
export function transitiveImports(entryRel, root = ROOT) {
  const seen = new Set();
  const stack = [norm(entryRel)];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const abs = path.join(root, cur);
    for (const spec of readImports(abs)) {
      const resolved = resolveSpecifier(spec, cur, root);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  seen.delete(norm(entryRel));
  return seen;
}

/**
 * For each ordinary route, report any OFFLINE_SINK it transitively reaches, and
 * any PRIVILEGED_ROUTE_ENTRYPOINT it transitively imports.
 */
export function findReachabilityViolations(root = ROOT) {
  const sinks = new Set(OFFLINE_SINKS.map(norm).filter((s) => fs.existsSync(path.join(root, s))));
  const privileged = new Set(PRIVILEGED_ROUTE_ENTRYPOINTS.map(norm));
  const routes = findOrdinaryRouteEntrypoints(root);

  const violations = [];
  for (const route of routes) {
    const reach = transitiveImports(route, root);
    for (const sink of sinks) {
      if (reach.has(sink)) violations.push({ route, reaches: sink, kind: "offline-sink" });
    }
    for (const p of privileged) {
      if (reach.has(p)) violations.push({ route, reaches: p, kind: "privileged-route" });
    }
  }
  return violations;
}

function main() {
  const routes = findOrdinaryRouteEntrypoints();
  const violations = findReachabilityViolations();
  if (violations.length > 0) {
    console.error(
      "\n✖ Service-role reachability check FAILED — an ordinary request route can reach a\n" +
        "  genuinely-offline/privileged module:\n",
    );
    for (const v of violations) {
      console.error(`    • ${v.route}  →  ${v.reaches}  [${v.kind}]`);
    }
    console.error("");
    process.exit(1);
  }
  console.log(
    `✓ Service-role reachability check passed — none of the ${routes.length} ordinary ` +
      `route entrypoints transitively reaches an OFFLINE_SINK or the privileged ` +
      `schema-maintenance route.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
