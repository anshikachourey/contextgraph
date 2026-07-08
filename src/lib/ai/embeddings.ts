/**
 * Embedding abstraction.
 *
 * Re-exports embed() from provider and adds the domain helper
 * for building canonical node embedding text.
 */

export { embed } from "./provider";

/**
 * Build the canonical text used for node embeddings.
 * ALL node embedding paths must use this function.
 */
export function buildNodeEmbeddingText(
  title: string,
  summary: string,
  evidenceSummary: string | null,
): string {
  const parts = [`Title: ${title}`, `Summary: ${summary}`];
  if (evidenceSummary) {
    parts.push(`Key points:\n${evidenceSummary}`);
  }
  return parts.join("\n\n");
}
