"""FastAPI ML service for conversation topic structuring.

Architecture (segmentation-first):
1. SEGMENTATION: Detect contiguous topic episodes via sliding-window
   cosine similarity drops. Each segment = a future graph node.
2. SEMANTIC GROUPING: Compute pairwise cosine similarity between segment
   centroids. Build a similarity graph. Connected components = groups.
   Groups identify related segments (e.g. early startup + late startup).
"""

import math
from fastapi import FastAPI, HTTPException
import numpy as np

from app.models import (
    Message,
    ClusterRequest,
    ClusterResponse,
    Segment,
    SemanticGroup,
    SegmentSimilarity,
)
from app.embedder import embed_messages, MODEL_NAME
from app.segmenter import segment_conversation
from app.grouper import group_segments_by_similarity, SEGMENT_GROUP_THRESHOLD
from app.sie.routes import router as sie_router

app = FastAPI(
    title="ContextGraph ML Service",
    description="Conversation structuring: segmentation + similarity-graph grouping",
    version="1.1.0",
)

# Register SIE pipeline routes (endpoint handles its own feature gating)
app.include_router(sie_router)


# ─── Safety helpers ──────────────────────────────────────────────────────────

def safe_centroid(vectors: np.ndarray, dim: int) -> list[float]:
    if vectors.size == 0:
        return [0.0] * dim
    centroid = np.mean(vectors, axis=0)
    norm = np.linalg.norm(centroid)
    if norm == 0 or math.isnan(norm):
        return [0.0] * dim
    return sanitize_floats((centroid / norm).tolist())


def sanitize_floats(values: list[float]) -> list[float]:
    return [0.0 if (math.isnan(v) or math.isinf(v)) else v for v in values]


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "grouping_threshold": SEGMENT_GROUP_THRESHOLD,
    }


@app.post("/cluster-conversation", response_model=ClusterResponse)
def cluster_conversation(request: ClusterRequest):
    """
    Two-stage conversation structuring:

    Stage 1 — SEGMENTATION:
      Sliding-window cosine similarity with adaptive threshold.
      Each contiguous block = one segment = one future graph node.

    Stage 2 — SEMANTIC GROUPING:
      Pairwise cosine similarity between segment centroids.
      Connected components over the similarity graph = semantic groups.
      Related segments share a group_id.
    """
    if len(request.messages) < 3:
        raise HTTPException(
            status_code=400,
            detail="At least 3 messages are required.",
        )

    # ─── Stage 1: Segmentation ────────────────────────────────────────────

    raw_segments = segment_conversation(request.messages)

    # Embed all messages for centroid computation
    msg_texts = [
        f"{'User' if m.role == 'user' else 'Assistant'}: {m.content}"
        for m in request.messages
    ]
    all_embeddings = embed_messages(msg_texts)
    embedding_dim = all_embeddings.shape[1]

    id_to_idx = {m.id: i for i, m in enumerate(request.messages)}

    # Build Segment objects with centroids
    segments: list[Segment] = []
    centroid_list: list[np.ndarray] = []

    for order, seg_ids in enumerate(raw_segments):
        member_indices = [id_to_idx[mid] for mid in seg_ids if mid in id_to_idx]
        if member_indices:
            seg_vectors = all_embeddings[member_indices]
            centroid = safe_centroid(seg_vectors, embedding_dim)
            centroid_array = np.array(centroid)
        else:
            centroid = [0.0] * embedding_dim
            centroid_array = np.zeros(embedding_dim)

        centroid_list.append(centroid_array)

        rep_ids = seg_ids[:2]
        rep_text = "\n".join(
            msg_texts[id_to_idx[mid]] for mid in rep_ids if mid in id_to_idx
        )

        segments.append(
            Segment(
                segment_id=f"segment_{order}",
                message_ids=seg_ids,
                temporal_order=order,
                centroid_embedding=centroid,
                representative_text=rep_text,
                semantic_group_id=None,
            )
        )

    # ─── Stage 2: Semantic Grouping (similarity graph) ────────────────────

    semantic_groups: list[SemanticGroup] = []
    segment_similarities: list[SegmentSimilarity] = []

    if len(segments) >= 2:
        centroid_matrix = np.array(centroid_list)
        result = group_segments_by_similarity(centroid_matrix)

        # Build similarity response (all pairs, for tuning visibility)
        for edge in result.all_pairs:
            segment_similarities.append(
                SegmentSimilarity(
                    segment_a=segments[edge.seg_a].segment_id,
                    segment_b=segments[edge.seg_b].segment_id,
                    score=round(edge.score, 4),
                    above_threshold=edge.score >= SEGMENT_GROUP_THRESHOLD,
                )
            )

        # Assign group IDs
        for group_idx, group_members in enumerate(result.groups):
            group_id = f"group_{group_idx}"
            group_segment_ids = [segments[i].segment_id for i in group_members]

            for i in group_members:
                segments[i].semantic_group_id = group_id

            # Group centroid
            group_vectors = centroid_matrix[group_members]
            group_centroid = safe_centroid(group_vectors, embedding_dim)

            semantic_groups.append(
                SemanticGroup(
                    group_id=group_id,
                    segment_ids=group_segment_ids,
                    centroid_embedding=group_centroid,
                )
            )

    # Noise (defensive — segmenter should assign all messages)
    all_seg_ids = set()
    for seg in segments:
        all_seg_ids.update(seg.message_ids)
    noise_ids = [m.id for m in request.messages if m.id not in all_seg_ids]

    return ClusterResponse(
        segments=segments,
        semantic_groups=semantic_groups,
        segment_similarities=segment_similarities,
        noise_message_ids=noise_ids,
        total_messages=len(request.messages),
        model_used=MODEL_NAME,
        grouping_threshold=SEGMENT_GROUP_THRESHOLD,
        clusters=segments,
    )
