export type ContextNode = {
  id: string;
  title: string;
  summary: string;
  messageIds: string[];
  // Neighborhood + hierarchy (for color derivation)
  neighborhoodHue: number | null;
  hierarchyDepth: number;
};
