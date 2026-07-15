/**
 * Object Formation Invariant Tests.
 *
 * Tests structural invariants of the thread-local object generation.
 * Does not test LLM output — tests the validation, windowing, and isolation logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Proposition, Thread } from "../schemas";

// Mock the AI module to avoid real LLM calls
vi.mock("@/src/lib/ai", () => ({
  complete: vi.fn(),
}));
vi.mock("@/src/lib/ai/models", () => ({
  NODE_MODEL: "test-model",
}));

import { complete } from "@/src/lib/ai";
import { formObjects } from "../objects";

const mockedComplete = vi.mocked(complete);

beforeEach(() => {
  mockedComplete.mockReset();
});

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function makeProposition(id: string, content: string, author: "user" | "assistant" = "user", provenance: "direct" | "interpretation" = "direct"): Proposition {
  return {
    propositionId: id,
    propositionType: "claim",
    normalizedContent: content,
    sourceUtteranceIds: [`utt-${id}`],
    authoredBy: author,
    provenance,
    confirmedByUser: false,
    confidence: 0.9,
    status: "active",
    supersedesPropositionId: null,
  };
}

function makeThread(id: string, subject: string, propIds: string[]): Thread {
  return {
    threadId: id,
    utteranceIds: propIds.map(p => `utt-${p}`),
    propositionIds: propIds,
    subject,
    branchId: null,
    originThreadId: null,
    divergenceUtteranceId: null,
    status: "active",
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("formObjects: thread-local generation", () => {
  it("does not use one global call — processes each thread independently", async () => {
    const props = [
      makeProposition("prop-0", "I want a small wedding"),
      makeProposition("prop-1", "Venue should be outdoors"),
      makeProposition("prop-2", "What about catering options?"),
    ];
    const threads = [
      makeThread("thread-0", "venue preferences", ["prop-0", "prop-1"]),
      makeThread("thread-1", "catering questions", ["prop-2"]),
    ];

    // Each thread gets its own LLM call
    mockedComplete
      .mockResolvedValueOnce({ content: '[{"objectType":"preference","title":"Small outdoor wedding preference","description":"Preference for small outdoor venue","propositionIds":["prop-0","prop-1"]}]' })
      .mockResolvedValueOnce({ content: '[{"objectType":"inquiry","title":"What about catering options?","description":"Question about catering","propositionIds":["prop-2"]}]' });

    const { objects, diagnostics } = await formObjects(props, threads);

    expect(objects.length).toBe(2);
    expect(diagnostics.threadDiagnostics.length).toBe(2);
    // Each thread processed independently — 2 calls (one per thread)
    expect(mockedComplete).toHaveBeenCalledTimes(2);
  });

  it("failure in one thread does not erase objects from other threads", async () => {
    const props = [
      makeProposition("prop-0", "Valid content here"),
      makeProposition("prop-1", "Another valid proposition"),
    ];
    const threads = [
      makeThread("thread-0", "working thread", ["prop-0"]),
      makeThread("thread-1", "broken thread", ["prop-1"]),
    ];

    mockedComplete
      .mockResolvedValueOnce({ content: '[{"objectType":"insight","title":"Valid content","description":"Test","propositionIds":["prop-0"]}]' })
      // Thread 1 fails twice (malformed JSON)
      .mockResolvedValueOnce({ content: 'broken json {{{' })
      .mockResolvedValueOnce({ content: 'still broken' });

    const { objects, diagnostics } = await formObjects(props, threads);

    expect(objects.length).toBe(1);
    expect(objects[0].title).toBe("Valid content");
    expect(diagnostics.failedThreads).toContain("thread-1");
    expect(diagnostics.totalAcceptedObjects).toBe(1);
  });

  it("object IDs are assigned deterministically", async () => {
    const props = [
      makeProposition("prop-0", "First"),
      makeProposition("prop-1", "Second"),
    ];
    const threads = [
      makeThread("thread-0", "test", ["prop-0", "prop-1"]),
    ];

    mockedComplete.mockResolvedValueOnce({
      content: '[{"objectType":"claim","title":"First thing","description":"A","propositionIds":["prop-0"]},{"objectType":"claim","title":"Second thing","description":"B","propositionIds":["prop-1"]}]',
    });

    const { objects } = await formObjects(props, threads);

    expect(objects[0].objectId).toBe("obj-0");
    expect(objects[1].objectId).toBe("obj-1");
  });

  it("threadIds are derived from the current thread, not from LLM", async () => {
    const props = [makeProposition("prop-0", "Test content")];
    const threads = [makeThread("thread-0", "test thread", ["prop-0"])];

    mockedComplete.mockResolvedValueOnce({
      content: '[{"objectType":"claim","title":"Test","description":"D","propositionIds":["prop-0"]}]',
    });

    const { objects } = await formObjects(props, threads);

    expect(objects[0].threadIds).toEqual(["thread-0"]);
  });

  it("malformed thread output retries once", async () => {
    const props = [makeProposition("prop-0", "Valid")];
    const threads = [makeThread("thread-0", "test", ["prop-0"])];

    mockedComplete
      .mockResolvedValueOnce({ content: '```json\n[{"incomplete":' }) // malformed
      .mockResolvedValueOnce({ content: '[{"objectType":"claim","title":"Recovered","description":"D","propositionIds":["prop-0"]}]' });

    const { objects, diagnostics } = await formObjects(props, threads);

    expect(objects.length).toBe(1);
    expect(objects[0].title).toBe("Recovered");
    expect(diagnostics.threadDiagnostics[0].attempts).toBe(2);
  });

  it("questions remain inquiry objects", async () => {
    const props = [makeProposition("prop-0", "Is this the right approach?", "user", "direct")];
    const threads = [makeThread("thread-0", "approach question", ["prop-0"])];

    mockedComplete.mockResolvedValueOnce({
      content: '[{"objectType":"inquiry","title":"Is this the right approach?","description":"User questioning the approach","propositionIds":["prop-0"]}]',
    });

    const { objects } = await formObjects(props, threads);

    expect(objects[0].objectType).toBe("inquiry");
    expect(objects[0].title).toContain("?");
  });

  it("unsupported thesis-like claims are rejected", async () => {
    const props = [makeProposition("prop-0", "I like outdoor venues")];
    const threads = [makeThread("thread-0", "venue", ["prop-0"])];

    mockedComplete.mockResolvedValueOnce({
      content: '[{"objectType":"insight","title":"Deep mutual alignment in venue philosophy","description":"The couple shares a profound connection","propositionIds":["prop-0"]}]',
    });

    const { objects, diagnostics } = await formObjects(props, threads);

    expect(objects.length).toBe(0);
    expect(diagnostics.threadDiagnostics[0].rejectedObjectCount).toBe(1);
    expect(diagnostics.threadDiagnostics[0].rejectionReasons[0]).toContain("unsupported synthesis");
  });

  it("one thread may produce multiple objects", async () => {
    const props = [
      makeProposition("prop-0", "I want a garden venue"),
      makeProposition("prop-1", "Should we invite extended family?"),
    ];
    const threads = [makeThread("thread-0", "wedding planning", ["prop-0", "prop-1"])];

    mockedComplete.mockResolvedValueOnce({
      content: '[{"objectType":"preference","title":"Garden venue preference","description":"Wants outdoor","propositionIds":["prop-0"]},{"objectType":"inquiry","title":"Should we invite extended family?","description":"Guest list question","propositionIds":["prop-1"]}]',
    });

    const { objects } = await formObjects(props, threads);

    expect(objects.length).toBe(2);
  });

  it("empty/noise threads may produce zero objects", async () => {
    const props = [makeProposition("prop-0", "ok thanks")];
    const threads = [makeThread("thread-0", "acknowledgement", ["prop-0"])];

    mockedComplete.mockResolvedValueOnce({ content: "[]" });

    const { objects, diagnostics } = await formObjects(props, threads);

    expect(objects.length).toBe(0);
    expect(diagnostics.failedThreads.length).toBe(0); // Not failed, just empty
  });

  it("oversized threads are windowed without dropping propositions", async () => {
    // Create 100 propositions (exceeds MAX_PROPS_PER_WINDOW of 80)
    const props = Array.from({ length: 100 }, (_, i) =>
      makeProposition(`prop-${i}`, `Proposition content ${i}`),
    );
    const threads = [makeThread("thread-0", "big thread", props.map(p => p.propositionId))];

    // Two windows → two LLM calls
    mockedComplete
      .mockResolvedValueOnce({ content: '[{"objectType":"claim","title":"Window 1 object","description":"D","propositionIds":["prop-0","prop-1"]}]' })
      .mockResolvedValueOnce({ content: '[{"objectType":"claim","title":"Window 2 object","description":"D","propositionIds":["prop-80","prop-81"]}]' });

    const { objects, diagnostics } = await formObjects(props, threads);

    expect(objects.length).toBe(2);
    expect(diagnostics.threadDiagnostics[0].windowCount).toBe(2);
    expect(mockedComplete).toHaveBeenCalledTimes(2);
  });

  it("provenance is derived deterministically from propositions", async () => {
    const props = [
      makeProposition("prop-0", "User said this", "user", "direct"),
      makeProposition("prop-1", "Assistant interpretation", "assistant", "interpretation"),
    ];
    const threads = [makeThread("thread-0", "test", ["prop-0", "prop-1"])];

    mockedComplete.mockResolvedValueOnce({
      content: '[{"objectType":"insight","title":"Test object","description":"D","propositionIds":["prop-0","prop-1"]}]',
    });

    const { objects } = await formObjects(props, threads);

    expect(objects[0].supportingUtteranceIds).toEqual(["utt-prop-0"]);
    expect(objects[0].contextualAssistantUtteranceIds).toEqual(["utt-prop-1"]);
  });
});
