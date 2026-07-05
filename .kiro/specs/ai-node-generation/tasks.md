# Implementation Plan

## Overview

This task list implements the AI node generation quality bugfix using the exploratory bugfix workflow: write tests to understand the bug, preserve existing behavior, implement the fix (graph-aware materialization, semantic edges, synthesis pass, benchmarks), then validate everything works.

## Tasks

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Shallow Materialization and Meaningless Edges
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the engine produces topic-label titles, message-replay summaries, and edges with `relationship_type = "related"` and empty explanations
  - **Scoped PBT Approach**: Feed the art-rock-persona benchmark messages to `materializeToNode()` and verify:
    - Title matches topic-label pattern (e.g., "Exploring X", "Discussion about X") — assert it should NOT match these patterns (test will FAIL on unfixed code)
    - Summary starts with replay patterns ("Discussion about", "They talked about") — assert it should NOT match these patterns (test will FAIL on unfixed code)
    - Edges produced by `computeIncrementalEdges()` have `relationship_type = "related"` and `explanation = ""` — assert they should have meaningful values (test will FAIL on unfixed code)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists: titles are topic labels, summaries replay messages, edges have no semantic meaning)
  - Document counterexamples found (e.g., "materializeToNode produced 'Exploring the Decline of Art Since 2021' instead of an insight-driven title")
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.5_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Pipeline Mechanics Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `checkSegmentBoundary()` produces consistent shouldClose decisions for exchange embeddings on unfixed code
  - Observe: `routeSegment()` routing decisions (extend_node, accumulate, new_candidate) for segment+node+candidate configurations on unfixed code
  - Observe: `computeConfidence()` returns consistent confidence scores for candidate/node states on unfixed code
  - Observe: `shouldMaterialize()` returns consistent boolean decisions for candidate states on unfixed code
  - Write property-based tests:
    - For all exchange embeddings, segmentation boundary detection logic is unchanged (cosine similarity thresholds preserved)
    - For all segment+node+candidate configurations, routing decisions are identical
    - For all candidate states, confidence computation formula yields same scores
    - For all candidate states, materialization threshold gating is unchanged
    - MIN_EVIDENCE_MESSAGES guardrail (4 messages) still blocks under-evidenced candidates
    - MAX_AUTO_NODE_MESSAGES / MAX_AUTO_NODE_SEGMENTS block checks still fire
  - Verify tests pass on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [ ] 3. Graph-aware materialization prompt

  - [ ] 3.1 Rewrite `materializeToNode()` in `src/lib/intelligence/engine.ts`
    - Load the 3 most similar existing nodes by embedding cosine similarity against the candidate embedding
    - Format neighboring nodes as context: `• "Node Title" — Node Summary` for each
    - Replace existing prompt with insight-synthesis prompt (not topic-labeling)
    - New prompt instructs: synthesize what was REALIZED, LEARNED, or EMOTIONALLY UNDERSTOOD
    - Include few-shot examples of good vs bad titles/summaries in the prompt
    - Increase `max_tokens` from 150 to 300
    - Increase title max from 60 to 80 chars
    - If no nodes exist yet, omit the neighbor context section
    - _Bug_Condition: isBugCondition(input) where materializedNode.title IS topic_label_style OR summary IS message_replay_style_
    - _Expected_Behavior: titles capture core insight/realization/emotional theme, summaries articulate what was concluded or learned_
    - _Preservation: Segmentation, routing, confidence gating unchanged — only the LLM prompt text changes_
    - _Requirements: 2.1, 2.2_

  - [ ] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Insight-Driven Node Materialization
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior (insight titles, conclusion summaries)
    - When this test passes, it confirms the materialization prompt produces insight-driven output
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms materialization bug is fixed)
    - _Requirements: 2.1, 2.2_

  - [ ] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Pipeline Mechanics Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions to segmentation, routing, confidence)
    - Confirm all pipeline mechanics are unchanged after materialization prompt rewrite

