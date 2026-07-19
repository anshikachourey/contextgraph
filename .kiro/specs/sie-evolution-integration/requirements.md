# Requirements Document

## Introduction

This spec defines the evolution, integration, and operational subsystems of the Semantic Intelligence Engine (SIE). It covers cross-object impact assessment, relationship analysis and lifecycle, the distinction between semantic evolution and semantic repair, semantic dependency groups for atomic mutations, graph commit and versioning, pipeline convergence guarantees, the Python/TypeScript integration architecture, and the Supabase persistence model.

The core principles: one packet may affect multiple objects beyond its primary owner (SME-6), state change preserves identity (SME-9), relationships are orthogonal to hierarchy and ownership (SME-17), historical provenance is immutable (SME-24), and full-batch and incremental processing must converge toward equivalent graphs (SME-27).

## Glossary

- **Cross_Object_Impact**: A material state change to an existing Persistent_Concern caused by a Semantic_Packet whose primary ownership belongs to a different concern (SME-6).
- **Semantic_Evolution**: A real user-state change to a concern: EXTEND (adding material), SUPERSEDE (new proposition replaces prior), RETRACT (user withdraws claim), or STATE_UPDATE (concern status reflects real progress).
- **Semantic_Repair**: Correcting an engine mistake: REASSIGN_PROPOSITION, REMOVE_FALSE_PROPOSITION, CORRECT_PROVENANCE, CORRECT_RELATIONSHIP, CORRECT_PARENT, MERGE_DUPLICATE, SPLIT_INCORRECT_OBJECT, or REBUILD_DERIVED_METADATA.
- **Semantic_Dependency_Group**: An atomic set of mutations with group ID, constituent mutations, preconditions, postconditions, and failure policy (ALL_OR_NONE, INDEPENDENT, DERIVED).
- **Relationship_Record**: A semantic relationship containing: ID, source concern, target concern, type, directionality, provenance, supporting propositions, status, and confidence band.
- **Relationship_Lifecycle**: The progression of a relationship: CREATE, STRENGTHEN, WEAKEN, SUPERSEDE, RETRACT, REPAIR, DELETE_FOR_PRIVACY.
- **Graph_Commit**: The atomic, versioned application of a validated mutation set to the persistent graph state.
- **Pipeline_Convergence**: The guarantee that full-batch reprocessing and incremental processing converge toward Current_State_Equivalence (not Historical_Trace_Equivalence) (SME-27).
- **Pipeline_Outcome**: The graduated result of a pipeline stage: YES, NO, UNRESOLVED, DEFER, RETRIEVAL_INCONCLUSIVE, or REQUIRES_VALIDATION.
- **Behavioral_Confidence_Band**: A stage-specific confidence classification (HIGH, MEDIUM, LOW) that directly determines pipeline behavior.

## Requirements

### Requirement 1: Cross-Object Impact Assessment

**User Story:** As ContextGraph, I want the pipeline to identify and apply material state changes to concerns beyond the primary owner of a Semantic_Packet, so that a single user statement can correctly update multiple related concerns without requiring separate explicit references to each.

#### Acceptance Criteria

1. WHEN a Semantic_Packet's primary ownership is resolved to one Persistent_Concern, THE SIE_Pipeline SHALL separately evaluate whether the packet also produces material state changes to other existing concerns (SME-6).
2. THE cross-object impact assessment SHALL be evaluated separately from primary ownership determination — primary ownership and cross-object impact are independent pipeline stages.
3. WHEN cross-object impact is detected with HIGH confidence, THE SIE_Pipeline SHALL produce additional mutations for the affected concerns and include them in the same Semantic_Dependency_Group as the primary mutations.
4. WHEN cross-object impact confidence is MEDIUM, THE SIE_Pipeline SHALL emit a Pipeline_Outcome of DEFER for the cross-object mutations rather than applying uncertain changes.
5. THE SIE_Pipeline SHALL treat cross-object impact as producing state changes within existing concerns — cross-object impact does NOT create new concerns or change ownership.
6. ONE Semantic_Packet MAY produce multiple simultaneous mutations across multiple concerns (SME-25) — this is normal pipeline behavior, not an error condition.
7. THE SIE_Pipeline SHALL NOT confuse continuation origin with ownership (SME-19) — a packet that originated from discussing concern A may have its primary impact on concern B.

### Requirement 2: Relationship Analysis and Lifecycle

**User Story:** As ContextGraph, I want semantic relationships between concerns to be tracked orthogonally to hierarchy and ownership, with their own lifecycle and evidence requirements, so that the graph captures genuine semantic connections without conflating them with structural containment.

#### Acceptance Criteria

