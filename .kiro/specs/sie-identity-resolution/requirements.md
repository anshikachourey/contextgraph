# Requirements Document

## Introduction

This specification defines the identity-resolution subsystem of the Semantic Intelligence Engine (SIE). It governs how concern-cohesive `Semantic_Packet` records are evaluated against existing `Persistent_Concern` records, how retrieval adequacy is established before novelty is declared, how retrieval is widened when initial results may be incomplete, and how unresolved packets and concern lifecycle states are handled over time.

The governing semantic principles are:

- Persistent concern identity outranks lexical similarity (SME-1).
- Retrieval proposes candidates but never determines ownership (SME-2).
- Retrieval absence is not semantic absence (SME-3).
- Exact concern continuity outranks broad topic compatibility (SME-5).
- Temporal distance does not break identity continuity (SME-8).
- State change does not by itself create a new identity (SME-9).
- Identity uncertainty reduces ownership commitment; the engine may defer rather than force a decision.

The Python `ml-service` is authoritative for semantic identity decisions. The TypeScript orchestration layer may retrieve versioned graph state, invoke Python, validate contracts and graph invariants, and commit returned mutation proposals, but it shall not make, reinterpret, or override the primary semantic identity decision.

This specification depends on the `sie-data-model` requirements. Identity resolution receives only validated, concern-cohesive packets and must preserve all proposition provenance, retention roles, packet membership, and association history defined by that specification.

## Glossary

- **Identity_Resolution**: Determining whether a concern-cohesive packet most directly advances, revisits, decides, corrects, or reopens an existing `Persistent_Concern`, or whether no existing concern has the same identity.
- **Identity_Continuity**: Evidence that new material belongs to the same independently returnable concern despite changes in vocabulary, time, state, or conversational context.
- **Identity_Candidate**: A concern returned by one or more retrieval channels for semantic evaluation. Candidate inclusion, rank, or similarity does not establish ownership.
- **Identity_Resolution_Record**: The version-bound, auditable result produced by Python, containing the outcome, action, candidates, evidence, retrieval history, confidence bands, and reasoning.
- **Retrieval_Sufficiency_Gate**: The stage that decides whether candidate retrieval was adequate enough to support a `NO_MATCH` conclusion.
- **Adaptive_Widening**: A bounded, signal-directed expansion of retrieval when initial retrieval is inconclusive.
- **Retrieval_Channel**: A materially distinct retrieval method or source, such as embedding retrieval, identity-summary search, alias lookup, lexical/entity search, dormant-concern scan, historical-region search, or alternate semantic query formulation.
- **Retrieval_Attempt_Status**: One of `SUCCESS_WITH_CANDIDATES`, `SUCCESS_EMPTY`, `ERROR`, `TIMEOUT`, `UNAVAILABLE`, or `SKIPPED_WITH_REASON`.
- **IRS_Signal**: A grounded indicator that retrieval may be incomplete: `IRS-1 REVISIT_LANGUAGE`, `IRS-2 HISTORICAL_REFERENT`, `IRS-3 IMPLIED_PRIOR_STATE`, `IRS-4 BROAD_CANDIDATE_MISMATCH`, `IRS-5 ALIAS_OR_VOCABULARY_DRIFT`, or `IRS-6 CONTINUATION_HISTORY_MISMATCH`.
- **Behavioral_Confidence_Band**: A stage-specific `HIGH`, `MEDIUM`, or `LOW` judgment that directly controls behavior. Bands from different stages are not numerically interchangeable.
- **Pipeline_Outcome**: One of `YES`, `NO`, `UNRESOLVED`, `DEFER`, `RETRIEVAL_INCONCLUSIVE`, or `REQUIRES_VALIDATION`.
- **Resolution_Action**: One of `ASSIGN_EXISTING`, `PROPOSE_NEW`, `RETAIN_PENDING`, or `NONE`.
- **Pending_Identity_Decision**: A durable, reloadable record for a packet whose ownership cannot yet be safely resolved.
- **Dormant_Concern**: A concern with `DORMANT` status whose identity is preserved and remains eligible for matching and reactivation.
- **Merged_Concern**: A concern with `MERGED` status that redirects to its surviving canonical concern.
- **Retired_Concern**: A concern with `RETIRED` status because the user concluded or abandoned it. Its history and identity remain preserved.
- **Adequate_Retrieval**: Successful coverage of the retrieval-channel families required by the versioned retrieval policy and the detected IRS signals, with no unresolved channel failure that could plausibly conceal the matching concern.
- **Plausible_Candidate**: A candidate for which grounded identity evidence remains credible enough that novelty cannot yet be safely declared, even if the evidence is not sufficient for assignment.
- **Graph_Version_Analyzed**: The exact committed graph version against which Python performed semantic reasoning.

