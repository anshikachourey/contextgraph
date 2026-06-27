"""
Test script for segmentation-first conversation structuring.

Architecture:
  Stage 1: Segmentation (contiguous topic episodes via sliding-window similarity)
  Stage 2: Semantic grouping (pairwise similarity graph + connected components)

Expected:
  Segment 0: m1-m4 (early startup)
  Segment 1: m5-m8 (hiking)
  Segment 2: m9-m12 (late startup)
  Semantic group: segments 0+2 grouped (both startup, similarity >= threshold)

Usage:
  1. Restart service: uvicorn app.main:app --reload --port 8000
  2. Run: python3 test_cluster.py
"""

import json
import urllib.request

ENDPOINT = "http://localhost:8000/cluster-conversation"

test_messages = [
    {"id": "m1", "role": "user", "content": "I want to build an AI startup that helps organize long conversations."},
    {"id": "m2", "role": "assistant", "content": "The key challenge is maintaining context as conversations grow longer."},
    {"id": "m3", "role": "user", "content": "Users lose track of what was discussed. We need a visual way to see topics."},
    {"id": "m4", "role": "assistant", "content": "A knowledge graph approach could work well. Topics become nodes, relationships become edges."},
    {"id": "m5", "role": "user", "content": "By the way, I went hiking at Mount Tamalpais last weekend. The weather was perfect."},
    {"id": "m6", "role": "assistant", "content": "Mount Tam is beautiful! Did you take the Dipsea trail or Matt Davis trail?"},
    {"id": "m7", "role": "user", "content": "I did the Steep Ravine trail down to Stinson Beach. The redwoods were incredible."},
    {"id": "m8", "role": "assistant", "content": "Steep Ravine is one of the best trails in Marin. The ladder section is always fun."},
    {"id": "m9", "role": "user", "content": "Back to the startup. Should we use embeddings or keyword matching for topic detection?"},
    {"id": "m10", "role": "assistant", "content": "Embeddings are much better for semantic similarity. Keywords miss synonyms."},
    {"id": "m11", "role": "user", "content": "What embedding model would you recommend for short conversational texts?"},
    {"id": "m12", "role": "assistant", "content": "sentence-transformers/all-MiniLM-L6-v2 is a great balance of speed and quality."},
]

payload = json.dumps({"messages": test_messages}).encode("utf-8")
req = urllib.request.Request(
    ENDPOINT, data=payload,
    headers={"Content-Type": "application/json"}, method="POST",
)

try:
    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read().decode("utf-8"))
except urllib.error.URLError as e:
    print(f"\nError: {e}")
    print("Restart the service: uvicorn app.main:app --reload --port 8000")
    exit(1)

# ─── Print results ───────────────────────────────────────────────────────────

print(f"\n{'='*70}")
print("SEGMENTATION-FIRST CLUSTERING RESULTS")
print(f"{'='*70}")
print(f"Messages:           {result['total_messages']}")
print(f"Segments:           {len(result['segments'])}")
print(f"Semantic groups:    {len(result['semantic_groups'])}")
print(f"Noise:              {len(result['noise_message_ids'])}")
print(f"Model:              {result['model_used']}")
print(f"Grouping method:    segment_similarity_graph")
print(f"Grouping threshold: {result.get('grouping_threshold', '?')}")

# Show segments
print(f"\n{'─'*70}")
print("SEGMENTS (contiguous topic episodes):")
print(f"{'─'*70}")

for seg in result["segments"]:
    group = seg.get("semantic_group_id") or "ungrouped"
    print(f"\n  {seg['segment_id']} (order={seg['temporal_order']}, group={group})")
    print(f"  Messages: {seg['message_ids']}")
    rep = seg.get("representative_text", "")
    if rep:
        print(f"  Representative: {rep[:80]}...")

# Show semantic groups
if result["semantic_groups"]:
    print(f"\n{'─'*70}")
    print("SEMANTIC GROUPS (related segments connected by similarity):")
    print(f"{'─'*70}")
    for group in result["semantic_groups"]:
        print(f"  {group['group_id']}: segments {group['segment_ids']}")

