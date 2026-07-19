# Requirements Document

## Introduction

The Semantic Intelligence Engine (SIE) implements ContextGraph's Candidate v1 semantic execution pipeline, as clarified and extended by the Requirements Clarifications Addendum. It replaces the current batch-oriented V2 intelligence layer with a principled, incremental semantic pipeline that processes concern-cohesive Semantic_Packets against a durable Persistent_Concern graph.

This document serves as the architectural overview and cross-reference for the SIE. The detailed requirements are organized into four focused sub-specifications:

1. **sie-data-model** — Core semantic data model: retention-level assessment, concern-cohesive packet validation, proposition data model, persistent concern data model.
2. **sie-identity-resolution** — Identity resolution: primary identity resolution, retrieval sufficiency gates, adaptive identity widening, dormant concern reactivation.
3. **sie-hierarchy-structure** — Hierarchy and structure: canonical parent resolution, longitudinal sub-concern emergence, structural change validation, parent assignment categories.
4. **sie-evolution-integration** — Evolution and integration: cross-object impact, relationships, evolution vs repair, dependency groups, graph commit, convergence, Python/TS integration, Supabase persistence.

Core semantic policies enforced across all sub-specs:
- 6-level retention model (DISCARD through INDEPENDENT_CONCERN)
- Behavioral confidence bands (HIGH/MEDIUM/LOW) — no arbitrary numeric thresholds
- Concern-cohesive packet validation before identity resolution
- Persistent concern identity outranks lexical similarity (SME-1)
- Retrieval proposes candidates; never determines ownership (SME-2)
- Retrieval absence is not semantic absence (SME-3)
- Graduated pipeline outcomes (YES, NO, UNRESOLVED, DEFER, RETRIEVAL_INCONCLUSIVE, REQUIRES_VALIDATION)
- Semantic evolution and semantic repair are mutually exclusive categories
- Signal→validate→apply lifecycle for structural changes
- Full-batch and incremental converge toward equivalent graphs (SME-27)

Candidate v1 + Addendum are authoritative semantic policy. Where ambiguity remains, sub-specs surface it explicitly rather than inventing rules.

## Glossary

- **Semantic_Packet**: A concern-cohesive processing unit containing propositions with provenance metadata. Must be validated as concern-cohesive before identity resolution. (Detailed in sie-data-model)
- **Proposition**: The smallest meaningful semantic unit with stable ID, provenance, type, and semantic state. (Detailed in sie-data-model)
- **Persistent_Concern**: A stable, independently returnable conversational concern with lifecycle status (ACTIVE, DORMANT, RETIRED, MERGED). (Detailed in sie-data-model)
- **Identity_Resolution**: Determining which existing Persistent_Concern a packet addresses, based on identity continuity not lexical similarity. (Detailed in sie-identity-resolution)
- **Retrieval_Sufficiency_Gate**: Checkpoint assessing whether retrieval was adequate before declaring novelty. (Detailed in sie-identity-resolution)
- **Adaptive_Widening**: Expanding retrieval scope through multiple channels when initial retrieval is insufficient. (Detailed in sie-identity-resolution)
- **Canonical_Parent**: Single structural parent determined by strict semantic containment, not topic proximity. (Detailed in sie-hierarchy-structure)
- **Sub_Concern_Emergence**: Longitudinal tracking and promotion of potential sub-concerns. (Detailed in sie-hierarchy-structure)
- **Semantic_Evolution**: Real user-state changes: EXTEND, SUPERSEDE, RETRACT, STATE_UPDATE. (Detailed in sie-evolution-integration)
- **Semantic_Repair**: Correcting engine mistakes with immediate deactivation and preserved audit trail. (Detailed in sie-evolution-integration)
- **Semantic_Dependency_Group**: Atomic mutation sets with failure policies (ALL_OR_NONE, INDEPENDENT, DERIVED). (Detailed in sie-evolution-integration)
- **Graph_Commit**: Atomic, versioned application of validated mutations to persistent state. (Detailed in sie-evolution-integration)
- **Behavioral_Confidence_Band**: Stage-specific HIGH/MEDIUM/LOW classification determining pipeline behavior. No numeric cutoffs.
- **Pipeline_Outcome**: Graduated stage result: YES, NO, UNRESOLVED, DEFER, RETRIEVAL_INCONCLUSIVE, REQUIRES_VALIDATION.
- **Retention_Level**: 6-level classification: DISCARD, CONTEXT_ONLY, SUPPORTING_EVIDENCE, DURABLE_PROPOSITION, EMERGENCE_EVIDENCE, INDEPENDENT_CONCERN.

## Requirements

### Requirement 1: Sub-Spec — Core Semantic Data Model (sie-data-model)

**User Story:** As ContextGraph, I want the foundational data model to be well-defined so that all downstream pipeline stages operate on consistent, validated data structures with clear semantics.

#### Acceptance Criteria

1. THE SIE SHALL implement the retention-level assessment, concern-cohesive packet validation, proposition data model, and persistent concern data model as specified in `.kiro/specs/sie-data-model/requirements.md`.
2. ALL downstream pipeline stages SHALL depend on the data structures and validation rules defined in the sie-data-model spec.

