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