1. THE SIE_Pipeline SHALL treat relationships as orthogonal to hierarchy and ownership (SME-17) — a relationship between two concerns does not imply structural containment or shared ownership.
2. EACH relationship record SHALL contain: ID, source concern, target concern, type, directionality, provenance, supporting propositions, status, and confidence band.
3. THE relationship lifecycle SHALL support: CREATE, STRENGTHEN, WEAKEN, SUPERSEDE, RETRACT, REPAIR, and DELETE_FOR_PRIVACY.
4. WHEN relationship evidence is uncertain, THE SIE_Pipeline SHALL NOT create a relationship edge (SME-18) — relationship uncertainty means no edge rather than a weak edge.
5. THE SIE_Pipeline SHALL NOT infer relationships from: shared entity alone, shared project alone, similar vocabulary alone, or temporal proximity alone — each of these is insufficient evidence for a semantic relationship.
6. THE SIE_Pipeline SHALL treat child_of as a structural relationship (hierarchy) that is NOT managed through the normal semantic relationship lifecycle — it is governed by the hierarchy-structure spec.
7. WHEN a relationship is retracted or repaired, THE SIE_Pipeline SHALL preserve the relationship's history in the audit trail while updating its active status.
8. THE SIE_Pipeline SHALL use Behavioral_Confidence_Bands to assess relationship evidence — only HIGH confidence creates or strengthens relationships.

### Requirement 3: Semantic Evolution vs Semantic Repair

**User Story:** As ContextGraph, I want the pipeline to explicitly distinguish between semantic evolution (real user-state changes) and semantic repair (correcting engine mistakes), so that the system can apply different validation rules, preserve accurate provenance, and immediately deactivate known mistakes while maintaining audit trails.

#### Acceptance Criteria

1. THE SIE_Pipeline SHALL classify every graph mutation as either Semantic_Evolution or Semantic_Repair — these are mutually exclusive categories with different processing rules.
2. Semantic_Evolution operations SHALL be: EXTEND (adding material to a concern), SUPERSEDE (new proposition replaces prior within same concern), RETRACT (user explicitly withdraws a claim), or STATE_UPDATE (concern status reflects real progress such as completion or abandonment).
3. Semantic_Repair operations SHALL be: REASSIGN_PROPOSITION, REMOVE_FALSE_PROPOSITION, CORRECT_PROVENANCE, CORRECT_RELATIONSHIP, CORRECT_PARENT, MERGE_DUPLICATE, SPLIT_INCORRECT_OBJECT, or REBUILD_DERIVED_METADATA.
4. WHEN a semantic repair is applied, THE SIE_Pipeline SHALL deactivate the known mistake immediately — known mistakes SHALL NOT remain active in the graph while the audit trail is preserved.
5. THE SIE_Pipeline SHALL preserve historical provenance as immutable (SME-24) — repairs correct the current state but do NOT rewrite the historical record of how the mistake occurred.
6. WHEN assistant context aids interpretation of user meaning but does not constitute a user-grounded claim, THE SIE_Pipeline SHALL NOT treat it as semantic evolution (SME-20) — durable claims require user evidence.
7. THE SIE_Pipeline SHALL preserve audit trails for all repairs — the fact that a repair occurred, what was corrected, and when, is part of the permanent record.

### Requirement 4: Semantic Dependency Groups

**User Story:** As ContextGraph, I want related mutations to be grouped into atomic dependency sets with explicit preconditions, postconditions, and failure policies, so that multi-mutation semantic changes succeed or fail coherently rather than leaving the graph in an inconsistent intermediate state.

#### Acceptance Criteria

1. EACH set of related mutations produced by a single pipeline execution SHALL be packaged as a Semantic_Dependency_Group with: group ID, constituent mutations, preconditions, postconditions, and failure policy.
2. THE failure policy SHALL be one of: ALL_OR_NONE (all mutations succeed or all are rolled back), INDEPENDENT (each mutation succeeds or fails independently), or DERIVED (secondary mutations depend on primary mutation success).
3. WHEN a Semantic_Dependency_Group has ALL_OR_NONE failure policy, THE SIE_Pipeline SHALL ensure that partial application never persists — either all mutations in the group commit or none do.
4. WHEN a Semantic_Dependency_Group has DERIVED failure policy, THE SIE_Pipeline SHALL apply primary mutations first and secondary mutations only if primaries succeed — secondary failure does not roll back primaries.
5. THE SIE_Pipeline SHALL validate preconditions before applying any mutation in the group — if preconditions are not met (e.g., target concern no longer exists, concurrent modification detected), the group fails according to its failure policy.
6. THE SIE_Pipeline SHALL distinguish database transaction success from semantic atomicity — a successful database write does not guarantee semantic correctness of the mutation group.
7. EACH Semantic_Dependency_Group SHALL be traceable to the Semantic_Packet(s) that produced it.

### Requirement 5: Graph Commit and Versioning

**User Story:** As ContextGraph, I want validated mutation sets to be committed as versioned, atomic graph changes with full traceability, so that the graph evolves through an auditable sequence of well-defined changes rather than through untracked state modifications.

#### Acceptance Criteria

