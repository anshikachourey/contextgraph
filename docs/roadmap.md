# Roadmap

## MVP 1 — Manual Context Graph (current)
- Chat UI with message list
- Select messages
- Create context node manually
- Node appears in graph drawer
- Maximize/collapse graph drawer

## MVP 2 — Real Graph Canvas
- Replace node card list with React Flow canvas
- Draggable nodes
- Edges between related nodes
- Visual graph layout

## MVP 3 — Node → Messages
- Click a node in the graph
- Highlight the linked messages in the chat
- Show message context panel

## MVP 4 — AI-Assisted Nodes
- AI generates node title from selected messages
- AI generates node summary
- No manual typing required

## MVP 5 — Persistence
- Database (Supabase / Postgres)
- Save conversations and graphs
- Load previous sessions

## MVP 6 — Semantic Search
- Embeddings on messages and nodes
- Search by meaning, not just keyword
- Suggested related nodes
- Context builder: select a node → AI continues from that context
