/**
 * Tests for the shared LLM JSON parser.
 */
import { describe, it, expect } from "vitest";
import { parseJsonFromLLM, LLMParseError } from "../llmJson";

describe("parseJsonFromLLM", () => {
  // ─── Valid cases ────────────────────────────────────────────────────────────

  it("parses a raw JSON array", () => {
    const result = parseJsonFromLLM('[{"a": 1}, {"b": 2}]');
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("parses a raw JSON object", () => {
    const result = parseJsonFromLLM('{"title": "hello", "summary": "world"}');
    expect(result).toEqual({ title: "hello", summary: "world" });
  });

  it("parses a fenced json array (```json)", () => {
    const input = '```json\n[{"type": "claim", "content": "test"}]\n```';
    const result = parseJsonFromLLM(input);
    expect(result).toEqual([{ type: "claim", content: "test" }]);
  });

  it("parses a fenced JSON object (```json)", () => {
    const input = '```json\n{"title": "Test", "summary": "Summary"}\n```';
    const result = parseJsonFromLLM(input);
    expect(result).toEqual({ title: "Test", summary: "Summary" });
  });

  it("parses a fence with no language label (```)", () => {
    const input = '```\n[{"x": 1}]\n```';
    const result = parseJsonFromLLM(input);
    expect(result).toEqual([{ x: 1 }]);
  });

  it("handles surrounding whitespace", () => {
    const input = '  \n  [{"a": 1}]  \n  ';
    const result = parseJsonFromLLM(input);
    expect(result).toEqual([{ a: 1 }]);
  });

  it("handles backticks inside a JSON string value", () => {
    // The key case: backticks in string values should NOT be treated as fences
    const input = '[{"code": "use `const` instead of `var`"}]';
    const result = parseJsonFromLLM(input);
    expect(result).toEqual([{ code: "use `const` instead of `var`" }]);
  });

  it("handles uppercase JSON label in fence", () => {
    const input = '```JSON\n[{"a": 1}]\n```';
    // Our parser handles this because it strips the opening line regardless of label
    const result = parseJsonFromLLM(input);
    expect(result).toEqual([{ a: 1 }]);
  });

  it("handles JSON with leading text before the opening bracket", () => {
    const input = 'Here is the result:\n[{"a": 1}]';
    const result = parseJsonFromLLM(input);
    expect(result).toEqual([{ a: 1 }]);
  });

  // ─── Error cases ────────────────────────────────────────────────────────────

  it("throws LLMParseError for empty response", () => {
    expect(() => parseJsonFromLLM("")).toThrow(LLMParseError);
    try {
      parseJsonFromLLM("");
    } catch (e) {
      expect(e).toBeInstanceOf(LLMParseError);
      expect((e as LLMParseError).category).toBe("empty_response");
    }
  });

  it("throws LLMParseError for incomplete fenced JSON (truncated)", () => {
    const input = '```json\n[{"type": "claim", "content": "hello"';
    expect(() => parseJsonFromLLM(input)).toThrow(LLMParseError);
    try {
      parseJsonFromLLM(input);
    } catch (e) {
      expect(e).toBeInstanceOf(LLMParseError);
      expect((e as LLMParseError).category).toBe("truncated");
    }
  });

  it("throws LLMParseError for malformed JSON", () => {
    const input = '[{"a": 1}, {"b": ]';
    expect(() => parseJsonFromLLM(input)).toThrow(LLMParseError);
    try {
      parseJsonFromLLM(input);
    } catch (e) {
      expect(e).toBeInstanceOf(LLMParseError);
      expect((e as LLMParseError).category).toBe("malformed");
      expect((e as LLMParseError).originalError).toBeTruthy();
    }
  });

  it("throws LLMParseError when no JSON is present", () => {
    const input = "I cannot help with that request.";
    expect(() => parseJsonFromLLM(input)).toThrow(LLMParseError);
    try {
      parseJsonFromLLM(input);
    } catch (e) {
      expect(e).toBeInstanceOf(LLMParseError);
      expect((e as LLMParseError).category).toBe("no_json_found");
    }
  });

  it("provides rawLength and preview on error", () => {
    const input = "no json here at all, just text";
    try {
      parseJsonFromLLM(input);
    } catch (e) {
      expect(e).toBeInstanceOf(LLMParseError);
      expect((e as LLMParseError).rawLength).toBe(input.length);
      expect((e as LLMParseError).preview.length).toBeGreaterThan(0);
    }
  });
});
