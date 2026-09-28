# Graph Workspaces Migration Plan (v3 — Final)

## Current State Summary

| Aspect | Graph Dashboard | Conversation Knowledge Map |
|--------|----------------|---------------------------|
| Source of truth | `localStorage["contextgraph-manual-dashboard"]` | `v2_graph_snapshots.graph_payload` (JSONB) |
| Position persistence | Yes — `PersistedNode.position` in localStorage | **None** — `layoutDisplayForest()` recomputes on every render |
| DB persistence | Partial/unused — fake-conversation path writes to `v2_graph_snapshots` but frontend reads localStorage | Yes — part of the V2/SIE pipeline output |
| Multiple graphs | No — single blob per workspace | N/A (one per conversation) |
| Node-conversation links | `PersistedNode.conversationId` in localStorage JSON | N/A |

The fake-conversation DB path:
- Uses deterministic UUIDs: `owner → 00000000-0000-4000-a000-000000000001`, `demo → 00000000-0000-4000-a000-000000000002`
- Creates archived conversation rows to satisfy `v2_graph_snapshots.conversation_id` FK
- The `POST /api/graph-dashboard` endpoint writes `{ nodes, edges }` to the DB
- The `GET /api/graph-dashboard` endpoint reads from DB
- **However**, the frontend page ignores the API entirely and uses localStorage for both reads and writes

---

## 1. Database Schema

### 1.1 `graph_workspaces` table

```sql
CREATE TABLE graph_workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Current ownership model (workspace-based).
    -- Designed so this column can later be replaced by user_id UUID REFERENCES auth.users(id)
    -- without restructuring the feature — just rename/migrate the column.
    workspace_id TEXT NOT NULL,
    
    name TEXT NOT NULL DEFAULT 'Untitled Graph',
    
    -- Versioned JSONB payload containing nodes, edges, and positions.
    -- Shape: { nodes: PersistedNode[], edges: PersistedEdge[] }
    -- PersistedNode includes: id, position.x, position.y, data.{title, objectType, description, provenance, createdAt}, conversationId?
    -- PersistedEdge includes: id, source, target, label?, data.{type, explanation, provenance, createdAt}
    graph_payload JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    
    -- Enables forward-compatible payload evolution.
    -- v1 = current shape. Future versions can add fields, change structure.
    -- Application code uses this to determine how to read/write the payload.
    schema_version INTEGER NOT NULL DEFAULT 1,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_gw_workspace_id_valid CHECK (workspace_id IN ('owner', 'demo'))
);

-- Primary listing query: "show me my graphs, most recently edited first"
CREATE INDEX idx_graph_workspaces_listing
    ON graph_workspaces (workspace_id, updated_at DESC);
```

### 1.2 `graph_workspace_conversations` table

```sql
CREATE TABLE graph_workspace_conversations (
    graph_workspace_id UUID NOT NULL REFERENCES graph_workspaces(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    
    -- The node inside graph_payload that originally spawned this conversation.
    -- TEXT (not UUID FK) because node IDs live inside JSONB, not in the relational nodes table.
    -- NULL means "manually associated, not linked to a specific dashboard node."
    source_node_id TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Same conversation cannot be attached to the same graph twice.
    PRIMARY KEY (graph_workspace_id, conversation_id)
);

-- "Which graphs does conversation X belong to?" (used when showing graph badges in chat)
CREATE INDEX idx_gwc_by_conversation
    ON graph_workspace_conversations (conversation_id);
```

### 1.3 `conversation_node_positions` table (for Knowledge Map position persistence)

```sql
CREATE TABLE conversation_node_positions (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,          -- objectId from the V2 graph snapshot
    position_x DOUBLE PRECISION NOT NULL,
    position_y DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    PRIMARY KEY (conversation_id, node_id)
);
```

This table stores user-arranged positions for conversation Knowledge Map nodes. The auto-layout function provides initial coordinates; once a user drags a node, the persisted position takes precedence on subsequent loads.

---

## 2. Deletion Semantics

### Deleting a Graph Workspace
```
DELETE graph_workspace WHERE id = X
→ CASCADE deletes graph_workspace_conversations rows (memberships)
→ Does NOT delete conversations or their messages
→ The graph_payload (nodes, edges, positions) is gone
```

### Removing a conversation from a graph
```
DELETE graph_workspace_conversations WHERE graph_workspace_id = X AND conversation_id = Y
→ Only removes the membership link
→ Conversation, messages, and all other data remain intact
```

### Deleting a dashboard node that started a conversation
```
Node removed from graph_payload
→ Set source_node_id = NULL on the corresponding graph_workspace_conversations row
  (keep the conversation in the graph's sidebar, just unlinked from a specific node)
→ Conversation itself is never deleted by this action
→ User must explicitly delete the conversation through the normal conversation delete flow
```

---

## 3. localStorage → DB Import Sequence

### Problem
The SQL migration cannot access browser localStorage. The frontend must handle the import.

### Lifecycle

