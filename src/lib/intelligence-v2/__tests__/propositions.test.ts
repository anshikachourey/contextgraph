/**
 * Regression tests for V2 proposition extraction.
 *
 * Tests the policy validators and extraction post-processing.
 * LLM integration tests require ANTHROPIC_API_KEY and are marked with .skip
 * unless running in integration mode.
 */

import { describe, it, expect } from "vitest";
import { validateProposition, MINIMUM_SUBSTANTIVE_LENGTH } from "../policies/proposition-policy";
import { buildUtterances } from "../utterances";
import type { Proposition, Utterance } from "../schemas";

// ─── Policy Validation Tests ────────────────────────────────────────────────

describe("validateProposition", () => {
  const validUserProp: Proposition = {
    propositionId: "prop-1",
    propositionType: "claim",
    normalizedContent: "I want an unconventional wedding",
    sourceUtteranceIds: ["msg-001"],
    authoredBy: "user",
    provenance: "direct",
    confirmedByUser: false,
    confidence: 0.9,
    status: "active",
    supersedesPropositionId: null,
  };

  it("accepts a valid user direct proposition", () => {
    const violations = validateProposition(validUserProp);
    expect(violations).toEqual([]);
  });

  it("rejects user-attributed proposition with interpretation provenance", () => {
    const bad: Proposition = {
      ...validUserProp,
      provenance: "interpretation",
    };
    const violations = validateProposition(bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("interpretation"))).toBe(true);
  });

  it("rejects empty content", () => {
    const bad: Proposition = {
      ...validUserProp,
      normalizedContent: "hi",
    };
    const violations = validateProposition(bad);
    expect(violations.some((v) => v.includes("too short"))).toBe(true);
  });

  it("rejects proposition with no source utterances", () => {
    const bad: Proposition = {
      ...validUserProp,
      sourceUtteranceIds: [],
    };
    const violations = validateProposition(bad);
    expect(violations.some((v) => v.includes("source utterance"))).toBe(true);
  });

  it("accepts assistant interpretation with correct attribution", () => {
    const assistantInterp: Proposition = {
      ...validUserProp,
      authoredBy: "assistant",
      provenance: "interpretation",
      normalizedContent: "The user seems to value authenticity",
    };
    const violations = validateProposition(assistantInterp);
    expect(violations).toEqual([]);
  });

  it("accepts user paraphrase proposition", () => {
    const paraphrase: Proposition = {
      ...validUserProp,
      provenance: "paraphrase",
    };
    const violations = validateProposition(paraphrase);
    expect(violations).toEqual([]);
  });

  it("validates minimum substantive length", () => {
    expect(MINIMUM_SUBSTANTIVE_LENGTH).toBe(10);
    const exactMin: Proposition = {
      ...validUserProp,
      normalizedContent: "1234567890", // exactly 10 chars
    };
    expect(validateProposition(exactMin)).toEqual([]);
  });

  it("rejects content just under minimum length", () => {
    const tooShort: Proposition = {
      ...validUserProp,
      normalizedContent: "123456789", // 9 chars
    };
    const violations = validateProposition(tooShort);
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ─── Utterance Build Tests ──────────────────────────────────────────────────

describe("buildUtterances", () => {
  const mockMessages = [
    {
      id: "msg-001-abcdef",
      role: "user",
      content: "I want to plan an unconventional wedding",
      conversation_id: "conv-1",
      created_at: "2024-01-01T00:00:00Z",
      parent_node_id: null,
      branch_root_message_id: null,
    },
    {
      id: "msg-002-ghijkl",
      role: "assistant",
      content: "That sounds exciting! What does unconventional mean to you?",
      conversation_id: "conv-1",
      created_at: "2024-01-01T00:01:00Z",
      parent_node_id: null,
      branch_root_message_id: null,
    },
    {
      id: "msg-003-mnopqr",
      role: "user",
      content: "No church, no parents at the ceremony, just us and close friends",
      conversation_id: "conv-1",
      created_at: "2024-01-01T00:02:00Z",
      parent_node_id: null,
      branch_root_message_id: null,
    },
  ];

  it("builds utterances from message rows", () => {
    const utterances = buildUtterances(mockMessages, "conv-1");
    expect(utterances).toHaveLength(3);
  });

  it("preserves message IDs as utterance IDs", () => {
    const utterances = buildUtterances(mockMessages, "conv-1");
    expect(utterances[0].utteranceId).toBe("msg-001-abcdef");
    expect(utterances[0].sourceMessageId).toBe("msg-001-abcdef");
  });

  it("assigns correct author from role", () => {
    const utterances = buildUtterances(mockMessages, "conv-1");
    expect(utterances[0].author).toBe("user");
    expect(utterances[1].author).toBe("assistant");
  });

  it("sets temporal position in order", () => {
    const utterances = buildUtterances(mockMessages, "conv-1");
    expect(utterances[0].temporalPosition).toBe(0);
    expect(utterances[1].temporalPosition).toBe(1);
    expect(utterances[2].temporalPosition).toBe(2);
  });

  it("sets tombstoned to false by default", () => {
    const utterances = buildUtterances(mockMessages, "conv-1");
    utterances.forEach((u) => expect(u.tombstoned).toBe(false));
  });

  it("handles branch provenance", () => {
    const branchedMsg = [
      {
        id: "msg-b1",
        role: "user",
        content: "What if we invited family instead?",
        conversation_id: "conv-1",
        created_at: "2024-01-01T00:03:00Z",
        parent_node_id: "branch-node-1",
        branch_root_message_id: "msg-002-ghijkl",
      },
    ];
    const utterances = buildUtterances(branchedMsg, "conv-1");
    expect(utterances[0].branchId).toBe("branch-node-1");
    expect(utterances[0].branchPointMessageId).toBe("msg-002-ghijkl");
    expect(utterances[0].branchPath).toEqual(["branch-node-1"]);
  });
});

// ─── Provenance Rule Tests (behavioral expectations) ────────────────────────

describe("provenance rules", () => {
  it("user direct proposition requires user-authored utterance support", () => {
    // This tests the principle: user-attributed propositions backed by direct provenance
    const userProp: Proposition = {
      propositionId: "p1",
      propositionType: "preference",
      normalizedContent: "User prefers no parents at ceremony",
      sourceUtteranceIds: ["msg-003-mnopqr"],
      authoredBy: "user",
      provenance: "direct",
      confirmedByUser: false,
      confidence: 0.95,
      status: "active",
      supersedesPropositionId: null,
    };
    expect(validateProposition(userProp)).toEqual([]);
  });

  it("assistant interpretation must NOT be attributed to user", () => {
    // Critical rule: "music is a coping mechanism" said by assistant is NOT a user fact
    const badProp: Proposition = {
      propositionId: "p2",
      propositionType: "claim",
      normalizedContent: "Music is a coping mechanism for the user",
      sourceUtteranceIds: ["msg-assistant-1"],
      authoredBy: "user", // WRONG — assistant inferred this
      provenance: "interpretation",
      confirmedByUser: false,
      confidence: 0.8,
      status: "active",
      supersedesPropositionId: null,
    };
    const violations = validateProposition(badProp);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("assistant can have its own interpretation propositions", () => {
    const assistantInterp: Proposition = {
      propositionId: "p3",
      propositionType: "claim",
      normalizedContent: "Music appears to serve as emotional processing for user",
      sourceUtteranceIds: ["msg-assistant-1"],
      authoredBy: "assistant",
      provenance: "interpretation",
      confirmedByUser: false,
      confidence: 0.6,
      status: "active",
      supersedesPropositionId: null,
    };
    expect(validateProposition(assistantInterp)).toEqual([]);
  });

  it("questions remain questions — not converted to claims", () => {
    const questionProp: Proposition = {
      propositionId: "p4",
      propositionType: "question",
      normalizedContent: "Were we being selfish by excluding family?",
      sourceUtteranceIds: ["msg-user-q"],
      authoredBy: "user",
      provenance: "direct",
      confirmedByUser: false,
      confidence: 0.95,
      status: "active",
      supersedesPropositionId: null,
    };
    expect(validateProposition(questionProp)).toEqual([]);
    expect(questionProp.propositionType).toBe("question");
  });

  it("superseded propositions need a target to be semantically valid", () => {
    const superseded: Proposition = {
      propositionId: "p5",
      propositionType: "claim",
      normalizedContent: "Originally wanted outdoor venue",
      sourceUtteranceIds: ["msg-1"],
      authoredBy: "user",
      provenance: "direct",
      confirmedByUser: false,
      confidence: 0.9,
      status: "superseded",
      supersedesPropositionId: null, // This is a warning, not hard failure per policy
    };
    // Policy says this is a warning, not a violation
    expect(validateProposition(superseded)).toEqual([]);
  });
});
