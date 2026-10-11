import { createClient } from "@supabase/supabase-js";
import { isAllowlistedModule } from "./service-role-allowlist";

/**
 * Service-role Supabase client factory — PRIVILEGED, RLS-BYPASSING.
 *
 * Feature: google-oauth-authentication (Task 1.3)
 *
 * Deliberately conspicuous name. This factory is permitted ONLY from modules on
 * the service-role allowlist (`./service-role-allowlist`) and ONLY when called
 * with the explicit opt-in marker `{ allowServiceRole: true }`. It must NEVER be
 * reachable from middleware or page/route request paths (Req 10.5).
 *
 * Enforcement is layered:
 *   - This runtime hard-violation guard (last line of defense) throws unless the
 *     opt-in marker is present AND the calling module is allowlisted.
 *   - A blocking CI static check + ESLint `no-restricted-imports` prevent any
 *     non-allowlisted module from importing this factory in the first place.
 *
 * Normal account provisioning does NOT use this factory — it runs through the
 * `auth.users` trigger or the `auth.uid()`-bound `provision_self()` RPC via the
 * user-scoped client.
 *
 * Requirements: 10.3, 10.5, 12.1
 */

export type ServiceRoleOptions = {
  /**
   * Explicit, visible-at-the-call-site opt-in. Required: constructing a
   * service-role client is a privileged act and must be impossible by accident.
   */
  allowServiceRole: true;
};

/**
 * Extracts the caller's source-file path from a captured stack trace, skipping
 * frames inside this module itself. Returns null if it cannot be determined
 * (in which case the guard fails closed).
 *
 * Exported for unit testing of the stack-parsing logic (Task 1.4).
 */
export function resolveCallerModule(stack: string | undefined): string | null {
  if (!stack) return null;

  const lines = stack.split("\n").slice(1); // drop the "Error" header line
  for (const line of lines) {
    // Match "(path:line:col)" or bare "path:line:col" frames.
    const match =
      line.match(/\((.*?):\d+:\d+\)\s*$/) ?? line.match(/at\s+(.*?):\d+:\d+\s*$/);
    if (!match) continue;

    let file = match[1];
    // Strip URL scheme / node internals we don't care about.
    file = file.replace(/^file:\/\//, "");
    if (file.startsWith("node:")) continue;

    // Skip frames inside this guard module and the allowlist module.
    if (
      file.includes("supabase/service-role.ts") ||
      file.includes("supabase/service-role.js") ||
      file.includes("supabase/service-role-allowlist")
    ) {
      continue;
    }

    return file;
  }

  return null;
}

/**
 * Constructs a service-role Supabase client. Throws a hard violation unless:
 *   1. the opt-in marker `allowServiceRole: true` is supplied, and
 *   2. the calling module is on the service-role allowlist.
 *
 * @param __stackForTest Internal testing seam ONLY: lets a test supply a stack
 *   string so the allowlisted-caller path can be exercised deterministically.
 *   Never pass this from production code.
 * @throws Error — hard violation; the operation is blocked (Req 10.5).
 */
export function createServiceRoleClient(
  options: ServiceRoleOptions,
  __stackForTest?: string,
) {
  if (!options || options.allowServiceRole !== true) {
    throw new Error(
      "[service-role] Hard violation: createServiceRoleClient requires the explicit " +
        "{ allowServiceRole: true } opt-in marker. The service-role client bypasses RLS " +
        "and must never be constructed implicitly.",
    );
  }

  const caller = resolveCallerModule(__stackForTest ?? new Error().stack);

  if (!caller || !isAllowlistedModule(caller)) {
    throw new Error(
      "[service-role] Hard violation: createServiceRoleClient was invoked from a " +
        `non-allowlisted module (${caller ?? "unknown caller"}). Only the UUID_Migration ` +
        "runner and allowlisted offline/system jobs may use the service-role client. " +
        "Request paths must use createUserScopedClient() so RLS applies.",
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
