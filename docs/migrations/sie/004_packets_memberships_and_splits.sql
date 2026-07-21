-- SIE Migration 004: Semantic Packets, Packet Memberships, and Packet Splits
--
-- Creates concern-cohesive processing units (packets), their normalized
-- proposition memberships, and split-lineage records.
-- Depends on: sie_propositions (003), sie_proposition_associations (003),
--             conversations table (existing)
-- Idempotent: uses IF NOT EXISTS for all objects.

-- =============================================================================
-- 1. Semantic Packets
-- =============================================================================
-- Concern-cohesive processing units with retry-stable creation lineage.
-- A packet is NOT automatically a graph object — one packet does not
-- automatically create one Persistent Concern. Packets are processing units
-- for identity resolution.
--
-- Source provenance (source_message_ids) is derived exclusively from
-- constituent propositions. Packet formation and splitting never introduce
-- new source provenance — only inherit from member propositions.

CREATE TABLE IF NOT EXISTS sie_semantic_packets (
    -- Opaque stable ID resolved from packet_creation_key via the entity registry.
    packet_id TEXT PRIMARY KEY,

    -- Retry-stable creation key derived from request + partition lineage.
    -- Excludes mutable/model-generated text (user_grounded_meaning, etc.).
    packet_creation_key TEXT NOT NULL,

    -- Conversation scope.
    conversation_id UUID NOT NULL REFERENCES conversations(id),

    -- Source message IDs inherited from constituent propositions.
    -- No new provenance is introduced by packet formation itself.
    source_message_ids TEXT[] NOT NULL,

    -- Message sequence range covering all constituent propositions.
    message_seq_start BIGINT NOT NULL,
    message_seq_end BIGINT NOT NULL,

    -- Semantic summary of user-grounded meaning in this packet.
    user_grounded_meaning TEXT NOT NULL,

    -- Optional assistant context that helps interpret user meaning.
    assistant_context TEXT,

    -- Optional continuation origin (e.g., previous packet or concern reference).
    continuation_origin TEXT,

    -- How this packet was formed (direct extraction, split, etc.).
    provenance TEXT NOT NULL,

    -- Version of the packet formation algorithm that produced this packet.
    packet_formation_version TEXT NOT NULL,

    -- Cohesion validation result. Only COHESIVE packets proceed to identity resolution.
    cohesion_status TEXT NOT NULL
        CHECK (cohesion_status IN ('COHESIVE', 'MIXED', 'UNRESOLVED_COHESION')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Sequence range invariant: start <= end.
    CHECK (message_seq_start <= message_seq_end),

    -- Must have at least one source message.
    CHECK (cardinality(source_message_ids) > 0)
);

-- Index for loading all packets in a conversation (graph-state retrieval).
CREATE INDEX IF NOT EXISTS idx_packets_conversation
    ON sie_semantic_packets(conversation_id);

-- Index for filtering by cohesion status (e.g., find MIXED packets needing re-evaluation).
CREATE INDEX IF NOT EXISTS idx_packets_cohesion
    ON sie_semantic_packets(cohesion_status);

-- =============================================================================
-- 2. Packet Memberships (Normalized Proposition-in-Packet)
-- =============================================================================
-- Each row records one proposition's membership in one packet with an ordinal
-- position. Source provenance is INHERITED from the proposition — membership
-- never introduces new source provenance.
--
-- Constraints ensure:
--   - A proposition appears at most once per packet (UNIQUE packet_id, proposition_id)
--   - Each ordinal position is unique within a packet (UNIQUE packet_id, ordinal)

CREATE TABLE IF NOT EXISTS sie_packet_memberships (
    -- Opaque stable membership identifier.
    membership_id TEXT PRIMARY KEY,

    -- Retry-stable creation key for this membership event.
    membership_creation_key TEXT NOT NULL,

    -- The packet this proposition belongs to.
    packet_id TEXT NOT NULL REFERENCES sie_semantic_packets(packet_id),

    -- The proposition that is a member of this packet.
    proposition_id TEXT NOT NULL REFERENCES sie_propositions(proposition_id),

    -- Position of this proposition within the packet (0-based).
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- A proposition can appear at most once in a given packet.
    CONSTRAINT uq_membership_packet_proposition UNIQUE (packet_id, proposition_id),

    -- Each ordinal position is unique within a packet.
    CONSTRAINT uq_membership_packet_ordinal UNIQUE (packet_id, ordinal)
);

-- Index for loading all memberships of a packet.
CREATE INDEX IF NOT EXISTS idx_membership_packet
    ON sie_packet_memberships(packet_id);

-- Index for finding all packets a proposition belongs to.
CREATE INDEX IF NOT EXISTS idx_membership_proposition
    ON sie_packet_memberships(proposition_id);

-- =============================================================================
-- 3. Packet Splits (Split-Lineage Records)
-- =============================================================================
-- Records packet splits as normalized edge rows. When a MIXED packet is split,
-- each resulting child packet gets one edge row. All edges from the same split
-- operation share a stable split_event_id.
--
-- CRITICAL INVARIANT: Child packet source_message_ids are derived exclusively
-- from their constituent propositions' provenance. The split operation itself
-- NEVER introduces new source provenance — it only partitions existing
-- proposition provenance among child packets.

CREATE TABLE IF NOT EXISTS sie_packet_splits (
    -- Unique identifier for this specific edge (original → resulting).
    split_edge_id TEXT PRIMARY KEY,

    -- Groups all edges from one split event. All edges sharing this ID
    -- represent the results of a single split operation.
    split_event_id TEXT NOT NULL,

    -- Retry-stable creation key for this split edge.
    split_creation_key TEXT NOT NULL,

    -- The packet that was split.
    original_packet_id TEXT NOT NULL REFERENCES sie_semantic_packets(packet_id),

    -- One of the resulting packets from the split.
    resulting_packet_id TEXT NOT NULL REFERENCES sie_semantic_packets(packet_id),

    -- Human/machine-readable reason for the split.
    split_reason TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- An original packet cannot produce the same resulting packet twice.
    CONSTRAINT uq_split_edge UNIQUE (original_packet_id, resulting_packet_id)
);

-- Index for finding all splits of a given packet.
CREATE INDEX IF NOT EXISTS idx_splits_original
    ON sie_packet_splits(original_packet_id);

-- Index for grouping edges by split event.
CREATE INDEX IF NOT EXISTS idx_splits_event
    ON sie_packet_splits(split_event_id);

-- =============================================================================
-- 4. Deferred Foreign Key: Association → Establishing Packet
-- =============================================================================
-- The sie_proposition_associations table (created in migration 003) has a
-- nullable established_by_packet_id column that was initially created without
-- a FK reference because sie_semantic_packets did not yet exist.
-- Now that the packet table exists, add the deferred FK constraint.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_established_by_packet'
    ) THEN
        ALTER TABLE sie_proposition_associations
            ADD CONSTRAINT fk_established_by_packet
            FOREIGN KEY (established_by_packet_id)
            REFERENCES sie_semantic_packets(packet_id);
    END IF;
END
$$;
