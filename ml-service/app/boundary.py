"""Boundary contamination fix using forward-block sequential rule.

Problem: Overlapping chunks near topic transitions assign the first 1–2
messages of a new topic to the previous cluster. The chunk-level clustering
is correct, but individual boundary messages get contaminated via majority vote.

Solution: A simple sequential rule applied in conversation order:
If a message is followed by 2+ consecutive messages of a DIFFERENT cluster,
reassign it to that forward cluster. This is forward-biased — at transitions,
the boundary message belongs to the upcoming topic.

This is purely order-based (no embeddings needed) and never merges distant clusters.
"""

from app.models import Message


def cleanup_boundary_contamination(
    message_labels: dict[str, int],
    all_messages: list[Message],
) -> dict[str, int]:
    """
    Fix boundary contamination using forward-block sequential assignment.

    For each message in conversation order:
    - Look at the next 2 messages' labels.
    - If both share a label different from the current message's label,
      reassign the current message to their label.

    Run multiple passes until stable (handles cascading contamination of 2+ messages).
    """
    new_labels = dict(message_labels)
    msg_order = [m.id for m in all_messages if m.id in new_labels]

    if len(msg_order) < 3:
        return new_labels

    # Run up to 3 passes for cascading fixes
    for _ in range(3):
        changed = False

        for i in range(len(msg_order) - 2):
            msg_id = msg_order[i]
            current_label = new_labels[msg_id]
            if current_label == -1:
                continue

            next1_label = new_labels[msg_order[i + 1]]
            next2_label = new_labels[msg_order[i + 2]]

            # Forward-block: next 2 messages agree on a different label
            if (
                next1_label != -1
                and next1_label == next2_label
                and next1_label != current_label
            ):
                new_labels[msg_id] = next1_label
                changed = True

        if not changed:
            break

    return new_labels