# Show pairwise similarities
if result.get("segment_similarities"):
    print(f"\n{'─'*70}")
    threshold = result.get("grouping_threshold", "?")
    print(f"PAIRWISE SEGMENT SIMILARITIES (threshold = {threshold}):")
    print(f"{'─'*70}")
    for pair in result["segment_similarities"]:
        marker = "✓ GROUPED" if pair["above_threshold"] else "  distinct"
        print(f"  {pair['segment_a']:12s} ↔ {pair['segment_b']:12s}  score={pair['score']:.4f}  {marker}")

# Show message → segment mapping
print(f"\n{'─'*70}")
print("MESSAGE → SEGMENT MAPPING:")
print(f"{'─'*70}")

msg_to_seg: dict[str, str] = {}
for seg in result["segments"]:
    for mid in seg["message_ids"]:
        msg_to_seg[mid] = seg["segment_id"]

for msg in test_messages:
    seg_id = msg_to_seg.get(msg["id"], "???")
    print(f"  {msg['id']:4s} → {seg_id:12s} │ {msg['content'][:50]}...")

# ─── Validation ──────────────────────────────────────────────────────────────

print(f"\n{'='*70}")
print("VALIDATION:")
print(f"{'='*70}")

early_startup = {"m1", "m2", "m3", "m4"}
hiking = {"m5", "m6", "m7", "m8"}
late_startup = {"m9", "m10", "m11", "m12"}


def check_in_one_segment(name: str, msg_ids: set) -> str | None:
    segs = {msg_to_seg.get(m) for m in msg_ids} - {None}
    if len(segs) == 1:
        seg = list(segs)[0]
        print(f"  ✓ PASS: {name} → all in {seg}")
        return seg
    else:
        print(f"  ✗ FAIL: {name} → split across {segs}")
        return None


seg_early = check_in_one_segment("m1-m4 (early startup)", early_startup)
seg_hiking = check_in_one_segment("m5-m8 (hiking)", hiking)
seg_late = check_in_one_segment("m9-m12 (late startup)", late_startup)

# Check all three are different segments
all_segs = {seg_early, seg_hiking, seg_late} - {None}
if len(all_segs) == 3:
    print(f"  ✓ PASS: All three groups in separate segments")
elif len(all_segs) == 2:
    print(f"  ✗ PARTIAL: Only 2 distinct segments")
else:
    print(f"  ✗ FAIL: Segments not properly separated")

# Check semantic grouping
print()
if seg_early and seg_late:
    early_seg_obj = next((s for s in result["segments"] if s["segment_id"] == seg_early), None)
    late_seg_obj = next((s for s in result["segments"] if s["segment_id"] == seg_late), None)

    if early_seg_obj and late_seg_obj:
        early_group = early_seg_obj.get("semantic_group_id")
        late_group = late_seg_obj.get("semantic_group_id")

        if early_group and late_group and early_group == late_group:
            print(f"  ✓ PASS: Early + late startup share semantic group ({early_group})")
        else:
            # Show the similarity score between these two segments
            score_between = None
            for pair in result.get("segment_similarities", []):
                pair_set = {pair["segment_a"], pair["segment_b"]}
                if pair_set == {seg_early, seg_late}:
                    score_between = pair["score"]
                    break

            threshold = result.get("grouping_threshold", "?")
            print(f"  ✗ FAIL: Early + late startup NOT grouped")
            print(f"    Early group: {early_group}, Late group: {late_group}")
            if score_between is not None:
                print(f"    Similarity between them: {score_between:.4f}")
                print(f"    Threshold: {threshold}")
                if isinstance(threshold, (int, float)) and score_between < threshold:
                    print(f"    → Score is below threshold. Consider lowering SEGMENT_GROUP_THRESHOLD.")
                else:
                    print(f"    → Score is above threshold but grouping failed for another reason.")

# Check hiking is NOT grouped with startup
if seg_hiking:
    hiking_seg_obj = next((s for s in result["segments"] if s["segment_id"] == seg_hiking), None)
    if hiking_seg_obj:
        hiking_group = hiking_seg_obj.get("semantic_group_id")
        if hiking_group is None:
            print(f"  ✓ PASS: Hiking segment is ungrouped (separate topic)")
        else:
            # Check if it's grouped with startup
            early_group = early_seg_obj.get("semantic_group_id") if early_seg_obj else None
            if hiking_group == early_group:
                print(f"  ✗ FAIL: Hiking wrongly grouped with startup ({hiking_group})")
            else:
                print(f"  ? NOTE: Hiking has group {hiking_group} (not with startup)")

print(f"\n{'='*70}\n")
