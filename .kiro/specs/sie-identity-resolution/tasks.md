# Implementation Plan: SIE Identity Resolution

## Overview

This plan implements the identity-resolution subsystem defined by the finalized `sie-identity-resolution` requirements and the consolidated final `design.md`.

The subsystem determines whether a concern-cohesive `Semantic_Packet` advances an existing committed `Persistent_Concern`, contributes to a shared new-concern proposal, or must remain unresolved pending further evidence. It includes version-bound retrieval, semantic identity evaluation, retrieval-sufficiency assessment, adaptive widening, lifecycle handling, normalized proposition associations, durable pending decisions, idempotent orchestration, atomic persistence, privacy controls, and release evaluation.

Python is the authoritative semantic core. TypeScript loads versioned state, orchestrates requests, enforces contracts and invariants, and commits results, but it does not make or reinterpret semantic identity decisions.

The existing V2/SIE semantic-authority and shadow-mode state machine remains authoritative for runtime selection. Identity resolution is implemented behind those existing controls. Completing this specification does not switch production semantic authority from V2 to SIE; cutover requires separate explicit approval and satisfaction of the existing cutover gates.

The consolidated final `design.md` is the sole authoritative identity-resolution design. Earlier identity designs and correction appendices are superseded.

All tasks in this plan are mandatory. Correctness tests, property tests, contract tests, migration tests, and real PostgreSQL tests may not be skipped for an MVP.

## Implementation Rules

- No behavioral confidence value exists outside `HIGH`, `MEDIUM`, and `LOW`.
- A stage that did not complete uses `StageExecutionStatus.NOT_RUN` or `FAILED` with nullable confidence.
- Retrieval sufficiency and identity resolution are independent judgments.
- All IRS-to-channel mappings come from a versioned `RetrievalPolicy`; no mapping is hardcoded in `AdaptiveWidener`.
- All attempt, latency, cost, retry, model, prompt, and channel limits come from approved versioned configuration with no executable defaults.
- Python retrieves only from the immutable `GraphStateContext` supplied by TypeScript; it never queries live Supabase state during semantic reasoning.
- Preserve the existing V2/SIE authority and shadow controls. This implementation must not implicitly activate SIE as the production authority.
- `FULL_PIPELINE` reuses existing upstream stages and does not implement or redesign out-of-scope extraction, retention, packet-formation, or cohesion algorithms.
- Existing `sie_pending_semantic_decisions` remains the generic pending-decision table.
- All durable ownership, evidence, packet membership, and pending proposition membership use normalized records.
- The engine fails closed with `DEFER` or `REQUIRES_VALIDATION` when required policy, context, grounding, or operational dependencies are unavailable.

### Canonical semantic request identity

For deterministic entity creation, **semantic request identity** means a stable canonical semantic creation event derived from:

- conversation ID;
- processing stage and operation kind;
- ordered packet lineage and stable packet/proposition creation keys;
- canonical source-content hashes and provenance version;
- semantic contract/pipeline version; and
- deterministic operation ordinal when one source event creates multiple entities.

It never includes raw `request_id`, raw `idempotency_key`, lease owner, retry count, timestamp, or graph-version-specific transport metadata. Retries and version-conflict reanalysis of the same semantic creation event therefore resolve to the same entity creation key. A genuine extraction repair or changed source lineage may create a different semantic request identity.

The **payload fingerprint** is separate: it additionally includes graph version/snapshot digest and policy/model/prompt versions so stale or materially different analysis inputs cannot reuse an idempotency result.

## Tasks

- [x] 0. Audit the real repository and freeze implementation contracts
  - [x] 0.1 Inspect the current repository before making changes
    - Inspect repository instructions, working-tree state, current SIE models, migrations, generated contracts, RPCs, roles, and tests.
    - Record the actual migration sequence and allocate new migration numbers only after confirming which numbers are free.
    - Inspect the exact schemas of `sie_commit_requests`, `sie_pending_semantic_decisions`, `sie_entity_registry`, concerns, propositions, associations, packets, snapshots, and update state.
    - Inspect the live signatures and bodies of `v2_commit_update` and all existing context-loading or reservation RPCs.
    - Inspect the current `IdentityResolver` protocol, `ProcessRequest`, `ProcessResult`, OpenAPI generation path, TypeScript generated-type path, and commit manager.
    - Inspect existing embedding storage, generation, refresh, model-version, source-hash, and graph-version behavior.
    - Inspect runtime/service/database roles, grants, RLS behavior, and current privacy/deletion mechanisms.
    - Inspect SMT harness integration points and existing batch/incremental convergence tests.
    - Preserve unrelated user changes in the working tree.

  - [x] 0.2 Produce a repository-alignment record
    - Map every final-design table, field, enum, RPC, and contract to its actual repository counterpart.
    - Identify which assets are reused, extended, newly created, or intentionally deferred.
    - Record final migration numbers and dependency order.
    - Record any consequential unresolved decision instead of inventing a rule.
    - Confirm that the consolidated final `design.md` is the only design authority used for implementation.

  - [x] 0.3 Preflight gate
    - Do not begin schema or semantic implementation until the repository-alignment record contains no unexplained contract conflict.
    - If an unresolved decision would materially change semantics, persistence, privacy, or runtime architecture, stop and flag it.

