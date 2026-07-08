# Deployment Checklist

## Environment Variables

### Required (Vercel / .env.local)
```
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
OPENAI_API_KEY=<openai-key>
ANTHROPIC_API_KEY=<anthropic-key>

# AI Provider config (premium)
AI_PROVIDER=anthropic
CHAT_MODEL=claude-sonnet-4-6
NODE_MODEL=claude-sonnet-4-6
GRAPH_SYNTHESIS_MODEL=claude-sonnet-4-6
STRUCTURE_MODEL=claude-sonnet-4-6
EDGE_MODEL=claude-sonnet-4-6
SUMMARY_MODEL=claude-sonnet-4-6
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-large
```

### Optional
```
DEBUG_GRAPH_PIPELINE=true    # Enable verbose engine logs (omit in production)
```

## Supabase Migrations

Run these in the **Supabase SQL Editor** before first deployment:

### 1. Engine state v2 columns
```sql
ALTER TABLE conversation_engine_state ADD COLUMN IF NOT EXISTS cursor text;
ALTER TABLE conversation_engine_state ADD COLUMN IF NOT EXISTS open_segment jsonb;
```

### 2. Topic candidates table
```sql
CREATE TABLE IF NOT EXISTS topic_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  status text NOT NULL DEFAULT 'accumulating',
  segments jsonb NOT NULL DEFAULT '[]',
  embedding jsonb,
  confidence real DEFAULT 0,
  last_touched_run integer DEFAULT 0,
  materialized_node_id uuid,
  created_at timestamptz DEFAULT now(),
  last_updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topic_candidates_conversation
  ON topic_candidates(conversation_id, status);
```

### 3. Verify existing tables
Ensure these exist (should already from earlier setup):
- `conversations` (id, title, created_at)
- `messages` (id, conversation_id, role, content, parent_node_id, branch_root_message_id, created_at)
- `nodes` (id, conversation_id, title, summary, evidence_summary, metadata, embedding, position_x, position_y, neighborhood_id, importance, stability, created_at)
- `node_messages` (node_id, message_id) — unique constraint on (node_id, message_id)
- `edges` (id, conversation_id, source_node_id, target_node_id, relationship_type, status, similarity_score, explanation, created_at) — unique on (conversation_id, source_node_id, target_node_id)
- `neighborhoods` (id, conversation_id, label, hue, centroid, created_at)
- `conversation_engine_state` (conversation_id unique, cursor, open_segment, total_engine_runs, last_engine_run_at)

## Vercel Deployment

1. Connect repo to Vercel
2. Set environment variables in Vercel project settings
3. Framework preset: Next.js (auto-detected)
4. Build command: `npm run build` (default)
5. Output directory: `.next` (default)
6. Install command: `npm install` (default)

### Build verification
```bash
npm run build    # Should complete without errors
```

## Pre-deployment Checks

- [ ] `npx tsc --noEmit` passes
- [ ] All SQL migrations applied to Supabase
- [ ] Environment variables set in Vercel
- [ ] `ANTHROPIC_API_KEY` is a real key from console.anthropic.com (not the placeholder)
- [ ] `OPENAI_API_KEY` is valid (still needed for embeddings)
- [ ] `DEBUG_GRAPH_PIPELINE` is NOT set in production
- [ ] Test: create new chat → send messages → graph updates
- [ ] Test: switch between conversations
- [ ] Test: candidate materializes into node after topic recurrence or stale promotion

## Smoke Test Checklist (After Provider Switch)

⚠️ **IMPORTANT: Embedding Dimension Change**

We switched from `text-embedding-3-small` (1536 dims) to `text-embedding-3-large` (3072 dims).
Old nodes and engine state may still contain 1536-dim embeddings. Comparing old embeddings
against new ones will throw a **dimension mismatch error**.

**For first smoke test:**
1. Start a **fresh new conversation** (do NOT test with old conversations)
2. Send 4-6 messages on a topic
3. Verify the graph engine creates candidates and materializes nodes
4. Verify edges have semantic relationship types (not "related")
5. Verify graph synthesis pass runs

**After fresh test passes:**
- Either run `/api/debug/reembed-nodes` on each existing conversation to update embeddings
- Or reset existing local data (delete all nodes/edges/candidates/engine state for old conversations)
- Old conversations with 1536-dim embeddings will error until re-embedded

**Re-embedding command:**
```
POST /api/debug/reembed-nodes
```
This regenerates embeddings for all nodes in the latest conversation using the current model.
For other conversations, repeat with conversation-specific endpoints or reset data.

## What's NOT included in MVP

- Authentication (no login)
- ML service (Python FastAPI — separate deployment if needed)
- File sharing / collaboration
- Delete / rename conversations
- Search
