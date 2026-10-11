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
});