- [x] 1. Implement canonical cross-language contracts and policy schemas
  - [x] 1.1 Add canonical Python enums and models
    - Add `ResolutionAction`, `IRSSignalType`, `RetrievalAttemptStatus`, and `StageExecutionStatus`.
    - Define exactly one canonical model for `IRSSignal`, `RetrievalAttemptRecord`, `CandidateRecord`, `SufficiencyRecord`, `WideningBudget`, and `IdentityResolutionRecord`.
    - Use `confidence`, not `confidence_band`.
    - Use canonical `CandidateRecord.contributing_attempt_ids`, not stale `contributing_channels`.
    - Require `query_mode`, `query_reference`, and `scope_description`; do not default them.
    - Enforce `candidate_count == len(candidate_ids)`.

  - [x] 1.2 Implement discriminated identity-result validation
    - `YES/ASSIGN_EXISTING` requires one committed matched concern, completed identity stage, and `HIGH` identity confidence.
    - `NO/PROPOSE_NEW` requires one proposed concern, completed sufficiency stage, and `HIGH` sufficiency confidence.
    - Pending outcomes contain neither matched nor proposed concern IDs.
    - `COMPLETED` stage status requires non-null `HIGH/MEDIUM/LOW` confidence.
    - `NOT_RUN` and `FAILED` require null confidence.
    - Never fabricate confidence for a stage that did not execute.

  - [x] 1.3 Implement required versioned policy/configuration schemas
    - Implement `RetrievalPolicy`, `WideningBudget`, `IdentityResolutionPolicy`, `ReEvaluationPolicy`, and `IdentityEvaluationConfig`.
    - Require every channel plan, IRS mapping, query mode, result limit, budget, retry, token limit, and model/prompt version from configuration.
    - Define the seven canonical channel families: `embedding_primary`, `identity_summary`, `alias_normalized`, `lexical_entity`, `dormant_scan`, `historical_region`, and `alternate_formulation`.
    - Validate configured channel IDs and query modes against the registry at startup.
    - Keep IRS-to-channel mappings exclusively in `RetrievalPolicy`. Example mappings may exist only in test fixtures or explicit configuration artifacts.
    - Missing or invalid approved policy causes fail-closed `DEFER`.

  - [x] 1.4 Extend versioned API models
    - Extend `GraphStateContext` with graph version, snapshot token/digest, version-matched embeddings, normalized aliases, eligible lifecycle states, pending identity details, and privacy eligibility.
    - Add `ProcessingMode`: `FULL_PIPELINE`, `IDENTITY_RESOLUTION_ONLY`, and `PENDING_RE_EVALUATION`.
    - Add first-class `identity_resolution_records` and identity mutation/dependency-group fields to `ProcessResult`.
    - Require complete proposition detail and all primary/secondary retention roles for identity-only processing.
    - Define canonical payload fingerprinting separately from semantic request identity.

  - [x] 1.5 Write mandatory model and contract property tests
    - Test every valid and invalid outcome/action/ID/stage-status/confidence combination.
    - Test serialization round trips and OpenAPI discriminators.
    - Test canonical payload fingerprint stability and sensitivity.
    - Test semantic creation keys remain stable across transport retries and graph-version reanalysis but change after genuine source-lineage repair.
    - Test missing policy and invalid channel configuration fail closed.

- [x] 2. Prepare database prerequisites in dependency order
  - [x] 2.1 Add or verify composite reference keys
    - Using migration numbers established by Task 0, add only missing unique composite keys for `(conversation_id, packet_id)`, `(conversation_id, proposition_id)`, `(conversation_id, concern_id)`, and `(conversation_id, decision_id)`.
    - Verify existing data before adding constraints; do not silently rewrite conflicting rows.
    - Add migration tests proving cross-conversation references can be rejected by later composite foreign keys.

  - [x] 2.2 Resolve versioned concern-embedding storage
    - Reuse compatible existing storage if Task 0 confirms it satisfies the final design.
    - If storage is absent or incompatible, create the smallest backward-compatible auxiliary schema required for concern ID, embedding vector, identity-summary source hash, embedding-model version, graph version, and lifecycle state.
    - Define invalidation/refresh behavior when identity summary or embedding model changes.
    - Do not hardcode an embedding model or similarity truth threshold.
    - Add real PostgreSQL constraint tests for version/hash consistency.

  - [x] 2.3 Dependency gate
    - Apply and verify prerequisite migrations before creating identity tables that reference them.
    - Do not place prerequisite composite keys/embedding tables and their dependent foreign-key tables in the same unordered migration wave.

