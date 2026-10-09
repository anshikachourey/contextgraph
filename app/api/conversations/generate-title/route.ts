import { NextRequest, NextResponse } from "next/server";
import { complete } from "@/src/lib/ai";
import { SUMMARY_MODEL } from "@/src/lib/ai/models";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";
import { resolveRequestDbClient, useRlsScopedAccess } from "@/src/lib/db/request-client";

type GenerateTitleRequest = {
  conversationId: string;
};

type SuccessResponse = { title: string };
type ErrorResponse = { error: string };

const DEFAULT_TITLE = "New conversation";

/**
 * POST /api/conversations/generate-title
 *
 * Generates a concise title for a conversation based on the earliest persisted
 * user message loaded from the database. Does NOT accept client-supplied message
 * text — the title source is always canonical server-side data.
 *
 * Only generates if the conversation still has the default title.
 * The title update is scoped by both conversation ID and authenticated workspace.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { conversationId } = (body ?? {}) as Partial<GenerateTitleRequest>;

  if (!conversationId || typeof conversationId !== "string") {
    return NextResponse.json(
      { error: "conversationId is required." },
      { status: 400 },
    );
  }

  // Verify workspace ownership. On the flag-true branch this relies on RLS
  // (non-member → zero rows → 404); on flag-false it keeps the legacy manual
  // workspace_id check inside requireConversationAccess.
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  // Flag-aware client: service-role (behavior-neutral) while disabled, user-scoped
  // (RLS applies) once enabled. `rlsScoped` toggles the manual workspace_id filters.
  const db = await resolveRequestDbClient();
  const rlsScoped = useRlsScopedAccess();

  // Check if the conversation still has the default title. While the cutover is
  // disabled we keep the manual workspace_id filter (identical behavior); once
  // enabled RLS already scopes the row to a workspace the caller is a member of.
  let convQuery = db
    .from("conversations")
    .select("title, workspace_id")
    .eq("id", conversationId);
  if (!rlsScoped) {
    convQuery = convQuery.eq("workspace_id", session.workspace);
  }
  const { data: conv, error: convErr } = await convQuery.single();

  if (convErr || !conv) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Only generate if the title is still the default
  if (conv.title !== DEFAULT_TITLE) {
    return NextResponse.json({ title: conv.title });
  }

  // Load the earliest persisted user message from the database (canonical source)
  const { data: firstMsg, error: msgErr } = await db
    .from("messages")
    .select("content")
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .is("parent_node_id", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (msgErr || !firstMsg || !firstMsg.content) {
    return NextResponse.json(
      { error: "No user message found." },
      { status: 400 },
    );
  }

  const messageContent = firstMsg.content as string;

  // Generate title via AI
  let title: string;
  try {
    title = await generateTitle(messageContent);
  } catch (err) {
    console.error("[generate-title] AI generation failed, using fallback:", err);
    title = deriveFallbackTitle(messageContent);
  }

  // Persist the generated title. Flag-false keeps the manual workspace_id scope
  // (behavior-neutral); flag-true relies on RLS to constrain the update.
  let updateQuery = db
    .from("conversations")
    .update({ title })
    .eq("id", conversationId);
  if (!rlsScoped) {
    updateQuery = updateQuery.eq("workspace_id", session.workspace);
  }
  const { error: updateErr } = await updateQuery;

  if (updateErr) {
    console.error("[generate-title] Failed to update title:", updateErr);
    return NextResponse.json(
      { error: "Failed to save title." },
      { status: 500 },
    );
  }

  return NextResponse.json({ title });
}

/**
 * Use the existing AI provider to generate a concise 3–7 word title.
 */
async function generateTitle(message: string): Promise<string> {
  // Truncate very long messages to control token usage
  const truncated = message.length > 500 ? message.slice(0, 500) + "…" : message;

  const result = await complete({
    model: SUMMARY_MODEL,
    messages: [
      {
        role: "system",
        content: `Generate a concise conversation title from the user's first message.

Rules:
- 3 to 7 words
- No quotation marks
- No trailing punctuation
- No generic labels like "Conversation" or "Chat"
- Capture the specific topic or intent
- Use sentence case (capitalize first word only)

Respond with ONLY the title text, nothing else.`,
      },
      {
        role: "user",
        content: truncated,
      },
    ],
    temperature: 0.3,
    maxTokens: 30,
  });

  const raw = result.content?.trim() ?? "";
  if (!raw) throw new Error("Empty AI response");

  // Clean up: remove quotes, trailing punctuation
  let cleaned = raw
    .replace(/^["'""]|["'""]$/g, "")
    .replace(/[.!?;:]+$/, "")
    .trim();

  // Validate length — if too long, truncate to ~7 words
  const words = cleaned.split(/\s+/);
  if (words.length > 8) {
    cleaned = words.slice(0, 7).join(" ");
  }

  if (!cleaned) throw new Error("Cleaned title is empty");

  return cleaned;
}

/**
 * Deterministic fallback: derive a title from the first message content.
 * Takes the first few words, trims to a reasonable length.
 */
export function deriveFallbackTitle(message: string): string {
  // Strip markdown, extra whitespace
  const plain = message
    .replace(/[#*_~`>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  const words = plain.split(" ").filter(Boolean);

  if (words.length <= 5) {
    return words.join(" ");
  }

  // Take first 5 words
  return words.slice(0, 5).join(" ") + "…";
}
