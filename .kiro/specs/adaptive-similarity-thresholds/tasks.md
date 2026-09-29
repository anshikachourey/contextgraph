# Implementation Plan: Adaptive Similarity Thresholds

## Overview

Most of this feature is already built and working: the migration/table + constraints, the pure calibration engine, the store, the accessor + constants, the consumer wiring, and the debug endpoint all exist. This plan therefore:

1. **Verifies** the already-built code against the requirements (run existing tests, diagnostics, build) rather than rebuilding it.
2. **Promotes** the existing example-based engine tests into `fast-check` property-based tests covering the 7 correctness properties in the design, and adds the accessor property.
3. **Closes the gaps** the current code does not yet satisfy (read timeout, stored-value validation, recompute timeout, unrecognized-verb handling, GET read-failure handling), each paired with its test.
4. Adds the **integration/unit tests** described in the design testing strategy.

Environment notes baked into the relevant tasks:
- This repo requires **Node 22** for all npm commands. Prefix every npm invocation with `eval "$(fnm env)" && fnm use 22`.
- Test runner is **Vitest**; property tests use **fast-check** (`--run` for single execution, never watch mode).
- Next.js 16 route handlers export async `GET`/`POST`.

## Tasks

- [x] 1. Verify the already-built implementation against requirements
  - [x] 1.1 Run the existing calibration engine test suite and confirm it passes
    - Run `eval "$(fnm env)" && fnm use 22 && npx vitest --run src/lib/calibration/threshold-calibration.test.ts`
    - Confirm existing example-based coverage of pairwise scores, bimodality, valley detection, revert cases, and applied case all pass before any changes
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 7.1, 8.1, 8.2, 8.8_
  - [x] 1.2 Run diagnostics on all shipped feature files to confirm a clean baseline
    - Check `src/lib/calibration/threshold-calibration.ts`, `src/lib/db/calibration.ts`, `src/lib/similarityThresholds.ts`, `src/lib/edgeSuggestions.ts`, and `app/api/debug/calibrate-thresholds/route.ts` for compile/type/lint issues
    - Record any pre-existing issues so they are not attributed to later changes
    - _Requirements: 1.1, 1.2, 1.3, 2.4, 3.5, 3.6, 4.1, 4.2, 10.1, 10.2_
  - [x] 1.3 Verify the migration constraints match the design schema
    - Read `supabase/migrations/20260823000000_create_similarity_calibration.sql`
    - Confirm `chk_similarity_calibration_singleton` (`id = 'global'`) and `chk_similarity_calibration_range` (thresholds in `[0,1]` AND `strongly_related >= possibly_related`) exist as designed
    - _Requirements: 9.2, 9.6_

- [x] 2. Promote engine tests to property-based tests (fast-check)
  - [x]* 2.1 Add fast-check generators and Property 1 (determinism) to `src/lib/calibration/threshold-calibration.test.ts`
    - Ensure `fast-check` is available as a dev dependency; install with Node 22 if missing (`eval "$(fnm env)" && fnm use 22 && npm i -D fast-check`)
    - Build a shared node-set arbitrary: arrays of `{ id, embedding }` with fixed-dimension `number[]`, mixing in `null` and `[]` embeddings, and one/two-cluster distributions via seeded jitter so both applied and reverted branches are exercised
    - Assert running `calibrateThresholds` twice on the same set produces field-by-field identical `CalibrationResult`
    - Use minimum 100 runs (`{ numRuns: 100 }`); tag `// Feature: adaptive-similarity-thresholds, Property 1: Determinism`
    - **Property 1: Determinism**
    - **Validates: Requirements 5.2**
  - [x]* 2.2 Add Property 2 (order-independence) property test
    - Assert `calibrateThresholds(nodes)` equals `calibrateThresholds(permutation(nodes))` field-by-field
    - Minimum 100 runs; tag `// Feature: adaptive-similarity-thresholds, Property 2: Order-independence (permutation invariance)`
    - **Property 2: Order-independence**
    - **Validates: Requirements 5.3**
  - [x]* 2.3 Add Property 3 (embedding-less exclusion) property test
    - Assert inserting extra `null`/`[]`-embedding nodes does not change the result, and that pairwise score count is `k·(k−1)/2` for `k` usable embeddings
    - Minimum 100 runs; tag `// Feature: adaptive-similarity-thresholds, Property 3: Embedding-less nodes are excluded`
    - **Property 3: Embedding-less nodes are excluded**
    - **Validates: Requirements 5.1, 5.4**
  - [x]* 2.4 Add Property 4 (no mutation of inputs) property test
    - Deep-clone the input before the call and assert deep equality of nodes and embedding arrays after `calibrateThresholds` returns
    - Minimum 100 runs; tag `// Feature: adaptive-similarity-thresholds, Property 4: No mutation of inputs`
    - **Property 4: No mutation of inputs**
    - **Validates: Requirements 5.7**
  - [x]* 2.5 Add Property 5 (revert-to-safe) property test
    - Assert that whenever `applied === false`, `stronglyRelated === STRONGLY_RELATED_THRESHOLD` (0.7) and `possiblyRelated === POSSIBLY_RELATED_THRESHOLD` (0.6)
    - Minimum 100 runs; tag `// Feature: adaptive-similarity-thresholds, Property 5: Revert-to-safe never installs derived thresholds`
    - **Property 5: Revert-to-safe never installs derived thresholds**
    - **Validates: Requirements 6.1, 6.4, 7.2, 8.3**
  - [x]* 2.6 Add Property 6 (applied-implies-safe-ordering) property test
    - Assert that whenever `applied === true`, `0.3 <= possiblyRelated <= 0.85` and `possiblyRelated < stronglyRelated <= 0.98`
    - Minimum 100 runs; tag `// Feature: adaptive-similarity-thresholds, Property 6: Applied results are sane and correctly ordered`
    - **Property 6: Applied results are sane and correctly ordered**
    - **Validates: Requirements 8.4, 8.5, 8.6, 8.8**
  - [x]* 2.7 Add Property 7 (accessor never throws) property test in a new `src/lib/similarityThresholds.test.ts`
    - Mock the store read outcome via `vi.mock("./db/calibration")` to yield each of: `null`, an applied row, a reverted row, and a throwing stub
    - Assert `getEdgeThresholds()` always resolves (never rejects) to a valid `EdgeThresholds`, and that no-row / reverted / error outcomes yield `DEFAULT_EDGE_THRESHOLDS` with `calibrated === false`
    - Minimum 100 runs over the outcome arbitrary; tag `// Feature: adaptive-similarity-thresholds, Property 7: The Threshold_Accessor never propagates an error`
    - **Property 7: The Threshold_Accessor never propagates an error**
    - **Validates: Requirements 1.6, 2.1, 2.3**