## Requirements

### Requirement 1: Authority and Input Preconditions

**User Story:** As ContextGraph, I want identity resolution to operate on validated semantic inputs through one authoritative semantic engine, so that ownership decisions are consistent and are not duplicated across Python and TypeScript.

#### Acceptance Criteria

1. THE Identity_Resolution subsystem SHALL execute in the Python `ml-service`, which SHALL be authoritative for primary semantic identity decisions.
2. THE TypeScript orchestration layer SHALL retrieve graph context, invoke the Python service, validate response schemas, validate graph versions and invariants, and commit approved mutation proposals.
3. THE TypeScript layer SHALL NOT independently choose a concern, reinterpret candidate rankings as ownership, or override Python's semantic identity outcome.
4. THE subsystem SHALL accept only `Semantic_Packet` records that have passed concern-cohesion validation.
5. Provisional concern-boundary analysis used during packet formation SHALL NOT assign final `Persistent_Concern` ownership.
6. THE subsystem SHALL preserve every applicable primary and secondary retention role. Routing to identity resolution SHALL NOT discard roles such as `SUPPORTING_EVIDENCE` or `EMERGENCE_EVIDENCE` merely because another role is primary.
7. THE subsystem SHALL preserve stable proposition IDs, packet IDs, membership records, split lineage, message provenance, speaker roles, and continuation origin supplied by the data-model layer.
8. Assistant-authored material MAY inform interpretation and retrieval queries but SHALL NOT independently establish a durable user concern or user belief without user-grounded evidence.

### Requirement 2: Primary Identity Resolution

**User Story:** As ContextGraph, I want each concern-cohesive packet evaluated against existing concerns using identity continuity, so that the same user concern retains its identity despite vocabulary drift, temporal distance, or state evolution.

#### Acceptance Criteria

1. WHEN a packet carries a retention role requiring durable association, THE Identity_Resolver SHALL determine whether one existing `Persistent_Concern` most directly owns the packet.
2. THE Identity_Resolver SHALL evaluate sameness of independently returnable concern, not mere similarity of words, entities, projects, mechanisms, goals, or temporal context.
3. THE Identity_Resolver SHALL apply the following priority order: exact concern continuity, historical trajectory, return-path continuity, semantic scope compatibility, and retrieval similarity.
4. `Return-path continuity` SHALL mean that the candidate concern is the coherent semantic location to which the user would return to continue the same unresolved concern; it SHALL NOT be treated as a prediction of future user behavior.
5. Exact concern continuity SHALL outrank broad topical compatibility. A narrower exact concern SHALL NOT be replaced by a broader related concern merely because the broader concern has greater retrieval similarity.
6. Temporal distance and recency SHALL NOT independently weaken or defeat an otherwise valid identity match.
7. A user decision, opinion, plan, preference, or factual state changing over time SHALL normally preserve concern identity. Subsequent stages SHALL determine whether the change is `EXTEND`, `SUPERSEDE`, `RETRACT`, or another evolution operation.
8. Evidence that an earlier assignment was an engine mistake SHALL NOT be treated as user-state evolution. The resolver SHALL emit or reference a semantic-repair signal for downstream handling.
9. Retrieval scores, ranks, and channel counts SHALL be treated as candidate-generation diagnostics only and SHALL NOT constitute semantic proof of ownership.
10. An existing-concern assignment SHALL require one uniquely actionable `HIGH` identity match with no materially competing candidate.
11. WHEN two or more candidates remain materially competitive, including multiple `HIGH` candidates, THE resolver SHALL NOT select an arbitrary winner and SHALL return `UNRESOLVED` or `REQUIRES_VALIDATION` with `RETAIN_PENDING`.
12. A single packet SHALL have at most one primary owning concern, while its propositions MAY retain multiple normalized association roles permitted by the data model.

### Requirement 3: Behavioral Confidence and Decision Semantics

**User Story:** As ContextGraph, I want confidence bands to have explicit behavioral consequences, so that uncertainty changes what the engine does rather than appearing only as diagnostic metadata.

#### Acceptance Criteria

