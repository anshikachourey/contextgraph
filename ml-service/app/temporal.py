"""Temporal continuity post-processing for semantic clusters.

Splits clusters that are too temporally discontinuous using two signals:
1. Message index gap (primary): how many intervening messages separate cluster members
2. Timestamp gap (secondary): real-time duration between messages

This prevents merging semantically similar but conversationally distant segments.

FUTURE: Temporal segments can later become child nodes under broader semantic
parent nodes, enabling a tree-like graph structure:
  Startup Planning (parent, semantic)
  ├── Early Discussion (child, temporal segment 1)
  └── Resumed After Break (child, temporal segment 2)
The semantic clustering gives us the parent. Temporal splitting gives us the children.
"""

import os
from datetime import datetime, timezone
from dataclasses import dataclass
from app.models import Message

# ─── Configuration (via env vars with defaults) ──────────────────────────────

# Maximum allowed index gap between consecutive messages in a cluster.
# If N+ non-cluster messages separate two cluster members → split.
MAX_CLUSTER_GAP = int(os.environ.get("MAX_CLUSTER_GAP", "4"))

# Maximum allowed real-time gap (minutes) between consecutive cluster messages.
# Even if index gap is small, a large time gap signals a session boundary.
MAX_TIME_GAP_MINUTES = int(os.environ.get("MAX_TIME_GAP_MINUTES", "30"))

# Minimum messages for a temporal subcluster to survive (smaller → noise).
MIN_TEMPORAL_SUBCLUSTER_SIZE = int(os.environ.get("MIN_TEMPORAL_SUBCLUSTER_SIZE", "2"))


@dataclass
class TemporalSubcluster:
    """A temporal segment of a semantic cluster."""
    message_ids: list[str]
    split_reason: str | None  # "message_gap" | "time_gap" | None (first segment)
    original_cluster_label: int


def _parse_timestamp(ts: str | None) -> datetime | None:
    """Parse ISO timestamp string, return None on failure."""
    if not ts:
        return None
    try:
        # Handle various ISO formats
        cleaned = ts.replace("Z", "+00:00")
        return datetime.fromisoformat(cleaned)
    except (ValueError, TypeError):
        return None


def _get_message_index(msg: Message, all_messages: list[Message], fallback_position: int) -> int:
    """Get the message's index — use explicit field if set, else position in list."""
    if msg.index is not None:
        return msg.index
    return fallback_position


def split_cluster_temporally(
    cluster_message_ids: list[str],
    all_messages: list[Message],
    original_label: int,
) -> list[TemporalSubcluster]:
    """
    Split a single cluster's messages into temporal subclusters.

    Splits on:
    1. Index gap > MAX_CLUSTER_GAP
    2. Timestamp gap > MAX_TIME_GAP_MINUTES (if timestamps available)

    Returns list of TemporalSubcluster objects with metadata.
    """
    # Build lookups
    msg_lookup = {m.id: m for m in all_messages}
    id_to_position = {m.id: i for i, m in enumerate(all_messages)}

    # Resolve each cluster message to (index, timestamp, id)
    indexed: list[tuple[int, datetime | None, str]] = []
    for mid in cluster_message_ids:
        msg = msg_lookup.get(mid)
        if not msg:
            continue
        position = id_to_position.get(mid, 0)
        idx = _get_message_index(msg, all_messages, position)
        ts = _parse_timestamp(msg.created_at)
        indexed.append((idx, ts, mid))

    indexed.sort(key=lambda x: x[0])

    if not indexed:
        return []

    # Walk and split
    subclusters: list[TemporalSubcluster] = []
    current_ids: list[str] = [indexed[0][2]]
    current_split_reason: str | None = None
    prev_index = indexed[0][0]
    prev_ts = indexed[0][1]

    for i in range(1, len(indexed)):
        curr_index, curr_ts, curr_id = indexed[i]

        # Check index gap
        index_gap = curr_index - prev_index - 1
        split_needed = False
        reason: str | None = None

        if index_gap >= MAX_CLUSTER_GAP:
            split_needed = True
            reason = "message_gap"

        # Check timestamp gap (only if both timestamps available)
        if not split_needed and prev_ts and curr_ts:
            time_diff = (curr_ts - prev_ts).total_seconds() / 60.0
            if time_diff >= MAX_TIME_GAP_MINUTES:
                split_needed = True
                reason = "time_gap"

        if split_needed:
            subclusters.append(TemporalSubcluster(
                message_ids=current_ids,
                split_reason=current_split_reason,
                original_cluster_label=original_label,
            ))
            current_ids = [curr_id]
            current_split_reason = reason
        else:
            current_ids.append(curr_id)

        prev_index = curr_index
        prev_ts = curr_ts

    # Don't forget the last segment
    subclusters.append(TemporalSubcluster(
        message_ids=current_ids,
        split_reason=current_split_reason,
        original_cluster_label=original_label,
    ))

    # Filter out tiny fragments
    valid = [sc for sc in subclusters if len(sc.message_ids) >= MIN_TEMPORAL_SUBCLUSTER_SIZE]

    return valid


@dataclass
class TemporalSplitResult:
    """Result of temporal splitting across all clusters."""
    message_labels: dict[str, int]
    cluster_metadata: dict[int, TemporalSubcluster]  # label → subcluster info


def apply_temporal_splitting(
    message_labels: dict[str, int],
    all_messages: list[Message],
) -> TemporalSplitResult:
    """
    Apply temporal splitting to all clusters.

    Returns a TemporalSplitResult with:
    - new message labels (subclusters get fresh sequential IDs)
    - metadata per cluster (split reason, original cluster label)
    """
    # Group message IDs by current cluster label
    clusters: dict[int, list[str]] = {}
    for msg_id, label in message_labels.items():
        if label == -1:
            continue
        if label not in clusters:
            clusters[label] = []
        clusters[label].append(msg_id)

    new_labels: dict[str, int] = {}
    cluster_metadata: dict[int, TemporalSubcluster] = {}
    next_label = 0

    for original_label, msg_ids in sorted(clusters.items()):
        subclusters = split_cluster_temporally(msg_ids, all_messages, original_label)

        for subcluster in subclusters:
            for msg_id in subcluster.message_ids:
                new_labels[msg_id] = next_label
            cluster_metadata[next_label] = subcluster
            next_label += 1

    # Messages not in any valid subcluster → noise
    for msg_id in message_labels:
        if msg_id not in new_labels:
            new_labels[msg_id] = -1

    return TemporalSplitResult(
        message_labels=new_labels,
        cluster_metadata=cluster_metadata,
    )