- [ ] 4. Insight-driven node title + summary generation refinements

  - [ ] 4.1 Tune prompt temperature and response parsing
    - Adjust temperature for optimal insight quality (test 0.5-0.7 range)
    - Update `isTitleSummaryResponse()` validation for new 80-char title / 300-char summary limits
    - Ensure `parseJsonFromLLM()` handles the richer response format
    - _Requirements: 2.1, 2.2_

  - [ ] 4.2 Validate against art-rock-persona benchmark
    - Run materializeToNode on benchmark segments
    - Verify titles score ≥3 on benchmark rubric "Title quality" dimension
    - Verify summaries score ≥3 on benchmark rubric "Summary quality" dimension
    - _Requirements: 2.1, 2.2, 2.5_

- [ ] 5. LLM semantic edge generation with relationship_type + explanation

  - [ ] 5.1 Create `generateSemanticEdge()` helper in `src/lib/intelligence/engine.ts`
    - Accept source node (title, summary) and target node (title, summary)
    - LLM prompt asks for: relationship_type (verb phrase), explanation (one sentence), direction (a_to_b | b_to_a | bidirectional)
    - Return typed result `{ relationship_type: string, explanation: string, direction: string }`
    - _Requirements: 2.3_

  - [ ] 5.2 Integrate with `computeIncrementalEdges()` pipeline
    - After `computeIncrementalEdges()` identifies pairs above cosine threshold, call `generateSemanticEdge()` for each new pair
    - Use direction field to determine source vs target (replace current alphabetical ordering)
    - Limit to max 3 edge generation calls per engine run (cost control)
    - _Requirements: 2.3, 2.5_

  - [ ] 5.3 Update `add_edge` mutation and `persistMutations` handler
    - Add `relationship_type` field to `add_edge` GraphMutation type in `types.ts`
    - Update `persistMutations` to write `relationship_type` from the mutation (instead of hardcoded `"related"`)
    - _Bug_Condition: edges have relationship_type == "related" AND explanation == ""_
    - _Expected_Behavior: edges have meaningful relationship_type (verb phrase) and non-empty explanation_
    - _Requirements: 2.3_

  - [ ] 5.4 Verify edges now have semantic relationship types
    - Run pipeline on art-rock-persona benchmark
    - Confirm edges have meaningful `relationship_type` values (e.g., "led to exploration of", "became foundation for")
    - Confirm edges have non-empty `explanation` sentences
    - Score ≥3 on benchmark rubric "Edge quality" dimension
    - _Requirements: 2.3, 2.5_

- [ ] 6. Local Graph Synthesis Pass for new node + 3 nearest neighbors

  - [ ] 6.1 Create `runGraphSynthesisPass()` function in `src/lib/intelligence/engine.ts`
    - Runs after every successful node materialization, before persist
    - Loads new node + up to 3 nearest neighbors (by embedding similarity)
    - Loads existing edges in the local subgraph
    - LLM prompt reviews subgraph and returns: nodeImprovements, newEdges, removeEdges
    - LLM is free to: rename shallow nodes, rewrite summaries, add edges with relationship types, remove meaningless edges
    - Skip if new node has no neighbors (first node in graph)
    - Max 1 synthesis pass per engine run
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ] 6.2 Add `update_node_content` mutation type to `types.ts`
    - New mutation: `{ type: "update_node_content"; nodeId: string; title: string; summary: string }`
    - Add handler in `persistMutations`: update nodes table with new title and summary
    - _Requirements: 2.1, 2.2_

  - [ ] 6.3 Wire synthesis pass into pipeline orchestration
    - Call `runGraphSynthesisPass()` after materialization in `runPipeline()`
    - Emit `update_node_content`, `add_edge`, and `remove_edge` mutations from synthesis results
    - Only improve nodes that are clearly shallow (the prompt handles this)
    - Only add edges that explain meaningful conceptual evolution
    - _Requirements: 2.5_

  - [ ] 6.4 Verify synthesis pass improves local subgraph coherence
    - Run full pipeline on art-rock-persona benchmark
    - Confirm synthesis pass identifies and improves any remaining shallow nodes
    - Confirm graph reads like externalized memory, not clustered transcript
    - Score ≥3 on benchmark rubric "Recall test" dimension
    - _Requirements: 2.4, 2.5_

