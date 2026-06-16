# Architecture

## Tech Stack

| Layer        | Choice             | Reason                                              |
|--------------|--------------------|-----------------------------------------------------|
| Framework    | Next.js (App Router) | Full-stack, file-based routing, React Server Components |
| Language     | TypeScript         | Type safety across the entire codebase              |
| Styling      | Tailwind CSS       | Fast, consistent, utility-first                     |
| Graph UI     | React Flow (@xyflow/react) | Purpose-built for node/edge graphs            |
| Database     | Supabase (future)  | Postgres + auth + real-time out of the box          |
| AI           | OpenAI API (future)| GPT-4o for node generation and summarization        |

## Folder Structure

```
contextgraph/
├── app/                    # Next.js App Router pages
│   ├── page.tsx            # Home — composes components only
│   └── layout.tsx
├── src/
│   ├── components/
│   │   ├── layout/         # App-wide chrome (Header)
│   │   ├── chat/           # Chat UI (ChatPanel, ChatMessage, ChatInput)
│   │   └── graph/          # Graph drawer (GraphDrawer, GraphToolbar, NodeCard)
│   ├── types/
│   │   ├── message.ts      # ChatMessage type
│   │   └── node.ts         # ContextNode type
│   ├── data/
│   │   └── mockMessages.ts # Static data, swapped for DB later
│   ├── hooks/              # Custom React hooks (useChat, useGraph — future)
│   ├── services/           # API calls and external integrations (future)
│   └── lib/                # Shared utilities (future)
└── docs/                   # Product and engineering documentation
```

## Key Principle

`app/page.tsx` is a composition file only. It holds state and wires components together.
It does not contain UI markup directly. All markup lives in `src/components`.

State lives at the page level for now. When the app grows, state will move into
custom hooks (`useChat`, `useGraph`) so components stay purely presentational.
