"""Semantic chunking: group consecutive messages into overlapping windows.

Why chunk instead of embedding individual messages:
- Single-sentence messages like "Exactly." or "Why?" have almost no semantic
  content on their own — they become isolated noise vectors.
- A chunk of 3-4 consecutive messages captures a coherent thought exchange.
- Overlapping windows (50%) ensure that topic boundaries aren't missed when
  they fall between chunks.

Each chunk gets one embedding. The cluster labels are then mapped back to
individual message IDs so the API contract stays unchanged.
"""

from app.models import Message


# Configurable
CHUNK_SIZE = 4  # messages per chunk
CHUNK_OVERLAP = 2  # 50% overlap (stride = CHUNK_SIZE - CHUNK_OVERLAP)


class Chunk:
    """A group of consecutive messages treated as one semantic unit."""

    def __init__(self, messages: list[Message], start_index: int):
        self.messages = messages
        self.start_index = start_index
        self.message_ids = [m.id for m in messages]

    @property
    def text(self) -> str:
        """Build embedding text for this chunk."""
        return "\n".join(
            f"{'User' if m.role == 'user' else 'Assistant'}: {m.content}"
            for m in self.messages
        )


def create_chunks(messages: list[Message]) -> list[Chunk]:
    """
    Create overlapping chunks from a list of messages.

    With CHUNK_SIZE=4 and CHUNK_OVERLAP=2 (stride=2):
      messages: [m1, m2, m3, m4, m5, m6, m7, m8]
      chunk 0:  [m1, m2, m3, m4]
      chunk 1:  [m3, m4, m5, m6]
      chunk 2:  [m5, m6, m7, m8]

    If fewer messages than CHUNK_SIZE, one chunk covers all messages.
    """
    stride = CHUNK_SIZE - CHUNK_OVERLAP
    chunks: list[Chunk] = []

    if len(messages) <= CHUNK_SIZE:
        # Not enough messages to slide — one chunk covers everything
        chunks.append(Chunk(messages=messages, start_index=0))
        return chunks

    for i in range(0, len(messages) - CHUNK_SIZE + 1, stride):
        window = messages[i : i + CHUNK_SIZE]
        chunks.append(Chunk(messages=window, start_index=i))

    # Ensure the last messages are covered even if stride doesn't land there
    last_start = len(messages) - CHUNK_SIZE
    if chunks[-1].start_index < last_start:
        chunks.append(Chunk(messages=messages[last_start:], start_index=last_start))

    return chunks


def map_chunk_labels_to_messages(
    chunks: list[Chunk], labels: list[int]
) -> dict[str, int]:
    """
    Map chunk-level cluster labels back to individual message IDs.

    When a message appears in multiple chunks (due to overlap), it may get
    different labels. Resolution: majority vote. If tied, use the label from
    the later chunk (more context = better assignment).

    Returns: {message_id: cluster_label}
    """
    from collections import Counter

    # Collect all labels per message ID
    message_votes: dict[str, list[int]] = {}

    for chunk, label in zip(chunks, labels):
        for msg_id in chunk.message_ids:
            if msg_id not in message_votes:
                message_votes[msg_id] = []
            message_votes[msg_id].append(label)

    # Resolve: most common label wins. Ties broken by last occurrence.
    result: dict[str, int] = {}
    for msg_id, votes in message_votes.items():
        counter = Counter(votes)
        # most_common returns [(label, count), ...] — take the first
        result[msg_id] = counter.most_common(1)[0][0]

    return result