1. Identity-match confidence SHALL be evaluated independently from retrieval-sufficiency confidence and IRS-signal confidence.
2. An identity-match band of `HIGH` SHALL mean the evidence is sufficient to act, the candidate has identity-defining continuity, and no materially competitive alternative remains.
3. An identity-match band of `MEDIUM` SHALL mean an existing match is plausible but evidence, candidate separation, or retrieval coverage is incomplete; it SHALL NOT authorize ownership assignment.
4. An identity-match band of `LOW` SHALL mean the available evidence does not support ownership assignment; it SHALL NOT by itself prove novelty.
5. WHEN the resolver has one uniquely supported `HIGH` match, it SHALL return outcome `YES` with action `ASSIGN_EXISTING`.
6. WHEN the best match is `MEDIUM` or `LOW`, or no candidate matches, THE pipeline SHALL evaluate retrieval sufficiency before returning `NO` or proposing novelty.
7. WHEN candidate ambiguity can plausibly be resolved by more evidence over time, THE resolver SHALL return `UNRESOLVED` with `RETAIN_PENDING`.
8. WHEN a decision cannot complete because an external dependency, retrieval service, model, budget, or required context is unavailable, THE resolver SHALL return `DEFER` or `RETRIEVAL_INCONCLUSIVE`, not a semantic `NO_MATCH`.
9. WHEN human or higher-assurance validation is required by policy, THE resolver SHALL return `REQUIRES_VALIDATION` and SHALL NOT propose an ownership-changing mutation.
10. Confidence bands SHALL NOT be converted into arbitrary numeric probabilities or universal similarity thresholds.
11. The evidence rubric and resulting behavior for every confidence band SHALL be versioned, testable, and included in diagnostics.

### Requirement 4: Retrieval Sufficiency Gate

**User Story:** As ContextGraph, I want retrieval adequacy established before novelty is declared, so that a missing candidate is never mistaken for a missing concern.

#### Acceptance Criteria

1. WHEN identity resolution lacks one uniquely supported `HIGH` match, THE Retrieval_Sufficiency_Gate SHALL run before the pipeline may conclude `NO_MATCH`.
2. THE gate SHALL distinguish `NO_MATCH` from `RETRIEVAL_INCONCLUSIVE`.
3. `NO_MATCH` SHALL mean that retrieval was positively determined to be adequate and semantic evaluation found no existing concern with the same identity.
4. `RETRIEVAL_INCONCLUSIVE` SHALL mean that retrieval may have omitted a relevant concern, required coverage was incomplete, or one or more material retrieval attempts failed, timed out, were unavailable, or could not run within the approved budget.
5. THE gate SHALL evaluate `IRS-1` through `IRS-6` using grounded packet, provenance, candidate, and conversation-history evidence.
6. An IRS signal SHALL record its type, confidence band, source evidence references, and explanation.
7. WHEN any `HIGH` or `MEDIUM` IRS signal remains unresolved, THE gate SHALL return `RETRIEVAL_INCONCLUSIVE` and trigger Adaptive_Widening.
8. Retrieval adequacy SHALL be based on successful channel-family coverage, detected IRS signals, result diversity, history coverage, and query-result semantic alignment—not a single score or rank.
9. The versioned retrieval policy SHALL define the channel families required for each IRS signal. It SHALL NOT permit `NO_MATCH` based solely on one retrieval channel or on failed attempts.
10. A `SUCCESS_EMPTY` attempt MAY contribute to adequacy; `ERROR`, `TIMEOUT`, `UNAVAILABLE`, and `SKIPPED_WITH_REASON` SHALL NOT be represented as successful empty retrieval.
11. THE gate SHALL produce an auditable sufficiency record containing the policy version, channels required, attempts made, attempt statuses, IRS signals, coverage gaps, confidence band, outcome, and reasoning.

### Requirement 5: Adaptive Identity Widening

**User Story:** As ContextGraph, I want retrieval widened through signal-directed channels when initial retrieval is inconclusive, so that aliased, dormant, historically distant, or differently phrased concerns can be recovered without unbounded search.

#### Acceptance Criteria

