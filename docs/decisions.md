# Architecture Decision Records

---

## ADR-001: State lives in page.tsx, not inside components

**Date:** 2025  
**Status:** Accepted

**Context:**  
During the MVP phase, the app has one page and a small number of shared state values
(`nodes`, `selectedMessageIds`, `isGraphOpen`, `isGraphMaximized`).

**Decision:**  
State is owned by `page.tsx` and passed down via props. Components are stateless where possible.

**Reason:**  
Avoids premature abstraction. When the app grows to multiple pages or the state becomes
complex, we'll extract it into custom hooks (`useGraph`, `useChat`).

---

## ADR-002: Graph opens as a drawer, not a separate page

**Date:** 2025  
**Status:** Accepted

**Context:**  
We considered routing to `/graph` as a separate page.

**Decision:**  
Graph opens as a slide-in drawer over the chat.

**Reason:**  
Users should never lose their chat context when opening the graph.
The relationship between chat and graph is the core product interaction.
A separate page would break that mental model.

---

## ADR-003: Mock data lives in src/data, not in page.tsx

**Date:** 2025  
**Status:** Accepted

**Context:**  
Initial messages were hardcoded directly inside `page.tsx`.

**Decision:**  
Moved to `src/data/mockMessages.ts`.

**Reason:**  
When we add a database, only `mockMessages.ts` needs to change — not the component tree.
This is the data layer boundary, even at prototype stage.

---

## ADR-006: Node detail panel splits layout based on drawer vs maximized mode

**Date:** 2025  
**Status:** Accepted

**Context:**  
When a node is selected, the detail panel needs to coexist with the graph canvas.
We have two drawer states: normal (460px wide) and maximized (full screen).

**Decision:**  
- Normal drawer: canvas takes 55% of height, detail panel takes 45% below it (vertical split).
- Maximized: canvas takes remaining width, detail panel is a fixed 320px right column (horizontal split).

**Reason:**  
In the narrow drawer, a side-by-side layout would make the canvas too small to be usable.
A vertical split preserves enough canvas area for navigation while showing the detail panel.
In maximized mode there's enough horizontal space to use both panes properly — the same
pattern used by tools like Linear (detail panels) and Figma (right sidebar).

**State ownership:**  
`activeNodeId` lives in `page.tsx`. `activeNode` and `activeNodeMessages` are derived values
(no extra state). `GraphDrawer` receives them as props — it doesn't fetch or compute them.
This keeps the drawer purely presentational.

---

## ADR-005: React Flow canvas is isolated in GraphCanvas.tsx

**Date:** 2025  
**Status:** Accepted

**Context:**  
We needed to replace the node card list in the graph drawer with an interactive React Flow canvas.

**Decision:**  
React Flow logic lives exclusively in `src/components/graph/GraphCanvas.tsx`.
`GraphDrawer.tsx` doesn't import anything from `@xyflow/react` — it just renders `<GraphCanvas />`.

**Reason:**  
React Flow is a complex third-party library with its own state model (`useNodesState`, `useEdgesState`).
Keeping it isolated means `GraphDrawer` can stay a simple layout component.
If we ever swap React Flow for a different graph library, only `GraphCanvas.tsx` and `ContextNodeCard.tsx` change.

**Node layout:**  
For MVP, nodes are positioned in a simple vertical column (`y = index * 180`).
A proper auto-layout (dagre or ELK) will be added in a later milestone when edge relationships matter more.

---

## ADR-004: Types live in src/types, not co-located with components

**Date:** 2025  
**Status:** Accepted

**Context:**  
`ChatMessage` and `ContextNode` types were defined inside `page.tsx`.

**Decision:**  
Moved to `src/types/message.ts` and `src/types/node.ts`.

**Reason:**  
Types are shared across components, services, and hooks. They don't belong to any
single component. Centralizing them prevents duplication and drift.
