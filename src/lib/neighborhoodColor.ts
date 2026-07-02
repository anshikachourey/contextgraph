/**
 * Neighborhood color derivation.
 *
 * Hue: identifies the conceptual family (from neighborhood)
 * Lightness: identifies hierarchy depth (darker = more abstract)
 *
 * Returns CSS color strings for subtle node card styling:
 * - borderColor: card border
 * - accentColor: top accent bar (slightly darker/richer than border)
 */

export function nodeColorFromNeighborhood(
  hue: number | null,
  depth: number,
): { borderColor: string; accentColor: string } | null {
  if (hue === null || hue === undefined) return null;

  const saturation = 58;
  // Depth 0: 40% (rich, visible). Depth 1: 52%. Depth 2: 64%. Cap at 72%.
  const lightness = Math.min(72, 40 + depth * 12);
  // Accent is slightly darker/more saturated than the border
  const accentLightness = Math.max(28, lightness - 10);

  return {
    borderColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
    accentColor: `hsl(${hue}, ${saturation + 8}%, ${accentLightness}%)`,
  };
}
