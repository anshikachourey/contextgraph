"""Request and response models for the clustering API."""

from pydantic import BaseModel


class Message(BaseModel):
    id: str
    role: str  # "user" or "assistant"
    content: str


class ClusterRequest(BaseModel):
    messages: list[Message]


class Cluster(BaseModel):
    cluster_id: str
    message_ids: list[str]
    centroid_embedding: list[float]
    representative_texts: list[str]


class ClusterResponse(BaseModel):
    clusters: list[Cluster]
    noise_message_ids: list[str]
    total_messages: int
    model_used: str
    clustering_method: str  # "hdbscan" or "agglomerative_fallback"
