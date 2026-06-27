"""Conversation segmenter using sliding-window cosine similarity.

Algorithm (TextTiling-inspired):
1. Embed each message individually using sentence-transformers.
2. Slide two adjacent windows across the message sequence.
3. At each position, compute cosine similarity between left-window mean
   and right-window mean embedding.
4. Compute adaptive threshold: mean_similarity - STD_MULTIPLIER * std.
5. Place boundaries where similarity drops below threshold.
6. Return contiguous segments (each is a list of message IDs in order).

Why this works for conversations:
- Captures the DIRECTION CHANGE, not individual message semantics.
- A transition message like "By the way, I went hiking..." is ambiguous
  in isolation, but in a window context the shift is clear.
- No post-processing needed — boundaries are the primary output.
"""

import os
import numpy as np
from app.models import Message
from app.embedder import embed_messages

# ─── Configuration ───────────────────────────────────────────────────────────

# Messages per window on each side of the boundary candidate
SEGMENT_WINDOW_SIZE = int(os.environ.get("SEGMENT_WINDOW_SIZE", "3"))

# How many standard deviations below the mean similarity to set the threshold.
# Higher = fewer boundaries (more permissive). Lower = more boundaries.
STD_MULTIPLIER = float(os.environ.get("SEGMENT_STD_MULTIPLIER", "1.0"))

# Minimum messages in a segment to be returned (smaller fragments merge with neighbors)
MIN_SEGMENT_SIZE = int(os.environ.get("MIN_SEGMENT_SIZE", "2"))


def segment_conversation(messages: list[Message]) -> list[list[str]]:
    """
    Segment a conversation into contiguous topic blocks.

    Returns a list of segments, where each segment is a list of message IDs
    in conversation order. Every message appears in exactly one segment.
    """
    n = len(messages)

    if n < 2 * SEGMENT_WINDOW_SIZE:
        # Too few messages to segment — return one big segment
        return [[m.id for m in messages]]

    # Step 1: Embed each message individually
    texts = [
        f"{'User' if m.role == 'user' else 'Assistant'}: {m.content}"
        for m in messages
    ]
    embeddings = embed_messages(texts)

    # Step 2: Compute similarity at each boundary candidate position
    # Boundary at position i means: left window = [i-W..i-1], right window = [i..i+W-1]
    similarities: list[float] = []
    boundary_positions: list[int] = []  # positions where boundary could be placed

    for i in range(SEGMENT_WINDOW_SIZE, n - SEGMENT_WINDOW_SIZE + 1):
        left_window = embeddings[i - SEGMENT_WINDOW_SIZE : i]
        right_window = embeddings[i : i + SEGMENT_WINDOW_SIZE]

        left_mean = np.mean(left_window, axis=0)
        right_mean = np.mean(right_window, axis=0)

        # Normalize
        left_norm = np.linalg.norm(left_mean)
        right_norm = np.linalg.norm(right_mean)

        if left_norm > 0 and right_norm > 0:
            sim = float(np.dot(left_mean / left_norm, right_mean / right_norm))
        else:
            sim = 1.0  # No boundary if embeddings are degenerate

        similarities.append(sim)
        boundary_positions.append(i)

    if not similarities:
        return [[m.id for m in messages]]

    # Step 3: Adaptive threshold — mean - STD_MULTIPLIER * std
    sim_array = np.array(similarities)
    mean_sim = float(np.mean(sim_array))
    std_sim = float(np.std(sim_array))
    threshold = mean_sim - STD_MULTIPLIER * std_sim

    # Step 4: Place boundaries where similarity drops below threshold
    boundaries: list[int] = []
    for pos, sim in zip(boundary_positions, similarities):
        if sim < threshold:
            boundaries.append(pos)

    # Remove boundaries that are too close together (within MIN_SEGMENT_SIZE)
    filtered_boundaries: list[int] = []
    prev_boundary = 0
    for b in sorted(boundaries):
        if b - prev_boundary >= MIN_SEGMENT_SIZE:
            filtered_boundaries.append(b)
            prev_boundary = b

    # Step 5: Build segments from boundary positions
    all_ids = [m.id for m in messages]
    segments: list[list[str]] = []

    start = 0
    for boundary in filtered_boundaries:
        segment = all_ids[start:boundary]
        if segment:
            segments.append(segment)
        start = boundary

    # Last segment
    last_segment = all_ids[start:]
    if last_segment:
        segments.append(last_segment)

    # Step 6: Merge tiny segments with their nearest neighbor
    merged: list[list[str]] = []
    for seg in segments:
        if len(seg) < MIN_SEGMENT_SIZE and merged:
            # Merge with previous segment
            merged[-1].extend(seg)
        else:
            merged.append(seg)

    # Final check: if last segment is tiny, merge with previous
    if len(merged) > 1 and len(merged[-1]) < MIN_SEGMENT_SIZE:
        merged[-2].extend(merged[-1])
        merged.pop()

    return merged if merged else [[m.id for m in messages]]
