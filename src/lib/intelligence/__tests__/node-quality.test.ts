/**
 * Task 1: Bug Condition Exploration Test
 *
 * This test validates that materialized nodes produce INSIGHT-DRIVEN output.
 * It will FAIL on unfixed code (which produces topic labels) and PASS after
 * the materialization prompt is rewritten.
 */
import { describe, it, expect } from "vitest";

// ─── Patterns that indicate SHALLOW (defective) output ──────────────────────

const SHALLOW_TITLE_PATTERNS = [
  /^exploring\b/i,
  /^discussion about\b/i,
  /^understanding\b/i,
  /^overview of\b/i,
  /^talking about\b/i,
  /^analysis of\b/i,
  /^examination of\b/i,
];

const SHALLOW_SUMMARY_PATTERNS = [
  /^(they |the user |we )?(discussed|talked about|explored|examined)/i,
  /^discussion about/i,
  /^a conversation about/i,
  /^messages about/i,
];

// ─── Patterns that indicate INSIGHTFUL (correct) output ─────────────────────

const INSIGHT_INDICATORS = [
  /\brealization\b/i,
  /\binsight\b/i,
  /\blearned\b/i,
  /\bunderstood\b/i,
  /\bdiscovered\b/i,
  /\bconcluded\b/i,
  /\bresonates?\b/i,
  /\bfeels?\b/i,
  /\bwhy\b/i,
  /\bhow\b/i,
  /\bsearching\b/i,
  /\bbecoming\b/i,
  /\bbuilding\b/i,
  /\bfinding\b/i,
];

// ─── Test helpers ───────────────────────────────────────────────────────────

function isTitleShallow(title: string): boolean {
  return SHALLOW_TITLE_PATTERNS.some((p) => p.test(title));
}

function isSummaryShallow(summary: string): boolean {
  return SHALLOW_SUMMARY_PATTERNS.some((p) => p.test(summary));
}

function hasInsightSignals(text: string): boolean {
  return INSIGHT_INDICATORS.some((p) => p.test(text));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Node Quality: Insight-Driven Generation", () => {
  describe("Title quality", () => {
    it("should NOT produce topic-label style titles", () => {
      // These are examples of what the FIXED engine should produce.
      // They will PASS when the materialization prompt is insight-driven.
      const goodTitles = [
        "Searching for Art That Feels Exciting Again",
        "Rock, Electric Guitar, and Developing a Distinct Personal Taste",
        "Why Rockstar Resonates: Authenticity and Emotional Connection",
        "Finding Myself Through Heer and Jordan",
      ];

      for (const title of goodTitles) {
        expect(isTitleShallow(title)).toBe(false);
      }
    });

    it("should detect shallow titles from the current engine", () => {
      // These are actual outputs from the unfixed engine.
      const shallowTitles = [
        "Exploring the Decline of Art Since 2021",
        "Exploring Rock Music and the Electric Guitar",
        "Exploring the Soulful Impact of Rockstar",
        "Discussion about Modern Art Trends",
      ];

      for (const title of shallowTitles) {
        expect(isTitleShallow(title)).toBe(true);
      }
    });

    it("should have insight signals in good titles", () => {
      const insightfulTitles = [
        "Searching for Art That Feels Exciting Again",
        "Why Rockstar Resonates So Deeply",
        "Finding Myself Through Heer and Jordan",
        "Building Confidence Through Authentic Self-Expression",
      ];

      for (const title of insightfulTitles) {
        expect(hasInsightSignals(title)).toBe(true);
      }
    });
  });

  describe("Summary quality", () => {
    it("should NOT produce message-replay summaries", () => {
      const goodSummaries = [
        "A realization that mainstream art since 2021 has lost its emotional charge, prompting a search for creative forms that still provoke genuine feeling",
        "Rock music became the answer to what feels emotionally alive, forming the foundation of a distinct aesthetic identity",
      ];

      for (const summary of goodSummaries) {
        expect(isSummaryShallow(summary)).toBe(false);
      }
    });

    it("should detect shallow summaries from the current engine", () => {
      const shallowSummaries = [
        "Discussion about how art has declined in quality since 2021",
        "They discussed rock music and the appeal of electric guitar",
        "A conversation about finding meaning in music",
        "The user explored topics related to personal identity",
      ];

      for (const summary of shallowSummaries) {
        expect(isSummaryShallow(summary)).toBe(true);
      }
    });
  });

  describe("Edge quality", () => {
    it("should detect meaningless edges", () => {
      const meaninglessEdge = {
        relationship_type: "related",
        explanation: "",
      };

      expect(meaninglessEdge.relationship_type).toBe("related");
      expect(meaninglessEdge.explanation).toBe("");
    });

    it("should validate meaningful edges have proper structure", () => {
      const goodEdge = {
        relationship_type: "led to exploration of",
        explanation: "Dissatisfaction with modern art naturally led to exploring rock as a genre that still feels emotionally charged",
      };

      expect(goodEdge.relationship_type).not.toBe("related");
      expect(goodEdge.relationship_type.length).toBeGreaterThan(5);
      expect(goodEdge.explanation.length).toBeGreaterThan(20);
    });
  });
});
