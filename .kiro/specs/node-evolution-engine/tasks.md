# Implementation Plan: Node Evolution Engine (v1)

## Overview

Implement the core evolution detection pipeline: typed suggestion types, a detection engine with three heuristics (extend_node, suggest_merge, suggest_parent), a POST API route, and a frontend suggestions panel triggered from the graph toolbar. Scoped to detection and display only — no auto-apply, no split detection, no persistent storage of suggestions.

## Tasks

- [ ] 1. Define evolution types and configuration
  - [ ] 1.1 Create `src/types/evolution.ts` with suggestion types
    - Define `EvolutionAction` type (limited to `"extend_node" | "suggest_merge" | "suggest_parent"`)
    - Define `EvolutionSuggestionBase` interface with `id`, `action`, `confidence`, `reason`, `createdAt`
    - Define `ExtendNodeSuggestion` (extends base with `targetNodeId`, `messageIds`, `similarityScore`)
    - Define `MergeSuggestion` (extends base with `nodeAId`, `nodeBId`, `similarityScore`, `proposedTitle: null`)
    - Define `ParentSuggestion` (extends base with `childNodeIds`, `proposedTitle`, `avgSimilarity`)
    - Define `EvolutionSuggestion` discriminated union of the three
    - Define `EvolveGraphRequest` (`{ conversationId: string }`)
    - Define `EvolveGraphResponse` (`{ suggestions: EvolutionSuggestion[]; meta: { unlinkedMessageCount: number; nodesAnalyzed: number; processingTimeMs: number } }`)
    - Define `NodeWithEmbedding` interface for internal use (`id`, `title`, `summary`, `evidenceSummary`, `embedding: number[]`, `messageIds: string[]`)
    - Define `EmbeddedWindow` interface (`messageIds: string[]`, `embedding: number[]`, `text: string`)
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §Data Models_

  - [ ] 1.2 Create `src/lib/evolutionConfig.ts` with threshold constants
    - Export `EXTEND_SUGGEST_THRESHOLD = 0.65`
    - Export `MERGE_THRESHOLD = 0.80`
    - Export `PARENT_MIN_CLUSTER_SIZE = 3`
    - Export `PARENT_INTRA_SIMILARITY = 0.60`
    - Export `EXTEND_WINDOW_SIZE = 4`
    - Add JSDoc comments explaining each threshold's purpose
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §Detection Heuristics & Thresholds_

- [ ] 2. Implement detection engine
  - [ ] 2.1 Create `src/lib/evolutionEngine.ts` — extend_node detection
    - Implement `buildUnlinkedWindows(messages, linkedMessageIds, windowSize)` — returns arrays of consecutive unlinked messages grouped into non-overlapping windows
    - Implement `normalizeConfidence(score, min, max)` — maps a similarity score to [0, 1] range
    - Implement `detectExtendNode(windows: EmbeddedWindow[], nodes: NodeWithEmbedding[])` — for each window, find best matching node by cosine similarity; return `ExtendNodeSuggestion[]` for matches above `EXTEND_SUGGEST_THRESHOLD`
    - Import `cosineSimilarity` from `@/src/lib/cosineSimilarity`
    - Import thresholds from `@/src/lib/evolutionConfig`
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §extend_node Detection_

  - [ ] 2.2 Add merge detection to `src/lib/evolutionEngine.ts`
    - Implement `detectMergeCandidates(nodes: NodeWithEmbedding[])` — compute all pairwise similarities; return `MergeSuggestion[]` for pairs above `MERGE_THRESHOLD`
    - Ensure merge is symmetric (only emit one suggestion per unordered pair, always using `i < j` ordering)
    - Generate reason string with node titles and similarity percentage
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §suggest_merge Detection_

  - [ ] 2.3 Add parent detection to `src/lib/evolutionEngine.ts`
    - Implement `detectParentCandidates(nodes: NodeWithEmbedding[], edges: SemanticEdge[])` — find connected components in the edge graph with ≥ `PARENT_MIN_CLUSTER_SIZE` nodes; compute average pairwise similarity; return `ParentSuggestion[]` where avg ≥ `PARENT_INTRA_SIMILARITY`
    - Generate `proposedTitle` by combining child node titles (simple concatenation like "Parent of: X, Y, Z")
    - Compute confidence as `(avgSimilarity - PARENT_INTRA_SIMILARITY) / (1 - PARENT_INTRA_SIMILARITY)` clamped to [0, 1]
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §suggest_parent Detection_

- [ ] 3. Checkpoint — Ensure all tests pass
  - Ensure `npx tsc --noEmit` passes with no errors across the new files, ask the user if questions arise.