1. WHEN the sufficiency gate returns `RETRIEVAL_INCONCLUSIVE`, THE Adaptive_Widener SHALL select additional channels based on the detected IRS signals and unresolved coverage gaps.
2. Supported channels SHALL include larger embedding retrieval, identity-summary search, alias-normalized retrieval, lexical/entity retrieval, dormant-concern scan, historical conversation-region search, and alternate semantic query formulation.
3. IRS-5 SHALL normally cause consideration of alias-normalized and alternate-formulation channels; IRS-2 and IRS-3 SHALL normally cause consideration of historical-summary and older-region channels. Deviations SHALL be recorded with reasons.
4. Retrieval channels SHALL be considered materially distinct only when they use different indexed fields, query formulations, temporal/status scopes, or retrieval mechanisms capable of recovering different candidates.
5. Adaptive Widening SHALL operate within a versioned maximum-attempt, latency, and cost budget.
6. The widening budget SHALL prevent unbounded search but SHALL NOT convert incomplete retrieval into semantic absence.
7. EACH retrieval attempt SHALL record its channel, query or query reference, scope, status, candidates returned, latency, failure reason when applicable, and retrieval-policy version.
8. Newly retrieved candidates SHALL return to the standard Identity_Resolver; the widener SHALL NOT assign ownership itself.
9. WHEN widening yields one uniquely supported `HIGH` match, THE resolver SHALL return `YES` with `ASSIGN_EXISTING`.
10. WHEN widening yields only ambiguous or `MEDIUM` candidates, THE resolver SHALL return `UNRESOLVED` or `DEFER` with `RETAIN_PENDING`.
11. WHEN all policy-required channels complete successfully, all material IRS signals are resolved, and no plausible candidate remains, THE sufficiency gate MAY return `NO_MATCH`.
12. WHEN widening stops because of failure, timeout, unavailability, or exhausted budget before adequacy is established, THE result SHALL remain `RETRIEVAL_INCONCLUSIVE` or `DEFER`.

### Requirement 6: Novelty and New-Concern Proposals

**User Story:** As ContextGraph, I want new concerns proposed only after adequate retrieval confirms novelty and the packet qualifies for independent concern status, so that evidence is retained without producing duplicate or premature concerns.

#### Acceptance Criteria

1. THE Python service SHALL propose, not directly persist, creation of a new `Persistent_Concern`.
2. A new-concern proposal SHALL require: outcome `NO`, positively adequate retrieval, no plausible existing identity candidate, and an applicable `INDEPENDENT_CONCERN_CANDIDATE` retention role.
3. A packet that does not qualify as `INDEPENDENT_CONCERN_CANDIDATE` SHALL NOT create a new concern solely because no owner was found.
4. WHEN such a non-independent packet carries `SUPPORTING_EVIDENCE`, `DURABLE_PROPOSITION`, or `EMERGENCE_EVIDENCE`, THE pipeline SHALL retain it and its associations in a pending/evidence state for later resolution rather than discard it.
5. A new-concern proposal SHALL contain a deterministic, retry-stable creation key compatible with the SIE entity registry and idempotent commit process.
6. A new-concern proposal SHALL be mutually exclusive with an existing-concern match in the same result.
7. New-concern persistence SHALL occur only after TypeScript verifies the graph version, validates invariants, and atomically commits the returned dependency group.

### Requirement 7: Concern Lifecycle and Redirect Handling

**User Story:** As ContextGraph, I want identity continuity preserved across dormant, merged, and retired concern states, so that lifecycle status does not cause duplicates or corrupt ownership.

#### Acceptance Criteria

1. `ACTIVE` and `DORMANT` concerns SHALL be eligible identity candidates.
2. `DORMANT` status SHALL NOT reduce identity solely because of age or inactivity, and dormant concerns SHALL be accessible through standard or widening retrieval as defined by policy.
3. WHEN a packet has one uniquely supported `HIGH` match to a dormant concern and substantively resumes that concern, Python SHALL propose an atomic dependency group containing ownership association, `DORMANT` to `ACTIVE` status transition, last-active update, and audit entry.
4. A historical mention of a dormant concern that does not substantively resume it SHALL NOT automatically reactivate it.
5. Reactivation SHALL preserve all propositions, evidence associations, aliases, and mutation history.
6. A `MERGED` concern SHALL NOT receive new primary ownership. Identity resolution SHALL follow its audited redirect to the surviving concern and record the redirect path considered.
7. A missing, cyclic, or invalid merge redirect SHALL produce `REQUIRES_VALIDATION`; it SHALL NOT be silently bypassed.
8. A `RETIRED` concern SHALL remain discoverable for identity continuity. A uniquely supported return that substantively reopens the same concern SHALL propose reactivation rather than create a duplicate; a purely historical reference SHALL preserve `RETIRED` status.
9. Concerns removed or suppressed under applicable deletion/privacy semantics SHALL NOT be exposed through ordinary identity retrieval. Their handling SHALL follow the system's deletion/privacy requirements.
10. WHEN several dormant, merged-target, active, or retired concerns compete, THE resolver SHALL use the same identity-continuity rules and SHALL NOT prefer recency or status alone.

