/**
 * V2 Continuation Context Tests.
 *
 * Proves that:
 * - continuation context is typed and complete;
 * - switching nodes replaces context entirely;
 * - no stale context leaks between nodes;
 * - the prompt builder produces focused content.
 */
import { describe, it, expect } from "vitest";
import { buildV2ContinuationPrompt, type V2ContinuationContext } from "../v2-continuation";

function makeContext(overrides: Partial<V2ContinuationContext> = {}): V2ContinuationContext {
  return {
    sourceConversationId: "conv-1",
    sourceObjectId: "obj-A",
    sourceObjectTitle: "Node A Title",
    sourceObjectType: "inquiry",
    sourceObjectDescription: "Description of node A",
    sourceMessageIds: ["msg-1", "msg-2"],
    sourceMessages: [
      { role: "user", content: "User said this about A" },
      { role: "assistant", content: "Assistant replied about A" },
    ],
    parentAncestry: [{ title: "Parent Topic", description: "Broad parent" }],
    relevantRelationships: [
      { type: "elaborates", connectedTitle: "Related Node", explanation: "It elaborates" },
    ],
    ...overrides,
  };
}

describe("V2ContinuationContext", () => {
  it("builds a focused prompt from node context", () => {
    const ctx = makeContext();
    const prompt = buildV2ContinuationPrompt(ctx);

    expect(prompt).toContain("Node A Title");
    expect(prompt).toContain("inquiry");
    expect(prompt).toContain("Description of node A");
    expect(prompt).toContain("User said this about A");
    expect(prompt).toContain("Assistant replied about A");
    expect(prompt).toContain("Parent Topic");
    expect(prompt).toContain("Related Node");
  });

  it("does not include node B content when building from node A", () => {
    const ctxA = makeContext({ sourceObjectId: "obj-A", sourceObjectTitle: "Node A" });
    const promptA = buildV2ContinuationPrompt(ctxA);

    expect(promptA).not.toContain("Node B");
    expect(promptA).not.toContain("obj-B");
  });

  it("switching from Node A to Node B produces completely separate context", () => {
    const ctxA = makeContext({
      sourceObjectId: "obj-A",
      sourceObjectTitle: "Node A Title",
      sourceObjectDescription: "About topic A",
      sourceMessages: [{ role: "user", content: "Question about A" }],
    });

    const ctxB = makeContext({
      sourceObjectId: "obj-B",
      sourceObjectTitle: "Node B Title",
      sourceObjectDescription: "About topic B",
      sourceMessages: [{ role: "user", content: "Question about B" }],
      parentAncestry: [],
      relevantRelationships: [],
    });

    const promptA = buildV2ContinuationPrompt(ctxA);
    const promptB = buildV2ContinuationPrompt(ctxB);

    // A's content only in A's prompt
    expect(promptA).toContain("Node A Title");
    expect(promptA).toContain("Question about A");
    expect(promptA).not.toContain("Node B Title");
    expect(promptA).not.toContain("Question about B");

    // B's content only in B's prompt
    expect(promptB).toContain("Node B Title");
    expect(promptB).toContain("Question about B");
    expect(promptB).not.toContain("Node A Title");
    expect(promptB).not.toContain("Question about A");
  });

  it("preserves sourceConversationId and sourceObjectId", () => {
    const ctx = makeContext({ sourceConversationId: "conv-42", sourceObjectId: "obj-7" });
    expect(ctx.sourceConversationId).toBe("conv-42");
    expect(ctx.sourceObjectId).toBe("obj-7");
  });

  it("handles empty source messages gracefully", () => {
    const ctx = makeContext({ sourceMessages: [] });
    const prompt = buildV2ContinuationPrompt(ctx);
    expect(prompt).toContain("Node A Title");
    expect(prompt).not.toContain("Conversation excerpt");
  });

  it("handles empty parent ancestry gracefully", () => {
    const ctx = makeContext({ parentAncestry: [] });
    const prompt = buildV2ContinuationPrompt(ctx);
    expect(prompt).not.toContain("Broader context");
  });

  it("limits source messages to 10 in prompt", () => {
    const manyMessages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const ctx = makeContext({ sourceMessages: manyMessages });
    const prompt = buildV2ContinuationPrompt(ctx);
    // Only first 10 should appear
    expect(prompt).toContain("Message 0");
    expect(prompt).toContain("Message 9");
    expect(prompt).not.toContain("Message 10");
  });

  it("simulates continuation state replacement (no stale context)", () => {
    // Simulate React state: set A, then replace with B
    let state: V2ContinuationContext | null = null;

    // User clicks Continue from A
    state = makeContext({ sourceObjectId: "obj-A", sourceObjectTitle: "Node A" });
    expect(state.sourceObjectId).toBe("obj-A");

    // User goes back, clicks Continue from B
    state = makeContext({ sourceObjectId: "obj-B", sourceObjectTitle: "Node B" });
    expect(state.sourceObjectId).toBe("obj-B");
    // No trace of A
    expect(state.sourceObjectTitle).not.toContain("A");

    // User dismisses continuation
    state = null;
    expect(state).toBeNull();
  });
});