- [ ] 7. Benchmarks: Rockstar and art-rock-persona evaluation

  - [ ] 7.1 Create Rockstar benchmark at `benchmarks/rockstar-identity.md`
    - Define conversation arc: Rockstar → personal identity → authentic relationships → self-confidence
    - Define expected nodes (insight-driven titles, conclusion summaries)
    - Define expected edges (relationship types explaining conceptual evolution)
    - Define expected segmentation (natural chapter boundaries)
    - Include scoring rubric (title quality, summary quality, edge quality, segmentation, recall test)
    - _Requirements: 2.6_

  - [ ] 7.2 Create evaluation utility at `src/lib/intelligence/benchmark.ts`
    - Function accepts: current graph state (nodes, edges) + benchmark definition
    - Scores each dimension 1-5 using benchmark rubric via LLM evaluation
    - Returns structured results: `{ titleQuality, summaryQuality, edgeQuality, segmentation, recallTest, overall }`
    - _Requirements: 2.6_

  - [ ] 7.3 Create debug endpoint `/api/debug/benchmark`
    - `GET /api/debug/benchmark?id=art-rock-persona` or `?id=rockstar-identity`
    - Loads current graph for the benchmark conversation
    - Runs evaluation utility and returns scores
    - _Requirements: 2.6_

  - [ ] 7.4 Validate both benchmarks score ≥3 on all dimensions
    - Run art-rock-persona benchmark: all dimensions ≥3
    - Run rockstar-identity benchmark: all dimensions ≥3
    - Document final scores
    - _Requirements: 2.6_

- [ ] 8. Cleanup, testing, and build verification

  - [ ] 8.1 Run `npx tsc --noEmit` — fix any type errors
    - Ensure all new types (update_node_content mutation, generateSemanticEdge return type) compile cleanly
    - Ensure all existing types remain valid
    - _Requirements: 3.2, 3.5_

  - [ ] 8.2 Run `npm run build` — fix any build errors
    - Verify Next.js production build succeeds
    - No new warnings or errors introduced
    - _Requirements: 3.2_

  - [ ] 8.3 Verify pipeline end-to-end
    - Run full pipeline on a test conversation
    - Confirm materialization, edge generation, and synthesis pass execute in sequence
    - Confirm mutations persist correctly to database
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

  - [ ] 8.4 Verify preservation: segmentation, routing, confidence unchanged
    - Re-run preservation property tests from task 2 — all must pass
    - Confirm hard topic change (e.g., music → weather) still produces separate segments
    - Confirm extend_node still triggers for highly similar new segments
    - Confirm confidence gating still blocks low-confidence candidates
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [ ] 9. Checkpoint — Ensure all tests pass
  - Run full test suite
  - Verify all property-based tests pass (bug condition and preservation)
  - Verify both benchmarks score ≥3 on all dimensions
  - Verify `npx tsc --noEmit` passes
  - Verify `npm run build` passes
  - Ensure all tests pass, ask the user if questions arise.

## Task Dependency Graph

```json
{
  "waves": [
    { "tasks": ["1", "2"] },
    { "tasks": ["3"] },
    { "tasks": ["4"] },
    { "tasks": ["5"] },
    { "tasks": ["6"] },
    { "tasks": ["7"] },
    { "tasks": ["8"] },
    { "tasks": ["9"] }
  ]
}
```

## Notes

- Tasks 1 and 2 MUST be completed before any implementation work (tasks 3-6)
- Task 3.2 and 3.3 re-run tests from tasks 1 and 2 — they do NOT write new tests
- The graph synthesis pass (task 6) depends on both materialization (task 3) and edge generation (task 5) being complete
- Benchmarks (task 7) validate the combined output of all prior implementation tasks
- Segmentation logic is explicitly out of scope — no broad segmentation rewrites
