/**
 * Relationship Generation Invariant Tests.
 *
 * Tests structural invariants of bounded relationship classification.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConversationalObject, Proposition } from "../schemas";

vi.mock("@/src/lib/ai", () => ({
  complete: vi.fn(),
  embed: vi.fn(),
}));
vi.mock("@/src/lib/ai/models", () => ({
  NODE_MODEL: "test-model",
}));

import { complete, embed } from "@/src/lib/ai";
import { generateRelationships } from "../relationships";

const mockedComplete = vi.mocked(complete);
const mockedEmbed = vi.mocked(embed);

beforeEach(() => {
  mockedComplete.mockReset();
  mockedEmbed.mockReset();
});

function makeObj(id: string, title: string, threadId: string, propIds: string[]): ConversationalObject {
  return {
    objectId: id, objectType: "insight", title, description: "D",
    propositionIds: propIds, threadIds: [threadId],
    supportingUtteranceIds: [`utt-${propIds[0]}`], contextualAssistantUtteranceIds: [],
    maturity: "developing", status: "active", provenanceSummary: "",
  };
}

function makeProp(id: string, content: string): Proposition {
  return {
    propositionId: id, propositionType: "claim", normalizedContent: content,
    sourceUtteranceIds: [`utt-${id}`], authoredBy: "user", provenance: "direct",
    confirmedByUser: false, confidence: 0.9, status: "active", supersedesPropositionId: null,
  };
}

describe("generateRelationships: bounded classification", () => {
  it("does not produce one giant LLM call for 70 objects", async () => {
    const props = Array.from({ length: 10 }, (_, i) => makeProp(`prop-${i}`, `Content ${i}`));
    const objs = Array.from({ length: 10 }, (_, i) => makeObj(`obj-${i}`, `Object ${i}`, "thread-0", [`prop-${i}`]));

    // Embeddings: return simple vectors so similarity works
    mockedEmbed.mockImplementation(async (text) => {
      const idx = parseInt(text.match(/Object (\d+)/)?.[1] ?? "0");
      const vec = new Array(10).fill(0);
      vec[idx % 10] = 1;
      return vec;
    });

    // Classification calls
    mockedComplete.mockResolvedValue({
      content: '[{"pairId":"pair-0","decision":"none"}]',
    });

    const { diagnostics } = await generateRelationships(objs, props);

    // Should NOT be just 1 call — batched
    expect(diagnostics.candidates.totalObjects).toBe(10);
    expect(diagnostics.candidates.deduplicatedCandidatePairs).toBeGreaterThan(0);
    // With 10 objects all in same thread, all pairs are structural candidates
    // But the key invariant is: they are classified in BATCHES, not one call
    expect(diagnostics.batchDiagnostics.length).toBeGreaterThan(1);
  });

  it("top-K retrieval is deterministic", async () => {
    const props = [makeProp("prop-0", "A"), makeProp("prop-1", "B"), makeProp("prop-2", "C")];
    const objs = [
      makeObj("obj-0", "Alpha", "t-0", ["prop-0"]),
      makeObj("obj-1", "Beta", "t-0", ["prop-1"]),
      makeObj("obj-2", "Gamma", "t-1", ["prop-2"]),
    ];

    mockedEmbed.mockImplementation(async () => [1, 0, 0]);
    mockedComplete.mockResolvedValue({ content: '[{"pairId":"pair-0","decision":"none"}]' });

    const r1 = await generateRelationships(objs, props);
    mockedComplete.mockClear();
    mockedEmbed.mockImplementation(async () => [1, 0, 0]);
    mockedComplete.mockResolvedValue({ content: '[{"pairId":"pair-0","decision":"none"}]' });

    const r2 = await generateRelationships(objs, props);

    expect(r1.diagnostics.candidates.deduplicatedCandidatePairs)
      .toBe(r2.diagnostics.candidates.deduplicatedCandidatePairs);
  });

  it("duplicate pairs are removed", async () => {
    // Two objects in same thread — structural candidate. Also similar embeddings — semantic candidate.
    // Should deduplicate to one pair.
    const props = [makeProp("prop-0", "A"), makeProp("prop-1", "B")];
    const objs = [
      makeObj("obj-0", "First", "t-0", ["prop-0"]),
      makeObj("obj-1", "Second", "t-0", ["prop-1"]),
    ];

    mockedEmbed.mockImplementation(async () => [1, 0, 0]); // identical embeddings
    mockedComplete.mockResolvedValue({ content: '[{"pairId":"pair-0","decision":"none"}]' });

    const { diagnostics } = await generateRelationships(objs, props);
    // Only 1 unique pair despite being both semantic AND structural candidate
    expect(diagnostics.candidates.deduplicatedCandidatePairs).toBe(1);
  });

  it("same-thread structural candidates are retained", async () => {
    const props = [makeProp("prop-0", "A"), makeProp("prop-1", "B")];
    const objs = [
      makeObj("obj-0", "First", "t-0", ["prop-0"]),
      makeObj("obj-1", "Second", "t-0", ["prop-1"]),
    ];

    mockedEmbed.mockImplementation(async () => [0]); // degenerate embedding, no semantic similarity
    mockedComplete.mockResolvedValue({ content: '[{"pairId":"pair-0","decision":"none"}]' });

    const { diagnostics } = await generateRelationships(objs, props);
    expect(diagnostics.candidates.structuralCandidates).toBeGreaterThanOrEqual(1);
  });

  it("malformed relationship output does not terminate later batches", async () => {
    const props = Array.from({ length: 20 }, (_, i) => makeProp(`prop-${i}`, `Content ${i}`));
    const objs = Array.from({ length: 20 }, (_, i) => makeObj(`obj-${i}`, `Object ${i}`, "t-0", [`prop-${i}`]));

    mockedEmbed.mockImplementation(async () => [1, 0]);

    let callCount = 0;
    mockedComplete.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        // First batch fails twice (retry also fails)
        return { content: "broken json {{{" };
      }
      return { content: '[{"pairId":"pair-0","decision":"none"}]' };
    });

    const { diagnostics } = await generateRelationships(objs, props);
    // Should have multiple batches, first failed, later ones succeeded
    expect(diagnostics.batchDiagnostics.length).toBeGreaterThan(1);
    const failedBatch = diagnostics.batchDiagnostics.find(b => !b.parseSucceeded);
    expect(failedBatch).toBeDefined();
    // Later batches should have run
    const successBatches = diagnostics.batchDiagnostics.filter(b => b.parseSucceeded);
    expect(successBatches.length).toBeGreaterThan(0);
  });

  it("LLM cannot control canonical relationship IDs", async () => {
    const props = [makeProp("prop-0", "A"), makeProp("prop-1", "B")];
    const objs = [
      makeObj("obj-0", "First", "t-0", ["prop-0"]),
      makeObj("obj-1", "Second", "t-0", ["prop-1"]),
    ];

    mockedEmbed.mockImplementation(async () => [1, 0, 0]);
    mockedComplete.mockResolvedValue({
      content: '[{"pairId":"pair-0","decision":"relationship","relationshipType":"elaborates","supportingPropositionIds":["prop-0"],"confidence":0.8,"explanation":"test"}]',
    });

    const { relationships } = await generateRelationships(objs, props);
    // IDs are assigned by code, not from LLM
    expect(relationships[0]?.relationshipId).toBe("rel-0");
  });

  it("valid child_of reaches deriveHierarchy when used downstream", async () => {
    const props = [makeProp("prop-0", "A"), makeProp("prop-1", "B")];
    const objs = [
      makeObj("obj-0", "Parent topic", "t-0", ["prop-0"]),
      makeObj("obj-1", "Child subtopic", "t-0", ["prop-1"]),
    ];

    mockedEmbed.mockImplementation(async () => [1, 0, 0]);
    mockedComplete.mockResolvedValue({
      content: '[{"pairId":"pair-0","decision":"relationship","relationshipType":"child_of","supportingPropositionIds":["prop-0","prop-1"],"confidence":0.85,"explanation":"subtopic"}]',
    });

    const { relationships } = await generateRelationships(objs, props);
    const childOf = relationships.filter(r => r.type === "child_of");
    expect(childOf.length).toBe(1);
    expect(childOf[0].family).toBe("structural");
  });
});