- [ ] 4. Implement API route
  - [ ] 4.1 Create `app/api/evolve-graph/route.ts`
    - Implement POST handler following existing route patterns (NextRequest/NextResponse)
    - Parse and validate `EvolveGraphRequest` body (require `conversationId` string)
    - Load nodes with embeddings from Supabase using `loadNodesWithEmbeddings`
    - Load all messages for the conversation
    - Load `node_messages` links to determine which messages are already linked
    - Identify unlinked messages and build windows using `buildUnlinkedWindows`
    - Embed each window using `generateEmbedding` from `@/src/lib/embeddings`
    - Run `detectExtendNode`, `detectMergeCandidates`, `detectParentCandidates`
    - Combine all suggestions sorted by confidence descending
    - Return `EvolveGraphResponse` with suggestions and meta (unlinkedMessageCount, nodesAnalyzed, processingTimeMs)
    - Handle errors: return 400 for bad input, 500 for DB/OpenAI failures with descriptive messages
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §Evolution API Route, §Main Evolution Detection Algorithm_

- [ ] 5. Implement frontend components
  - [ ] 5.1 Create `src/components/graph/EvolutionPanel.tsx`
    - Accept props: `suggestions: EvolutionSuggestion[]`, `isLoading: boolean`, `onAccept: (suggestion: EvolutionSuggestion) => void`, `onDismiss: (suggestion: EvolutionSuggestion) => void`, `onClose: () => void`
    - Render loading spinner when `isLoading` is true
    - Show "No suggestions" empty state when suggestions array is empty and not loading
    - Group suggestions by action type with section headers (Extend, Merge, Parent)
    - For each suggestion: show action type icon/badge, confidence as percentage, reason text, and affected node references
    - For `extend_node` suggestions: show an "Apply" button (calls `onAccept`)
    - For `suggest_merge` and `suggest_parent`: show only a "Dismiss" button (no apply logic for v1)
    - Include a close button in the panel header
    - Follow existing panel patterns (similar to `NodeDetailPanel` / `GraphSummaryPanel` styling)
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §EvolutionPanel, §Frontend Component Structure_

  - [ ] 5.2 Update `src/components/graph/GraphToolbar.tsx` — add Evolve button
    - Add new props: `isEvolving: boolean`, `onEvolve: () => void`
    - Add "🔄 Evolve" button alongside existing Structure and Summarize buttons
    - Button shows spinner + "Evolving…" text when `isEvolving` is true
    - Disable button when `isEvolving`, `isSummarizing`, or `isStructuring` is active
    - Only show button when `hasNodes` is true (same guard as Summarize)
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §Frontend Component Structure_

  - [ ] 5.3 Update `src/components/graph/GraphDrawer.tsx` — render EvolutionPanel
    - Add new props: `evolutionSuggestions: EvolutionSuggestion[]`, `isEvolving: boolean`, `onEvolve: () => void`, `onAcceptSuggestion: (s: EvolutionSuggestion) => void`, `onDismissSuggestion: (s: EvolutionSuggestion) => void`, `onCloseEvolution: () => void`
    - Pass `isEvolving` and `onEvolve` down to `GraphToolbar`
    - Render `EvolutionPanel` in the panel area when `evolutionSuggestions.length > 0 || isEvolving`
    - Evolution panel takes priority over summary/node/edge panels when active
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §Architecture, §Frontend Component Structure_

  - [ ] 5.4 Update `app/page.tsx` — wire evolution state and handler
    - Add state: `evolutionSuggestions` (EvolutionSuggestion[]), `isEvolving` (boolean)
    - Implement `handleEvolve()` — POST to `/api/evolve-graph` with `conversationId`, set loading state, store response suggestions
    - Implement `handleAcceptSuggestion(suggestion)` — for `extend_node` only: POST to existing `/api/nodes` endpoint to link messages, then remove from suggestions list and refresh conversation
    - Implement `handleDismissSuggestion(suggestion)` — remove from local suggestions array
    - Implement `handleCloseEvolution()` — clear suggestions array
    - Pass all new props to `GraphDrawer`
    - Verify: `npx tsc --noEmit` passes
    - _Requirements: Design §Example Usage_

- [ ] 6. Final checkpoint — Ensure all tests pass
  - Ensure `npx tsc --noEmit` passes across all modified and new files, ask the user if questions arise.

## Notes

- **Deferred from v1**: `suggest_split` detection, auto-apply logic (no `EXTEND_HIGH_CONFIDENCE` threshold used), persistent suggestions table, parent node creation execution, merge execution
- Each task references specific design sections for traceability
- Checkpoints validate TypeScript compilation as acceptance criteria
- The "Apply" button on `extend_node` performs a simple message-linking POST — no graph mutation beyond what already exists in the node creation flow
- All detection logic is pure (no side effects) and testable in isolation
- Frontend follows existing patterns: `GraphSummaryPanel` for panel layout, `GraphToolbar` for action buttons

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["5.1", "5.2"] },
    { "id": 5, "tasks": ["5.3"] },
    { "id": 6, "tasks": ["5.4"] }
  ]
}
```
