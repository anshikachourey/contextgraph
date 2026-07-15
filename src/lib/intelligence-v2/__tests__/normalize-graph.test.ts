/**
 * Graph Normalization Tests.
 */
import { describe, it, expect } from "vitest";
import { normalizeGraph } from "../normalize-graph";
import type { ConversationalObject, Relationship } from "../schemas";

function makeObj(id: string, title: string, type: string = "insight", propCount: number = 5, threadId: string = "t-0"): ConversationalObject {
  return {
    objectId: id, objectType: type as ConversationalObject["objectType"], title, description: "D",
    propositionIds: Array.from({ length: propCount }, (_, i) => `${id}-prop-${i}`),
    threadIds: [threadId], supportingUtteranceIds: ["u1"], contextualAssistantUtteranceIds: [],
    maturity: "developing", status: "active", provenanceSummary: "",
  };
}

function makeChildOf(id: string, childId: string, parentId: string, confidence: number = 0.8): Relationship {
  return {
    relationshipId: id, sourceObjectId: childId, targetObjectId: parentId,
    type: "child_of", family: "structural", sourcePropositionIds: [],
    provenance: "llm", confidence, createdBy: "system", status: "proposed",
    visualClass: "structural", explanation: "",
  };
}

function makeRel(id: string, src: string, tgt: string, type: string = "elaborates"): Relationship {
  return {
    relationshipId: id, sourceObjectId: src, targetObjectId: tgt,
    type: type as Relationship["type"], family: "semantic", sourcePropositionIds: [],
    provenance: "llm", confidence: 0.7, createdBy: "system", status: "proposed",
    visualClass: "semantic", explanation: "test",
  };
}

describe("normalizeGraph", () => {
  it("assigns exactly one canonical parent per non-root node", () => {
    const objects = [
      makeObj("A", "Parent A", "explanation", 10),
      makeObj("B", "Child B", "inquiry", 3),
    ];
    const rels = [makeChildOf("r1", "B", "A")];
    const graph = normalizeGraph(objects, rels);

    const nodeB = graph.nodes.find((n) => n.objectId === "B")!;
    expect(nodeB.parentId).toBe("A");
    expect(nodeB.depth).toBe(1);

    const nodeA = graph.nodes.find((n) => n.objectId === "A")!;
    expect(nodeA.parentId).toBeNull();
    expect(nodeA.depth).toBe(0);
  });

  it("resolves multi-parent conflicts by choosing highest confidence", () => {
    const objects = [
      makeObj("A", "Parent A", "explanation", 10),
      makeObj("B", "Parent B", "explanation", 8),
      makeObj("C", "Child C", "inquiry", 3),
    ];
    const rels = [
      makeChildOf("r1", "C", "A", 0.7),
      makeChildOf("r2", "C", "B", 0.9),
    ];
    const graph = normalizeGraph(objects, rels);

    const nodeC = graph.nodes.find((n) => n.objectId === "C")!;
    expect(nodeC.parentId).toBe("B"); // higher confidence
    expect(graph.diagnostics.multiParentConflicts).toBe(1);
  });

  it("prevents cycles", () => {
    const objects = [
      makeObj("A", "Object A", "insight", 5),
      makeObj("B", "Object B", "insight", 5),
    ];
    const rels = [
      makeChildOf("r1", "A", "B"),
      makeChildOf("r2", "B", "A"),
    ];
    const graph = normalizeGraph(objects, rels);

    // One must be a root, the other its child — no mutual parent
    expect(graph.diagnostics.cyclesRemoved).toBeGreaterThan(0);
    const depths = graph.nodes.map((n) => n.depth);
    expect(depths).toContain(0); // at least one root exists
  });

  it("rejects child_of where child is much broader than parent", () => {
    const objects = [
      makeObj("A", "Broad explanation", "explanation", 20),
      makeObj("B", "Narrow inquiry", "inquiry", 3),
    ];
    // Trying to make broad A a child of narrow B — should be rejected or reversed
    const rels = [makeChildOf("r1", "A", "B")];
    const graph = normalizeGraph(objects, rels);

    const nodeA = graph.nodes.find((n) => n.objectId === "A")!;
    // A should NOT be child of B (it's broader)
    expect(nodeA.parentId).not.toBe("B");
    expect(graph.diagnostics.rejectedChildOfs.length).toBeGreaterThan(0);
  });

  it("rejects cross-thread child_of", () => {
    const objects = [
      makeObj("A", "Thread 1 topic", "insight", 5, "t-1"),
      makeObj("B", "Thread 2 topic", "insight", 5, "t-2"),
    ];
    const rels = [makeChildOf("r1", "B", "A")];
    const graph = normalizeGraph(objects, rels);

    const nodeB = graph.nodes.find((n) => n.objectId === "B")!;
    expect(nodeB.parentId).toBeNull(); // cross-thread rejected
  });

  it("preserves semantic relationships separately", () => {
    const objects = [
      makeObj("A", "Topic A"),
      makeObj("B", "Topic B"),
    ];
    const rels = [
      makeRel("r1", "A", "B", "elaborates"),
      makeRel("r2", "B", "A", "contrasts_with"),
    ];
    const graph = normalizeGraph(objects, rels);

    expect(graph.semanticEdges.length).toBe(2);
    expect(graph.nodes.every((n) => n.depth === 0)).toBe(true); // no hierarchy from semantic edges
  });

  it("produces correct tree structure", () => {
    const objects = [
      makeObj("root", "Root topic", "explanation", 10),
      makeObj("child1", "Subtopic 1", "inquiry", 4),
      makeObj("child2", "Subtopic 2", "insight", 3),
    ];
    const rels = [
      makeChildOf("r1", "child1", "root"),
      makeChildOf("r2", "child2", "root"),
    ];
    const graph = normalizeGraph(objects, rels);

    expect(graph.trees.length).toBe(1);
    expect(graph.trees[0].nodeIds.length).toBe(3);
    expect(graph.diagnostics.roots).toBe(1);
    expect(graph.diagnostics.maxDepth).toBe(1);

    const rootNode = graph.nodes.find((n) => n.objectId === "root")!;
    expect(rootNode.childIds.sort()).toEqual(["child1", "child2"]);
  });

  it("unrelated topics form separate trees", () => {
    const objects = [
      makeObj("A", "Topic A", "insight", 5, "t-1"),
      makeObj("B", "Topic B", "problem", 5, "t-2"),
    ];
    const rels: Relationship[] = [];
    const graph = normalizeGraph(objects, rels);

    expect(graph.trees.length).toBe(2);
    expect(graph.diagnostics.roots).toBe(2);
  });
});