- [x] 3. Create identity-resolution persistence tables
  - [x] 3.1 Create `sie_identity_resolution_records`
    - Store explicit matched and proposed concern IDs, stage statuses, nullable confidences, graph version, snapshot token, policy/model/prompt versions, reasoning, and immutable diagnostics.
    - Enforce mutually exclusive result branches with explicit `IS NOT NULL` checks so PostgreSQL null semantics cannot bypass invariants.
    - Add one record per `(request_id, packet_id)` and deterministic entity-registry integration.
    - Use composite conversation FKs for packet, matched concern, and proposed concern.

  - [x] 3.2 Create `sie_retrieval_attempts`
    - Link each attempt to its resolution record, conversation, and packet.
    - Store required channel ID/family, query mode/reference, scope, status, candidate count/diagnostic IDs, latency, failure reason, policy version, widening flag, and IRS trigger.
    - Treat candidate arrays as immutable diagnostics only; do not claim array-level FK integrity.

  - [x] 3.3 Create normalized pending identity tables
    - Reuse `sie_pending_semantic_decisions` as the generic decision record.
    - Create `sie_pending_identity_details` as one-to-one identity detail containing packet, graph version, source resolution record, stage statuses, and confidences.
    - Create `sie_pending_identity_propositions` as ordered normalized many-to-many decision/proposition membership.
    - Preserve exactly the implemented generic lifecycle states: `pending`, `unresolved`, `deferred`, `resolved`.
    - Do not introduce `sie_pending_decisions` or an `expired` lifecycle state.

  - [x] 3.4 Write mandatory real PostgreSQL table tests
    - Test valid and invalid result branches, including null confidence edge cases.
    - Test composite conversation FK rejection.
    - Test diagnostic cardinality constraints.
    - Test normalized pending membership and deterministic uniqueness.
    - Test creation order and rollback in a disposable database.

- [x] 4. Implement request reservation, result caching, and snapshot loading
  - [x] 4.1 Extend `sie_commit_requests` state machine
    - Implement `RESERVED → ANALYZED → COMMITTED`, plus `FAILED_RETRYABLE` and `SUPERSEDED`.
    - Add lease owner, lease expiry, successor request/key, analyzed result, snapshot digest, and transition metadata as required by the audited schema.
    - Preserve existing committed-request compatibility.

  - [x] 4.2 Implement atomic request-state RPCs
    - Implement atomic reservation returning `NEW_LEASE`, `ANALYZED_RESULT`, `COMMITTED_RESULT`, `IN_PROGRESS`, `FINGERPRINT_CONFLICT`, or `RETRYABLE_LEASE`.
    - Implement lease renewal, analyzed-result recording, retryable failure, supersession, and successor linkage.
    - Only the active lease owner may record analysis or transition the request.
    - Persist the validated Python semantic result before graph commit so response-loss recovery does not rerun nondeterministic analysis.
    - Ensure crashed requests can recover after lease expiry and cannot remain permanently in progress.

  - [x] 4.3 Implement one atomic identity-context loader RPC
    - Load all required graph state through one PostgreSQL MVCC snapshot/statement.
    - Return graph version, snapshot token/digest, concerns, aliases, propositions, associations, packet lineage, pending decisions/memberships, and valid embeddings.
    - Exclude privacy-suppressed concerns and their sensitive content before constructing the returned context; Python must never receive them.
    - Mark missing/stale embeddings as unavailable, not successful empty retrieval.
    - Fail rather than return partial or cross-version context.

  - [x] 4.4 Write mandatory real PostgreSQL concurrency tests
    - Test lease acquisition, renewal, expiry, takeover, concurrent waiters, analyzed-result replay, fingerprint conflict, failure recovery, and supersession.
    - Inject concurrent commits while loading context and prove every returned field belongs to one graph snapshot.
    - Test suppressed concerns never appear in the context payload.

