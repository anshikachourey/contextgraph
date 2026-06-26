"""FastAPI ML service for conversation topic clustering.

Pipeline (BERTopic-style):
1. Chunk consecutive messages into overlapping semantic windows
2. Embed each chunk using sentence-transformers (local, no API calls)
3. Reduce dimensions with UMAP (384d → 5d)
4. Cluster chunks using HDBSCAN
5. Map chunk labels back to individual message IDs
6. Return structured cluster assignments

It does NOT:
- Write to any database
- Call OpenAI or any external LLM API
- Create nodes or edges
- Render any UI
"""

from fastapi import FastAPI, HTTPException
import numpy as np

from app.models import Message, ClusterRequest, ClusterResponse, Cluster
from app.embedder import embed_messages, MODEL_NAME
from app.clusterer import cluster_embeddings, UMAP_ENABLED
import app.clusterer as clusterer_module
from app.chunker import create_chunks, map_chunk_labels_to_messages

app = FastAPI(
    title="ContextGraph ML Service",
    description="Semantic clustering for conversation messages (BERTopic-style pipeline)",
    version="0.2.0",
)


@app.get("/health")
def health_check():
    """Simple health check endpoint."""
    return {"status": "ok", "model": MODEL_NAME, "umap_enabled": UMAP_ENABLED}


@app.post("/cluster-conversation", response_model=ClusterResponse)
def cluster_conversation(request: ClusterRequest):
    """
    Cluster conversation messages by semantic similarity.

    Pipeline:
    1. Create overlapping semantic chunks (4 messages, 50% overlap)
    2. Embed each chunk using sentence-transformers
    3. Reduce to 5 dimensions with UMAP (configurable)
    4. Run HDBSCAN to find density-based clusters
    5. Map chunk-level labels back to individual messages (majority vote)
    6. Compute cluster centroids and representative texts
    7. Return structured cluster assignments

    Messages assigned to noise (label -1) are returned separately
    in noise_message_ids — these are transition messages, small talk,
    or isolated remarks that don't belong to any topic cluster.
    """
    if len(request.messages) < 3:
        raise HTTPException(
            status_code=400,
            detail="At least 3 messages are required for clustering.",
        )

    # Step 1: Create semantic chunks
    chunks = create_chunks(request.messages)

    if len(chunks) < 2:
        # Not enough chunks to cluster meaningfully
        # Return all messages as noise
        return ClusterResponse(
            clusters=[],
            noise_message_ids=[m.id for m in request.messages],
            total_messages=len(request.messages),
            model_used=MODEL_NAME,
        )

    # Step 2: Embed chunks
    chunk_texts = [chunk.text for chunk in chunks]
    embeddings = embed_messages(chunk_texts)

    # Step 3 + 4: UMAP reduction + HDBSCAN clustering
    labels = cluster_embeddings(embeddings)

    # Step 5: Map chunk labels back to message IDs
    message_labels = map_chunk_labels_to_messages(chunks, labels.tolist())

    # Step 6: Build response — group messages by cluster label
    unique_labels = set(message_labels.values())
    unique_labels.discard(-1)

    # Build a message lookup for texts
    message_lookup = {m.id: m for m in request.messages}

    clusters: list[Cluster] = []

    for label in sorted(unique_labels):
        # Find all message IDs with this label
        cluster_msg_ids = [
            msg_id for msg_id, lbl in message_labels.items() if lbl == label
        ]

        # Compute centroid from the chunk embeddings that belong to this cluster
        chunk_indices = [i for i, lbl in enumerate(labels) if lbl == label]
        cluster_embeddings_subset = embeddings[chunk_indices]
        centroid = np.mean(cluster_embeddings_subset, axis=0)
        centroid = centroid / (np.linalg.norm(centroid) + 1e-10)

        # Representative texts: chunks closest to centroid
        distances = np.dot(cluster_embeddings_subset, centroid)
        top_chunk_indices = np.argsort(distances)[-3:][::-1]
        representative_texts = [chunk_texts[chunk_indices[i]] for i in top_chunk_indices]

        clusters.append(
            Cluster(
                cluster_id=f"cluster_{label}",
                message_ids=cluster_msg_ids,
                centroid_embedding=centroid.tolist(),
                representative_texts=representative_texts,
            )
        )

    # Noise messages
    noise_msg_ids = [
        msg_id for msg_id, lbl in message_labels.items() if lbl == -1
    ]

    return ClusterResponse(
        clusters=clusters,
        noise_message_ids=noise_msg_ids,
        total_messages=len(request.messages),
        model_used=MODEL_NAME,
        clustering_method=clusterer_module.last_method_used,
    )
