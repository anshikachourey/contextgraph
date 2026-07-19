# Requirements Document

## Introduction

This spec defines the hierarchy and structural management subsystem of the Semantic Intelligence Engine (SIE). It covers canonical parent resolution, longitudinal sub-concern emergence and promotion, structural change validation through the signal→validate→apply lifecycle, and the distinct categories of parent assignment.

The core principle: hierarchy requires strict semantic containment (SME-12), each concern has at most one canonical structural parent (SME-13), and parenthood is determined by primary semantic home rather than retrieval rank (SME-15). Shared dependencies, projects, entities, mechanisms, or goals alone do not establish containment (SME-16).

## Glossary

- **Canonical_Parent**: The single structural parent of a Persistent_Concern, determined by identity-defining semantic containment. A concern's canonical parent is where it semantically "lives" — not merely where it was retrieved or what it is related to.
- **Potential_Sub_Concern**: Tracked evidence for a candidate future concern, including candidate meaning, supporting propositions, episodes, questions, constraints, decisions, and state trajectory (NO_DISTINCT → EMERGING → ESTABLISHED). Not yet graduated to Persistent_Concern status.
- **Sub_Concern_State**: The progression of a potential sub-concern: NO_DISTINCT (no distinct identity observed), EMERGING (evidence accumulating across episodes), ESTABLISHED (meets all promotion criteria).
- **Structural_Change**: A modification to the concern hierarchy (reparenting, merge, split, promotion) that follows the signal→validate→apply lifecycle.
- **Parent_Assignment_Category**: The classification of how a parent was assigned: INITIAL (at concern creation), DEFERRED (parent not yet determined), REPAIR (correcting a prior mistake), GENUINE_REPARENTING (real semantic migration), MERGE_SPLIT_RELOCATION (consequence of merge or split operation).
- **Canonical_Parent_Criteria**: The criteria for establishing canonical parenthood: CPR-1 through CPR-5.
- **Behavioral_Confidence_Band**: A stage-specific confidence classification (HIGH, MEDIUM, LOW) that directly determines pipeline behavior.
- **Semantic_Dependency_Group**: An atomic set of mutations representing one semantic change, used here for structural operations that affect multiple objects.

## Requirements

### Requirement 1: Canonical Parent Resolution

**User Story:** As ContextGraph, I want each Persistent_Concern to have at most one canonical structural parent determined by strict semantic containment, so that the concern hierarchy reflects genuine conceptual nesting rather than topical proximity or retrieval artifacts.

#### Acceptance Criteria

1. EACH Persistent_Concern SHALL have at most one canonical structural parent (SME-13) — multiple parents are never valid.
2. THE SIE_Pipeline SHALL determine canonical parenthood by primary semantic home (SME-15) — the parent is the concern that semantically contains the child as a narrower aspect of itself, not the concern that retrieval ranked highest.
3. THE SIE_Pipeline SHALL require strict semantic containment for hierarchy (SME-12) — the child must be a genuine sub-aspect of the parent's semantic scope.
4. THE SIE_Pipeline SHALL NOT establish containment based on shared dependency, shared project, shared entity, shared mechanism, or shared goal alone (SME-16) — these indicate relationship, not hierarchy.
5. A parent concern MAY have any number of children (SME-14) — there is no limit on the number of sub-concerns a parent can contain.
6. THE SIE_Pipeline SHALL NOT create artificial umbrella objects to group unrelated concerns (SME-21) — hierarchy must reflect genuine semantic containment that exists in the user's conceptual model.
7. WHEN a legitimate broader concern emerges later that genuinely contains existing concerns, THE SIE_Pipeline SHALL allow reparenting of those concerns under the new broader parent (SME-22), following the structural change lifecycle.
8. WHEN canonical parent cannot be determined with HIGH confidence at concern creation time, THE SIE_Pipeline SHALL assign parent category DEFERRED and leave canonical parent as null rather than forcing an uncertain assignment (SME-26).
9. THE SIE_Pipeline SHALL apply Canonical_Parent_Criteria (CPR-1 through CPR-5) to evaluate candidate parents using Behavioral_Confidence_Bands.

### Requirement 2: Longitudinal Sub-Concern Emergence

**User Story:** As ContextGraph, I want the pipeline to track emerging sub-concerns across non-contiguous episodes and promote them to independent concerns only when rigorous criteria are met, so that genuine sub-topics are recognized without premature concern creation.

#### Acceptance Criteria