- [x] 5. Extend atomic commit, security, privacy, and rollback
  - [x] 5.1 Extend `v2_commit_update` with identity bundle sections
    - Add optional arrays for resolution records, retrieval attempts, pending identity details, pending proposition memberships, association mutations, shared proposals, and request-state transitions.
    - Preserve backward compatibility for existing callers that omit identity keys.
    - Identify SIE identity-resolution callers participating in the new reservation protocol through the existing authority/engine contract and identity-specific bundle/request fields.
    - Keep legitimate legacy V2 callers on their existing backward-compatible commit path until a separately approved migration or authority cutover changes that contract.

  - [x] 5.2 Enforce invariants inside `v2_commit_update`
    - For SIE identity-resolution callers participating in the reservation protocol, the RPC itself must validate the active lease and lease owner.
    - For those SIE identity-resolution callers, validate idempotency key and payload fingerprint before mutation.
    - Validate `graph_version_analyzed` and snapshot binding.
    - Validate deterministic entity-registry mappings.
    - Validate composite conversation ownership for every referenced entity.
    - Validate dependency-group membership, completeness, ordering, and failure policy.
    - Validate result cross-field invariants and association uniqueness.
    - Reject the whole transaction on any violation; do not rely only on TypeScript validation.
    - Do not impose the new lease/fingerprint contract retroactively on legitimate legacy V2 callers during the compatibility period; retain their established validations and behavior.

  - [x] 5.3 Add indexes, RLS, privileges, and append-only enforcement
    - Add indexes based on audited query patterns.
    - Enable RLS and conversation-owner read policies.
    - Revoke direct runtime-role mutation privileges; service-role RLS bypass is not append-only enforcement.
    - Permit normal writes only through narrowly scoped `SECURITY DEFINER` RPCs.
    - Prevent ordinary update/delete of append-only resolution and retrieval records.

  - [x] 5.4 Implement controlled privacy purge/redaction
    - Add a separately authorized purge/redaction RPC consistent with system privacy requirements.
    - Remove or redact reasoning, evidence snapshots, candidates, LLM diagnostics, retrieval records, associations, and pending memberships containing deleted/suppressed content.
    - Record only the minimal permitted non-content-bearing privacy event.
    - Ensure future context snapshots continue excluding suppressed concerns.
    - Treat privacy deletion as an authorized exception to ordinary audit immutability.

  - [x] 5.5 Create rollback migration(s)
    - Reverse new RPCs, grants, policies, triggers, tables, and prerequisite extensions in dependency-safe order.
    - Preserve pre-existing data-model infrastructure.
    - Run rollback and re-apply tests in a disposable database.

  - [x] 5.6 Write mandatory real PostgreSQL commit/security/privacy tests
    - Test each RPC-side validation independently and in combination.
    - Inject failures at every new bundle phase and prove no partial graph, cursor, snapshot, request-state, or diagnostic state persists.
    - Test runtime roles cannot mutate append-only records directly.
    - Test privacy purge/redaction and subsequent snapshot exclusion.
    - Test old V2/SIE callers remain compatible.

- [x] 6. Database checkpoint
  - Apply prerequisite and dependent migrations in the audited order against real local PostgreSQL/Supabase.
  - Require every Task 2–5 database test to pass with zero skips.
  - Record exact migration/RPC versions and rollback results.

- [ ] 7. Implement retrieval coordinator and channel architecture in Python
  - [x] 7.1 Implement channel protocol and validated registry
    - Each channel searches only the supplied immutable context.
    - Registry validation rejects unknown channel IDs and unsupported query modes.
    - No channel may assign ownership or interpret its score as confidence.

  - [x] 7.2 Implement the seven channel families
    - Implement embedding, identity-summary, alias, lexical/entity, dormant, historical-region, and alternate-formulation channels.
    - Parameterize broad/narrow/continuation behavior through configured query modes.
    - Record every attempt using the canonical model.
    - Alternate-formulation LLM failure is recorded as a channel failure; it does not automatically abort if remaining retrieval is adequate.

  - [~] 7.3 Implement `RetrievalCoordinator`
    - Execute only the versioned policy's initial or widening invocation plan.
    - Aggregate and deduplicate candidates while preserving contributing attempt IDs.
    - Record timeouts/errors/unavailability distinctly from successful empty results.
    - Preserve channel-local scores as diagnostics only.

  - [~] 7.4 Write mandatory retrieval unit and property tests
    - Test every channel and query mode using approved fixtures.
    - Test registry rejection and missing-policy fail-closed behavior.
    - Test candidate deduplication and contributing-attempt preservation.
    - Prove failed/skipped/unavailable attempts never satisfy successful coverage.
    - Prove retrieval scores alone cannot produce ownership.

- [ ] 8. Implement the semantic identity evaluator
  - [~] 8.1 Implement provider-neutral structured LLM adapter
    - Implement versioned prompt/schema registry and configurable primary/fallback adapters without hardcoded production model choice.
    - Record model, prompt/schema versions, tokens, latency, attempts, structured-output status, and grounding status.
    - Provide deterministic fake adapters for tests.

  - [~] 8.2 Implement identity evaluation
    - Evaluate exact continuity, historical trajectory, return-path continuity, and semantic scope compatibility in order.
    - Treat retrieval similarity only as candidate-generation diagnostic context.
    - Produce typed candidate assessments, competing candidates, substantive-resumption judgment, and evidence references.

  - [~] 8.3 Implement deterministic grounding validation and fallback
    - Reject fabricated IDs, missing evidence spans, unsupported assistant-to-user attribution, unlisted competitors, and malformed output.
    - Apply bounded retry/fallback from approved configuration.
    - Exhaustion returns `DEFER` or `REQUIRES_VALIDATION`, never inferred `LOW` or novelty.

  - [~] 8.4 Implement behavioral confidence evaluator
    - `HIGH` requires actionable identity evidence and no material competitor.
    - `MEDIUM` is plausible but non-actionable.
    - `LOW` is insufficient and does not prove novelty.
    - Keep identity, IRS, sufficiency, retention, and association confidence separate.

  - [~] 8.5 Write mandatory evaluator property and adversarial tests
    - Unique actionable `HIGH` may assign; multiple `HIGH` or material competitors may not.
    - Exact continuity outranks greater lexical/embedding similarity.
    - Temporal distance alone cannot weaken a valid identity.
    - Assistant-authored content alone cannot establish a user concern.
    - Grounding/model failure never becomes semantic absence.
    - Add multilingual and domain-diverse cases without keyword-only truth rules.

