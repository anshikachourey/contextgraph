/**
 * Persistence for global similarity-threshold calibration.
 *
 * Server-only (uses the service-role Supabase client). Holds a single global
 * row (id = 'global'). Reads are cheap and used by the threshold accessor;
 * writes only happen on an explicit calibration trigger.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import type { CalibrationResult } from "@/src/lib/calibration/threshold-calibration";

const GLOBAL_ID = "global";

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
  const db = createServerSupabaseClient();
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
export async function getStoredCalibration(): Promise<StoredCalibration | null> {
  const db = createServerSupabaseClient();
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
  const db = createServerSupabaseClient();
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
