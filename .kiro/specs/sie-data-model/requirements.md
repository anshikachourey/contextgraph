# Requirements Document

## Introduction

This spec defines the foundational semantic data model used by the Semantic Intelligence Engine. It covers conversational retention assessment, proposition representation, concern-cohesive Semantic Packet formation and validation, and Persistent Concern representation and lifecycle.

All downstream semantic stages depend on these models. The data model must preserve enough semantic and provenance information for later identity resolution, adaptive retrieval, hierarchy, sub-concern emergence, cross-object impact, relationships, supersession, repair, restructuring, and full/incremental convergence.

This spec defines what the semantic data means. It does not define the later decision logic itself.

## Glossary

- **Proposition**: The smallest meaningful semantic unit that can participate in durable conversation understanding. Has a stable ID, source message IDs, speaker role (user/assistant), type, canonical meaning, sequence position, provenance (direct, paraphrase, interpretation, inference), and semantic state (active, superseded, retracted, invalidated).
- **Semantic_Packet**: A concern-cohesive processing unit (not a graph object) containing one or more propositions with provenance metadata. Must be validated as concern-cohesive before identity resolution.
- **Persistent_Concern**: A stable, durable, independently returnable conversational concern with persistent identity across time. Status: ACTIVE, DORMANT, RETIRED, MERGED.
- **Retention_Level**: Classification of how material should be retained: DISCARD, CONTEXT_ONLY, SUPPORTING_EVIDENCE, DURABLE_PROPOSITION, EMERGENCE_EVIDENCE, INDEPENDENT_CONCERN_CANDIDATE.
- **Concern_Cohesion**: The property that all propositions in a Semantic_Packet belong to the same primary concern ownership.
- **Behavioral_Confidence_Band**: Stage-specific confidence (HIGH/MEDIUM/LOW) determining pipeline behavior. No arbitrary numeric cutoffs.
- **Pipeline_Outcome**: Graduated result: YES, NO, UNRESOLVED, DEFER, RETRIEVAL_INCONCLUSIVE, REQUIRES_VALIDATION.

## Requirements

### Requirement 1: Semantic Retention Assessment

**User Story:** As ContextGraph, I want incoming conversational material to be classified by how it should be retained and used, so meaningful context is preserved without forcing every utterance into durable graph state.

#### Acceptance Criteria

1. WHEN conversational material is received, THE Retention_Assessor SHALL classify it into one of the supported retention roles: DISCARD, CONTEXT_ONLY, SUPPORTING_EVIDENCE, DURABLE_PROPOSITION, EMERGENCE_EVIDENCE, or INDEPENDENT_CONCERN_CANDIDATE.
2. DISCARD SHALL mean the material has no meaningful future semantic, interpretive, retrieval, or provenance value. Only genuinely semantically empty material should be permanently discarded.
3. CONTEXT_ONLY SHALL mean the material may help interpret nearby user meaning but does not itself become durable semantic state.
4. SUPPORTING_EVIDENCE SHALL mean the material contributes meaningfully to an existing or future concern but does not independently define durable user state.
5. DURABLE_PROPOSITION SHALL mean the material expresses durable semantic state such as a user-grounded claim, question, preference, goal, intent, decision, constraint, plan, correction, rejection, update, or state.
6. EMERGENCE_EVIDENCE SHALL mean the material contributes evidence that a narrower independently returnable concern may be developing over time.
7. INDEPENDENT_CONCERN_CANDIDATE SHALL mean the material may justify a new Persistent Concern, subject to downstream identity resolution and structural validation.
8. Retention roles SHALL NOT be required to be mutually exclusive at the underlying evidence level — one proposition may carry multiple semantic roles (e.g., DURABLE_PROPOSITION + EMERGENCE_EVIDENCE) represented through primary class plus flags, multiple roles, or another normalized form.
9. WHEN retention classification confidence is LOW, THE Retention_Assessor SHALL support REQUIRES_VALIDATION or DEFER outcomes rather than forcing a permanent classification.
10. THE Retention_Assessor SHALL preserve source message IDs, speaker role, sequence information, extraction version, and provenance with every retention decision.
11. Assistant-authored material MAY be retained as context, supporting evidence, source material, or explanation — but SHALL NOT automatically become durable user belief, preference, decision, or state.
12. Failure to justify a new concern SHALL NOT automatically cause material to be discarded.

