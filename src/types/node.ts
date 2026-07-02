export type ContextNode = {
  id: string;
  title: string;
  summary: string;
  messageIds: string[];
  // Neighborhood + hierarchy (for color derivation) — optional, default to null/0 when absent
  neighborhoodHue?: number | null;
  hierarchyDepth?: number;
};
