import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Feature: google-oauth-authentication (Task 1.6 → tightened in Task 14)
// Single source of truth for which modules may import a privileged,
// RLS-bypassing service-role PROVIDER. MUST stay in sync with
// `src/lib/supabase/service-role-allowlist.ts` (the runtime guard + CI static
// check read that file). Adding an entry here requires a reviewed edit — the
// intended cutover checkpoint. Paths are workspace-root-relative globs.
//
// TIGHTENED (Task 14): the restriction below now rejects BOTH service-role
// providers — the guarded factory `@/src/lib/supabase/service-role` AND the
// legacy bridge `@/src/lib/supabase/legacy-service-role` — everywhere except
// these allowlisted paths.
const SERVICE_ROLE_ALLOWLIST = [
  // Group (d): genuinely privileged / offline
  "src/lib/migration/uuid-migration.ts",
  "src/lib/supabase/service-role.ts",
  "src/lib/supabase/service-role-allowlist.ts",
  "src/lib/supabase/legacy-service-role.ts",
  // (d) One-off schema/DDL maintenance diagnostic (not conversation-scoped;
  // must bypass RLS). Gated by requireDebugAccess(); explicitly allowlisted.
  "app/api/debug/migrate-engine-state/route.ts",
  // (d) Genuinely-offline background sweep + global-singleton maintenance
  // (construct the guarded factory directly; work in cutover mode).
  "src/lib/intelligence-v2/incremental/update-runner.ts",
  "src/lib/db/calibration.ts",
  // Flag-aware bridges: user-scoped on the flag-TRUE branch, legacy (hard-
  // failing) bridge only on the flag-FALSE branch. Collapse at the flag flip.
  "src/lib/db/request-client.ts",
  "src/lib/db/client.ts",
  "src/lib/auth/authorization.ts",
];

// The restriction that forbids importing a service-role provider. The patterns
// cover both the `@/` path alias and relative imports resolving to EITHER
// provider module (guarded factory OR legacy bridge), while leaving the
// `service-role-allowlist` helper import legal.
const noServiceRoleImport = {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              // Guarded factory (both alias + relative forms).
              "@/src/lib/supabase/service-role",
              "**/supabase/service-role",
              // Legacy bridge (both alias + relative forms).
              "@/src/lib/supabase/legacy-service-role",
              "**/supabase/legacy-service-role",
            ],
            message:
              "Do not import a service-role client provider (service-role OR " +
              "legacy-service-role). Both bypass RLS and are restricted to " +
              "allowlisted privileged paths (see " +
              "src/lib/supabase/service-role-allowlist.ts). Use " +
              "createUserScopedClient() so RLS applies.",
          },
        ],
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Third-party / generated code that should never be linted:
    "node_modules/**",
    "ml-service/**", // Python service + bundled venv JS (e.g. torch model_dump)
  ]),
  // Forbid importing any service-role provider everywhere by default.
  {
    files: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    ...noServiceRoleImport,
  },
  // Allow it ONLY for the allowlisted privileged modules.
  {
    files: SERVICE_ROLE_ALLOWLIST,
    rules: {
      "no-restricted-imports": "off",
    },
  },
]);

export default eslintConfig;
