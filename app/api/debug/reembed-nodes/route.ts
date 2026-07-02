import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { loadLatestConversation } from "@/src/lib/db/conversations";
import { generateEmbedding, buildNodeEmbeddingText } from "@/src/lib/embeddings";

/**
 * POST /api/debug/reembed-nodes
 *
 * Dev-only: recomputes embeddings for all nodes using the canonical
 * buildNodeEmbeddingText function. Fixes inconsistencies from old
 * code paths that embedded different text formats.
 *
 * Does NOT change titles, summaries, evidence, or message links.
 * Only regenerates the embedding column.
 */
export async function POST() {
  try {
    const data = await loadLatestConversation();
    if (!data) {
      return NextResponse.json({ error: "No conversation found." }, { status: 404 });
    }

    const db = createServerSupabaseClient();
    const conversationId = data.conversation.id;

    // Load all nodes with their text fields
    const { data: nodeRows, error } = await db
      .from("nodes")
      .select("id, title, summary, evidence_summary")
      .eq("conversation_id", conversationId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const nodes = nodeRows ?? [];
    let updated = 0;
    let failed = 0;
    const results: Array<{ title: string; status: string; textPreview: string }> = [];

    for (const node of nodes) {
      const title = node.title ?? "";
      const summary = node.summary ?? "";
      const evidence = typeof node.evidence_summary === "string" ? node.evidence_summary : null;

      const canonicalText = buildNodeEmbeddingText(title, summary, evidence);

      try {
        const embedding = await generateEmbedding(canonicalText.slice(0, 7000));

        await db
          .from("nodes")
          .update({ embedding })
          .eq("id", node.id);

        updated++;
        results.push({
          title,
          status: "ok",
          textPreview: canonicalText.slice(0, 100),
        });
      } catch (err) {
        failed++;
        results.push({
          title,
          status: `failed: ${err instanceof Error ? err.message : "unknown"}`,
          textPreview: canonicalText.slice(0, 100),
        });
      }
    }

    return NextResponse.json({
      totalNodes: nodes.length,
      updated,
      failed,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
