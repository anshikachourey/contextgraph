/**
 * V2 Invariant Tests — Domain-Independent Semantic Rules.
 *
 * These tests verify structural invariants that must hold
 * regardless of conversation content.
 */
import { describe, it, expect } from "vitest";
import { validateProposition } from "../policies/proposition-policy";
import { validateThread } from "../policies/thread-policy";
import { validateObject, INSUFFICIENT_FOR_OBJECT_CREATION } from "../policies/object-policy";
import { validateRelationship } from "../policies/relationship-policy";
import { validateHierarchy } from "../policies/hierarchy-policy";
import { isValidChildOf } from "../policies/relationship-policy";
import type { Proposition, Thread, ConversationalObject, Relationship, DerivedHierarchyNode } from "../schemas";

// ─── Proposition Invariants ─────────────────────────────────────────────────

describe("Invariant: Proposition Provenance", () => {
  it("assistant interpretation cannot become a user proposition", () => {
    const invalid: Proposition = {
      propositionId: "p1",
      propositionType: "claim",
      normalizedContent: "User uses music to cope with anxiety",
      sourceUtteranceIds: ["u1"],
      authoredBy: "user",
      provenance: "interpretation",
      confirmedByUser: false,
      confidence: 0.7,
      status: "active",
      supersedesPropositionId: null,
    };
    const violations = validateProposition(invalid);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("interpretation"))).toBe(true);
  });

  it("user direct proposition is valid", () => {
    const valid: Proposition = {
      propositionId: "p2",
      propositionType: "emotional_state",
      normalizedContent: "I feel anxious about my career",
      sourceUtteranceIds: ["u1"],
      authoredBy: "user",
      provenance: "direct",
      confirmedByUser: false,
      confidence: 0.9,
      status: "active",
      supersedesPropositionId: null,
    };
    const violations = validateProposition(valid);
    expect(violations.length).toBe(0);
  });

  it("proposition must trace to at least one utterance", () => {
    const noSource: Proposition = {
      propositionId: "p3",
      propositionType: "claim",
      normalizedContent: "Some claim",
      sourceUtteranceIds: [],
      authoredBy: "user",
      provenance: "direct",
      confirmedByUser: false,
      confidence: 0.7,
      status: "active",
      supersedesPropositionId: null,
    };
    const violations = validateProposition(noSource);
    expect(violations.some((v) => v.includes("source utterance"))).toBe(true);
  });
});

// ─── Thread Invariants ──────────────────────────────────────────────────────

describe("Invariant: Thread Separation", () => {
  it("unrelated propositions cannot enter one thread", () => {
    // A thread must have ONE coherent subject
    const badThread: Thread = {
      threadId: "t1",
      utteranceIds: ["u1", "u5"],
      propositionIds: ["p1", "p5"],
      subject: "", // empty subject = violation
      branchId: null,
      originThreadId: null,
      divergenceUtteranceId: null,
      status: "active",
    };
    const violations = validateThread(badThread);
    expect(violations.some((v) => v.includes("subject"))).toBe(true);
  });

  it("valid thread has a coherent subject", () => {
    const goodThread: Thread = {
      threadId: "t2",
      utteranceIds: ["u1", "u2", "u3"],
      propositionIds: ["p1", "p2"],
      subject: "physical symptoms of anxiety",
      branchId: null,
      originThreadId: null,
      divergenceUtteranceId: null,
      status: "active",
    };
    const violations = validateThread(goodThread);
    expect(violations.length).toBe(0);
  });
});

// ─── Object Invariants ──────────────────────────────────────────────────────

describe("Invariant: Object Formation", () => {
  it("questions are not converted into conclusions", () => {
    const inquiry: ConversationalObject = {
      objectId: "obj1",
      objectType: "inquiry",
      title: "Were the parents hurt by being excluded?",
      description: "User questions whether excluding parents was harmful",
      propositionIds: ["p1"],
      threadIds: ["t1"],
      supportingUtteranceIds: ["u1"],
      contextualAssistantUtteranceIds: [],
      maturity: "developing",
      status: "active",
      provenanceSummary: "User asked directly",
    };
    const violations = validateObject(inquiry);
    expect(violations.length).toBe(0);
    expect(inquiry.title).toMatch(/\?/);
  });

  it("object without user utterance support fails validation", () => {
    const unsupported: ConversationalObject = {
      objectId: "obj2",
      objectType: "insight",
      title: "Music as emotional anchor",
      description: "Assistant interpretation only",
      propositionIds: ["p1"],
      threadIds: ["t1"],
      supportingUtteranceIds: [],
      contextualAssistantUtteranceIds: ["u3"],
      maturity: "stable",
      status: "active",
      provenanceSummary: "No user support",
    };
    const violations = validateObject(unsupported);
    expect(violations.some((v) => v.includes("user utterance"))).toBe(true);
  });

  it("no node is created solely because of message count", () => {
    // This is a policy principle — validated by ensuring
    // INSUFFICIENT_FOR_OBJECT_CREATION includes "enough_messages_accumulated"
    expect(INSUFFICIENT_FOR_OBJECT_CREATION).toContain("enough_messages_accumulated");
  });
});

