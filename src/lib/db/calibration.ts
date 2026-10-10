/**
 * Persistence for global similarity-threshold calibration.
 *
 * Server-only (uses the service-role Supabase client). Holds a single global
 * row (id = 'global'). Reads are cheap and used by the threshold accessor;
 * writes only happen on an explicit calibration trigger.
 */

import { createServiceRoleClient } from "@/src/lib/supabase/service-role";
import { resolveDbClient, type DbClient } from "@/src/lib/db/client";
import type { CalibrationResult } from "@/src/lib/calibration/threshold-calibration";

const GLOBAL_ID = "global";

/**
 * Global-maintenance service-role client for the calibration singleton.
 *
 * ── Why service-role here is legitimate (group (d)) ─────────────────────────
 * Calibration operates on a SINGLE GLOBAL row (`id = 'global'`) and a global
 * read of `nodes.id/embedding` — it is never scoped to a caller's workspace or
 * conversation, so it cannot leak one workspace's rows to another. The write
 * path (`loadAllNodeEmbeddings` + `saveCalibration`) is a privileged global
 * maintenance operation reached ONLY from the `requireDebugAccess()`-gated
 * `/api/debug/calibrate-thresholds` route.
 *
 * It constructs the GUARDED factory directly (with the conspicuous opt-in
 * marker), NOT the legacy bridge — so it keeps working in cutover mode as a
 * genuine background/maintenance path rather than hard-failing. The
 * request-reachable READ path (`getStoredCalibration`, reached lazily via
 * `getEdgeThresholds`) instead takes the INJECTED user-scoped client so RLS
 * applies on the hot path; the global calibration row is world-readable to
 * authenticated users via its RLS policy.
 */
function globalMaintenanceClient() {
  return createServiceRoleClient({ allowServiceRole: true });
}

export type StoredCalibration = {
  stronglyRelated: number;
  possiblyRelated: number;
  isApplied: boolean;
  reason: string | null;
  computedAt: string;
};

/**
 * Load all node embeddings across the whole DB (global calibration input).
 * Returns only id + embedding — no user content.
 */
export async function loadAllNodeEmbeddings(): Promise<
  { id: string; embedding: number[] | null }[]
> {
  // Privileged GLOBAL read (all nodes, id+embedding only) — reached only from
  // the requireDebugAccess()-gated calibrate-thresholds route. Guarded factory.
  const db = globalMaintenanceClient();
  const { data, error } = await db.from("nodes").select("id, embedding");
  if (error) throw new Error(`Failed to load node embeddings: ${error.message}`);

  return (data ?? []).map((row: { id: string; embedding: unknown }) => ({
    id: row.id,
    embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : null,
  }));
}

/**
 * Read the current stored calibration, or null if none has ever been computed.
 * When null, callers fall back to the compile-time constants.
 */
export async function getStoredCalibration(
  client?: DbClient,
): Promise<StoredCalibration | null> {
  // Takes the INJECTED user-scoped client when a caller threads one (so RLS
  // applies and the global calibration row is read as the authenticated user).
  // When omitted, falls back via resolveDbClient to the legacy service-role
  // client (behavior-neutral pre-cutover). This read is NOT on any ordinary
  // request hot path today (the async getEdgeThresholds caller has no route
  // handler), so the cutover hard-fail guard is never tripped by a request;
  // the reachability assertion test documents this.
  const db = resolveDbClient(client);
  const { data, error } = await db
    .from("similarity_calibration")
    .select("strongly_related, possibly_related, is_applied, reason, computed_at")
    .eq("id", GLOBAL_ID)
    .maybeSingle();

  if (error) throw new Error(`Failed to read calibration: ${error.message}`);
  if (!data) return null;

  return {
    stronglyRelated: data.strongly_related as number,
    possiblyRelated: data.possibly_related as number,
    isApplied: data.is_applied as boolean,
    reason: (data.reason as string | null) ?? null,
    computedAt: data.computed_at as string,
  };
}

/**
 * Persist a calibration result (upsert the singleton global row).
 * Stores the values in effect regardless of applied/rejected — when rejected,
 * these mirror the fallback constants and is_applied is false.
 */
export async function saveCalibration(result: CalibrationResult): Promise<void> {
  // Privileged GLOBAL singleton write — reached only from the
  // requireDebugAccess()-gated calibrate-thresholds route. Guarded factory.
  const db = globalMaintenanceClient();
  const { error } = await db.from("similarity_calibration").upsert(
    {
      id: GLOBAL_ID,
      strongly_related: result.stronglyRelated,
      possibly_related: result.possiblyRelated,
      is_applied: result.applied,
      sample_pair_count: result.samplePairCount,
      node_count: result.nodeCount,
      bimodality_coefficient: result.bimodalityCoefficient,
      valley_score: result.valleyScore,
      reason: result.reason,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  if (error) throw new Error(`Failed to save calibration: ${error.message}`);
}