### Requirement 8: Pending Decisions and Later Resolution

**User Story:** As ContextGraph, I want unresolved identity decisions persisted and reconsidered when better evidence becomes available, so that uncertainty is durable and recoverable rather than forcing or losing an ownership decision.

#### Acceptance Criteria

1. `UNRESOLVED`, `DEFER`, `RETRIEVAL_INCONCLUSIVE`, and `REQUIRES_VALIDATION` outcomes SHALL be persistable as `Pending_Identity_Decision` records.
2. EACH pending decision SHALL contain its stable ID, packet ID, proposition IDs, graph version analyzed, outcome, candidates considered, evidence references, IRS signals, retrieval-attempt record, confidence bands, reason, creation time, and lifecycle state.
3. Pending decisions SHALL survive process restarts, unrelated conversational episodes, and incremental cursor advancement.
4. Pending decisions SHALL be reloaded into later identity context when new packets, new aliases, graph repairs, concern merges, or retrieval improvements may resolve them.
5. Re-evaluation SHALL be triggered by versioned, auditable policy and SHALL be bounded to avoid unending repeated work.
6. WHEN later evidence resolves a pending decision, THE pipeline SHALL preserve the original record, record the resolution and successor mutation references, and change its lifecycle state without deleting history.
7. Resolution MAY assign the packet to an active concern, reactivate a dormant or retired concern, follow a merge redirect, or propose a new concern if all novelty requirements are then satisfied.
8. Duplicate delivery or retry of the same unresolved request SHALL NOT create duplicate pending decisions.

### Requirement 9: Versioning, Idempotency, and Concurrency

**User Story:** As ContextGraph, I want identity decisions bound to the graph state and request that produced them, so that retries are idempotent and stale semantic reasoning cannot be committed against a newer graph.

#### Acceptance Criteria

1. EVERY identity-resolution request SHALL include a stable request ID, idempotency key, payload fingerprint, conversation ID, packet IDs, sequence range, contract version, retrieval-policy version, and `Graph_Version_Analyzed`.
2. EVERY identity-resolution response SHALL repeat the request identity and graph version and SHALL include the model, prompt, extraction, and semantic-policy versions used.
3. Reusing an idempotency key with the same payload fingerprint SHALL return the previously recorded result and SHALL NOT repeat side effects or create new IDs.
4. Reusing an idempotency key with a different payload fingerprint SHALL fail validation.
5. Entity IDs and creation keys proposed by identity resolution SHALL be deterministic and retry-stable according to the SIE data-model ID strategy.
6. TypeScript SHALL commit a returned mutation proposal only if the current graph version equals `Graph_Version_Analyzed` and all preconditions remain true.
7. WHEN the graph version has advanced, TypeScript SHALL reject the stale proposal, reload current graph state, and request semantic re-analysis. It SHALL NOT merely replay the old semantic decision against the new version.
8. An exact replay of an already committed idempotent request MAY return its recorded commit result without re-analysis.
9. Candidate records and retrieval results SHALL be treated as version-bound evidence and SHALL NOT be silently reused after material graph changes unless the versioned policy explicitly establishes their validity.

### Requirement 10: Identity Resolution Record and Mutation Boundary

**User Story:** As ContextGraph, I want every identity decision represented by a complete typed record, so that decisions can be validated, committed, tested, audited, and repaired without reconstructing hidden reasoning.

#### Acceptance Criteria

1. EACH `Identity_Resolution_Record` SHALL contain: request identity, packet ID, proposition IDs, graph version, outcome, action, identity confidence, sufficiency confidence, matched concern ID or new-concern proposal where applicable, candidates considered, competing candidates, grounded evidence references, IRS signals, retrieval attempts, reasoning, diagnostics, policy/model versions, and proposed mutations.
2. An outcome of `YES` SHALL require action `ASSIGN_EXISTING` and exactly one matched concern ID; it SHALL NOT contain a new-concern proposal.
3. An outcome of `NO` with action `PROPOSE_NEW` SHALL require adequate retrieval and an eligible independent-concern retention role; it SHALL NOT contain a matched concern ID.
4. Outcomes `UNRESOLVED`, `DEFER`, `RETRIEVAL_INCONCLUSIVE`, and `REQUIRES_VALIDATION` SHALL use action `RETAIN_PENDING` or `NONE` and SHALL NOT contain an ownership-changing mutation.
5. Candidate records SHALL contain the concern ID, resolved merge target when applicable, lifecycle status, contributing retrieval channels, channel-local ranks or scores, identity evidence, contrary evidence, confidence band, and explanation.
6. Reasoning SHALL be expressed as concise, inspectable semantic justification tied to evidence references; unsupported hidden-chain-of-thought storage SHALL NOT be required.
7. Python SHALL return proposed semantic decisions and mutation/dependency-group payloads. TypeScript SHALL own persistence, version validation, invariant validation, transaction execution, and commit recording.
8. A reactivation proposal and its ownership association SHALL be placed in a semantically atomic dependency group.
9. All association changes SHALL use the normalized association records defined by `sie-data-model`; identity resolution SHALL NOT encode durable ownership or evidence associations solely as unvalidated ID arrays.

