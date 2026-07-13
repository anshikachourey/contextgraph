/**
 * Robust JSON array parser for LLM responses.
 *
 * Handles:
 * - Markdown code fences (```json ... ```)
 * - Leading/trailing whitespace
 * - Detects truncated arrays (incomplete JSON)
 *
 * Does NOT:
 * - Fabricate missing braces or content
 * - Silently fix malformed data
 * - Accept non-array responses as arrays
 */

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
  if (!raw || raw.trim().length === 0) {
    return { success: false, data: null, error: "Empty response" };
  }

  let cleaned = raw.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fencedMatch = cleaned.match(
    /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/,
  );
  if (fencedMatch) {
    cleaned = fencedMatch[1].trim();
  }

  // If fenced match failed but response starts with ``` try to extract content between fences
  if (!fencedMatch && cleaned.startsWith("```")) {
    const openEnd = cleaned.indexOf("\n");
    if (openEnd !== -1) {
      const closeIdx = cleaned.lastIndexOf("```");
      if (closeIdx > openEnd) {
        cleaned = cleaned.slice(openEnd + 1, closeIdx).trim();
      } else {
        // No closing fence — truncated response inside a fence
        cleaned = cleaned.slice(openEnd + 1).trim();
      }
    }
  }

  // Locate the outer array brackets
  const arrayStart = cleaned.indexOf("[");
  if (arrayStart === -1) {
    return { success: false, data: null, error: "No JSON array found — no opening bracket" };
  }

  // Find the matching closing bracket
  const arrayEnd = cleaned.lastIndexOf("]");

  if (arrayEnd === -1 || arrayEnd <= arrayStart) {
    // Truncated — array was started but never closed
    return {
      success: false,
      data: null,
      error: `Truncated JSON array — opening bracket at position ${arrayStart}, no matching closing bracket. Response length: ${raw.length} chars`,
    };
  }

  const jsonCandidate = cleaned.slice(arrayStart, arrayEnd + 1);

  // Attempt strict parse
  try {
    const parsed = JSON.parse(jsonCandidate);
    if (!Array.isArray(parsed)) {
      return { success: false, data: null, error: `Parsed value is ${typeof parsed}, not an array` };
    }
    return { success: true, data: parsed as Array<Record<string, unknown>>, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown parse error";
    return {
      success: false,
      data: null,
      error: `JSON parse failed: ${msg}. Array candidate length: ${jsonCandidate.length} chars. Last 50 chars: "${jsonCandidate.slice(-50)}"`,
    };
  }
}
