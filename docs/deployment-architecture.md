# Deployment Architecture

## Overview

ContextGraph uses a split deployment model:

| Component | Host | Role |
|-----------|------|------|
| Next.js frontend + API routes | **Vercel** | UI, chat streaming, CRUD, lightweight API |
| Durable graph worker | **Railway** (planned) | Long-running V2 graph generation, SIE pipeline |
| Python ML service | **Railway** (planned) | NLP clustering, SIE semantic processing |
| Database + Auth + Storage | **Supabase** | Postgres, RLS, file storage, realtime |

## Vercel (Preview Deployment)

Vercel serves the Next.js application including:
- Static pages and client-side React
- API routes for chat, messages, conversations, nodes
- Short-lived graph snapshot initiation (returns 202, registers attempt)
- Streaming chat responses (≤60s)

### Limitations on Vercel

**Graph generation is preview-only and NOT durable on Vercel.**

The V2 graph-snapshot POST endpoint registers a generation attempt and runs the
pipeline in the same serverless function invocation. On Vercel:
- Function timeout is 300s max (Pro plan); free tier is 10s.
- If the function times out, the generation attempt is lost.
- There is no persistent process — a timed-out attempt cannot resume.
- The attempt/lease model prevents stale results from overwriting newer attempts,
  but it does NOT guarantee completion.

For production use, graph generation must be delegated to a durable worker (Railway).

### What works reliably on Vercel
- Chat conversations (streaming, ≤60s)
- Message persistence and retrieval
- Conversation CRUD (create, rename, archive, delete)
- Attachment upload and retrieval (via Supabase Storage)
- V2 graph snapshot reads (GET — always fast)
- V2 graph generation for small conversations (≤~10 messages, completes in <60s)
- Theme, settings, all frontend features

### What does NOT work reliably on Vercel
- V2 graph generation for large conversations (>10 messages, may exceed timeout)
- The Python ML service (not a Node.js application)
- SIE authority-mode processing (requires Python + long-running execution)
- Any background job that needs >300s or process persistence

## Railway (Planned — Durable Worker)

Railway will host:

1. **Graph generation worker** — A long-running Node.js process that:
   - Polls `v2_graph_snapshots` for rows with `status = 'generating'`
   - Executes the full V2 pipeline without timeout constraints
   - Writes results back via the attempt/lease model (same `isAttemptStillActive` guard)
   - Handles incremental updates via the existing `v2_update_state` cursor system

2. **Python ML service** — The FastAPI application in `ml-service/` that provides:
   - `/cluster-conversation` — V1 topic clustering
   - SIE semantic processing pipeline (when authority mode is enabled)
   - Embedding generation (alternative to OpenAI)

### Migration path (Vercel → Railway for graph work)

1. Deploy the graph worker on Railway as a standalone Node.js service
2. Change the POST endpoint to ONLY register the attempt (no inline execution)
3. The Railway worker picks up the registered attempt and runs generation
4. Frontend polling (already implemented) transparently sees completion
5. No frontend changes required — the same GET polling works regardless of which
   process actually runs the generation

### Railway environment variables

The Railway worker needs the same server-side env vars as the Vercel deployment:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- Model override vars as needed

## Supabase

Supabase provides:
- **Postgres** — All application data (conversations, messages, nodes, edges, snapshots)
- **Storage** — `chat-attachments` bucket for uploaded files
- **Auth** — Not currently used but available for future multi-user support
- **Realtime** — Not currently used

### Required migrations

Before first deployment, apply all migrations in `supabase/migrations/` in order:
1. `20250117000000_add_attachments_column_and_storage.sql`
2. `20250118000000_add_message_seq_column.sql`

### Required tables (created via Supabase dashboard or initial schema)
- `conversations`
- `messages`
- `nodes`
- `node_messages`
- `edges`
- `neighborhoods`
- `v2_graph_snapshots`
- `v2_update_state`

### Required RPC functions
- `v2_commit_update` — Atomic snapshot + cursor commit (gracefully falls back if missing)

## Security Model

- `SUPABASE_SERVICE_ROLE_KEY` — Server-only, bypasses RLS. Never exposed to browser.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Safe for browser, subject to RLS policies.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — Server-only, used in API routes.
- Debug endpoints gated by middleware — return 404 unless `DEBUG_ENDPOINTS=true`.
- No env var with secrets uses the `NEXT_PUBLIC_` prefix.