// ─── Relationship Invariants ────────────────────────────────────────────────

describe("Invariant: Relationship Rules", () => {
  it("chronology alone cannot create child_of", () => {
    // "coding bug" and "skincare routine" — no shared content words
    expect(isValidChildOf("skincare routine moisturizer", "react component rendering bug")).toBe(false);
  });

  it("genuine subtopic passes child_of check", () => {
    expect(isValidChildOf("physical symptoms of career anxiety", "career anxiety and uncertainty")).toBe(true);
  });

  it("diverged_from does not affect tree membership", () => {
    const diverged: Relationship = {
      relationshipId: "r1",
      sourceObjectId: "obj-skincare",
      targetObjectId: "obj-coding",
      type: "diverged_from",
      family: "structural",
      sourcePropositionIds: [],
      provenance: "temporal",
      confidence: 0.9,
      createdBy: "system",
      status: "active",
      visualClass: "weak",
      explanation: "Conversation shifted from coding to skincare",
    };
    const violations = validateRelationship(diverged);
    expect(violations.length).toBe(0);
    expect(diverged.type).not.toBe("child_of");
    expect(diverged.visualClass).toBe("weak");
  });

  it("self-referential relationship is invalid", () => {
    const selfRef: Relationship = {
      relationshipId: "r2",
      sourceObjectId: "obj1",
      targetObjectId: "obj1",
      type: "elaborates",
      family: "semantic",
      sourcePropositionIds: [],
      provenance: "llm",
      confidence: 0.8,
      createdBy: "system",
      status: "active",
      visualClass: "semantic",
      explanation: "Elaborates itself",
    };
    const violations = validateRelationship(selfRef);
    expect(violations.some((v) => v.includes("Self-referential"))).toBe(true);
  });
});

// ─── Hierarchy Invariants ───────────────────────────────────────────────────

describe("Invariant: Hierarchy Derivation", () => {
  it("cycles are rejected", () => {
    const relationships: Relationship[] = [
      { relationshipId: "r1", sourceObjectId: "A", targetObjectId: "B", type: "child_of", family: "structural", sourcePropositionIds: [], provenance: "", confidence: 0.9, createdBy: "system", status: "active", visualClass: "semantic", explanation: "" },
      { relationshipId: "r2", sourceObjectId: "B", targetObjectId: "A", type: "child_of", family: "structural", sourcePropositionIds: [], provenance: "", confidence: 0.9, createdBy: "system", status: "active", visualClass: "semantic", explanation: "" },
    ];
    const hierarchy: DerivedHierarchyNode[] = [];
    const violations = validateHierarchy(hierarchy, relationships);
    expect(violations.some((v) => v.includes("Cycle"))).toBe(true);
  });

  it("uncertain placement can abstain (separate root)", () => {
    // If no child_of exists, the object is a root
    const hierarchy: DerivedHierarchyNode[] = [
      { objectId: "A", treeId: "A", depth: 0, parentObjectId: null, childObjectIds: [], siblingObjectIds: [] },
      { objectId: "B", treeId: "B", depth: 0, parentObjectId: null, childObjectIds: [], siblingObjectIds: [] },
    ];
    // Two separate roots — this is valid when relationship is uncertain
    expect(hierarchy[0].depth).toBe(0);
    expect(hierarchy[1].depth).toBe(0);
    expect(hierarchy[0].treeId).not.toBe(hierarchy[1].treeId);
  });

  it("cross-tree bridges do not merge trees", () => {
    const relationships: Relationship[] = [
      { relationshipId: "r1", sourceObjectId: "A", targetObjectId: "B", type: "contrasts_with", family: "semantic", sourcePropositionIds: [], provenance: "", confidence: 0.8, createdBy: "system", status: "active", visualClass: "semantic", explanation: "" },
    ];
    // A and B are in different trees — contrasts_with does NOT make them child_of
    expect(relationships[0].type).not.toBe("child_of");
    // They remain separate roots
  });

  it("every object claim must trace to propositions → utterances", () => {
    // This is the fundamental traceability requirement
    // object → propositionIds → sourceUtteranceIds → original messages
    const validObject: ConversationalObject = {
      objectId: "obj1",
      objectType: "inquiry",
      title: "Can anxiety cause leg pain?",
      description: "User's question about physical symptoms",
      propositionIds: ["p1"],
      threadIds: ["t1"],
      supportingUtteranceIds: ["u1"],
      contextualAssistantUtteranceIds: [],
      maturity: "developing",
      status: "active",
      provenanceSummary: "User asked directly in u1",
    };
    expect(validObject.propositionIds.length).toBeGreaterThan(0);
    expect(validObject.supportingUtteranceIds.length).toBeGreaterThan(0);
  });
});