```
User opens Graph Dashboard (post-upgrade)
  │
  ├─ GET /api/graph-workspaces → returns list for this workspace
  │
  ├─ IF list is non-empty:
  │     Load selected graph, done.
  │
  ├─ IF list is empty:
  │     ├─ Check localStorage["contextgraph-manual-dashboard"]
  │     │
  │     ├─ IF localStorage has data:
  │     │     ├─ POST /api/graph-workspaces/import-legacy
  │     │     │   Body: { nodes, edges, source: "localStorage" }
  │     │     │   Server: creates graph_workspace + graph_workspace_conversations
  │     │     │   Response: { graphId, imported: true }
  │     │     │
  │     │     ├─ Verify: GET /api/graph-workspaces → confirm the new graph exists
  │     │     │
  │     │     ├─ On success:
  │     │     │     localStorage.setItem("contextgraph-dashboard-migrated", "true")
  │     │     │     localStorage.removeItem("contextgraph-manual-dashboard")
  │     │     │
  │     │     └─ On failure:
  │     │           Keep localStorage intact, show error, allow retry
  │     │
  │     └─ IF localStorage is empty:
  │           ├─ Check fake-conversation DB path (GET /api/graph-dashboard legacy)
  │           ├─ IF data exists: import via same server-side path
  │           └─ IF nothing: show empty state with "Create your first graph"
  │
  └─ Done
```

### Idempotency

The import endpoint (`POST /api/graph-workspaces/import-legacy`) must be idempotent:
- Accept an optional `idempotency_key` (or derive one from workspace + source)
- Before creating, check if a graph with name "Graph Dashboard" already exists for this workspace with `schema_version = 1`
- If found, return the existing graph (no duplicate created)
- This ensures refresh/retry cannot create duplicate workspaces

### Conflict Resolution: localStorage vs. fake-conversation DB data