### Requirement 11: Failure Handling and Observability

**User Story:** As ContextGraph, I want retrieval and model failures represented honestly and observably, so that operational failure cannot masquerade as semantic novelty.

#### Acceptance Criteria

1. Retrieval errors, timeouts, unavailable indexes, malformed model output, contract-version mismatch, missing graph context, and exhausted budgets SHALL produce explicit failure diagnostics.
2. Such failures SHALL NOT be converted to `NO_MATCH`, `LOW` semantic confidence, or a new-concern proposal unless adequate retrieval and semantic evaluation independently support that result.
3. Structured-output validation failures SHALL follow bounded retry and escalation policies; exhausted retries SHALL return `DEFER` or `REQUIRES_VALIDATION`.
4. The subsystem SHALL emit structured metrics for latency, channel use, widening frequency, model routing, retries, failures, pending-decision rate, dormant reactivation, new-concern proposals, and version-conflict re-analysis.
5. Logs and diagnostics SHALL preserve traceability while obeying applicable privacy, access-control, and retention requirements.
6. Operational policies governing attempt limits, timeouts, model escalation, and cost budgets SHALL be versioned and configurable without duplicating semantic logic in TypeScript.

### Requirement 12: Evaluation and Release Gates

**User Story:** As ContextGraph, I want identity resolution evaluated against representative and adversarial conversations before release, so that lexical shortcuts, false novelty, and unsafe ownership decisions are detected systematically.

#### Acceptance Criteria

1. THE identity subsystem SHALL be evaluated through the SMT harness using labeled examples across short and long, representative, adversarial, and domain-diverse conversations, including domains not represented in the development examples, to test domain-general behavior and detect domain-specific heuristics.
2. Evaluation coverage SHALL include: same vocabulary with different identities, different vocabulary with the same identity, dormant returns, retired reopening, merge redirects, parent-versus-child ambiguity, duplicate concerns, multiple competitive candidates, assistant-generated material, extraction corrections, channel failures, unresolved-decision reactivation, and state evolution without identity change.
3. Evaluation SHALL separately measure false existing-concern assignment, false new-concern creation, missed reactivation, unresolved/defer calibration, retrieval-sufficiency error, and retry/version determinism.
4. Invariant tests SHALL verify that retrieval rank never directly assigns ownership, stale proposals cannot commit, mixed packets do not reach final identity resolution, and non-independent unmatched evidence is not discarded.
5. Property-based tests SHALL cover result-union validity, stable IDs, idempotent retries, merge redirects, pending lifecycle transitions, and invalid combinations of outcome, action, matched concern, and new-concern proposal.
6. Batch and incremental evaluation SHALL require Current_State_Equivalence for active concern identities and proposition ownership after all repairs and pending resolutions are applied; identical packet boundaries or historical traces SHALL NOT be required.
7. Real PostgreSQL integration tests SHALL verify pending-decision persistence, atomic reactivation/ownership commits, idempotency, graph-version rejection, rollback, and merge-redirect integrity.
8. Production release SHALL require zero known violations of semantic and graph invariants and approval of versioned quality thresholds for the semantic metrics in Acceptance Criterion 3.
9. The exact numeric quality thresholds and acceptable latency/cost budgets are a consequential release-policy decision and SHALL be approved and recorded before production rollout; this specification SHALL NOT invent them.

## Explicitly Deferred Release-Policy Decision

The semantic behavior required by this specification is defined. The following operational release decision remains intentionally unresolved:

- The numeric acceptance thresholds for false assignment, false novelty, missed reactivation, unresolved/defer calibration, latency, and cost in the SMT release gate.

These thresholds must be established from benchmark baselines and product risk tolerance before production release. Their absence does not block architecture or implementation, but it does block a production-readiness declaration.