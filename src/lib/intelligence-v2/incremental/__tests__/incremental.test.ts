/**
 * Incremental V2 Engine — Invariant Tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { V2Snapshot } from "../schemas";
import type { ConversationalObject, Proposition, Thread, Relationship } from "../../schemas";

vi.mock("@/src/lib/ai", () => ({
  complete: vi.fn(),
  embed: vi.fn(),
}));
vi.mock("@/src/lib/ai/models", () => ({ NODE_MODEL: "test" }));

import { complete, embed } from "@/src/lib/ai";
import { runIncrementalV2Update } from "../index";

const mockedComplete = vi.mocked(complete);
const mockedEmbed = vi.mocked(embed);

beforeEach(() => {
  mockedComplete.mockReset();
  mockedEmbed.mockReset();
  mockedEmbed.mockResolvedValue([1, 0, 0]);
});

function makeSnapshot(objects: ConversationalObject[] = [], relationships: Relationship[] = []): V2Snapshot {
  return {
    conversationId: "conv-1",
    objects,
    relationships,
    propositions: [
      { propositionId: "prop-0", propositionType: "claim", normalizedContent: "Initial claim", sourceUtteranceIds: ["utt-0"], authoredBy: "user", provenance: "direct", confirmedByUser: false, confidence: 0.9, status: "active", supersedesPropositionId: null },
    ],
    threads: [
      { threadId: "thread-0", utteranceIds: ["utt-0"], propositionIds: ["prop-0"], subject: "Test thread", branchId: null, originThreadId: null, divergenceUtteranceId: null, status: "active" },
    ],
    hierarchy: [],
    trees: [],
  };
}

function makeObj(id: string, title: string): ConversationalObject {
  return {
    objectId: id, objectType: "inquiry", title, description: "D",
    propositionIds: ["prop-0"], threadIds: ["thread-0"],
    supportingUtteranceIds: ["utt-0"], contextualAssistantUtteranceIds: [],
    maturity: "developing", status: "active", provenanceSummary: "",
  };
}

const newMessages = [{
  id: "msg-new-1", role: "user", content: "Tell me more about this",
  conversation_id: "conv-1", created_at: "2024-01-01T00:05:00Z",
  parent_node_id: null, branch_root_message_id: null,
}];

describe("Incremental V2 Engine", () => {
  it("Fixture A: same inquiry deepens → extend_object", async () => {
    const snapshot = makeSnapshot([makeObj("obj-0", "User's initial question")]);

    // Proposition extraction
    mockedComplete.mockResolvedValueOnce({
      content: '[{"propositionType":"claim","normalizedContent":"More detail about the question","sourceUtteranceIds":["msg-new-"],"authoredBy":"user","provenance":"direct","confidence":0.9}]',
    });
    // Object decision
    mockedComplete.mockResolvedValueOnce({
      content: '{"action":"extend_object","targetObjectId":"obj-0","newObjectDraft":null,"supportingNewPropositionIds":["prop-1"],"relevantExistingPropositionIds":["prop-0"],"lifecycleTransition":null,"confidence":0.85,"explanation":"Same inquiry deepening"}',
    });

    const result = await runIncrementalV2Update({ conversationId: "conv-1", snapshot, newMessages });

    expect(result.decisions[0].action).toBe("extend_object");
    expect(result.diagnostics.objectsUpdated).toBe(1);
    expect(result.diagnostics.objectsCreated).toBe(0);
  });

  it("Fixture F: new unrelated topic → create_object", async () => {
    const snapshot = makeSnapshot([makeObj("obj-0", "Previous topic")]);

    mockedComplete.mockResolvedValueOnce({
      content: '[{"propositionType":"request","normalizedContent":"What is the weather today?","sourceUtteranceIds":["msg-new-"],"authoredBy":"user","provenance":"direct","confidence":0.9}]',
    });
    mockedComplete.mockResolvedValueOnce({
      content: '{"action":"create_object","targetObjectId":null,"newObjectDraft":{"objectType":"inquiry","title":"Weather question","description":"User asks about weather"},"supportingNewPropositionIds":["prop-1"],"relevantExistingPropositionIds":[],"lifecycleTransition":null,"confidence":0.9,"explanation":"Unrelated subject"}',
    });
    // Placement decision
    mockedComplete.mockResolvedValueOnce({
      content: '{"placement":"independent_root","targetObjectId":null,"relationshipType":null,"supportingPropositionIds":[],"confidence":0.9,"explanation":"No connection to existing objects"}',
    });

    const result = await runIncrementalV2Update({ conversationId: "conv-1", snapshot, newMessages });

    expect(result.decisions[0].action).toBe("create_object");
    expect(result.diagnostics.objectsCreated).toBe(1);
  });

  it("Fixture J: idempotency — second run produces zero graph-changing mutations", async () => {
    const snapshot = makeSnapshot([makeObj("obj-0", "Question")]);

    // First run
    mockedComplete.mockResolvedValueOnce({
      content: '[{"propositionType":"claim","normalizedContent":"Deepening","sourceUtteranceIds":["msg-new-"],"authoredBy":"user","provenance":"direct","confidence":0.9}]',
    });
    mockedComplete.mockResolvedValueOnce({
      content: '{"action":"extend_object","targetObjectId":"obj-0","newObjectDraft":null,"supportingNewPropositionIds":["prop-1"],"relevantExistingPropositionIds":["prop-0"],"lifecycleTransition":null,"confidence":0.85,"explanation":"Continues"}',
    });

    const result1 = await runIncrementalV2Update({ conversationId: "conv-1", snapshot, newMessages });
    expect(result1.diagnostics.objectsUpdated).toBe(1);

    // Second run with the UPDATED snapshot (which already has the propositions)
    const updatedSnapshot = result1.updatedGraph;
    mockedComplete.mockResolvedValueOnce({ content: '[]' }); // No new propositions
    mockedComplete.mockResolvedValueOnce({
      content: '{"action":"discard","targetObjectId":null,"newObjectDraft":null,"supportingNewPropositionIds":[],"relevantExistingPropositionIds":[],"lifecycleTransition":null,"confidence":0.9,"explanation":"No new content"}',
    });

    const result2 = await runIncrementalV2Update({ conversationId: "conv-1", snapshot: updatedSnapshot, newMessages });
    expect(result2.diagnostics.objectsUpdated).toBe(0);
    expect(result2.diagnostics.objectsCreated).toBe(0);
  });

  it("does not call the full V2 pipeline", async () => {
    const snapshot = makeSnapshot([makeObj("obj-0", "Test")]);

    mockedComplete.mockResolvedValueOnce({
      content: '[{"propositionType":"claim","normalizedContent":"Something","sourceUtteranceIds":["msg-new-"],"authoredBy":"user","provenance":"direct","confidence":0.9}]',
    });
    mockedComplete.mockResolvedValueOnce({
      content: '{"action":"extend_object","targetObjectId":"obj-0","newObjectDraft":null,"supportingNewPropositionIds":["prop-1"],"relevantExistingPropositionIds":[],"lifecycleTransition":null,"confidence":0.8,"explanation":"extends"}',
    });

    const result = await runIncrementalV2Update({ conversationId: "conv-1", snapshot, newMessages });

    // Should use bounded calls: 1 for propositions + 1 for decision = 2
    expect(result.diagnostics.llmCalls).toBe(2);
  });

  it("Fixture D: new sub-question → create_object + child_of", async () => {
    const snapshot = makeSnapshot([makeObj("obj-0", "Broad topic exploration")]);

    mockedComplete.mockResolvedValueOnce({
      content: '[{"propositionType":"question","normalizedContent":"What about a specific subtopic?","sourceUtteranceIds":["msg-new-"],"authoredBy":"user","provenance":"direct","confidence":0.9}]',
    });
    mockedComplete.mockResolvedValueOnce({
      content: '{"action":"create_object","targetObjectId":null,"newObjectDraft":{"objectType":"inquiry","title":"Specific subtopic question","description":"Sub-question"},"supportingNewPropositionIds":["prop-1"],"relevantExistingPropositionIds":["prop-0"],"lifecycleTransition":null,"confidence":0.85,"explanation":"Narrower sub-question"}',
    });
    mockedComplete.mockResolvedValueOnce({
      content: '{"placement":"child_of","targetObjectId":"obj-0","relationshipType":"child_of","supportingPropositionIds":["prop-1"],"confidence":0.8,"explanation":"Sub-question of broad topic"}',
    });

    const result = await runIncrementalV2Update({ conversationId: "conv-1", snapshot, newMessages });

    expect(result.diagnostics.objectsCreated).toBe(1);
    expect(result.diagnostics.relationshipsAdded).toBe(1);
    const relMutation = result.acceptedMutations.find((m) => m.type === "add_relationship");
    expect(relMutation).toBeDefined();
  });
});
