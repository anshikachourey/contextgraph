/**
 * Neighborhood color derivation.
 *
 * Hue: identifies the conceptual family (from neighborhood)
 * Lightness: identifies hierarchy depth (darker = more abstract)
 *
 * Returns CSS color strings for use in React Flow node cards.
 */

export function nodeColorFromNeighborhood(
  hue: number | null,
  depth: number,
): { borderColor: string; textColor: string } | null {
  if (hue === null) return null; // no neighborhood assigned → use default style

  const saturation = 55;
  const lightness = Math.min(80, 35 + depth * 15);

  return {
    borderColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
    textColor: `hsl(${hue}, ${saturation + 10}%, ${Math.max(20, lightness - 20)}%)`,
  };
}