### Requirement 2: Proposition Data Model

**User Story:** As ContextGraph, I want propositions to preserve the smallest meaningful semantic units and their provenance, so downstream stages can reason about identity, evolution, ownership, and repair reliably.

#### Acceptance Criteria

1. EACH Proposition SHALL have a stable identifier that remains consistent across incremental processing, retries, semantic reassignment, repair, and graph commits.
2. EACH Proposition SHALL include at minimum: propositionId, conversationId, sourceMessageIds, speakerRole (USER/ASSISTANT), canonicalMeaning, propositionType, messageSeqRange, provenance, semanticState, createdAt, and extractionVersion.
3. Proposition type SHALL support: QUESTION, CLAIM, PREFERENCE, GOAL, INTENT, DECISION, CONSTRAINT, PLAN, CORRECTION, REJECTION, UPDATE, REQUEST, EMOTIONAL_STATE, and EXAMPLE. The set may be extended but new types must not change semantic policy without review.
4. Proposition provenance SHALL record how the proposition was derived: DIRECT, PARAPHRASE, INTERPRETATION, or INFERENCE — and SHALL preserve all source message IDs contributing to the proposition.
5. Original conversational provenance SHALL be immutable — later semantic reassignment may change concern ownership or evidence association but SHALL NOT rewrite where the proposition originally came from.
6. Proposition semantic state SHALL support: ACTIVE, SUPERSEDED, RETRACTED, and INVALIDATED — where SUPERSEDED means user state evolved and INVALIDATED means an extraction or engine error.
7. State transitions SHALL be historically traceable — current state may change but prior states SHALL remain available in audit history.
8. A Proposition MAY have one primary semantic owner and multiple supporting/evidence associations — these are distinct concepts.
9. A Proposition SHALL NOT be forced to have a concern owner before identity resolution succeeds — pending or unresolved ownership SHALL be representable.
10. Assistant-authored propositions SHALL carry their speaker role so later stages cannot accidentally treat them as user-grounded state.

### Requirement 3: Concern-Cohesive Semantic Packets

**User Story:** As ContextGraph, I want identity resolution to receive concern-cohesive Semantic Packets, so one packet does not incorrectly hide multiple independent concerns.

#### Acceptance Criteria

1. EACH Semantic Packet SHALL include at minimum: packetId, conversationId, propositionIds, sourceMessageIds, messageSeqRange, userGroundedMeaning, assistantContext, continuationOrigin, provenance, packetFormationVersion, and cohesionStatus.
2. A Semantic Packet is a processing unit, not automatically a graph object — one packet does not automatically create one Persistent Concern.
3. A packet presented to primary identity resolution SHALL be concern-cohesive: it represents one primary persistent conversational concern, even if it may materially affect other concerns via cross-object impact.
4. WHEN a packet contains multiple independently owned concerns (e.g., "I'm reconsidering moving to Mumbai. Also I need a different laptop for work."), THE SIE_Pipeline SHALL split it before primary identity resolution.
5. A packet with one primary concern plus cross-object impact (e.g., "I'll only move to Mumbai if the Netflix offer works out") SHALL remain one packet — cross-object impact is handled downstream, not by splitting.
6. WHEN a packet is split, THE SIE_Pipeline SHALL preserve original message IDs, proposition IDs, sequence positions, continuation provenance, and shared source provenance — and SHALL record the split relationship (originalPacketId → resultingPacketIds) for diagnostics.
7. Cohesion assessment SHALL support outcomes: COHESIVE, MIXED, or UNRESOLVED_COHESION — low confidence SHALL NOT automatically mean "split."
8. WHEN cohesion is UNRESOLVED, THE SIE_Pipeline MAY re-evaluate propositions, use additional context, defer packet formation, or request stronger reasoning — but SHALL NOT invent an arbitrary split merely because confidence is low.
9. A packet with unresolved cohesion SHALL NOT proceed to final primary identity resolution as though cohesion were established.
10. Cross-object impact SHALL NOT be used to compensate for an incorrectly mixed packet.
11. Packet IDs SHALL be stable across retry of the same packet formation event unless deliberately split into new child packet IDs.

