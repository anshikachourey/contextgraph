/**
 * Display Layout Tests — Domain-neutral structural fixtures.
 */
import { describe, it, expect } from "vitest";
import { layoutDisplayForest, buildVisibleEdges, buildFlowNodes, getLocalSemanticNeighborhood } from "../display-layout";
import { normalizeGraph, type DisplayGraph } from "../normalize-graph";
import type { ConversationalObject, Relationship } from "../schemas";

function makeObj(id: string, props: number = 5, thread: string = "t-0"): ConversationalObject {
  return {
    objectId: id, objectType: "insight", title: `Node ${id}`, description: "Desc",
    propositionIds: Array.from({ length: props }, (_, i) => `${id}-p${i}`),
    threadIds: [thread], supportingUtteranceIds: ["u1"], contextualAssistantUtteranceIds: [],
    maturity: "developing", status: "active", provenanceSummary: "",
  };
}

function makeChildOf(child: string, parent: string, conf = 0.8): Relationship {
  return {
    relationshipId: `r-${child}-${parent}`, sourceObjectId: child, targetObjectId: parent,
    type: "child_of", family: "structural", sourcePropositionIds: [], provenance: "llm",
    confidence: conf, createdBy: "system", status: "proposed", visualClass: "structural", explanation: "",
  };
}

function makeSemantic(src: string, tgt: string, type = "elaborates"): Relationship {
  return {
    relationshipId: `sem-${src}-${tgt}`, sourceObjectId: src, targetObjectId: tgt,
    type: type as Relationship["type"], family: "semantic", sourcePropositionIds: [], provenance: "llm",
    confidence: 0.7, createdBy: "system", status: "proposed", visualClass: "semantic", explanation: "test",
  };
}

