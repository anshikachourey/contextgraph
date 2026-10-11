/**
 * Fixture test for the service-role static check script.
 *
 * Feature: google-oauth-authentication (Task 1.7)
 * Requirements: 10.3, 10.5
 *
 * Builds a throwaway temp workspace with:
 *   - a DISALLOWED importer of the service-role factory  → must be flagged
 *   - an ALLOWLISTED importer of the service-role factory → must pass
 *   - a module importing the look-alike `service-role-allowlist` → must NOT flag
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findViolations } from "../check-service-role-usage.mjs";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sr-check-"));

  // Mirror the allowlist file so the script loads a known allowlist.
  const allowlistDir = path.join(tmpRoot, "src/lib/supabase");
  fs.mkdirSync(allowlistDir, { recursive: true });
  fs.writeFileSync(
    path.join(allowlistDir, "service-role-allowlist.ts"),
    `export const SERVICE_ROLE_ALLOWLIST = [\n  "src/lib/migration/uuid-migration.ts",\n];\n`,
  );

  // Disallowed importer (a fake request route).
  const routeDir = path.join(tmpRoot, "app/api/evil");
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(
    path.join(routeDir, "route.ts"),
    `import { createServiceRoleClient } from "@/src/lib/supabase/service-role";\nexport const GET = () => createServiceRoleClient({ allowServiceRole: true });\n`,
  );

  // Allowlisted importer.
  const migDir = path.join(tmpRoot, "src/lib/migration");
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(
    path.join(migDir, "uuid-migration.ts"),
    `import { createServiceRoleClient } from "@/src/lib/supabase/service-role";\nexport const run = () => createServiceRoleClient({ allowServiceRole: true });\n`,
  );

  // Innocent module importing the ALLOWLIST helper (not the factory). Must not flag.
  const innocentDir = path.join(tmpRoot, "src/lib/other");
  fs.mkdirSync(innocentDir, { recursive: true });
  fs.writeFileSync(
    path.join(innocentDir, "ok.ts"),
    `import { isAllowlistedModule } from "@/src/lib/supabase/service-role-allowlist";\nexport const x = isAllowlistedModule("a");\n`,
  );

  // Task 14 (hardening item 2): the LEGACY bridge import style must ALSO be
  // rejected for a non-allowlisted request route.
  const legacyRouteDir = path.join(tmpRoot, "app/api/legacy-evil");
  fs.mkdirSync(legacyRouteDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyRouteDir, "route.ts"),
    `import { createServerSupabaseClient } from "@/src/lib/supabase/legacy-service-role";\nexport const GET = () => createServerSupabaseClient();\n`,
  );

  // Capability boundary (incident fix for 260ec8b): a non-allowlisted request
  // module must not be able to import EITHER service-role export. The capability
  // only prevents ACCIDENTAL misuse at runtime; the authorization of WHICH
  // modules may import/mint it is enforced HERE, statically. So importing
  // grantServiceRoleCapability — not just createServiceRoleClient — from a
  // non-allowlisted request path must be flagged too.
  const capRouteDir = path.join(tmpRoot, "app/api/cap-evil");
  fs.mkdirSync(capRouteDir, { recursive: true });
  fs.writeFileSync(
    path.join(capRouteDir, "route.ts"),
    `import { grantServiceRoleCapability } from "@/src/lib/supabase/service-role";\n` +
      `export const GET = () => grantServiceRoleCapability("sneaky");\n`,
  );

  // Combined import of BOTH exports from a non-allowlisted request path.
  const comboRouteDir = path.join(tmpRoot, "app/api/combo-evil");
  fs.mkdirSync(comboRouteDir, { recursive: true });
  fs.writeFileSync(
    path.join(comboRouteDir, "route.ts"),
    `import { createServiceRoleClient, grantServiceRoleCapability } from "@/src/lib/supabase/service-role";\n` +
      `export const GET = () =>\n` +
      `  createServiceRoleClient({ allowServiceRole: true, capability: grantServiceRoleCapability("x") });\n`,
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("check-service-role-usage static check", () => {
  it("flags a disallowed importer and passes an allowlisted one", () => {
    const violations = findViolations({ root: tmpRoot });
    expect(violations).toContain("app/api/evil/route.ts");
    expect(violations).not.toContain("src/lib/migration/uuid-migration.ts");
  });

  it("rejects BOTH the guarded-factory and the legacy-bridge import styles", () => {
    const violations = findViolations({ root: tmpRoot });
    // Guarded factory style (service-role) AND legacy bridge style
    // (legacy-service-role) are both flagged outside the allowlist.
    expect(violations).toContain("app/api/evil/route.ts");
    expect(violations).toContain("app/api/legacy-evil/route.ts");
  });

  it("does not flag modules importing the look-alike allowlist helper", () => {
    const violations = findViolations({ root: tmpRoot });
    expect(violations).not.toContain("src/lib/other/ok.ts");
  });

  it("flags a non-allowlisted request module that imports grantServiceRoleCapability", () => {
    // The capability guards against ACCIDENTAL runtime misuse; module
    // authorization is enforced statically here. Importing the capability
    // mint from a non-allowlisted request path is itself a violation —
    // acquiring the capability is exactly what the static layer forbids.
    const violations = findViolations({ root: tmpRoot });
    expect(violations).toContain("app/api/cap-evil/route.ts");
  });

  it("flags a non-allowlisted request module importing BOTH exports together", () => {
    const violations = findViolations({ root: tmpRoot });
    expect(violations).toContain("app/api/combo-evil/route.ts");
  });

  it("neither service-role export is reachable from a non-allowlisted request path (summary)", () => {
    const violations = findViolations({ root: tmpRoot });
    // All four non-allowlisted request routes — importing the factory, the
    // legacy bridge, the capability mint, or both — are rejected; the
    // allowlisted module and the allowlist-helper importer are not.
    for (const flagged of [
      "app/api/evil/route.ts",
      "app/api/legacy-evil/route.ts",
      "app/api/cap-evil/route.ts",
      "app/api/combo-evil/route.ts",
    ]) {
      expect(violations).toContain(flagged);
    }
    expect(violations).not.toContain("src/lib/migration/uuid-migration.ts");
    expect(violations).not.toContain("src/lib/other/ok.ts");
  });
});