### Requirement 2: Sub-Spec — Identity Resolution (sie-identity-resolution)

**User Story:** As ContextGraph, I want identity resolution to enforce that persistent concern identity outranks lexical similarity, with retrieval sufficiency gates preventing false novelty declarations.

#### Acceptance Criteria

1. THE SIE SHALL implement primary identity resolution, retrieval sufficiency gates, adaptive identity widening, and dormant concern reactivation as specified in `.kiro/specs/sie-identity-resolution/requirements.md`.
2. THE identity resolution subsystem SHALL receive only concern-cohesive packets that have passed data model validation.

### Requirement 3: Sub-Spec — Hierarchy and Structure (sie-hierarchy-structure)

**User Story:** As ContextGraph, I want hierarchy management to enforce strict semantic containment with rigorous validation, so that the concern graph reflects genuine conceptual nesting.

#### Acceptance Criteria

1. THE SIE SHALL implement canonical parent resolution, longitudinal sub-concern emergence, structural change validation, and parent assignment categories as specified in `.kiro/specs/sie-hierarchy-structure/requirements.md`.
2. ALL structural changes SHALL follow the signal→validate→apply lifecycle before modifying the persistent graph.

### Requirement 4: Sub-Spec — Evolution and Integration (sie-evolution-integration)

**User Story:** As ContextGraph, I want the evolution, integration, and operational layers to ensure atomic graph mutations, clear separation of evolution from repair, convergence guarantees, and clean Python/TypeScript boundaries.

#### Acceptance Criteria

1. THE SIE SHALL implement cross-object impact assessment, relationship analysis, evolution/repair separation, semantic dependency groups, graph commit, convergence guarantee, Python/TypeScript integration, and Supabase persistence as specified in `.kiro/specs/sie-evolution-integration/requirements.md`.
2. THE SIE SHALL guarantee that full-batch and incremental processing converge toward Current_State_Equivalence.
### Requirement 20: Python Semantic Core Architecture

**User Story:** As ContextGraph, I want the semantic intelligence logic to execute in the Python ml-service environment, so that ML/retrieval experimentation is decoupled from the TypeScript product layer while maintaining a single authoritative engine.

#### Acceptance Criteria

1. THE SIE_Pipeline semantic stages (retention assessment, packet cohesion validation, identity resolution, sufficiency gates, adaptive widening, sub-concern tracking, parent resolution, structural sufficiency, cross-object impact, relationship analysis, state/supersession analysis, restructuring detection, mutation assembly) SHALL execute within the Python ml-service.
2. THE TypeScript orchestration layer SHALL invoke the Python ml-service via versioned HTTP API, passing Semantic_Packets and receiving validated mutation sets.
3. THE Python ml-service SHALL expose a versioned API contract enabling independent evolution of semantic logic without breaking the TypeScript consumer.
4. THE TypeScript layer SHALL remain responsible for: persistence, snapshot management, UI serving, commit orchestration, proposition extraction (initial), message ingestion, and cursor/recovery state.
5. WHEN the Python ml-service is unavailable, THE TypeScript layer SHALL queue unprocessed packets and retry when service is restored.
6. THE Python environment SHALL support experimentation with retrieval strategies, reranking, model routing, cheap/strong model escalation, and structured output contracts without requiring TypeScript changes.

### Requirement 21: Domain-General Operation

**User Story:** As ContextGraph, I want the semantic engine to operate correctly across all conversation domains without domain-specific tuning, so that users discussing any topic receive consistent semantic intelligence.

#### Acceptance Criteria

1. THE SIE_Pipeline SHALL produce correct identity resolution, hierarchy, and relationship analysis for conversations spanning: software development, career planning, health management, interpersonal relationships, travel planning, academic research, creative projects, personal decision-making, and any unforeseen domain.
2. THE SIE_Pipeline SHALL NOT use domain-specific heuristics, keyword lists, or classification rules that would fail for unforeseen conversation domains.
3. THE SIE_Pipeline SHALL rely on semantic structure (concern continuity, containment, evidence grounding) rather than topic classification for all pipeline decisions.
4. THE same underlying semantic laws SHALL work for all long and short conversations regardless of domain.

### Requirement 22: Integration with Existing Infrastructure

**User Story:** As ContextGraph, I want the semantic intelligence engine to integrate with existing persistence, snapshot, and UI infrastructure, so that the new engine evolves the system rather than replacing working components.

#### Acceptance Criteria

1. THE SIE_Pipeline SHALL persist graph state through the existing Supabase persistence layer using v2_graph_snapshots and v2_update_state tables.
2. THE SIE_Pipeline SHALL produce output compatible with the existing V2 snapshot schema (objects, relationships, propositions, threads, hierarchy, trees).
3. THE SIE_Pipeline SHALL consume propositions extracted by the existing proposition extraction pipeline as input to Semantic_Packet assembly.
4. THE SIE_Pipeline SHALL maintain the existing incremental processing contract using message_seq cursors and the v2_commit_update RPC.
5. THE SIE_Pipeline SHALL produce graph state that the React Flow UI can render without modification to the UI consumption layer.
6. THE SIE_Pipeline SHALL log mutations using the existing mutation logging infrastructure for audit and debugging.
