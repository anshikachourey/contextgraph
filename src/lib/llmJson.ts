/**
 * Robust JSON parser for LLM responses.
 *
 * LLMs sometimes return JSON wrapped in markdown code fences,
 * even when instructed not to. This helper handles:
 * - Raw JSON object: {"title": "..."}
 * - Raw JSON array: [{"a": 1}]
 * - JSON in ```json fenced block
 * - JSON in ```JSON fenced block
 * - JSON in ``` fenced block (no language label)
 * - Leading/trailing whitespace and explanatory text
 *
 * Does NOT:
 * - Fabricate missing brackets or content
 * - Silently fix malformed JSON
 * - Use heuristics that can damage JSON string values
 *
 * Throws a LLMParseError with structured diagnostics on failure.
 */

export type ParseErrorCategory = "empty_response" | "no_json_found" | "truncated" | "malformed" | "not_json";

export class LLMParseError extends Error {
  category: ParseErrorCategory;
  rawLength: number;
  preview: string;
  originalError: string | null;

  constructor(
    category: ParseErrorCategory,
    message: string,
    rawLength: number,
    preview: string,
    originalError: string | null = null,
  ) {
    super(message);
    this.name = "LLMParseError";
    this.category = category;
    this.rawLength = rawLength;
    this.preview = preview;
    this.originalError = originalError;
  }
}

/**
 * Parse a JSON value from an LLM response string.
 * Handles code fences, whitespace, and common LLM wrappers.
 * Throws LLMParseError with structured diagnostics on failure.
 */
export function parseJsonFromLLM(raw: string): unknown {
  if (!raw || raw.trim().length === 0) {
    throw new LLMParseError("empty_response", "Empty LLM response", 0, "", null);
  }

  const cleaned = stripFences(raw.trim());

  // Locate the start of JSON content — either [ or {
  const arrayStart = cleaned.indexOf("[");
  const objectStart = cleaned.indexOf("{");

  let jsonStart: number;
  if (arrayStart === -1 && objectStart === -1) {
    throw new LLMParseError(
      "no_json_found",
      "No JSON array or object found in response",
      raw.length,
      raw.slice(0, 200),
      null,
    );
  } else if (arrayStart === -1) {
    jsonStart = objectStart;
  } else if (objectStart === -1) {
    jsonStart = arrayStart;
  } else {
    jsonStart = Math.min(arrayStart, objectStart);
  }

  // Find the matching close bracket
  const openChar = cleaned[jsonStart];
  const closeChar = openChar === "[" ? "]" : "}";
  const jsonEnd = cleaned.lastIndexOf(closeChar);

  if (jsonEnd <= jsonStart) {
    throw new LLMParseError(
      "truncated",
      `JSON starts with '${openChar}' at position ${jsonStart} but no matching '${closeChar}' found. Response may be truncated.`,
      raw.length,
      raw.slice(0, 200),
      null,
    );
  }

  const jsonCandidate = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    return JSON.parse(jsonCandidate);
  } catch (e) {
    const originalMsg = e instanceof Error ? e.message : "Unknown parse error";
    throw new LLMParseError(
      "malformed",
      `JSON parse failed: ${originalMsg}`,
      raw.length,
      jsonCandidate.slice(0, 200),
      originalMsg,
    );
  }
}

/**
 * Strip markdown code fences from LLM output.
 * Handles: ```json, ```JSON, ``` (no label), with or without closing fence.
 * Does NOT use regex on backticks inside JSON string values — operates only on outer structure.
 */
function stripFences(text: string): string {
  // Full fence: starts with ``` and ends with ```
  // Match opening fence line: ```json or ```JSON or ``` (possibly with trailing whitespace)
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline === -1) {
      // Single line starting with ``` — strip the prefix
      return text.slice(3).trim();
    }

    // Check if there's a closing fence
    const closingFenceIdx = text.lastIndexOf("```");
    if (closingFenceIdx > firstNewline) {
      // Extract content between opening fence line and closing fence
      return text.slice(firstNewline + 1, closingFenceIdx).trim();
    } else {
      // No closing fence — truncated fenced response. Strip opening fence line.
      return text.slice(firstNewline + 1).trim();
    }
  }

  return text;
}

/**
 * Type guard for LLM responses that should contain { title: string, summary: string }.
 * Use after parseJsonFromLLM to safely access title/summary fields.
 */
export type TitleSummaryResponse = { title: string; summary: string };

export function isTitleSummaryResponse(
  value: unknown,
): value is TitleSummaryResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).summary === "string"
  );
}
