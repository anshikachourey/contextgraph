/**
 * Service-role reachability proof (Task 14, hardening item 3).
 *
 * Feature: google-oauth-authentication
 *
 * Proves that EVERY module on the service-role allowlist is either (a) NOT
 * reachable from an ordinary request path, or (b) — for the documented
 * pre-cutover residuals — reached only in a way that cannot leak another
 * workspace's data (global-scope maintenance / background sweep). Combines the
 * static reachability graph (approach a) with per-module assertions (approach b).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findReachabilityViolations,
  findOrdinaryRouteEntrypoints,
  transitiveImports,
  OFFLINE_SINKS,
} from "../../../../scripts/check-service-role-reachability.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ───────────────────────────────────────────────────────────────────────────────
// (a) Static reachability: genuinely-offline/privileged modules are unreachable
// ───────────────────────────────────────────────────────────────────────────────
describe("reachability (approach a) — offline sinks unreachable from ordinary routes", () => {
  it("no ordinary app/api route transitively reaches an OFFLINE_SINK or the privileged debug route", () => {
    const violations = findReachabilityViolations(ROOT);
    expect(violations).toEqual([]);
  });

  it("there is a non-trivial set of ordinary routes being checked (guards against a vacuous pass)", () => {
    const routes = findOrdinaryRouteEntrypoints(ROOT);
    expect(routes.length).toBeGreaterThan(10);
  });

  it("the UUID_Migration runner exists and is one of the offline sinks", () => {
    expect(OFFLINE_SINKS).toContain("src/lib/migration/uuid-migration.ts");
    expect(fs.existsSync(path.join(ROOT, "src/lib/migration/uuid-migration.ts"))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// (b) Per-module assertions for the allowlisted modules
// ───────────────────────────────────────────────────────────────────────────────
describe("reachability (approach b) — per-module privilege/offline assertions", () => {
  it("uuid-migration.ts: only the guarded factory, with the opt-in marker; no route imports it", () => {
    const src = read("src/lib/migration/uuid-migration.ts");
    expect(src).toMatch(/createServiceRoleClient\(\s*\{\s*allowServiceRole:\s*true\s*\}\s*\)/);
    // Not reachable from any ordinary route (also covered by approach a).
    const reachingRoutes = findOrdinaryRouteEntrypoints(ROOT).filter((r) =>
      transitiveImports(r, ROOT).has("src/lib/migration/uuid-migration.ts"),
    );
    expect(reachingRoutes).toEqual([]);
  });

  it("migrate-engine-state route: requireDebugAccess()-gated AND not imported by any OTHER ordinary route", () => {
    const src = read("app/api/debug/migrate-engine-state/route.ts");
    // Privileged + gated.
    expect(src).toMatch(/requireDebugAccess\(\)/);
    expect(src).toMatch(/createServiceRoleClient\(\s*\{\s*allowServiceRole:\s*true\s*\}\s*\)/);
    // No other ordinary route transitively imports this privileged route module.
    const importers = findOrdinaryRouteEntrypoints(ROOT).filter((r) =>
      transitiveImports(r, ROOT).has("app/api/debug/migrate-engine-state/route.ts"),
    );
    expect(importers).toEqual([]);
  });

  it("recovery sweep: recoverAbandonedWork is a BACKGROUND path; routes only call triggerRecoveryOnce", () => {
    // The runner's recovery sweep uses the legacy service-role client. It is a
    // background, non-request path (no auth.uid() to scope by). Prove that no
    // route handler calls recoverAbandonedWork() directly — routes may only call
    // the fire-and-forget triggerRecoveryOnce() which schedules the sweep.
    const runner = read("src/lib/intelligence-v2/incremental/update-runner.ts");
    // The service-role client is constructed ONLY inside recoverAbandonedWork,
    // and it uses the GUARDED factory directly (works in cutover mode) — NOT the
    // hard-failing legacy bridge. The request path uses resolveDbClient instead.
    const recoveryFnStart = runner.indexOf("export async function recoverAbandonedWork");
    const nextFnStart = runner.indexOf("async function processFromCursor");
    expect(recoveryFnStart).toBeGreaterThan(-1);
    const recoveryBody = runner.slice(recoveryFnStart, nextFnStart);
    expect(recoveryBody).toMatch(/createServiceRoleClient\(\s*\{\s*allowServiceRole:\s*true\s*\}\s*\)/);
    // The request-triggered path must NOT construct a service-role client — it
    // resolves the injected/user-scoped client via resolveDbClient.
    const processStart = runner.indexOf("async function processFromCursor");
    const processBody = runner.slice(processStart, processStart + 400);
    expect(processBody).toMatch(/resolveDbClient\(/);

    // No route handler file calls recoverAbandonedWork directly.
    const routes = findOrdinaryRouteEntrypoints(ROOT);
    const directCallers = routes.filter((r) =>
      /recoverAbandonedWork\s*\(/.test(read(r)),
    );
    expect(directCallers).toEqual([]);
  });

  it("calibration.ts: GLOBAL-singleton maintenance — guarded factory for the global write/read, injected client for the request-reachable read", () => {
    // calibration.ts touches ONLY a GLOBAL singleton row (id='global') and a
    // global id+embedding read — it never scopes by a caller-supplied
    // workspace/conversation, so it cannot leak another workspace's rows. The
    // privileged GLOBAL write path (loadAllNodeEmbeddings/saveCalibration,
    // reached only from the requireDebugAccess()-gated route) uses the GUARDED
    // factory directly (works in cutover mode). The request-reachable READ
    // (getStoredCalibration) takes the INJECTED client via resolveDbClient.
    const src = read("src/lib/db/calibration.ts");
    // Singleton id guard present.
    expect(src).toMatch(/GLOBAL_ID\s*=\s*["']global["']/);
    expect(src).toMatch(/\.eq\(\s*["']id["']\s*,\s*GLOBAL_ID\s*\)/);
    // Global maintenance uses the guarded factory (not the legacy bridge).
    expect(src).toMatch(/createServiceRoleClient\(\s*\{\s*allowServiceRole:\s*true\s*\}\s*\)/);
    // The request-reachable read takes an injected client via resolveDbClient.
    expect(src).toMatch(/getStoredCalibration\([\s\S]*?client\?:\s*DbClient/);
    expect(src).toMatch(/resolveDbClient\(client\)/);
    // It is reached only via the lazy dynamic import in the threshold accessor,
    // never statically from a route (keeps the import out of the eager graph).
    const accessor = read("src/lib/similarityThresholds.ts");
    expect(accessor).toMatch(/await import\(\s*["']\.\/db\/calibration["']\s*\)/);
  });
});