- [ ] 9. Implement IRS assessment and retrieval-sufficiency gate
  - [x] 9.1 Implement grounded IRS assessment
    - Use deterministic structured provenance/history checks where sufficient.
    - Use the semantic evaluator for multilingual or implicit cues when needed.
    - Store typed signal, confidence, grounded evidence, resolution state, and resolving attempt IDs.
    - Do not use domain-specific keyword lists as truth rules.

  - [x] 9.2 Implement `SufficiencyGate`
    - Produce only `ADEQUATE` or `INCONCLUSIVE` retrieval-sufficiency outcomes.
    - Adequacy requires configured coverage, addressed material IRS signals, no material failed coverage, and required lifecycle/historical scope.
    - Do not include identity ambiguity or candidate plausibility in retrieval adequacy.
    - A successful empty attempt may contribute; errors/timeouts/unavailability/skips may not.

  - [x] 9.3 Implement downstream separation explicitly
    - Adequate retrieval plus one uniquely actionable `HIGH` match → `YES/ASSIGN_EXISTING`.
    - Adequate retrieval plus plausible candidates but no unique owner → `UNRESOLVED/RETAIN_PENDING`.
    - Adequate retrieval plus no plausible candidate → novelty eligibility.
    - Inconclusive retrieval → widening or pending; never novelty.

  - [~] 9.4 Write mandatory sufficiency property tests
    - Prove identity ambiguity can coexist with `ADEQUATE` retrieval.
    - Prove ambiguity does not itself trigger widening.
    - Prove unresolved `HIGH/MEDIUM` IRS signals block adequacy.
    - Prove `NO/PROPOSE_NEW` is impossible without completed `HIGH` adequacy.

- [ ] 10. Implement adaptive widening
  - [x] 10.1 Implement policy-driven `AdaptiveWidener`
    - Read all IRS-to-channel invocations from `RetrievalPolicy` at runtime.
    - Do not embed example or fallback mappings in code.
    - Select only configured additional invocations for unresolved coverage gaps.
    - Send every new candidate back to the standard evaluator.

  - [x] 10.2 Enforce required widening budgets
    - Enforce configured attempts, rounds, latency, and cost without defaults.
    - Budget exhaustion before adequacy returns `RETRIEVAL_INCONCLUSIVE` or `DEFER`.
    - A nonmaterial channel failure does not invalidate otherwise adequate retrieval.

  - [~] 10.3 Write mandatory widening property tests
    - Load example IRS mappings exclusively from test policy fixtures.
    - Prove changing policy changes widening behavior without code changes.
    - Prove missing mappings fail closed rather than using hidden defaults.
    - Prove budget exhaustion never produces novelty.

- [ ] 11. Implement novelty and concern lifecycle handling
  - [x] 11.1 Implement fail-closed novelty eligibility
    - After completed `HIGH` retrieval adequacy, no plausible existing candidate, and `INDEPENDENT_CONCERN_CANDIDATE` eligibility among complete primary/secondary retention roles are established, emit `NO/PROPOSE_NEW`.
    - The novelty checker does not require a pre-existing `NO` outcome; `NO` is the outcome it emits after all novelty preconditions pass.
    - Missing retention detail denies novelty and retains the packet pending.
    - Generate concern proposal IDs from canonical semantic request identity, never raw request or idempotency IDs.
    - Leave canonical parent null and parent state deferred; do not infer hierarchy.

  - [~] 11.2 Implement lifecycle handler
    - Include active, dormant, and eligible retired concerns in identity evaluation without recency bias.
    - Reactivate dormant/retired concerns only for substantive resumption, in an `ALL_OR_NONE` group.
    - Preserve historical mention without reactivation.
    - Follow ordered merge redirects and reject missing, cyclic, cross-conversation, suppressed, or invalid targets.

  - [~] 11.3 Write mandatory novelty/lifecycle property tests
    - Test every novelty precondition and missing-data fail-closed path.
    - Test deterministic proposal identity across retries/reanalysis.
    - Test dormant/retired substantive resumption versus historical mention.
    - Test merge redirects and privacy-suppressed targets.