describe("Display Layout — Structural Fixtures", () => {
  it("A. Empty graph — intentional empty state", () => {
    const graph = normalizeGraph([], []);
    const positions = layoutDisplayForest(graph);
    expect(positions.size).toBe(0);
    expect(graph.nodes.length).toBe(0);
    const edges = buildVisibleEdges(graph, "structure", null);
    expect(edges.length).toBe(0);
  });

  it("B. Single node — one centered root", () => {
    const graph = normalizeGraph([makeObj("A")], []);
    const positions = layoutDisplayForest(graph);
    expect(positions.size).toBe(1);
    expect(positions.get("A")).toEqual({ x: 0, y: 0 });
    expect(graph.diagnostics.roots).toBe(1);
  });

  it("C. Deep tree — 5 levels, parents above children", () => {
    const objs = [makeObj("A", 20), makeObj("B", 10), makeObj("C", 8), makeObj("D", 5), makeObj("E", 3)];
    const rels = [makeChildOf("B", "A"), makeChildOf("C", "B"), makeChildOf("D", "C"), makeChildOf("E", "D")];
    const graph = normalizeGraph(objs, rels);

    expect(graph.diagnostics.maxDepth).toBe(4);
    const positions = layoutDisplayForest(graph);

    // Each child should be below its parent
    const yA = positions.get("A")!.y;
    const yB = positions.get("B")!.y;
    const yC = positions.get("C")!.y;
    const yD = positions.get("D")!.y;
    const yE = positions.get("E")!.y;
    expect(yB).toBeGreaterThan(yA);
    expect(yC).toBeGreaterThan(yB);
    expect(yD).toBeGreaterThan(yC);
    expect(yE).toBeGreaterThan(yD);
  });

  it("D. Wide tree — one root with many children, stable ordering", () => {
    const objs = [makeObj("root", 20), ...Array.from({ length: 8 }, (_, i) => makeObj(`child-${i}`, 3))];
    const rels = Array.from({ length: 8 }, (_, i) => makeChildOf(`child-${i}`, "root"));
    const graph = normalizeGraph(objs, rels);

    expect(graph.diagnostics.roots).toBe(1);
    const positions = layoutDisplayForest(graph);

    // All children at same depth (below root)
    const rootY = positions.get("root")!.y;
    for (let i = 0; i < 8; i++) {
      const childY = positions.get(`child-${i}`)!.y;
      expect(childY).toBeGreaterThan(rootY);
    }

    // Deterministic: running again gives same positions
    const positions2 = layoutDisplayForest(graph);
    for (const [id, pos] of positions) {
      expect(positions2.get(id)).toEqual(pos);
    }
  });

  it("E. Forest — multiple disconnected trees separated", () => {
    const objs = [makeObj("A", 10, "t-1"), makeObj("B", 5, "t-1"), makeObj("C", 10, "t-2"), makeObj("D", 5, "t-2")];
    const rels = [makeChildOf("B", "A"), makeChildOf("D", "C")];
    const graph = normalizeGraph(objs, rels);

    expect(graph.diagnostics.trees).toBe(2);
    const positions = layoutDisplayForest(graph);

    // Trees should be separated (non-overlapping x or y bounds)
    const treeA_xs = [positions.get("A")!.x, positions.get("B")!.x];
    const treeC_xs = [positions.get("C")!.x, positions.get("D")!.x];
    const maxA = Math.max(...treeA_xs) + 260;
    const minC = Math.min(...treeC_xs);
    // Either horizontally or vertically separated
    const treeA_ys = [positions.get("A")!.y, positions.get("B")!.y];
    const treeC_ys = [positions.get("C")!.y, positions.get("D")!.y];
    const maxAy = Math.max(...treeA_ys) + 100;
    const minCy = Math.min(...treeC_ys);
    const separated = (maxA <= minC) || (maxAy <= minCy) || (Math.min(...treeC_xs) + 260 <= Math.min(...treeA_xs)) || (minCy + 100 <= Math.min(...treeA_ys));
    expect(separated).toBe(true);
  });

  it("F. Semantic density — Structure mode remains clean", () => {
    const objs = [makeObj("A"), makeObj("B"), makeObj("C"), makeObj("D")];
    const rels = [
      makeChildOf("B", "A"),
      makeSemantic("A", "C"), makeSemantic("A", "D"), makeSemantic("B", "C"),
      makeSemantic("B", "D"), makeSemantic("C", "D"), makeSemantic("D", "A"),
    ];
    const graph = normalizeGraph(objs, rels);

    const structureEdges = buildVisibleEdges(graph, "structure", null);
    // Only hierarchy edge (A→B) should appear
    expect(structureEdges.length).toBe(1);
    expect(structureEdges[0].source).toBe("A");
    expect(structureEdges[0].target).toBe("B");

    // Local mode on A reveals its semantic connections
    const localEdges = buildVisibleEdges(graph, "local", "A");
    const semanticLocal = localEdges.filter((e) => e.id.startsWith("sem-"));
    expect(semanticLocal.length).toBeGreaterThan(0);
    // But not ALL semantic edges
    expect(semanticLocal.length).toBeLessThan(6);
  });

  it("G. Invalid references and cycles — skipped safely", () => {
    const objs = [makeObj("A"), makeObj("B")];
    const rels: Relationship[] = [
      makeChildOf("A", "B"),
      makeChildOf("B", "A"), // cycle
      { ...makeSemantic("A", "NONEXIST"), relationshipId: "bad-1" }, // invalid ref
    ];
    const graph = normalizeGraph(objs, rels);

    // Should not crash
    expect(graph.nodes.length).toBe(2);
    expect(graph.diagnostics.cyclesRemoved).toBeGreaterThanOrEqual(0);

    const positions = layoutDisplayForest(graph);
    expect(positions.size).toBe(2);

    // Invalid references skipped from semantic edges
    expect(graph.semanticEdges.every((e) => e.source !== "NONEXIST" && e.target !== "NONEXIST")).toBe(true);
  });

  it("H. Variable title lengths — layout produces positions for all nodes", () => {
    const objs = [
      { ...makeObj("short"), title: "OK" },
      { ...makeObj("long"), title: "This is a very long title that spans multiple lines and might cause overlap if not handled" },
      { ...makeObj("medium"), title: "Medium length title here" },
    ];
    const graph = normalizeGraph(objs as ConversationalObject[], []);
    const positions = layoutDisplayForest(graph);
    expect(positions.size).toBe(3);
    // All nodes get valid positions
    for (const [, pos] of positions) {
      expect(typeof pos.x).toBe("number");
      expect(typeof pos.y).toBe("number");
      expect(isNaN(pos.x)).toBe(false);
      expect(isNaN(pos.y)).toBe(false);
    }
  });

  it("getLocalSemanticNeighborhood returns correct set", () => {
    const objs = [makeObj("A"), makeObj("B"), makeObj("C"), makeObj("D")];
    const rels = [makeChildOf("B", "A"), makeSemantic("A", "C"), makeSemantic("D", "A")];
    const graph = normalizeGraph(objs, rels);

    const neighborhood = getLocalSemanticNeighborhood(graph, "A");
    expect(neighborhood.has("A")).toBe(true); // self
    expect(neighborhood.has("B")).toBe(true); // child
    expect(neighborhood.has("C")).toBe(true); // semantic neighbor
    expect(neighborhood.has("D")).toBe(true); // semantic neighbor
  });
});
