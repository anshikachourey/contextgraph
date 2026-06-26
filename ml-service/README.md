# ContextGraph ML Service

Semantic clustering microservice for conversation topic detection.

## Pipeline (BERTopic-style)

```
Messages
    │
    ▼
┌─────────────────────────────┐
│  1. Semantic Chunking       │  Group consecutive messages into
│     (4 msgs, 50% overlap)   │  overlapping windows
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  2. Sentence Transformers   │  Embed each chunk (384 dimensions)
│     all-MiniLM-L6-v2       │  Local model, no API calls
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  3. UMAP Reduction          │  384d → 5d (configurable)
│     n_neighbors=15          │  Makes density estimation reliable
│     min_dist=0.0            │  Allows tight clusters
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  4. HDBSCAN Clustering      │  Density-based, no predefined k
│     min_cluster_size=3      │  Discovers natural topic structure
│     min_samples=2           │  Noise = unclustered messages
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  5. Label Mapping           │  Chunk labels → message IDs
│     (majority vote)         │  Handles overlap resolution
└─────────────────────────────┘
    │
    ▼
  Clusters + Noise
```

## Why chunk instead of per-message embedding?

Single-sentence messages like "Exactly." or "Why?" have almost no semantic
content — they become noise vectors that confuse clustering. A chunk of 3-4
consecutive messages captures a coherent thought exchange.

## Why UMAP?

HDBSCAN's density estimates degrade in high-dimensional space (curse of
dimensionality). UMAP reduces 384 dimensions to 5 while preserving local
structure. This is the exact pipeline BERTopic uses.

To disable UMAP for comparison: `DISABLE_UMAP=1 uvicorn app.main:app`

## Stack

- Python 3.11
- FastAPI
- sentence-transformers (`all-MiniLM-L6-v2`)
- UMAP (`umap-learn`)
- HDBSCAN

## Setup (local)

```bash
cd ml-service
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

## Test

```bash
python test_cluster.py
```

## Health check

```bash
curl http://localhost:8000/health
```

## Docker

```bash
docker build -t contextgraph-ml .
docker run -p 8000:8000 contextgraph-ml
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `DISABLE_UMAP` | `0` | Set to `1` to skip UMAP and cluster in full 384d space |
| `MIN_CLUSTER_SIZE` | `3` | HDBSCAN: minimum points to form a cluster. Lower = more clusters, higher = fewer but denser |
| `MIN_SAMPLES` | `2` | HDBSCAN: density threshold. Lower = more lenient, higher = stricter |
| `FALLBACK_THRESHOLD` | `0.5` | Agglomerative fallback: cosine distance threshold. Lower = more merging (fewer clusters), higher = more splitting |

### Fallback behavior

When HDBSCAN returns fewer than 2 useful clusters (common for <15 messages),
the service automatically falls back to agglomerative clustering:
- Uses cosine distance on the raw 384d embeddings (not UMAP-reduced)
- Merges chunks below the distance threshold
- Caps at 5 maximum clusters
- Never produces noise (-1) labels — every message gets a cluster

The `clustering_method` field in the response tells you which path was taken:
- `"hdbscan"` — primary pipeline succeeded
- `"agglomerative_fallback"` — HDBSCAN failed, used fallback

## Architecture

This service is a **pure computation layer**:
- Embeds messages locally (no external API calls)
- Chunks conversation into semantic windows
- Reduces dimensions with UMAP
- Clusters using HDBSCAN
- Returns cluster assignments with centroid embeddings

It does NOT:
- Write to Supabase or any database
- Call OpenAI or any external LLM
- Create nodes or edges
- Serve any UI

The Next.js app calls this service, receives clusters, then uses GPT
to label them and create nodes via the existing pipeline.