- [ ] 12. Implement normalized multi-role proposition associations
  - [~] 12.1 Implement complete proposition-detail validation
    - Require every packet membership to have speaker role, complete retention roles, provenance, and stable IDs.
    - Missing detail blocks the entire packet dependency group with `DEFER` or `REQUIRES_VALIDATION`; never silently skip.

  - [~] 12.2 Implement multi-role association assembly
    - Create every applicable normalized association role instead of selecting one winning role.
    - User propositions may receive `PRIMARY_OWNER`, `SUPPORTING_EVIDENCE`, and `EMERGENCE_EVIDENCE` according to their retained roles.
    - Preserve valid existing secondary associations.
    - `CONTEXT_ONLY` and `DISCARD` create no durable concern association.
    - Assistant-authored propositions never become user-grounded ownership or evidence, even after confirmation; the confirming USER proposition carries the applicable evidence.
    - Keep association confidence stage- and role-specific.
    - Generate association IDs from canonical semantic request identity and normalized association tuple.

  - [~] 12.3 Write mandatory association property tests
    - Prove every retained role survives downstream assembly.
    - Prove one proposition can hold multiple valid association roles.
    - Prove assistant propositions never receive user-grounded durable roles.
    - Prove missing detail prevents all packet mutations.
    - Prove input provenance and prior valid associations remain unchanged.

- [ ] 13. Implement durable pending identity decisions
  - [~] 13.1 Implement creation and persistence
    - Create pending records for `UNRESOLVED`, `DEFER`, `RETRIEVAL_INCONCLUSIVE`, and `REQUIRES_VALIDATION` as appropriate.
    - Generate pending decision creation keys from canonical semantic request identity, never raw request/idempotency IDs.
    - Write generic decision, identity detail, and normalized proposition memberships atomically.
    - Ensure duplicate delivery cannot create duplicate decisions.

  - [~] 13.2 Implement re-evaluation and resolution
    - Trigger only from configured new evidence, alias change, graph repair/merge, retrieval improvement, policy change, or manual validation.
    - Enforce configured attempt/cooldown policy with no hardcoded limit.
    - Preserve original decision/history, set resolution time, and link successor associations/proposals/repairs.

  - [~] 13.3 Write mandatory pending-decision property and database tests
    - Test persistence across restarts and cursor advancement.
    - Test normalized membership referential integrity.
    - Test retry deduplication and bounded re-evaluation.
    - Test every resolution pathway while preserving original history.

- [ ] 14. Implement deterministic multi-packet ordering and shared proposals
  - [~] 14.1 Implement provisional overlay
    - Order packets by `(message_seq_start, message_seq_end, packet_id)`.
    - Make earlier proposals, associations, reactivations, and pending records visible to later packets in memory.
    - Do not mutate committed context during analysis.

  - [~] 14.2 Implement shared proposal coalescing
    - Later packets matching the same uncommitted proposal return `NO/PROPOSE_NEW` referencing the same deterministic proposal, never `YES`.
    - Emit one concern-creation mutation and all dependent associations in one `ALL_OR_NONE` group.
    - Keep unrelated packet groups semantically separate while the request transaction remains atomic.

  - [~] 14.3 Write mandatory ordering/convergence properties
    - Test deterministic ordering under randomized input order.
    - Prove shared proposals never duplicate concern mutations.
    - Prove non-cohesive packets cannot produce assignment or novelty.
    - Compare one-request multi-packet results with sequential incremental processing for current-state equivalence.

- [ ] 15. Compose and expose the Python identity pipeline
  - [~] 15.1 Implement `IdentityResolutionPipeline`
    - Compose retrieval, evaluation, sufficiency, widening, novelty, lifecycle, pending, association, and provisional-overlay stages.
    - Emit one complete `IdentityResolutionRecord` per packet and complete dependency groups/mutations.
    - Preserve retrieval adequacy/identity ambiguity separation throughout control flow.

  - [~] 15.2 Wire processing modes into `/sie/process-messages`
    - `FULL_PIPELINE` reuses existing upstream SIE/data-model stages and begins identity work only after cohesive packets are available.
    - Do not implement or redesign extraction, retention, packet formation, or cohesion algorithms in this task.
    - `IDENTITY_RESOLUTION_ONLY` requires preformed cohesive packets and complete proposition/context detail.
    - `PENDING_RE_EVALUATION` requires a trigger and optional targeted decision IDs.

  - [~] 15.3 Implement fail-closed route behavior
    - Missing policy, invalid contract, incomplete context, non-cohesive packet, model exhaustion, or stale snapshot produces the specified non-forced outcome/error.
    - Never fabricate successful semantic output.

  - [~] 15.4 Write mandatory composed-pipeline and route tests
    - Cover every processing mode, all terminal outcomes, direct match, ambiguity, adequate novelty, widening, failure, lifecycle, shared proposal, and pending re-evaluation.
    - Test upstream-stage reuse without introducing duplicate extraction or retention logic.