- [x] 3. Checkpoint - Ensure all tests pass
  - Run `eval "$(fnm env)" && fnm use 22 && npx vitest --run src/lib/calibration src/lib/similarityThresholds.test.ts`
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Gap fix: 500 ms read timeout in the accessor (Req 2.5)
  - [x] 4.1 Add a 500 ms timeout to the store read in `getEdgeThresholds()`
    - In `src/lib/similarityThresholds.ts`, race `getStoredCalibration()` against a 500 ms timeout (e.g. `Promise.race` with a rejecting/resolving timer)
    - On timeout, abandon the read, return `DEFAULT_EDGE_THRESHOLDS`, and log a distinct message indicating a Calibration_Store read timeout
    - Keep the existing try/catch fail-safe intact so the accessor still never throws
    - _Requirements: 2.5_
  - [x]* 4.2 Add unit test for the read timeout path
    - In `src/lib/similarityThresholds.test.ts`, mock `getStoredCalibration` to resolve after >500 ms (use fake timers) and assert `getEdgeThresholds()` returns defaults and logs the timeout message
    - _Requirements: 2.5_

- [x] 5. Gap fix: validate stored values in the accessor before use (Req 2.6)
  - [x] 5.1 Validate the stored calibration in `getEdgeThresholds()` before returning it
    - In `src/lib/similarityThresholds.ts`, before returning stored applied values, check both thresholds are present, finite numbers, within `[0,1]`, and correctly ordered (`stronglyRelated >= possiblyRelated`)
    - If missing/malformed/out-of-range, return `DEFAULT_EDGE_THRESHOLDS` and log a distinct "invalid Calibration_Store value" message
    - _Requirements: 2.6_
  - [x]* 5.2 Add unit tests for stored-value validation
    - In `src/lib/similarityThresholds.test.ts`, feed applied rows with missing, NaN/Infinity, out-of-range, and mis-ordered values and assert each yields defaults + the invalid-value log
    - Assert a valid applied row still returns stored values with `calibrated: true`
    - _Requirements: 2.6_

- [x] 6. Gap fix: 30 s recompute timeout on POST (Reqs 4.3, 4.5)
  - [x] 6.1 Enforce a 30 s bound on the compute path in the POST handler
    - In `app/api/debug/calibrate-thresholds/route.ts`, wrap load → calibrate → save so it aborts if it exceeds 30 seconds
    - On timeout, return an error response indicating a timeout and do NOT call `saveCalibration`, leaving the previously stored row unchanged
    - Keep the existing catch-all 500 for other computation errors
    - _Requirements: 4.3, 4.5_
  - [x]* 6.2 Add integration test for the recompute timeout
    - Mock `loadAllNodeEmbeddings` / `calibrateThresholds` to exceed 30 s (fake timers); assert the endpoint returns the timeout error response and `saveCalibration` is never invoked
    - _Requirements: 4.3, 4.5_

