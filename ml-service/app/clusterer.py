"""BERTopic-style clustering with agglomerative fallback.

Primary: Sentence Transformers → UMAP → HDBSCAN
Fallback: Agglomerative clustering with cosine distance threshold

HDBSCAN is a density-based algorithm that requires enough points to detect
dense regions. For short conversations (5–10 chunks), it often labels
everything as noise. The agglomerative fallback uses hierarchical merging
with a fixed distance threshold, which always produces clusters regardless
of data density.

Configuration via environment variables:
  DISABLE_UMAP=1       → skip UMAP, cluster in full 384-d space
  MIN_CLUSTER_SIZE=N   → HDBSCAN minimum cluster size (default: 3)
  MIN_SAMPLES=N        → HDBSCAN minimum samples (default: 2)
  FALLBACK_THRESHOLD=X → cosine distance threshold for fallback (default: 0.5)
"""

import os
import hdbscan
import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics.pairwise import cosine_distances

# ─── Configurable parameters (via env vars with defaults) ────────────────────

MIN_CLUSTER_SIZE = int(os.environ.get("MIN_CLUSTER_SIZE", "3"))
MIN_SAMPLES = int(os.environ.get("MIN_SAMPLES", "2"))

# Cosine distance threshold for agglomerative fallback.
# Lower = more aggressive merging (fewer, larger clusters).
# Higher = more clusters (more sensitive to differences).
# 0.5 cosine distance ≈ 0.5 cosine similarity — reasonable boundary.
FALLBACK_DISTANCE_THRESHOLD = float(os.environ.get("FALLBACK_THRESHOLD", "0.5"))

# Maximum clusters from fallback (prevents over-segmentation)
FALLBACK_MAX_CLUSTERS = 5

# Minimum useful clusters — if HDBSCAN returns fewer, trigger fallback
MIN_USEFUL_CLUSTERS = 2

# ─── UMAP parameters ────────────────────────────────────────────────────────

UMAP_N_COMPONENTS = 5
UMAP_N_NEIGHBORS = 15
UMAP_MIN_DIST = 0.0
UMAP_METRIC = "cosine"

UMAP_ENABLED = os.environ.get("DISABLE_UMAP", "0") != "1"

# ─── Track which method was used (exposed to main.py) ────────────────────────

last_method_used: str = "none"


def reduce_dimensions(embeddings: np.ndarray) -> np.ndarray:
    """Reduce embedding dimensionality using UMAP."""
    import umap

    reducer = umap.UMAP(
        n_components=UMAP_N_COMPONENTS,
        n_neighbors=min(UMAP_N_NEIGHBORS, len(embeddings) - 1),
        min_dist=UMAP_MIN_DIST,
        metric=UMAP_METRIC,
        random_state=42,
    )
    reduced = reducer.fit_transform(embeddings)
    return np.array(reduced)


def _hdbscan_cluster(data: np.ndarray) -> np.ndarray:
    """Run HDBSCAN on the (possibly reduced) data."""
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=MIN_CLUSTER_SIZE,
        min_samples=MIN_SAMPLES,
        metric="euclidean",
        cluster_selection_epsilon=0.0,
    )
    return clusterer.fit_predict(data)


def _agglomerative_fallback(embeddings: np.ndarray) -> np.ndarray:
    """
    Fallback: hierarchical agglomerative clustering with cosine distance.

    Uses a distance threshold to merge similar chunks. Unlike HDBSCAN,
    this always produces clusters regardless of data density.

    Operates on the ORIGINAL embeddings (not UMAP-reduced) because
    cosine distance is meaningful in the full 384-d sentence-transformer space.
    """
    n_samples = len(embeddings)

    if n_samples <= 1:
        return np.array([0] * n_samples)

    # Compute cosine distance matrix
    dist_matrix = cosine_distances(embeddings)

    # AgglomerativeClustering with distance_threshold
    # n_clusters=None means the threshold controls the number of clusters
    agg = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=FALLBACK_DISTANCE_THRESHOLD,
        metric="precomputed",
        linkage="average",
    )
    labels = agg.fit_predict(dist_matrix)

    # Cap at max clusters — if over, re-run with explicit n_clusters
    unique_clusters = len(set(labels))
    if unique_clusters > FALLBACK_MAX_CLUSTERS:
        agg_capped = AgglomerativeClustering(
            n_clusters=FALLBACK_MAX_CLUSTERS,
            metric="precomputed",
            linkage="average",
        )
        labels = agg_capped.fit_predict(dist_matrix)

    return labels


def cluster_embeddings(embeddings: np.ndarray) -> np.ndarray:
    """
    Full clustering pipeline with fallback:

    1. Try HDBSCAN (with optional UMAP reduction)
    2. If HDBSCAN returns < MIN_USEFUL_CLUSTERS real clusters,
       fall back to agglomerative clustering on raw embeddings

    Returns an array of cluster labels (shape: (n_samples,)).
    Label -1 means noise (only from HDBSCAN path).
    Agglomerative fallback never produces -1 labels.

    Sets module-level `last_method_used` for observability.
    """
    global last_method_used

    if len(embeddings) < 2:
        last_method_used = "none"
        return np.array([-1] * len(embeddings))

    # ─── Primary: UMAP + HDBSCAN ──────────────────────────────────────────

    if UMAP_ENABLED and len(embeddings) > UMAP_N_COMPONENTS + 1:
        data = reduce_dimensions(embeddings)
    else:
        data = embeddings

    labels = _hdbscan_cluster(data)

    # Count real clusters (excluding noise label -1)
    real_clusters = len(set(labels)) - (1 if -1 in labels else 0)

    if real_clusters >= MIN_USEFUL_CLUSTERS:
        last_method_used = "hdbscan"
        return labels

    # ─── Fallback: Agglomerative clustering ────────────────────────────────

    # Use original (non-UMAP) embeddings for cosine distance
    labels = _agglomerative_fallback(embeddings)
    last_method_used = "agglomerative_fallback"
    return labels