Both sources may contain data. Priority:
1. **localStorage wins** — it is the actual source of truth the user has been interacting with
2. The fake-conversation DB data is stale (the frontend hasn't been reading from it)
3. If localStorage is empty but DB fake-conversation has data, import from DB
4. If both exist and differ, import localStorage (the user's working copy)

---

## 4. Handling Existing Fake-Conversation Snapshots

After successful import (or if the workspace never had dashboard data):

1. Do **not** delete fake-conversation rows during migration — they serve as a safety net
2. After confirming the new system works in production for 1+ releases:
   - Delete `v2_graph_snapshots` rows for the deterministic dashboard UUIDs
   - Delete the synthetic `conversations` rows (`00000000-0000-4000-a000-000000000001/2`)
   - Remove the `GET /api/graph-dashboard` and `POST /api/graph-dashboard` legacy endpoints
   - Remove the `DASHBOARD_IDS` constants from server code

---

## 5. Source-Node / Conversation Association Rules

When a user clicks "Start a conversation" on a dashboard node:

```
1. POST /api/conversations → { id: newConversationId }
2. Update graph_payload: set node.conversationId = newConversationId
3. POST /api/graph-workspaces/conversations → { graphId, conversationId: newConversationId, sourceNodeId: node.id }
4. Save updated graph_payload via POST /api/graph-workspaces/:id/save
5. Navigate to conversation
```

When a user "Adds existing conversation" to a graph:
```
1. POST /api/graph-workspaces/conversations → { graphId, conversationId, sourceNodeId: null }
2. Conversation appears in sidebar, not linked to any specific node
```

When viewing the conversations sidebar:
- Query `graph_workspace_conversations` for current graph
- Show conversation title, linked node name (if `source_node_id` is set)
- Click → navigate to that conversation in main chat

---

## 6. Hydration / Save Lifecycle (Anti-Race Conditions)

The frontend must track explicit states to prevent the classic bug of an empty React state overwriting persisted data:

```typescript
type GraphHydrationState =
  | { status: "loading" }                    // Initial fetch in progress
  | { status: "hydrated"; graphId: string }  // Successfully loaded from DB
  | { status: "empty" }                      // No graph exists, show creation UI
  | { status: "error"; message: string }     // Failed to load, show error + retry
  | { status: "migrating" }                  // Legacy import in progress
```

### Rules

1. **No saves until `status === "hydrated"`** — prevents empty state overwriting real data
2. **A failed GET does not transition to "empty"** — it transitions to "error"
3. **Saves are debounced** (existing 300ms pattern) but always fire on:
   - Node drag end (not during drag)
   - Node/edge create, edit, delete
   - Window beforeunload (flush pending save)
4. **Optimistic UI** — local state updates immediately; save fires in background
5. **Save conflict detection** — if `updated_at` on server is newer than client's last-known value, warn user (future enhancement, not MVP)

### Position Save Behavior

For the Graph Dashboard:
- Positions live inside `graph_payload.nodes[].position`
- During drag: only local React Flow state updates
- On drag end: persist final position to `graph_payload`, trigger debounced save
- On page load: positions restored from `graph_payload`

For Conversation Knowledge Maps:
- Auto-layout provides initial positions via `layoutDisplayForest()`
- When user drags a node to a new position (drag end): `PUT /api/conversation-node-positions` → upserts to `conversation_node_positions` table
- On load: fetch user positions → overlay onto auto-layout → user positions take precedence for any node that has a saved position
- When SIE generates new nodes: new nodes get auto-layout positions; existing nodes with saved positions keep their user positions

---

## 7. Position Persistence for Conversation Knowledge Maps

### Current behavior (no persistence)
`V2GraphCanvas` calls `layoutDisplayForest(displayGraph)` on every render. Positions are never saved. Dragging works within the session (React Flow internal state) but resets on refresh.

### New behavior
1. Add `onNodeDragStop` handler to `V2GraphCanvas`
2. On drag stop: save `{ nodeId, x, y }` to `conversation_node_positions` table (debounced batch)
3. On load: 
   ```
   autoPositions = layoutDisplayForest(displayGraph)
   savedPositions = GET /api/conversation-node-positions?conversationId=X
   finalPositions = merge(autoPositions, savedPositions)  // saved overrides auto
   ```
4. When graph is regenerated (new SIE update adds/removes nodes):
   - Nodes with saved positions: keep saved positions
   - New nodes (no saved position): get auto-layout position
   - Removed nodes: their saved positions become orphaned (no harm, cleaned up lazily or on conversation delete via CASCADE)

### What is NOT persisted (transient React Flow state)
- `selected`, `dragging`, `measured` dimensions
- Hover state, temporary lasso/selection state
- Viewport zoom/pan position (could be added later but not in scope)

---

## 8. API Surface

### `/api/graph-workspaces`

| Method | Action | Body/Params |
|--------|--------|-------------|
| `GET` | List all graph workspaces for session's workspace | — |
| `POST` | Create new empty graph workspace | `{ name: string }` |
| `PATCH` | Rename a graph workspace | `{ id: string, name: string }` |
| `DELETE` | Delete a graph workspace (with cascade) | `{ id: string }` |

### `/api/graph-workspaces/import-legacy`

| Method | Action | Body |
|--------|--------|------|
| `POST` | Import legacy localStorage/DB data | `{ nodes, edges, source: "localStorage" \| "db" }` |

Returns existing graph if idempotent match found.

### `/api/graph-workspaces/:id/save`

| Method | Action | Body |
|--------|--------|------|
| `PUT` | Save graph payload (nodes, edges, positions) | `{ nodes: PersistedNode[], edges: PersistedEdge[] }` |

Updates `graph_payload` and `updated_at`.

### `/api/graph-workspaces/:id/load`

| Method | Action | Params |
|--------|--------|--------|
| `GET` | Load graph payload + conversation list | — |

Returns `{ graph_payload, conversations: [...], schema_version }`.

### `/api/graph-workspaces/conversations`

| Method | Action | Body |
|--------|--------|------|
| `POST` | Associate conversation with graph | `{ graphId, conversationId, sourceNodeId? }` |
| `DELETE` | Remove conversation from graph | `{ graphId, conversationId }` |

### `/api/conversation-node-positions`

| Method | Action | Body/Params |
|--------|--------|-------------|
| `GET ?conversationId=X` | Load saved positions for a conversation | — |
| `PUT` | Batch upsert positions | `{ conversationId, positions: [{nodeId, x, y}] }` |

---

## 9. Rollback Strategy

### If migration fails mid-way

1. **SQL tables are additive** — creating `graph_workspaces` and `graph_workspace_conversations` doesn't break any existing functionality
2. **localStorage is not deleted until DB write is verified** — user can always fall back
3. **Fake-conversation data is preserved** — old API endpoints still work during transition
4. **Feature flag**: Add `NEXT_PUBLIC_GRAPH_WORKSPACES=true` env var. When false, old localStorage behavior continues to work unchanged.

### Full rollback SQL

```sql
-- Emergency rollback: drops new tables, restores old behavior
DROP TABLE IF EXISTS graph_workspace_conversations CASCADE;
DROP TABLE IF EXISTS graph_workspaces CASCADE;
DROP TABLE IF EXISTS conversation_node_positions CASCADE;
```

The old code paths (localStorage + fake-conversation) remain functional until explicitly removed in a cleanup PR.

---

## 10. Future Auth Transition Notes

The `workspace_id TEXT` column is designed for easy transition:

```sql
-- Future migration (NOT part of this task):
ALTER TABLE graph_workspaces ADD COLUMN user_id UUID REFERENCES auth.users(id);
-- Backfill user_id from workspace_id mapping
-- Then: ALTER TABLE graph_workspaces DROP COLUMN workspace_id;
-- Update RLS policies to use auth.uid() = user_id
```

No structural changes to `graph_workspace_conversations` or `conversation_node_positions` needed — they reference `graph_workspaces.id` and `conversations.id` respectively, both of which persist across the auth migration.

---

## 11. What This Does NOT Change

- V2/SIE pipeline snapshot generation (`v2_graph_snapshots` per conversation)
- The conversation-level "Full Network" graph view component structure
- Canvas interaction (React Flow, V2NodeCard, edge editing, lasso, copy/paste)
- The right-side node detail panel
- Start/Continue conversation UX on nodes
- Authentication or workspace scoping model
- The conceptual map view
