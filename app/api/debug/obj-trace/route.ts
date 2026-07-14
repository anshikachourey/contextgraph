import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { buildUtterances } from "@/src/lib/intelligence-v2/utterances";
import { extractPropositions } from "@/src/lib/intelligence-v2/propositions";
import { formThreads } from "@/src/lib/intelligence-v2/threads";
import { formObjects } from "@/src/lib/intelligence-v2/objects";

export const maxDuration = 120;

/**
 * GET /api/debug/obj-trace?id=<conversationId>
 * Focused: only runs through object formation and returns full diagnostics.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("id");
  if (!conversationId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  try {
    const db = createServerSupabaseClient();
    const { data: msgData, error: dbError } = await db
      .from("messages")
      .select("id, role, content, conversation_id, created_at, parent_node_id, branch_root_message_id")
      .eq("conversation_id", conversationId)
      .is("parent_node_id", null)
      .order("created_at", { ascending: true });

    if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });

    const messages = (msgData ?? []) as Array<{
      id: string; role: string; content: string; conversation_id: string;
      created_at: string; parent_node_id: string | null; branch_root_message_id: string | null;
    }>;

    const utterances = buildUtterances(messages, conversationId);
    const { propositions } = await extractPropositions(utterances);
    const { threads } = await formThreads(utterances, propositions);
    const { objects, diagnostics: objDiag } = await formObjects(propositions, threads);

    return NextResponse.json({
      propositionCount: propositions.length,
      threadCount: threads.length,
      threadSubjects: threads.map(t => ({ id: t.threadId, subject: t.subject, propCount: t.propositionIds.length })),
      objectCount: objects.length,
      objDiag,
      objects: objects.map(o => ({ id: o.objectId, type: o.objectType, title: o.title, propIds: o.propositionIds, threadIds: o.threadIds })),
      sampleRealPropIds: propositions.slice(0, 10).map(p => p.propositionId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown";
    return NextResponse.json({ error: message, stack: err instanceof Error ? err.stack : undefined }, { status: 500 });
  }
}
