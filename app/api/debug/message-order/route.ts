import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { repairMessageOrder, isValidAlternating } from "@/src/lib/repairMessageOrder";
import type { ChatMessage } from "@/src/types/message";

/**
 * GET /api/debug/message-order?id=<conversationId>
 *
 * Inspects message ordering for a conversation:
 * - Raw DB order
 * - Whether it's validly alternating
 * - Canonical repaired order
 * - Anomalies detected
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("id");

  if (!conversationId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("messages")
    .select("id, role, content, created_at, parent_node_id")
    .eq("conversation_id", conversationId)
    .is("parent_node_id", null)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rawMessages: ChatMessage[] = (data ?? []).map((m: any) => ({
    id: m.id,
    role: m.role,
    content: m.content,
  }));

  const rawSequence = rawMessages.map((m, i) => ({
    index: i,
    role: m.role,
    snippet: m.content.slice(0, 60),
    id: m.id,
  }));

  const isValid = isValidAlternating(rawMessages);
  const repaired = repairMessageOrder(rawMessages);

  const canonicalSequence = repaired.canonical.map((m, i) => ({
    index: i,
    role: m.role,
    snippet: m.content.slice(0, 60),
    id: m.id,
  }));

  return NextResponse.json({
    conversationId,
    totalMessages: rawMessages.length,
    isValidAlternating: isValid,
    rawSequence,
    anomalies: repaired.anomalies,
    wasRepaired: repaired.wasRepaired,
    canonicalSequence: repaired.wasRepaired ? canonicalSequence : "same as raw (no repair needed)",
  });
}
