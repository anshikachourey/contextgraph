/**
 * Robust JSON parser for LLM responses.
 *
 * LLMs sometimes return JSON wrapped in markdown code fences,
 * even when instructed not to. This helper handles:
 * - Raw JSON object: {"title": "..."}
 * - JSON in ```json fenced block
 * - JSON in ``` fenced block (no language tag)
 * - Leading/trailing whitespace
 * - Leading/trailing newlines
 *
 * Throws if the cleaned string is still not valid JSON.
 */
export function parseJsonFromLLM(raw: string): unknown {
  let cleaned = raw.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fencedMatch = cleaned.match(
    /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/,
  );
  if (fencedMatch) {
    cleaned = fencedMatch[1].trim();
  }

  return JSON.parse(cleaned);
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
