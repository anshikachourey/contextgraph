"""
Test script for the chunked clustering endpoint with fallback detection.

Usage:
  1. Start the service: uvicorn app.main:app --reload
  2. Run: python test_cluster.py

Verifies that the chunking + UMAP + HDBSCAN (or agglomerative fallback)
pipeline produces sensible topic boundaries on a sample conversation.
"""

import json
import urllib.request

ENDPOINT = "http://localhost:8000/cluster-conversation"

# Sample conversation with two clear topics:
# Topic A: AI startup / knowledge graph (messages 1-4, 9-12)
# Topic B: Weekend hiking (messages 5-8)
# Expected: Two clusters (startup + hiking) with message 9 as a bridge
sample_messages = [
    {"id": "m1", "role": "user", "content": "I want to build an AI startup that helps people organize long conversations."},
    {"id": "m2", "role": "assistant", "content": "That's an interesting problem. The key challenge is maintaining context as conversations grow longer."},
    {"id": "m3", "role": "user", "content": "Exactly. Users lose track of what was discussed 50 messages ago. We need a visual way to see topics."},
    {"id": "m4", "role": "assistant", "content": "A knowledge graph approach could work well. Each topic becomes a node, and relationships between topics become edges."},
    {"id": "m5", "role": "user", "content": "By the way, I went hiking last weekend at Mount Tamalpais. The weather was perfect."},
    {"id": "m6", "role": "assistant", "content": "Mount Tam is beautiful! Did you take the Dipsea trail or the Matt Davis trail?"},
    {"id": "m7", "role": "user", "content": "I did the Steep Ravine trail down to Stinson Beach. The redwoods were incredible."},
    {"id": "m8", "role": "assistant", "content": "Steep Ravine is one of the best trails in Marin. The ladder section is always fun."},
    {"id": "m9", "role": "user", "content": "Anyway, back to the startup. Should we use embeddings or keyword matching for topic detection?"},
    {"id": "m10", "role": "assistant", "content": "Embeddings are much better for semantic similarity. Keywords miss synonyms and related concepts."},
    {"id": "m11", "role": "user", "content": "What embedding model would you recommend for short conversational texts?"},
    {"id": "m12", "role": "assistant", "content": "For short texts, sentence-transformers/all-MiniLM-L6-v2 is a great balance of speed and quality."},
]

payload = json.dumps({"messages": sample_messages}).encode("utf-8")

req = urllib.request.Request(
    ENDPOINT,
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)

try:
    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read().decode("utf-8"))

    print(f"\n{'='*70}")
    print(f"CLUSTERING RESULTS")
    print(f"{'='*70}")
    print(f"Total messages:     {result['total_messages']}")
    print(f"Clusters found:     {len(result['clusters'])}")
    print(f"Noise messages:     {len(result['noise_message_ids'])}")
    print(f"Model:              {result['model_used']}")
    print(f"Clustering method:  {result['clustering_method']}")

    if result["clustering_method"] == "agglomerative_fallback":
        print(f"  ⚠ HDBSCAN failed to find clusters — agglomerative fallback was used")
    else:
        print(f"  ✓ HDBSCAN produced sufficient clusters directly")

    # Show message-to-cluster mapping
    print(f"\n{'─'*70}")
    print("MESSAGE → CLUSTER MAPPING:")
    print(f"{'─'*70}")

    msg_to_cluster: dict[str, str] = {}
    for cluster in result["clusters"]:
        for msg_id in cluster["message_ids"]:
            msg_to_cluster[msg_id] = cluster["cluster_id"]
    for msg_id in result["noise_message_ids"]:
        msg_to_cluster[msg_id] = "NOISE"

    for msg in sample_messages:
        cluster_label = msg_to_cluster.get(msg["id"], "???")
        content_preview = msg["content"][:55]
        print(f"  {msg['id']:4s} → {cluster_label:12s} │ {content_preview}...")

    # Show cluster details
    for cluster in result["clusters"]:
        print(f"\n{'─'*70}")
        print(f"  {cluster['cluster_id']} ({len(cluster['message_ids'])} messages)")
        print(f"  Messages: {cluster['message_ids']}")
        print(f"  Representative chunks:")
        for text in cluster["representative_texts"][:2]:
            lines = text.split("\n")[:2]
            for line in lines:
                print(f"    │ {line[:70]}")
            print(f"    │ ...")

    if result["noise_message_ids"]:
        print(f"\n{'─'*70}")
        print(f"  NOISE (unclustered): {result['noise_message_ids']}")

    print(f"\n{'='*70}")

    # Validation
    print("\nVALIDATION:")
    startup_ids = {"m1", "m2", "m3", "m4", "m9", "m10", "m11", "m12"}
    hiking_ids = {"m5", "m6", "m7", "m8"}

    if len(result["clusters"]) >= 2:
        for cluster in result["clusters"]:
            ids = set(cluster["message_ids"])
            startup_overlap = len(ids & startup_ids)
            hiking_overlap = len(ids & hiking_ids)
            if startup_overlap > hiking_overlap:
                print(f"  ✓ {cluster['cluster_id']} → STARTUP ({startup_overlap} startup, {hiking_overlap} hiking)")
            elif hiking_overlap > startup_overlap:
                print(f"  ✓ {cluster['cluster_id']} → HIKING ({hiking_overlap} hiking, {startup_overlap} startup)")
            else:
                print(f"  ? {cluster['cluster_id']} → MIXED ({startup_overlap} startup, {hiking_overlap} hiking)")
        print("\n  ✓ Pipeline produced multiple clusters — topics are separated!")
    elif len(result["clusters"]) == 1:
        print("  ✗ Only 1 cluster — topics were not separated")
    else:
        print("  ✗ 0 clusters — all messages are noise")

except urllib.error.URLError as e:
    print(f"\nError: {e}")
    print("Make sure the service is running: uvicorn app.main:app --reload --port 8000")
