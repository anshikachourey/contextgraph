/**
 * Unit tests for the service-role hard-violation guard.
 *
 * Feature: google-oauth-authentication (Task 1.4)
 * Requirements: 10.5
 *
 * The guard must:
 *   - throw when invoked WITHOUT the opt-in marker,
 *   - throw when invoked from a NON-allowlisted module (even with the marker),
 *   - succeed only from an allowlisted module WITH { allowServiceRole: true }.
 *
 * Because the guard resolves the caller from the stack trace, we exercise the
 * allowlisted-success path through a tiny fixture module placed on the allowlist
 * (`src/lib/db/calibration.ts` is allowlisted; we simulate an allowlisted caller
 * by stubbing the stack via a wrapper that reports an allowlisted frame).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("createServiceRoleClient hard-violation guard", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when the opt-in marker is missing", async () => {
    const { createServiceRoleClient } = await import("../service-role");
    // @ts-expect-error — intentionally omitting the required marker
    expect(() => createServiceRoleClient()).toThrow(/opt-in marker/i);
    // @ts-expect-error — wrong marker value
    expect(() => createServiceRoleClient({ allowServiceRole: false })).toThrow(
      /opt-in marker/i,
    );
  });

  it("throws when invoked from a non-allowlisted module (even with the marker)", async () => {
    const { createServiceRoleClient } = await import("../service-role");
    // This very test file is NOT on the allowlist, so the caller frame
    // (service-role.test.ts) is rejected.
    expect(() => createServiceRoleClient({ allowServiceRole: true })).toThrow(
      /non-allowlisted module/i,
    );
  });

  it("succeeds from an allowlisted module with the opt-in marker", async () => {
    const srMod = await import("../service-role");

    // Supply a stack whose caller frame is an allowlisted module.
    const allowlistedFrame =
      "Error\n    at Object.<anonymous> (/repo/src/lib/migration/uuid-migration.ts:10:20)\n" +
      "    at createServiceRoleClient (/repo/src/lib/supabase/service-role.ts:1:1)";

    const client = srMod.createServiceRoleClient(
      { allowServiceRole: true },
      allowlistedFrame,
    );

    expect(client).toBeTruthy();
    expect(typeof client.from).toBe("function");
  });

  it("fails closed when the caller cannot be resolved", async () => {
    const srMod = await import("../service-role");
    expect(() =>
      srMod.createServiceRoleClient({ allowServiceRole: true }, undefined),
    ).toThrow(/non-allowlisted module|unknown caller/i);
    // Also: an empty/garbage stack resolves to no caller → fail closed.
    expect(() =>
      srMod.createServiceRoleClient({ allowServiceRole: true }, "Error\n"),
    ).toThrow(/non-allowlisted module|unknown caller/i);
  });

  it("resolveCallerModule skips guard frames and resolves the real caller", async () => {
    const { resolveCallerModule } = await import("../service-role");
    const stack =
      "Error\n" +
      "    at resolveCallerModule (/repo/src/lib/supabase/service-role.ts:30:5)\n" +
      "    at createServiceRoleClient (/repo/src/lib/supabase/service-role.ts:90:20)\n" +
      "    at run (/repo/src/lib/migration/uuid-migration.ts:12:10)";
    expect(resolveCallerModule(stack)).toBe(
      "/repo/src/lib/migration/uuid-migration.ts",
    );
    expect(resolveCallerModule(undefined)).toBeNull();
  });
});