1. WHEN a Semantic_Packet classified at EMERGENCE_EVIDENCE retention level shows evidence of a potential sub-topic within an existing Persistent_Concern, THE SIE_Pipeline SHALL create or update a Potential_Sub_Concern tracker associated with that parent concern.
2. THE Potential_Sub_Concern SHALL progress through states: NO_DISTINCT (no distinct sub-identity observed), EMERGING (evidence accumulating across episodes), ESTABLISHED (meets all promotion criteria).
3. THE SIE_Pipeline SHALL accumulate sub-concern evidence across non-contiguous episodes — evidence does NOT require temporal adjacency.
4. THE SIE_Pipeline SHALL ensure sub-concern evidence survives conversational interruption — intervening unrelated material does not invalidate accumulated evidence.
5. WHEN a Potential_Sub_Concern reaches ESTABLISHED state, THE SIE_Pipeline SHALL verify ALL promotion criteria before creating a new Persistent_Concern: strict semantic containment within the parent (SME-12), independent returnability (user returns to this sub-topic independently), credible autonomy (the sub-concern has its own identity beyond the parent), and sufficient longitudinal evidence.
6. THE SIE_Pipeline SHALL NOT use a fixed episode count as a promotion threshold — promotion requires qualitative assessment of all criteria using Behavioral_Confidence_Bands.
7. WHEN promotion criteria assessment produces MEDIUM confidence on any criterion, THE SIE_Pipeline SHALL continue accumulating evidence rather than forcing promotion or abandonment.
8. WHEN a Potential_Sub_Concern is promoted to a Persistent_Concern, THE SIE_Pipeline SHALL assign the parent concern as Canonical_Parent (category: INITIAL), migrate relevant propositions, and emit the promotion as a Semantic_Dependency_Group.
9. THE SIE_Pipeline SHALL persist emergence evidence across interruptions — emergence tracking is not reset by unrelated conversational activity.

### Requirement 3: Structural Change Validation

**User Story:** As ContextGraph, I want all structural hierarchy changes (reparenting, merge, split, promotion) to follow a signal→validate→apply lifecycle, so that structural modifications are never applied impulsively and each change is grounded in validated evidence.

#### Acceptance Criteria

1. ALL structural hierarchy changes (duplicate detection, merge, reparenting, split, promotion) SHALL follow the lifecycle: SIGNAL → VALIDATE → APPLY (SME-23).
2. WHEN a structural change signal is detected, THE SIE_Pipeline SHALL record the signal with its evidence and source but SHALL NOT immediately apply the change.
3. DURING the VALIDATE phase, THE SIE_Pipeline SHALL assess the signal using Behavioral_Confidence_Bands — HIGH confidence permits proceeding to APPLY, MEDIUM confidence requires additional evidence gathering, LOW confidence rejects the signal.
4. DURING the APPLY phase, THE SIE_Pipeline SHALL execute the structural change as a Semantic_Dependency_Group, ensuring all constituent mutations (parent reassignment, proposition migration, metadata updates) succeed or fail atomically.
5. THE SIE_Pipeline SHALL treat structural uncertainty as reducing structural commitment (SME-26) — when confidence about a structural change is not HIGH, the system preserves the current structure.
6. WHEN a validated structural change affects multiple concerns (e.g., merge affects both source and target), THE SIE_Pipeline SHALL assess cross-object impact for each affected concern.
7. THE SIE_Pipeline SHALL distinguish creating a concern with initial parent assignment (lower consequence) from changing an established concern's parent (higher consequence, requires stronger evidence).

### Requirement 4: Parent Assignment Categories

**User Story:** As ContextGraph, I want parent assignments to be classified by category so that the system can distinguish routine initial assignments from high-consequence reparenting operations, applying appropriate evidence thresholds to each.

#### Acceptance Criteria

1. EACH parent assignment operation SHALL be classified into exactly one category: INITIAL, DEFERRED, REPAIR, GENUINE_REPARENTING, or MERGE_SPLIT_RELOCATION.
2. WHEN a new Persistent_Concern is created with a known parent, THE SIE_Pipeline SHALL assign category INITIAL — this is the lowest-consequence assignment requiring standard confidence.
3. WHEN a new Persistent_Concern is created without a determinable parent, THE SIE_Pipeline SHALL assign category DEFERRED with canonical parent set to null — this is valid and does not require urgent resolution.
4. WHEN a prior parent assignment is determined to have been incorrect (engine mistake), THE SIE_Pipeline SHALL assign category REPAIR and follow the semantic repair pathway rather than the evolution pathway.
5. WHEN a concern's semantic scope genuinely migrates to a different parent (real user-state change, not an engine mistake), THE SIE_Pipeline SHALL assign category GENUINE_REPARENTING — this is the highest-consequence category requiring the strongest evidence and signal→validate→apply lifecycle.
6. WHEN a parent changes as a consequence of a merge or split operation, THE SIE_Pipeline SHALL assign category MERGE_SPLIT_RELOCATION — the parent change is a derived effect of the primary structural operation.
7. THE SIE_Pipeline SHALL require progressively stronger evidence for higher-consequence categories: INITIAL < DEFERRED < REPAIR < MERGE_SPLIT_RELOCATION < GENUINE_REPARENTING.
