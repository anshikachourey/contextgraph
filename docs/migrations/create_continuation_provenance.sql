-- Continuation Provenance: durable record of which graph entity an exchange continued from.
-- Supports both V1 nodes and V2 objects. Survives graph evolution/supersession.

CREATE TABLE IF NOT EXISTS continuation_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  origin_entity_id text NOT NULL,
  origin_graph_version text NOT NULL CHECK (origin_graph_version IN ('v1', 'v2')),
  origin_entity_type text NOT NULL CHECK (origin_entity_type IN ('node', 'object')),
  message_ids text[] NOT NULL DEFAULT '{}',
  current_canonical_entity_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_continuation_provenance_conversation
  ON continuation_provenance(conversation_id);
CREATE INDEX IF NOT EXISTS idx_continuation_provenance_entity
  ON continuation_provenance(origin_entity_id);
