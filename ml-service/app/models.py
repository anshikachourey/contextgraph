"""Request and response models for the clustering API."""

from pydantic import BaseModel


class Message(BaseModel):
    id: str
    role: str  # "user" or "assistant"
    content: str
    index: int | None = None
    created_at: str | None = None


class ClusterRequest(BaseModel):
    messages: list[Message]


# ─── Response models ─────────────────────────────────────────────────────────

class Segment(BaseModel):
    """A contiguous topic episode in the conversation."""
    segment_id: str
    message_ids: list[str]
    temporal_order: int
    centroid_embedding: list[float]
    representative_text: str
    semantic_group_id: str | None = None


class SemanticGroup(BaseModel):
    """A broader topic that groups related temporal segments."""
    group_id: str
    segment_ids: list[str]
    centroid_embedding: list[float]


class SegmentSimilarity(BaseModel):
    """Pairwise similarity between two segments (for debugging/tuning)."""
    segment_a: str
    segment_b: str
    score: float
    above_threshold: bool


class ClusterResponse(BaseModel):
    segments: list[Segment]
    semantic_groups: list[SemanticGroup]
    # All pairwise similarities between segments (sorted highest first)
    segment_similarities: list[SegmentSimilarity]
    noise_message_ids: list[str]
    total_messages: int
    model_used: str
    grouping_threshold: float
    # Backward-compatible
    clusters: list[Segment]
