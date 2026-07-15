/**
 * V2 Continuation Context.
 *
 * Built when a user clicks "Continue from this node" in the V2 graph preview.
 * Passed to the chat API so the LLM receives focused node context.
 */

export interface V2ContinuationContext {
  sourceConversationId: string;
  sourceObjectId: string;
  sourceObjectTitle: string;
  sourceObjectType: string;
  sourceObjectDescription: string;
  sourceMessageIds: string[];
  sourceMessages: Array<{ role: string; content: string }>;
  parentAncestry: Array<{ title: string; description: string }>;
  relevantRelationships: Array<{ type: string; connectedTitle: string; explanation: string }>;
}

/**
 * Build a system context block from a V2 continuation context.
 * This is what the LLM actually receives.
 */
export function buildV2ContinuationPrompt(ctx: V2ContinuationContext): string {
  const parts: string[] = [];

  parts.push(`Topic: ${ctx.sourceObjectTitle} (${ctx.sourceObjectType})`);
  parts.push(`Summary: ${ctx.sourceObjectDescription}`);

  if (ctx.parentAncestry.length > 0) {
    parts.push(`\nBroader context:\n${ctx.parentAncestry.map((p) => `- ${p.title}: ${p.description}`).join("\n")}`);
  }

  if (ctx.relevantRelationships.length > 0) {
    parts.push(`\nConnected topics:\n${ctx.relevantRelationships.slice(0, 5).map((r) => `- ${r.type}: ${r.connectedTitle}`).join("\n")}`);
  }

  if (ctx.sourceMessages.length > 0) {
    parts.push(`\nConversation excerpt:`);
    for (const msg of ctx.sourceMessages.slice(0, 10)) {
      const label = msg.role === "user" ? "User" : "Assistant";
      parts.push(`${label}: ${msg.content}`);
    }
  }

  return parts.join("\n\n");
}