- [x] 7. Gap fix: explicit unrecognized-operation handling at the endpoint (Req 4.6)
  - [x] 7.1 Handle non-GET/POST verbs explicitly
    - In `app/api/debug/calibrate-thresholds/route.ts`, after the Debug_Access_Guard, ensure any recognized-but-unsupported verb (PUT/PATCH/DELETE, etc.) returns an explicit "invalid request" error response without invoking the Calibration_Engine
    - Follow the Next.js 16 route-handler conventions in `node_modules/next/dist/docs/` for exporting/handling additional methods
    - _Requirements: 4.6_
  - [x]* 7.2 Add integration test for unrecognized-verb rejection
    - Assert a non-GET/POST request returns the invalid-request response and that the engine/store are not invoked
    - _Requirements: 4.6_

- [x] 8. Gap fix: GET report read-failure handling (Reqs 1.6, 10.3)
  - [x] 8.1 Catch store read failures in the GET handler
    - In `app/api/debug/calibrate-thresholds/route.ts`, wrap `getStoredCalibration()` in the GET path so a read failure reports that the Compile_Time_Constants are in effect (defaults, `calibrated: false`) and logs the read failure, instead of surfacing an unhandled 500
    - _Requirements: 1.6, 10.3_
  - [x]* 8.2 Add integration test for GET read-failure reporting
    - Mock `getStoredCalibration` to throw; assert the GET response reports defaults in effect and the failure is logged
    - _Requirements: 1.6, 10.3_

- [x] 9. Checkpoint - Ensure all tests pass
  - Run `eval "$(fnm env)" && fnm use 22 && npx vitest --run`
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Add remaining integration and unit tests for shipped behavior
  - [x]* 10.1 Store singleton / replace-in-place tests
    - In a new `src/lib/db/calibration.test.ts`, assert `saveCalibration` upserts then `getStoredCalibration` yields exactly one row, and a second `saveCalibration` replaces in place (still one row)
    - _Requirements: 9.1, 9.2_
  - [x]* 10.2 DB range/order constraint rejection test
    - Assert inserting a row with `strongly_related < possibly_related` is rejected by `chk_similarity_calibration_range`
    - _Requirements: 9.6_
  - [x]* 10.3 Persist-failure leaves previous row unchanged test
    - Simulate a `saveCalibration` write error and assert the previously stored row is unchanged and the failure is surfaced to the caller
    - _Requirements: 9.8, 3.2, 4.4_
  - [x]* 10.4 Endpoint access-denial test
    - In a new `app/api/debug/calibrate-thresholds/route.test.ts`, mock `requireDebugAccess` to deny; assert both GET and POST return the denial response and the engine/store are never invoked
    - _Requirements: 4.1_
  - [x]* 10.5 Endpoint report-shape tests
    - Assert GET with no row returns `no-calibration` + defaults; GET with an applied row returns thresholds, status, reason, and computedAt
    - _Requirements: 4.2, 10.1, 10.2_
  - [x]* 10.6 Endpoint recompute persist test
    - Assert POST runs the compute path and calls `saveCalibration`, returning the applied/reverted status and diagnostics
    - _Requirements: 3.1, 4.4_
  - [x]* 10.7 Read-path-never-computes spy test
    - Spy on `computePairwiseScores` / `calibrateThresholds` and assert they are never called during `getEdgeThresholds()` / `selectCandidates()`
    - _Requirements: 3.3, 3.5, 3.6_
  - [x]* 10.8 Accessor mapping unit tests
    - Assert null store → defaults + `calibrated:false`; reverted row → defaults; applied row → stored values + `calibrated:true`; log emitted on read failure
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.2_

- [x] 11. Final verification
  - Run diagnostics on all changed files: `src/lib/calibration/threshold-calibration.test.ts`, `src/lib/similarityThresholds.ts`, `src/lib/similarityThresholds.test.ts`, `app/api/debug/calibrate-thresholds/route.ts`, and any new test files
  - Run the full test suite: `eval "$(fnm env)" && fnm use 22 && npx vitest --run`
  - Lint the changed files: `eval "$(fnm env)" && fnm use 22 && npm run lint`
  - Build: `eval "$(fnm env)" && fnm use 22 && npm run build`
  - Clean up any temporary files created during verification
  - _Requirements: 1.6, 2.1, 2.5, 2.6, 4.3, 4.5, 4.6, 9.8, 10.3_

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster path, but they carry the property-based and integration coverage the design calls for.
- Property tests use `fast-check` on the Vitest runner, a minimum of 100 runs each, and are tagged with the `// Feature: adaptive-similarity-thresholds, Property N: ...` comment format.
- Verification of the already-shipped code comes first (Task 1), then property tests (Task 2), then each gap fix paired with its test (Tasks 4–8), then a final full verification (Task 11).
- All npm/vitest commands must run under Node 22 (`eval "$(fnm env)" && fnm use 22`).
- Each task references specific granular requirements for traceability.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6", "2.7"] },
    { "id": 3, "tasks": ["4.1", "6.1", "7.1", "8.1"] },
    { "id": 4, "tasks": ["5.1"] },
    { "id": 5, "tasks": ["4.2", "5.2", "6.2", "7.2", "8.2"] },
    { "id": 6, "tasks": ["10.1", "10.2", "10.3", "10.4", "10.5", "10.6", "10.7", "10.8"] }
  ]
}
```
