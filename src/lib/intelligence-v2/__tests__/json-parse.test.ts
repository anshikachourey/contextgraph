/**
 * Tests for the V2 pipeline JSON array parser.
 */
import { describe, it, expect } from "vitest";
import { parseJsonArrayFromLLM } from "../json-parse";

describe("parseJsonArrayFromLLM", () => {
  it("parses a raw JSON array", () => {
    const result = parseJsonArrayFromLLM('[{"a": 1}]');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ a: 1 }]);
  });

  it("parses a fenced json array", () => {
    const input = '```json\n[{"type": "claim", "content": "test"}]\n```';
    const result = parseJsonArrayFromLLM(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ type: "claim", content: "test" }]);
  });

  it("parses a fenced array with no language label", () => {
    const input = '```\n[{"x": 1}]\n```';
    const result = parseJsonArrayFromLLM(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ x: 1 }]);
  });

  it("parses fenced array with JSON label (uppercase)", () => {
    const input = '```JSON\n[{"a": 1}]\n```';
    const result = parseJsonArrayFromLLM(input);
    expect(result.success).toBe(true);
  });

  it("handles surrounding whitespace", () => {
    const input = '   \n[{"a": 1}]\n   ';
    const result = parseJsonArrayFromLLM(input);
    expect(result.success).toBe(true);
  });

  it("rejects a JSON object (not an array)", () => {
    const result = parseJsonArrayFromLLM('{"title": "hello"}');
    expect(result.success).toBe(false);
    expect(result.error).toContain("not an array");
  });

  it("rejects empty response", () => {
    const result = parseJsonArrayFromLLM("");
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty_response");
  });

  it("rejects truncated JSON array", () => {
    const input = '```json\n[{"type": "claim"}, {"type": "q';
    const result = parseJsonArrayFromLLM(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("truncated");
  });

  it("rejects malformed JSON", () => {
    const input = '[{"a": 1,, "b": 2}]';
    const result = parseJsonArrayFromLLM(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("malformed");
  });

  it("handles backticks inside JSON string values", () => {
    const input = '[{"code": "use `let` here"}]';
    const result = parseJsonArrayFromLLM(input);
    expect(result.success).toBe(true);
    expect(result.data![0].code).toBe("use `let` here");
  });

  it("handles the exact fenced-JSON pattern that crashed object formation", () => {
    const input = '```json\n[\n  {\n    "objectType": "inquiry",\n    "title": "Wedding planning approach?",\n    "description": "Exploring options",\n    "propositionIds": ["prop-0"],\n    "threadIds": ["thread-0"],\n    "maturity": "nascent",\n    "status": "active",\n    "provenanceSummary": "prop-0"\n  }\n]\n```';
    const result = parseJsonArrayFromLLM(input);
    expect(result.success).toBe(true);
    expect(result.data!.length).toBe(1);
    expect(result.data![0].objectType).toBe("inquiry");
  });
});
