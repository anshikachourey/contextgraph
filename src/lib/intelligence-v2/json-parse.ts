/**
 * Robust JSON array parser for V2 pipeline LLM responses.
 *
 * Wraps the shared parseJsonFromLLM with array-specific validation
 * and returns a typed result (never throws).
 *
 * Handles:
 * - Markdown code fences (```json ... ```, ```JSON ... ```, ``` ... ```)
 * - Leading/trailing whitespace
 * - Detects truncated arrays (incomplete JSON)
 *
 * Does NOT:
 * - Fabricate missing braces or content
 * - Silently fix malformed data
 * - Accept non-array responses as arrays
 */

import { parseJsonFromLLM, LLMParseError } from "@/src/lib/llmJson";

export interface ParseSuccess {
  success: true;
  data: Array<Record<string, unknown>>;
  error: null;
}

export interface ParseFailure {
  success: false;
  data: null;
  error: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Parse an LLM response that should contain a JSON array.
 * Returns a typed result — never throws.
 */
export function parseJsonArrayFromLLM(raw: string): ParseResult {
  try {
    const parsed = parseJsonFromLLM(raw);
    if (!Array.isArray(parsed)) {
      return { success: false, data: null, error: `Parsed value is ${typeof parsed}, not an array` };
    }
    return { success: true, data: parsed as Array<Record<string, unknown>>, error: null };
  } catch (e) {
    if (e instanceof LLMParseError) {
      return {
        success: false,
        data: null,
        error: `[${e.category}] ${e.message}. Response length: ${e.rawLength} chars. Preview: "${e.preview.slice(0, 100)}"`,
      };
    }
    const msg = e instanceof Error ? e.message : "Unknown parse error";
    return { success: false, data: null, error: msg };
  }
}
