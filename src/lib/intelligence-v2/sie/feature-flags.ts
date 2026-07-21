/**
 * SIE Feature Flags — TypeScript-side disabled-by-default flags.
 *
 * All flags default to false. Each flag is controlled by an environment
 * variable and must be explicitly enabled for the corresponding
 * functionality to become available.
 *
 * These mirror the Python-side flags in ml-service/app/sie/config.py.
 *
 * CRITICAL: SIE_AUTHORITY_ENABLED must NEVER be activated for production
 * conversations within this implementation plan. The default authoritative
 * engine remains V2.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function envBool(key: string): boolean {
  const val = (process.env[key] ?? "").trim().toLowerCase();
  return val === "1" || val === "true" || val === "yes";
}

// ─── Feature Flags ──────────────────────────────────────────────────────────

/**
 * Whether shadow-mode execution is active.
 *
 * When enabled, SIE runs alongside V2 without affecting production state.
 * SIE output is isolated — it does not alter the production snapshot,
 * production cursor, or production mutation history.
 *
 * Reads from `NEXT_PUBLIC_SIE_SHADOW_ENABLED` (client-visible) or
 * `SIE_SHADOW_ENABLED` (server-only) environment variables.
 */
export const SIE_SHADOW_ENABLED: boolean =
  envBool("NEXT_PUBLIC_SIE_SHADOW_ENABLED") || envBool("SIE_SHADOW_ENABLED");

/**
 * Whether SIE is the authoritative semantic engine for new conversations.
 *
 * When enabled, the SIE pipeline becomes the authoritative writer for
 * semantic identity. The legacy Thread → Object identity-formation path
 * must not write authoritative objects for SIE-authoritative conversations.
 *
 * CRITICAL: This flag is disabled by default and must NOT be activated
 * for production conversations in this plan. Cutover operations are
 * guarded by graph-version checks and audit trails.
 *
 * Reads from `SIE_AUTHORITY_ENABLED` (server-only — never NEXT_PUBLIC_).
 */
export const SIE_AUTHORITY_ENABLED: boolean = envBool("SIE_AUTHORITY_ENABLED");
