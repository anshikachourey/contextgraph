"""Semantic grouping via pairwise similarity graph + connected components.

Replaces HDBSCAN for segment grouping. HDBSCAN is unreliable when there
are only a few segments (3–10) because density estimation is meaningless
at that scale.

Instead:
1. Compute cosine similarity between every pair of segment centroids.
2. Build a graph where edge = similarity >= threshold.
3. Find connected components → each component = one semantic group.

This is deterministic, interpretable, and works with any number of segments.
"""

import os
import numpy as np

# ─── Configuration ───────────────────────────────────────────────────────────

# Minimum cosine similarity between segment centroids to consider them related.
# Segments above this threshold get connected in the similarity graph.
SEGMENT_GROUP_THRESHOLD = float(os.environ.get("SEGMENT_GROUP_THRESHOLD", "0.60"))


# ─── Types ───────────────────────────────────────────────────────────────────

class SimilarityEdge:
    """A similarity relationship between two segments."""
    def __init__(self, seg_a: int, seg_b: int, score: float):
        self.seg_a = seg_a
        self.seg_b = seg_b
        self.score = score


class GroupingResult:
    """Result of semantic grouping."""
    def __init__(
        self,
        groups: list[list[int]],  # each group = list of segment indices
        edges: list[SimilarityEdge],  # all edges above threshold
        all_pairs: list[SimilarityEdge],  # ALL pairwise scores (for debugging)
    ):
        self.groups = groups
        self.edges = edges
        self.all_pairs = all_pairs


# ─── Algorithm ───────────────────────────────────────────────────────────────

def _find_connected_components(n_nodes: int, edges: list[tuple[int, int]]) -> list[list[int]]:
    """Find connected components using BFS."""
    adj: dict[int, set[int]] = {i: set() for i in range(n_nodes)}
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)

    visited: set[int] = set()
    components: list[list[int]] = []

    for node in range(n_nodes):
        if node in visited:
            continue
        component: list[int] = []
        queue = [node]
        visited.add(node)
        while queue:
            current = queue.pop(0)
            component.append(current)
            for neighbor in adj[current]:
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)
        components.append(sorted(component))

    return components


def group_segments_by_similarity(centroids: np.ndarray) -> GroupingResult:
    """
    Group segments using pairwise cosine similarity + connected components.

    Args:
        centroids: numpy array of shape (n_segments, embedding_dim)
                   Each row is a normalized segment centroid.

    Returns:
        GroupingResult with groups, threshold-passing edges, and all pairwise scores.
    """
    n = len(centroids)

    if n < 2:
        return GroupingResult(
            groups=[[0]] if n == 1 else [],
            edges=[],
            all_pairs=[],
        )

    # Compute ALL pairwise cosine similarities
    all_pairs: list[SimilarityEdge] = []
    threshold_edges: list[SimilarityEdge] = []
    graph_edges: list[tuple[int, int]] = []

    for i in range(n):
        for j in range(i + 1, n):
            # Both centroids should be normalized, so dot product = cosine similarity
            sim = float(np.dot(centroids[i], centroids[j]))
            all_pairs.append(SimilarityEdge(i, j, sim))

            if sim >= SEGMENT_GROUP_THRESHOLD:
                threshold_edges.append(SimilarityEdge(i, j, sim))
                graph_edges.append((i, j))

    # Find connected components
    components = _find_connected_components(n, graph_edges)

    # Only return components with 2+ members as "groups"
    # Single-segment components are ungrouped
    groups = [comp for comp in components if len(comp) >= 2]

    return GroupingResult(
        groups=groups,
        edges=threshold_edges,
        all_pairs=sorted(all_pairs, key=lambda e: e.score, reverse=True),
    )
