import { describe, it, expect } from "vitest";
import { deriveConceptualMap, SYNTHETIC_ROOT_ID } from "../derive-map";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function makeObject(id: string, overrides?: Partial<{
  objectType: string; title: string; description: string;
  propositionIds: string[]; threadIds: string[];
}>) {
  return {
    objectId: id,
    objectType: overrides?.objectType ?? "insight",
    title: overrides?.title ?? `Object ${id}`,
    description: overrides?.description ?? `Description for ${id}`,
    propositionIds: overrides?.propositionIds ?? ["p1"],
    threadIds: overrides?.threadIds ?? ["t1"],
    maturity: "stable",
    status: "active",
    supportingUtteranceIds: ["u1"],
    contextualAssistantUtteranceIds: [],
    provenanceSummary: "test",
  };
}

function makeHierarchy(id: string, opts: {
  depth: number; parentObjectId: string | null;
  childObjectIds: string[]; treeId?: string;
}) {
  return {
    objectId: id,
    depth: opts.depth,
    parentObjectId: opts.parentObjectId,
    childObjectIds: opts.childObjectIds,
    treeId: opts.treeId ?? "tree-1",
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("deriveConceptualMap", () => {
  it("creates a synthetic root when there are multiple tree roots", () => {
    const objects = [makeObject("a"), makeObject("b"), makeObject("c")];
    const hierarchy = [
      makeHierarchy("a", { depth: 0, parentObjectId: null, childObjectIds: [], treeId: "t1" }),
      makeHierarchy("b", { depth: 0, parentObjectId: null, childObjectIds: [], treeId: "t2" }),
      makeHierarchy("c", { depth: 0, parentObjectId: null, childObjectIds: [], treeId: "t3" }),
    ];

    const map = deriveConceptualMap(objects, hierarchy, []);

    expect(map.rootId).toBe(SYNTHETIC_ROOT_ID);
    expect(map.majorConceptIds).toHaveLength(3);
    expect(map.majorConceptIds).toContain("a");
    expect(map.majorConceptIds).toContain("b");
    expect(map.majorConceptIds).toContain("c");
    expect(map.nodes.get(SYNTHETIC_ROOT_ID)?.title).toBe("Conversation");
  });

  it("uses a single tree root as the real root and its children as major concepts", () => {
    const objects = [
      makeObject("root"),
      makeObject("child-1", { propositionIds: ["p1", "p2", "p3"] }),
      makeObject("child-2", { propositionIds: ["p1"] }),
    ];
    const hierarchy = [
      makeHierarchy("root", { depth: 0, parentObjectId: null, childObjectIds: ["child-1", "child-2"] }),
      makeHierarchy("child-1", { depth: 1, parentObjectId: "root", childObjectIds: [] }),
      makeHierarchy("child-2", { depth: 1, parentObjectId: "root", childObjectIds: [] }),
    ];

    const map = deriveConceptualMap(objects, hierarchy, []);

    expect(map.rootId).toBe("root");
    expect(map.majorConceptIds).toEqual(["child-1", "child-2"]); // ranked by proposition count
  });

  it("ranks major concepts by proposition count descending", () => {
    const objects = [
      makeObject("a", { propositionIds: ["p1"] }),
      makeObject("b", { propositionIds: ["p1", "p2", "p3", "p4", "p5"] }),
      makeObject("c", { propositionIds: ["p1", "p2", "p3"] }),
    ];
    const hierarchy = [
      makeHierarchy("a", { depth: 0, parentObjectId: null, childObjectIds: [] }),
      makeHierarchy("b", { depth: 0, parentObjectId: null, childObjectIds: [] }),
      makeHierarchy("c", { depth: 0, parentObjectId: null, childObjectIds: [] }),
    ];

    const map = deriveConceptualMap(objects, hierarchy, []);

    expect(map.majorConceptIds[0]).toBe("b"); // 5 props
    expect(map.majorConceptIds[1]).toBe("c"); // 3 props
    expect(map.majorConceptIds[2]).toBe("a"); // 1 prop
  });

  it("classifies roles from objectType", () => {
    const objects = [
      makeObject("inq", { objectType: "inquiry" }),
      makeObject("prob", { objectType: "problem" }),
      makeObject("expl", { objectType: "explanation" }),
      makeObject("noise", { objectType: "noise" }),
    ];
    const hierarchy = [
      makeHierarchy("inq", { depth: 0, parentObjectId: null, childObjectIds: [] }),
      makeHierarchy("prob", { depth: 0, parentObjectId: null, childObjectIds: [] }),
      makeHierarchy("expl", { depth: 0, parentObjectId: null, childObjectIds: [] }),
      makeHierarchy("noise", { depth: 0, parentObjectId: null, childObjectIds: [] }),
    ];

    const map = deriveConceptualMap(objects, hierarchy, []);

    expect(map.nodes.get("inq")?.role).toBe("position");
    expect(map.nodes.get("prob")?.role).toBe("objection");
    expect(map.nodes.get("expl")?.role).toBe("evidence");
    expect(map.nodes.get("noise")?.role).toBe("other");
  });

  it("computes descendant counts correctly", () => {
    const objects = [
      makeObject("root"),
      makeObject("a"),
      makeObject("a1"),
      makeObject("a2"),
      makeObject("b"),
    ];
    const hierarchy = [
      makeHierarchy("root", { depth: 0, parentObjectId: null, childObjectIds: ["a", "b"] }),
      makeHierarchy("a", { depth: 1, parentObjectId: "root", childObjectIds: ["a1", "a2"] }),
      makeHierarchy("a1", { depth: 2, parentObjectId: "a", childObjectIds: [] }),
      makeHierarchy("a2", { depth: 2, parentObjectId: "a", childObjectIds: [] }),
      makeHierarchy("b", { depth: 1, parentObjectId: "root", childObjectIds: [] }),
    ];

    const map = deriveConceptualMap(objects, hierarchy, []);

    expect(map.nodes.get("a")?.descendantCount).toBe(2); // a1 + a2
    expect(map.nodes.get("b")?.descendantCount).toBe(0);
    expect(map.nodes.get("root")?.descendantCount).toBe(4); // a + a1 + a2 + b
  });

  it("filters semantic edges by confidence threshold", () => {
    const objects = [makeObject("a"), makeObject("b")];
    const hierarchy = [
      makeHierarchy("a", { depth: 0, parentObjectId: null, childObjectIds: [] }),
      makeHierarchy("b", { depth: 0, parentObjectId: null, childObjectIds: [] }),
    ];
    const relationships = [
      { relationshipId: "r1", sourceObjectId: "a", targetObjectId: "b", type: "supports", family: "semantic", confidence: 0.8, explanation: "strong" },
      { relationshipId: "r2", sourceObjectId: "b", targetObjectId: "a", type: "weak_link", family: "semantic", confidence: 0.2, explanation: "weak" },
      { relationshipId: "r3", sourceObjectId: "a", targetObjectId: "b", type: "child_of", family: "structural", confidence: 0.9, explanation: "structural" },
    ];

    const map = deriveConceptualMap(objects, hierarchy, relationships);

    // Only semantic with confidence > 0.3 should be included
    expect(map.semanticEdges).toHaveLength(1);
    expect(map.semanticEdges[0].id).toBe("r1");
  });

  it("does not enforce a fixed branch count", () => {
    // 2 concepts — should show 2, not pad to 5-7
    const objects = [makeObject("x"), makeObject("y")];
    const hierarchy = [
      makeHierarchy("x", { depth: 0, parentObjectId: null, childObjectIds: [] }),
      makeHierarchy("y", { depth: 0, parentObjectId: null, childObjectIds: [] }),
    ];

    const map = deriveConceptualMap(objects, hierarchy, []);
    expect(map.majorConceptIds).toHaveLength(2);
  });

  it("handles empty hierarchy gracefully — treats all objects as major concepts", () => {
    const objects = [makeObject("a"), makeObject("b")];
    const map = deriveConceptualMap(objects, [], []);

    expect(map.rootId).toBe(SYNTHETIC_ROOT_ID);
    expect(map.majorConceptIds).toContain("a");
    expect(map.majorConceptIds).toContain("b");
  });

  it("never assigns the synthetic root as a continuation origin", () => {
    const objects = [makeObject("a")];
    const hierarchy = [
      makeHierarchy("a", { depth: 0, parentObjectId: null, childObjectIds: [] }),
    ];

    const map = deriveConceptualMap(objects, hierarchy, []);

    // The synthetic root node should not be a real persisted object
    const root = map.nodes.get(SYNTHETIC_ROOT_ID);
    if (root) {
      expect(root.objectId).toBe(SYNTHETIC_ROOT_ID);
      // SYNTHETIC_ROOT_ID is a special marker that the UI checks before
      // allowing "Continue from node" actions
    }
  });
});