- [ ] 16. Implement TypeScript orchestration and generated contracts
  - [~] 16.1 Regenerate and adopt OpenAPI TypeScript types
    - Generate types from the Python contract after model changes.
    - Remove or update handwritten duplicate identity unions.
    - Add backward-compatibility contract tests and full TypeScript compilation.

  - [~] 16.2 Implement atomic context loading
    - Call the context-loader RPC and map its coherent response to `GraphStateContext`.
    - Validate graph version, snapshot token/digest, embedding hashes/versions, and suppression filtering.
    - Fail on partial or invalid context.

  - [~] 16.3 Implement reservation, lease, and cached-result orchestration
    - Handle every reservation outcome.
    - Serialize concurrent duplicates with bounded wait/retry behavior.
    - Record validated analyzed result before commit.
    - Recover expired leases and retryable failures without duplicating committed work.

  - [~] 16.4 Implement version-conflict supersession
    - Reject stale analysis, mark it superseded, link successor, reload context, and re-invoke Python with a version-scoped payload fingerprint.
    - Preserve semantic creation keys for the same semantic creation event.

  - [~] 16.5 Extend commit manager
    - Validate generated contract and dependency-group completeness before RPC invocation.
    - Pass all identity bundle sections to `v2_commit_update`.
    - Never choose a concern, reinterpret scores, change confidence, or override Python's decision.
    - Treat database validation as authoritative even after TypeScript pre-validation.
    - Route SIE identity work through the existing semantic-authority/shadow controls; do not bypass or mutate the authority state as a side effect of completing this spec.

  - [~] 16.6 Write mandatory TypeScript orchestration tests
    - Test generated contracts, context coherence, reservations, waiters, analyzed replay, fingerprint mismatch, lease recovery, supersession, re-analysis, and commit bundles.
    - Prove TypeScript cannot semantically override Python results.
    - Prove shadow-mode SIE execution does not replace V2 production authority or commit authoritative SIE graph mutations unless the existing authority state permits it.
    - Prove legitimate legacy V2 commit callers remain backward-compatible without the new SIE reservation fields.
    - Run full TypeScript typecheck and existing V2 regression suites.

- [ ] 17. Implement observability, failure handling, and privacy-safe diagnostics
  - [~] 17.1 Emit structured metrics
    - Measure latency, channels, widening, model routing, retries, failures, pending rate, reactivation, proposals, version conflicts, cache hits, and privacy purges.
    - Version all diagnostic schemas.

  - [~] 17.2 Enforce privacy-safe logging
    - Avoid raw sensitive packet/concern text in general logs.
    - Store authorized evidence/query detail only under approved access and retention controls.
    - Ensure purge/redaction reaches diagnostic and model-invocation material.

  - [~] 17.3 Write mandatory failure/observability tests
    - Test retrieval/model/contract/policy/context failures produce explicit diagnostics and safe outcomes.
    - Test operational failure never becomes `NO_MATCH`, `LOW` confidence, or novelty by implication.
    - Test diagnostics are purged/redacted with their protected source data.

- [ ] 18. Run mandatory end-to-end and real PostgreSQL integration tests
  - [~] 18.1 Test complete semantic flows
    - Existing assignment, adequate ambiguity, adequate novelty, inconclusive widening, dormant/retired reactivation, merge redirect, pending resolution, multi-role associations, and shared proposals.

  - [~] 18.2 Test atomic persistence and concurrency
    - Inject failure at every identity bundle phase and prove complete rollback.
    - Test stale-version rejection, concurrent duplicate serialization, lease recovery, cached result replay, and cross-conversation rejection.
    - Test database-side validation catches invalid input even when TypeScript validation is bypassed in the test.

  - [~] 18.3 Test privacy and rollback
    - Verify suppressed concerns never reach Python context.
    - Verify controlled purge/redaction across semantic, pending, retrieval, LLM, association, snapshot, and audit data.
    - Execute rollback and re-apply migrations in a disposable database.

  - [~] 18.4 Test structural completeness
    - Require canonical `CandidateRecord.contributing_attempt_ids` and every other final-model field.
    - Require complete retrieval attempts, stage statuses, evidence references, policy/model versions, deterministic IDs, and dependency groups.

- [ ] 19. Integrate SMT evaluation, convergence, and release gates
  - [~] 19.1 Integrate identity resolution with the SMT harness
    - Add labeled representative, adversarial, multilingual, long/short, and domain-diverse cases, including domains absent from development examples.
    - Cover same vocabulary/different identity, vocabulary drift/same identity, dormant return, retired reopening, merge redirect, parent/child ambiguity, duplicates, multiple competitors, assistant attribution, extraction repair, failure, and pending reactivation.

  - [~] 19.2 Measure semantic quality and calibration
    - Measure false assignment, false novelty, missed reactivation, unresolved/defer calibration, retrieval-sufficiency error, and retry/version determinism.
    - Record model, prompt, policy, and inference configuration for every run.
    - Do not approve production behavior until numeric quality thresholds are explicitly approved.

  - [~] 19.3 Test batch/incremental Current-State Equivalence
    - Process the same conversations incrementally and in full batch.
    - Compare active concerns, proposition ownership/evidence roles, relationships relevant to identity, hierarchy references, and pending resolution outcomes after repairs.
    - Do not require identical packet boundaries or historical traces.

  - [~] 19.4 Run compatibility and reliability gates
    - Run all existing data-model and V2 regression suites.
    - Verify V2 snapshot and React Flow consumption remain compatible.
    - Verify the existing V2/SIE authority and shadow-state transitions remain unchanged and no test or migration performs an implicit production cutover.
    - Run configured latency, throughput, availability, and cost tests once budgets are approved.

