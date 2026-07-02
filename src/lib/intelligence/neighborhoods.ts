/**
 * Neighborhood assignment for new nodes.
 *
 * Neighborhoods are first-class objects that own groups of semantically
 * related nodes. Assignment is permanent (nodes never change neighborhood).
 * Color hue is derived deterministically from the neighborhood.
 */

import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { cosineSimilarity } from "@/src/lib/cosineSimilarity";

/** Minimum similarity to assign a node to an existing neighborhood. */
const NEIGHBORHOOD_ASSIGN_THRESHOLD = 0.55;

/** Spacing between neighborhood canvas positions. */
const NEIGHBORHOOD_SPACING = 500;

export interface NeighborhoodRecord {
  id: string;
  conversationId: string;
  label: string;
  centroidEmbedding: number[] | null;
  canvasPositionX: number;
  canvasPositionY: number;
  hue: number;
}

/**
 * Assign a newly materialized node to a neighborhood.
 * Returns the neighborhood ID and hue.
 * Creates a new neighborhood if no existing one is similar enough.
 */
export async function assignNodeToNeighborhood(
  conversationId: string,
  nodeId: string,
  nodeEmbedding: number[],
  nodeTitle: string,
): Promise<{ neighborhoodId: string; hue: number }> {
  const db = createServerSupabaseClient();

  // Load existing neighborhoods
  const { data: nbData } = await db
    .from("neighborhoods")
    .select("*")
    .eq("conversation_id", conversationId);

  const neighborhoods: NeighborhoodRecord[] = (nbData ?? []).map((r: any) => ({
    id: r.id,
    conversationId: r.conversation_id,
    label: r.label,
    centroidEmbedding: Array.isArray(r.centroid_embedding) ? r.centroid_embedding : null,
    canvasPositionX: r.canvas_position_x ?? 0,
    canvasPositionY: r.canvas_position_y ?? 0,
    hue: r.hue ?? 0,
  }));

  // Find best matching neighborhood
  let bestScore = 0;
  let bestNeighborhood: NeighborhoodRecord | null = null;

  for (const nb of neighborhoods) {
    if (!nb.centroidEmbedding || nb.centroidEmbedding.length === 0) continue;
    if (nodeEmbedding.length === 0) continue;
    const score = cosineSimilarity(nodeEmbedding, nb.centroidEmbedding);
    if (score > bestScore) {
      bestScore = score;
      bestNeighborhood = nb;
    }
  }

  let neighborhoodId: string;
  let hue: number;

  if (bestNeighborhood && bestScore >= NEIGHBORHOOD_ASSIGN_THRESHOLD) {
    // Assign to existing neighborhood
    neighborhoodId = bestNeighborhood.id;
    hue = bestNeighborhood.hue;

    // Update centroid (running average: new = old*0.8 + new*0.2)
    if (bestNeighborhood.centroidEmbedding && nodeEmbedding.length > 0) {
      const dim = nodeEmbedding.length;
      const updated = new Array(dim);
      for (let i = 0; i < dim; i++) {
        updated[i] = bestNeighborhood.centroidEmbedding[i] * 0.8 + nodeEmbedding[i] * 0.2;
      }
      await db
        .from("neighborhoods")
        .update({ centroid_embedding: updated })
        .eq("id", neighborhoodId);
    }

    console.log(
      `[neighborhoods] Node "${nodeTitle}" → existing neighborhood (hue=${hue}, sim=${bestScore.toFixed(3)})`,
    );
  } else {
    // Create new neighborhood
    hue = deterministicHue(crypto.randomUUID());
    const position = computeNewNeighborhoodPosition(neighborhoods);

    const { data: inserted } = await db
      .from("neighborhoods")
      .insert({
        conversation_id: conversationId,
        label: nodeTitle, // initial label from first member
        centroid_embedding: nodeEmbedding,
        canvas_position_x: position.x,
        canvas_position_y: position.y,
        hue,
      })
      .select("id")
      .single();

    neighborhoodId = inserted?.id ?? crypto.randomUUID();
    console.log(
      `[neighborhoods] Node "${nodeTitle}" → NEW neighborhood (hue=${hue})`,
    );
  }

  // Assign node to neighborhood
  await db
    .from("nodes")
    .update({
      neighborhood_id: neighborhoodId,
      hierarchy_depth: 0,
      hierarchy_role: "topic",
    })
    .eq("id", nodeId);

  return { neighborhoodId, hue };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function deterministicHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  // Map to a set of visually distinct hues (avoid muddy yellows)
  const hues = [270, 200, 340, 150, 30, 180, 300, 60, 220, 120, 0, 45];
  return hues[Math.abs(hash) % hues.length];
}

function computeNewNeighborhoodPosition(
  existing: NeighborhoodRecord[],
): { x: number; y: number } {
  if (existing.length === 0) return { x: 0, y: 0 };

  // Place in a spiral pattern around existing neighborhoods
  const count = existing.length;
  const angle = count * 1.2; // golden-angle-ish spacing
  const radius = NEIGHBORHOOD_SPACING * (1 + Math.floor(count / 6));
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}
