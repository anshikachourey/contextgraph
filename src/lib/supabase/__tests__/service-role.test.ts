/**
 * Unit tests for the service-role hard-violation guard (capability boundary).
 *
 * Feature: google-oauth-authentication (Task 1.4 → bundle-safe capability
 * boundary, incident fix for 260ec8b)
 * Requirements: 10.5
 *
 * The guard is now a MISUSE guard with a bundle-safe, explicit CAPABILITY
 * boundary (no stack-trace / caller-filename inspection, which was unsound in a
 * production bundle). It must:
 *   - throw when invoked WITHOUT the opt-in marker,
 *   - throw when invoked WITHOUT a genuine, module-minted capability,
 *   - throw when handed a FORGED (plain-object) capability,
 *   - succeed when given the opt-in marker AND a real
 *     grantServiceRoleCapability(...) value — regardless of which module calls
 *     it (authorization of WHICH modules may import/mint is enforced statically
 *     at build time, not at runtime).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("createServiceRoleClient capability guard", () => {
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

  it("throws when the capability is missing (marker alone is insufficient)", async () => {
    const { createServiceRoleClient } = await import("../service-role");
    // @ts-expect-error — capability omitted
    expect(() => createServiceRoleClient({ allowServiceRole: true })).toThrow(
      /unforgeable ServiceRoleCapability/i,
    );
  });

  it("throws when handed a FORGED (plain-object) capability", async () => {
    const { createServiceRoleClient } = await import("../service-role");
    expect(() =>
      createServiceRoleClient({
        allowServiceRole: true,
        // A plain object cannot carry the module-private brand symbol.
        capability: { reason: "I promise I'm allowed" } as never,
      }),
    ).toThrow(/unforgeable ServiceRoleCapability/i);
  });

  it("succeeds with the opt-in marker AND a genuine minted capability", async () => {
    const srMod = await import("../service-role");
    const client = srMod.createServiceRoleClient({
      allowServiceRole: true,
      capability: srMod.grantServiceRoleCapability("unit-test legitimate use"),
    });
    expect(client).toBeTruthy();
    expect(typeof client.from).toBe("function");
  });

  it("does NOT inspect the call stack — succeeds no matter which frame calls it", async () => {
    const srMod = await import("../service-role");
    // Call through an anonymous indirection to prove no caller-path check runs.
    const callThrough = () =>
      srMod.createServiceRoleClient({
        allowServiceRole: true,
        capability: srMod.grantServiceRoleCapability("indirect caller"),
      });
    expect(callThrough()).toBeTruthy();
  });

  it("still fails closed on missing Supabase env even with a valid capability", async () => {
    const srMod = await import("../service-role");
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() =>
      srMod.createServiceRoleClient({
        allowServiceRole: true,
        capability: srMod.grantServiceRoleCapability("env-missing case"),
      }),
    ).toThrow(/Missing Supabase environment variables/i);
  });

  it("no longer exports stack-trace parsing (resolveCallerModule removed)", async () => {
    const srMod = (await import("../service-role")) as Record<string, unknown>;
    expect(srMod.resolveCallerModule).toBeUndefined();
  });
});