### Requirement 4: Persistent Concern Data Model

**User Story:** As ContextGraph, I want each Persistent Concern to preserve one durable semantic identity across time, so users can return to the same concern even after vocabulary, state, or conversational context changes.

#### Acceptance Criteria

1. EACH Persistent Concern SHALL contain at minimum: concernId, identitySummary, displayTitle, currentSummary, status, createdAt, lastActiveAt, canonicalParentId (nullable), aliases, ownedPropositionIds, supportingEvidenceIds, metadata, and semanticVersion.
2. The concernId SHALL remain stable across ordinary extension, state change, dormant periods, reactivation, title changes, summary changes, and vocabulary drift.
3. Concern status SHALL support: ACTIVE (currently relevant), DORMANT (not recently active but retains full identity), RETIRED (explicitly concluded/abandoned, remains historically queryable), and MERGED (subsumed into another concern with mergedIntoConcernId redirect).
4. DORMANT concerns SHALL remain eligible for retrieval, identity resolution, and reactivation — temporal distance alone SHALL NOT destroy concern identity.
5. canonicalParentId = null SHALL be valid, but the model SHALL separately represent parent-resolution state (ROOT_CONFIRMED, PARENT_DEFERRED, PARENT_ASSIGNED or equivalent) so that "legitimate root" and "parent unresolved" are not conflated.
6. identitySummary SHALL be the internal semantic representation used to distinguish this concern from others. displayTitle is user-facing metadata that may change independently from concern identity.
7. Aliases SHALL record alternative names, vocabulary drift, historical terminology, and user-specific references — they are retrieval evidence but do not independently define identity.
8. A concern SHALL support distinct owned propositions (primary ownership) and supporting evidence (evidentiary association) — these remain distinct concepts.
9. Concern identity SHALL NOT be defined by title alone, summary alone, current parent, embedding vector, latest state, or current vocabulary.
10. A Persistent Concern SHALL support later semantic repair, merge redirects, reparenting, and evidence reassociation without requiring a change to its stable concernId.
11. Independent returnability is a criterion for concern formation — the system SHALL NOT reason circularly that a concern is independently returnable merely because it already exists as a stored object.
12. A concern MAY exist even when its current parent is unresolved — unresolved parenthood is a valid state.

### Requirement 5: Cross-Cutting Data Model Invariants

**User Story:** As ContextGraph, I want mandatory invariants enforced across all data model operations, so that provenance integrity, ownership clarity, and semantic correctness are never violated regardless of processing path.

#### Acceptance Criteria

1. Original source provenance SHALL be immutable — semantic interpretation may evolve, but where a proposition originally came from SHALL NOT change.
2. Ownership and evidence SHALL remain distinct — a proposition may have one primary owner while serving as evidence for other concerns.
3. A Semantic Packet is a processing unit and a Persistent Concern is a durable graph identity — one does not automatically create the other.
4. THE SIE_Pipeline SHALL support unresolved retention, cohesion, ownership, and parenthood as first-class states — uncertainty SHALL NOT silently become false certainty.
5. Assistant context SHALL NOT automatically become user state — assistant content can help interpret user meaning without becoming durable user belief.
6. Stable IDs SHALL survive semantic evolution — normal semantic change SHALL NOT create replacement IDs.
7. Repairs SHALL NOT rewrite provenance — repairs may correct semantic state and ownership but SHALL NOT erase the historical fact that an engine mistake occurred.
8. Data structures SHALL support both full-batch and incremental execution — no core model may depend on being created only through one execution mode.
