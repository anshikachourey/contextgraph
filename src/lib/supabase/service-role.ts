import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client factory — PRIVILEGED, RLS-BYPASSING.
 *
 * Feature: google-oauth-authentication (Task 1.3 → bundle-safe capability
 * boundary, incident fix for 260ec8b)
 *
 * Deliberately conspicuous name. The service-role client bypasses RLS and must
 * NEVER be reachable from middleware or page/route request paths (Req 10.5).
 *
 * ── Why this no longer inspects the call stack ──────────────────────────────
 *
 * The previous implementation authorized callers by parsing `new Error().stack`
 * and matching the caller's SOURCE FILE PATH against the allowlist. That is
 * fundamentally unsound in a production build: Next.js/Turbopack bundles every
 * module into opaque chunks (e.g. `.next/server/chunks/[root-of-the-server]__…_.js`),
 * so the "caller module" is a chunk path that is never on the allowlist. On
 * deployment 260ec8b this made the LEGITIMATE flag-false legacy-compatibility
 * call throw a hard violation, 500-ing `GET /api/conversations` before any DB
 * query ran. Runtime authorization based on stack traces / caller filenames is
 * removed entirely.
 *
 * ── The replacement: an explicit, bundle-safe capability boundary ───────────
 *
 * Two independent layers, with a clear division of responsibility:
 *
 *   1. CAPABILITY (runtime) — prevents ACCIDENTAL MISUSE. Constructing a
 *      service-role client requires an unforgeable {@link ServiceRoleCapability}
 *      value, obtainable only via {@link grantServiceRoleCapability}(reason).
 *      The capability is a module-private branded object: it cannot be
 *      fabricated from a plain `{}` or JSON, and the brand symbol is
 *      module-scoped (not on the global registry). Because it is a VALUE
 *      threaded explicitly through the call site (not ambient caller context),
 *      it survives bundling unchanged — the boundary behaves identically in
 *      `tsx` dev, `vitest`, and the bundled `.next/server/chunks` runtime. This
 *      is what the old stack/filename check failed to be: it makes a privileged
 *      construction impossible BY ACCIDENT, with the reason visible at the call
 *      site. It does NOT, and is not meant to, decide WHICH modules are allowed
 *      to do this.
 *
 *   2. CI IMPORT / REACHABILITY RULES (build time) — ENFORCE MODULE
 *      AUTHORIZATION. Deciding which modules may import this factory (and thus
 *      acquire the capability) is enforced statically, where source paths are
 *      meaningful, by the retained DEFENSE-IN-DEPTH layer:
 *        - the blocking CI static check (`scripts/check-service-role-usage.mjs`)
 *          — fails the build if any non-allowlisted module imports EITHER
 *          service-role export (`createServiceRoleClient` OR
 *          `grantServiceRoleCapability`) from this module or the legacy bridge,
 *        - the import-reachability check (`scripts/check-service-role-reachability.mjs`),
 *        - the ESLint `no-restricted-imports` rule,
 *      all keyed off the `service-role-allowlist.ts` module list.
 *
 * In short: the capability stops accidental misuse at runtime; the CI
 * import/reachability rules decide and enforce who is authorized. Neither layer
 * depends on stack traces or caller filenames, so neither is defeated by
 * production bundling.
 *
 * Requirements: 10.3, 10.5, 12.1
 */

/** Module-private brand. Not on the global symbol registry, so a capability
 *  object cannot be forged from outside this module. */
const CAPABILITY_BRAND: unique symbol = Symbol("service-role-capability");

/**
 * An unforgeable grant permitting construction of the service-role client.
 * Obtain one via {@link grantServiceRoleCapability}; it cannot be constructed
 * as a plain object literal because the brand symbol is module-private.
 */
export type ServiceRoleCapability = {
  readonly [CAPABILITY_BRAND]: true;
  /** Human-readable justification, surfaced in errors/telemetry. */
  readonly reason: string;
};

export type ServiceRoleOptions = {
  /**
   * Explicit, visible-at-the-call-site opt-in. Required: constructing a
   * service-role client is a privileged act and must be impossible by accident.
   */
  allowServiceRole: true;
  /** The capability grant (see {@link grantServiceRoleCapability}). */
  capability: ServiceRoleCapability;
};

/**
 * Mint a service-role capability. Callers must pass a short, explicit reason
 * documenting why RLS bypass is legitimate for this path (e.g. "legacy
 * pre-cutover compatibility bridge", "uuid-migration runner", "offline recovery
 * sweep"). Only modules that import this factory module can call this; the
 * build-time static checks ensure those modules are exactly the allowlisted
 * ones.
 */
export function grantServiceRoleCapability(reason: string): ServiceRoleCapability {
  return { [CAPABILITY_BRAND]: true, reason } as ServiceRoleCapability;
}

/** Type guard: a genuine, module-minted capability (not a forged literal). */
function isServiceRoleCapability(value: unknown): value is ServiceRoleCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CAPABILITY_BRAND] === true
  );
}

/**
 * Constructs a service-role Supabase client. Throws a hard MISUSE violation
 * unless:
 *   1. the opt-in marker `allowServiceRole: true` is supplied, and
 *   2. a genuine, module-minted {@link ServiceRoleCapability} is supplied.
 *
 * There is NO stack/filename inspection — authorization of WHICH modules may
 * acquire the capability is enforced statically at build time (see the module
 * doc), which is the only sound approach in a bundled runtime.
 *
 * @throws Error — hard violation; the operation is blocked (Req 10.5).
 */
export function createServiceRoleClient(options: ServiceRoleOptions) {
  if (!options || options.allowServiceRole !== true) {
    throw new Error(
      "[service-role] Hard violation: createServiceRoleClient requires the explicit " +
        "{ allowServiceRole: true } opt-in marker. The service-role client bypasses RLS " +
        "and must never be constructed implicitly.",
    );
  }

  if (!isServiceRoleCapability(options.capability)) {
    throw new Error(
      "[service-role] Hard violation: createServiceRoleClient requires an unforgeable " +
        "ServiceRoleCapability minted via grantServiceRoleCapability(reason). A plain " +
        "object cannot be used. Only allowlisted modules (enforced by the blocking CI " +
        "static + reachability checks and the ESLint rule) may import this factory and " +
        "mint the capability; request paths must use createUserScopedClient() so RLS applies.",
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only, never NEXT_PUBLIC_

  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }

  return createClient(url, key, { auth: { persistSession: false } });
}