- [~] 20. Final implementation checkpoint
  - Report engineering implementation completion and production-cutover readiness as two separate statuses.
  - Require zero failed or skipped mandatory tests.
  - Require real PostgreSQL evidence for migrations, concurrency, atomicity, RLS/grants, privacy, and rollback.
  - Require full Python and TypeScript tests/typecheck to pass; unrelated pre-existing failures must be separately evidenced and must not mask SIE failures.
  - Require SMT and convergence reports with model/prompt/policy versions.
  - Engineering implementation may be declared complete when the specified code, migrations, contracts, mandatory tests, and non-production evaluation plumbing are complete and verified, even if production model/policy selections remain unresolved.
  - Production-cutover readiness additionally requires explicit model selection, approved numeric semantic-quality thresholds, approved privacy/retention policy, approved operational budgets, completion of existing authority cutover gates, and separate explicit cutover approval.
  - Do not switch production semantic authority from V2 to SIE merely because engineering implementation is complete.

## Dependency Order

The implementation must respect this dependency sequence:

```text
Task 0 repository audit
  → Task 1 canonical contracts
  → Task 2 database prerequisites
  → Task 3 identity tables
  → Task 4 reservation + snapshot RPCs
  → Task 5 commit/security/privacy/rollback
  → Task 6 database checkpoint
  → Tasks 7–10 retrieval/evaluation/sufficiency/widening
  → Tasks 11–14 novelty/lifecycle/associations/pending/ordering
  → Task 15 composed Python pipeline
  → Task 16 TypeScript orchestration
  → Task 17 observability/privacy diagnostics
  → Task 18 end-to-end PostgreSQL integration
  → Task 19 SMT/convergence/release evaluation
  → Task 20 final checkpoint
```

Parallel work is permitted only within a task after its stated prerequisites are committed and validated. Dependent tables and foreign keys may not be created in parallel with the prerequisite keys/tables they reference.


## Notes

- All tasks are mandatory — correctness tests, property tests, migration tests, and real PostgreSQL tests may not be skipped.
- `design-corrections.md` is authoritative where it conflicts with `design.md`.
- All policy/budget values are required versioned configuration — no invented defaults in code.
- The engine fails closed (returns DEFER) whenever approved policy is unavailable.
- Python retrieves ONLY from TypeScript-supplied `GraphStateContext` — Python does NOT query Supabase independently.
- Existing `sie_pending_semantic_decisions` table is used (NOT a new `sie_pending_decisions` table).
- ONE `sie_identity_resolution_records` table (no duplicate audit table).
- Field name is `confidence` (not `confidence_band`).
- `identity_confidence` and `sufficiency_confidence` are nullable with NOT_EVALUATED when stage didn't run.
- One API route: `POST /sie/process-messages` with `processing_mode` discriminator.
- YES outcome means existing committed concern match only — uncommitted proposals use NO/PROPOSE_NEW.
- Migrations numbered from current repository sequence (009+).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "3.1"] },
    { "id": 1, "tasks": ["1.3", "3.2", "3.3"] },
    { "id": 2, "tasks": ["1.4", "3.4"] },
    { "id": 3, "tasks": ["1.5", "3.5", "3.6"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "6.1"] },
    { "id": 6, "tasks": ["4.3", "5.1", "6.2"] },
    { "id": 7, "tasks": ["4.4", "4.5", "5.2", "5.3"] },
    { "id": 8, "tasks": ["5.4", "5.5", "5.6", "6.3", "7.1"] },
    { "id": 9, "tasks": ["7.2", "9.1", "9.2"] },
    { "id": 10, "tasks": ["9.3", "10.1"] },
    { "id": 11, "tasks": ["10.2", "11.1"] },
    { "id": 12, "tasks": ["11.2", "11.3", "12.1"] },
    { "id": 13, "tasks": ["12.2", "14.1"] },
    { "id": 14, "tasks": ["14.2", "14.3"] },
    { "id": 15, "tasks": ["14.4", "15.1"] },
    { "id": 16, "tasks": ["15.2", "15.3"] },
    { "id": 17, "tasks": ["15.4"] },
    { "id": 18, "tasks": ["15.5", "15.6", "17.1"] },
    { "id": 19, "tasks": ["17.2", "18.1"] },
    { "id": 20, "tasks": ["18.2"] }
  ]
}
```
