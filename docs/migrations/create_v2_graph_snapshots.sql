-- V2 Graph Snapshots: stores generated V2 pipeline output for instant retrieval.
-- The UI reads the stored snapshot; it never reruns the pipeline on page load.

CREATE TABLE IF NOT EXISTS v2_graph_snapshots (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  pipeline_version text NOT NULL DEFAULT '2.0.0',
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'ready', 'failed')),
  graph_payload jsonb,
  diagnostics jsonb,
  error_message text,
  generated_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

-- Index for quick status checks
CREATE INDEX IF NOT EXISTS idx_v2_snapshots_status ON v2_graph_snapshots(status);