1. WHEN a Semantic_Dependency_Group passes validation, THE SIE_Pipeline SHALL commit it as an atomic, versioned Graph_Commit to the persistent graph state.
2. EACH Graph_Commit SHALL carry: commit ID, timestamp, source Semantic_Dependency_Group ID, source Semantic_Packet ID(s), mutation type classification (evolution or repair), and before/after state snapshots for affected objects.
3. THE SIE_Pipeline SHALL ensure that Graph_Commits are ordered — concurrent commits to the same concern SHALL be serialized to prevent conflicting state.
4. WHEN a Graph_Commit fails (database error, constraint violation), THE SIE_Pipeline SHALL NOT leave the graph in a partially-committed state — the commit is atomic.
5. THE SIE_Pipeline SHALL support querying the history of any Persistent_Concern through its sequence of Graph_Commits — full audit trail is accessible.
6. WHEN a repair commit corrects a prior evolution commit, THE SIE_Pipeline SHALL preserve both commits in history — the repair references the commit it corrects, but does not delete the original commit record.

### Requirement 6: Pipeline Convergence Guarantee

**User Story:** As ContextGraph, I want the guarantee that full-batch reprocessing and incremental processing converge toward the same graph state, so that the system produces consistent results regardless of processing order and can be validated by comparing batch and incremental outputs.

#### Acceptance Criteria

1. THE SIE_Pipeline SHALL guarantee that full-batch reprocessing of all conversation history and incremental processing of individual messages converge toward Current_State_Equivalence (SME-27).
2. Convergence SHALL be defined as Current_State_Equivalence — the resulting graph state is equivalent — NOT Historical_Trace_Equivalence — the sequence of commits need not be identical.
3. WHEN the same set of messages is processed in batch versus incrementally, THE resulting Persistent_Concern graph SHALL contain the same active concerns, the same proposition assignments, the same relationship edges, and the same structural hierarchy.
4. THE SIE_Pipeline SHALL preserve audit trails of repairs but SHALL NOT keep known mistakes active — convergence after repair means the corrected state matches what batch processing would produce.
5. WHEN incremental processing detects a state that would diverge from batch processing (e.g., ordering dependency produces different assignment), THE SIE_Pipeline SHALL flag the divergence for resolution rather than silently accepting inconsistency.

### Requirement 7: Python/TypeScript Integration Architecture

**User Story:** As ContextGraph, I want the semantic intelligence core (Python/ml-service) and the product orchestration layer (TypeScript/Next.js) to integrate cleanly with well-defined boundaries, so that semantic processing leverages Python's ML ecosystem while the product layer handles user interaction, persistence, and presentation.

#### Acceptance Criteria

1. THE SIE architecture SHALL separate the semantic processing core (Python ml-service) from the product orchestration layer (TypeScript/Next.js application).
2. THE Python ml-service SHALL be responsible for: semantic packet formation, retention assessment, identity resolution, concern cohesion validation, sub-concern emergence tracking, cross-object impact assessment, relationship analysis, and evolution/repair classification.
3. THE TypeScript product layer SHALL be responsible for: conversation ingestion, pipeline orchestration, graph commit execution, Supabase persistence, API serving, and user-facing presentation.
4. THE integration boundary SHALL be defined by typed request/response contracts — the Python service receives structured input and returns structured semantic decisions, the TypeScript layer applies those decisions to persistent state.
5. THE SIE_Pipeline SHALL produce ONE authoritative semantic engine — there SHALL NOT be duplicate semantic logic in both Python and TypeScript layers.
6. WHEN the Python ml-service returns a semantic decision, THE TypeScript layer SHALL apply it without re-interpreting or overriding the semantic judgment — the Python layer is authoritative for semantic decisions.

### Requirement 8: Supabase Persistence Model

**User Story:** As ContextGraph, I want the persistent graph state to be stored in Supabase with proper schema design for concerns, propositions, relationships, and mutation history, so that the graph is durable, queryable, and supports the retrieval operations required by identity resolution and adaptive widening.

#### Acceptance Criteria

1. THE persistence layer SHALL store Persistent_Concerns with all fields defined in the data model: concern ID, identity summary, title, summary, status, timestamps, canonical parent, aliases, and metadata.
2. THE persistence layer SHALL store Propositions with their full provenance: stable ID, source message IDs, speaker role, type, canonical meaning, sequence position, provenance classification, semantic state, and owning concern ID.
3. THE persistence layer SHALL store Relationship_Records with: ID, source, target, type, directionality, provenance, supporting propositions, status, and confidence.
4. THE persistence layer SHALL store Graph_Commits as an ordered, append-only audit log supporting temporal queries.
5. THE persistence layer SHALL support the retrieval operations required by identity resolution: embedding-based similarity search, alias lookup, status-filtered queries (including dormant concerns), and temporal range queries.
6. THE persistence layer SHALL support atomic transactions for Graph_Commit operations — partial writes SHALL NOT be visible to concurrent readers.
7. THE persistence layer SHALL store Semantic_Dependency_Groups with their failure policies and constituent mutation references for traceability.
