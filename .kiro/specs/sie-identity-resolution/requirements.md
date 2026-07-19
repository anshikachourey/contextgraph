# Requirements Document

## Introduction

This spec defines the identity resolution subsystem of the Semantic Intelligence Engine (SIE). It covers how concern-cohesive Semantic_Packets are matched against existing Persistent_Concerns using identity continuity rather than lexical similarity, how retrieval sufficiency is assessed before declaring novelty, how adaptive widening expands retrieval scope when initial results are inadequate, and how dormant concerns are reactivated when evidence warrants.

The core principle: persistent concern identity outranks lexical similarity (SME-1), retrieval proposes candidates but never determines ownership (SME-2), and retrieval absence is not semantic absence (SME-3).

## Glossary

- **Identity_Resolution**: The process of determining which existing Persistent_Concern a Semantic_Packet most directly advances, revisits, decides, or corrects. Based on concern identity continuity, not lexical similarity.
- **Retrieval_Sufficiency_Gate**: A checkpoint that assesses whether retrieval returned adequate candidates before concluding that no matching Persistent_Concern exists. Distinguishes NO_MATCH from RETRIEVAL_INCONCLUSIVE.
- **Adaptive_Widening**: The process of expanding retrieval scope through multiple channels when the Retrieval_Sufficiency_Gate detects inadequacy signals.
- **Retrieval_Channel**: A specific method of searching for candidate concerns (e.g., embedding similarity, lexical match, alias lookup, dormant object scan, historical summary search, alias-normalized search, entity-based search, alternate query formulation).
- **Behavioral_Confidence_Band**: A stage-specific confidence classification (HIGH, MEDIUM, LOW) that directly determines pipeline behavior. Confidence from different pipeline stages is not comparable.
- **Pipeline_Outcome**: The graduated result of a pipeline stage: YES, NO, UNRESOLVED, DEFER, RETRIEVAL_INCONCLUSIVE, or REQUIRES_VALIDATION.
- **IRS_Signal**: An Identity Retrieval Sufficiency signal indicating potential retrieval inadequacy: IRS-1 (revisit language), IRS-2 (historical referent), IRS-3 (implied prior state), IRS-4 (broad-candidate mismatch), IRS-5 (alias/vocabulary drift), IRS-6 (continuation/history mismatch).
- **Dormant_Concern**: A Persistent_Concern with DORMANT status — not recently referenced but identity preserved and eligible for reactivation.

## Requirements

### Requirement 1: Primary Identity Resolution

**User Story:** As ContextGraph, I want each concern-cohesive Semantic_Packet to be matched against existing Persistent_Concerns using identity continuity rather than lexical similarity, so that the same real-world user concern retains the same identity regardless of how it is phrased across interactions.

#### Acceptance Criteria

1. WHEN a Semantic_Packet passes retention assessment with a level of SUPPORTING_EVIDENCE or higher, THE SIE_Pipeline SHALL perform identity resolution to determine which existing Persistent_Concern the packet most directly advances, revisits, decides, or corrects.
2. THE SIE_Pipeline SHALL determine identity based on persistent concern identity (SME-1) — the question is whether the packet addresses the SAME concern, not whether it uses similar words.
3. WHEN identity resolution produces a HIGH Behavioral_Confidence_Band match to an existing Persistent_Concern, THE SIE_Pipeline SHALL assign primary ownership to that concern.
4. WHEN identity resolution produces a MEDIUM Behavioral_Confidence_Band, THE SIE_Pipeline SHALL proceed to retrieval sufficiency assessment before concluding the match or declaring novelty.
5. WHEN identity resolution produces a LOW Behavioral_Confidence_Band, THE SIE_Pipeline SHALL NOT assign ownership and SHALL emit a Pipeline_Outcome of UNRESOLVED, persisting the packet in pending state for later reactivation.
6. THE SIE_Pipeline SHALL rank exact persistent concern match higher than broad topic compatibility (SME-5) — a packet about "my running schedule" matches the existing "running schedule" concern, not a broader "fitness goals" concern.
7. THE SIE_Pipeline SHALL treat temporal distance as irrelevant to identity — a user returning to a concern after extended absence retains the same concern identity (SME-8).
8. THE SIE_Pipeline SHALL treat state change as preserving identity — a user updating, correcting, or superseding material within a concern does NOT create a new concern (SME-9).
9. THE SIE_Pipeline SHALL treat retrieval as proposing candidates only — retrieval never determines ownership (SME-2).
10. THE SIE_Pipeline SHALL apply priority ordering: exact concern continuity > historical trajectory > future return path > scope compatibility > retrieval similarity.

### Requirement 2: Identity Retrieval Sufficiency Gates

**User Story:** As ContextGraph, I want the pipeline to assess whether retrieval returned adequate candidates before concluding that no matching concern exists, so that retrieval gaps never cause false novelty declarations — retrieval absence is not semantic absence (SME-3).

#### Acceptance Criteria

1. WHEN identity resolution does not find a HIGH confidence match among retrieved candidates, THE SIE_Pipeline SHALL assess retrieval sufficiency before concluding NO_MATCH.
2. THE Retrieval_Sufficiency_Gate SHALL distinguish between two outcomes: NO_MATCH (retrieval was adequate and no matching concern exists) and RETRIEVAL_INCONCLUSIVE (retrieval may have missed relevant concerns).
3. THE Retrieval_Sufficiency_Gate SHALL detect IRS signals indicating potential retrieval inadequacy: IRS-1 (revisit language suggesting return to prior topic), IRS-2 (historical referent implying prior discussion), IRS-3 (implied prior state suggesting existing concern), IRS-4 (broad-candidate mismatch where results are topically related but not identity matches), IRS-5 (alias/vocabulary drift where user employs new terms for existing concern), IRS-6 (continuation/history mismatch where packet implies continuation but no candidate shows history).
4. WHEN any IRS signal is detected with HIGH or MEDIUM confidence, THE SIE_Pipeline SHALL produce RETRIEVAL_INCONCLUSIVE rather than NO_MATCH.
5. WHEN the Retrieval_Sufficiency_Gate produces RETRIEVAL_INCONCLUSIVE, THE SIE_Pipeline SHALL trigger Adaptive_Widening before making any ownership decision.
6. WHEN the Retrieval_Sufficiency_Gate produces NO_MATCH with HIGH confidence (adequate search, diverse channels, no plausible candidates, no IRS signals detected), THE SIE_Pipeline SHALL proceed with new concern creation for packets classified at INDEPENDENT_CONCERN retention level.
7. THE Retrieval_Sufficiency_Gate SHALL evaluate adequacy based on multiple signals (channel diversity, result density, query-result semantic alignment) rather than a single retrieval score threshold.
8. THE SIE_Pipeline SHALL NOT treat retrieval rank as ownership determination — retrieval proposes candidates, identity resolution determines ownership (SME-2).

### Requirement 3: Adaptive Identity Widening

**User Story:** As ContextGraph, I want the pipeline to expand retrieval scope through multiple channels when initial retrieval is insufficient, so that dormant, aliased, or historically distant concerns are found before the system incorrectly creates duplicates.

#### Acceptance Criteria

1. WHEN the Retrieval_Sufficiency_Gate produces RETRIEVAL_INCONCLUSIVE, THE SIE_Pipeline SHALL initiate Adaptive_Widening to expand retrieval scope.
2. THE Adaptive_Widening stage SHALL employ multiple Retrieval_Channels including but not limited to: larger embedding window, dormant object scan, historical summary search, alias-normalized search, lexical/entity match, older temporal regions, and alternate query formulation.
3. THE SIE_Pipeline SHALL NOT require a fixed minimum number of retrieval channels — the appropriate channels depend on the inadequacy signals detected by the sufficiency gate.
4. WHEN Adaptive_Widening discovers a candidate that was missed by initial retrieval, THE SIE_Pipeline SHALL return the candidate to identity resolution for standard confidence assessment.
5. WHEN Adaptive_Widening exhausts available channels without finding plausible candidates, THE SIE_Pipeline SHALL upgrade the sufficiency assessment to NO_MATCH and proceed accordingly.
6. THE Adaptive_Widening stage SHALL specifically scan dormant concerns — a concern's DORMANT status does not exclude it from identity matching (SME-8).
7. WHEN Adaptive_Widening produces candidates with MEDIUM confidence, THE SIE_Pipeline SHALL prefer DEFER over forced assignment — structural uncertainty reduces structural commitment (SME-26).
8. THE Adaptive_Widening stage SHALL select channels based on which IRS signals triggered the RETRIEVAL_INCONCLUSIVE outcome — IRS-5 (alias drift) suggests alias-normalized search, IRS-2 (historical referent) suggests historical summary and older region search.

### Requirement 4: Dormant Concern Reactivation

**User Story:** As ContextGraph, I want concerns that have been dormant for extended periods to be reactivated when the user returns to them, so that identity continuity is preserved regardless of temporal distance and users never encounter duplicate concerns for topics they discussed previously.

#### Acceptance Criteria

1. WHEN identity resolution or Adaptive_Widening matches a Semantic_Packet to a Persistent_Concern with DORMANT status, THE SIE_Pipeline SHALL reactivate the concern by transitioning its status to ACTIVE.
2. WHEN a dormant concern is reactivated, THE SIE_Pipeline SHALL preserve all existing propositions, evidence, and mutation history — reactivation adds to the concern, never resets it.
3. THE SIE_Pipeline SHALL treat temporal distance as irrelevant to reactivation eligibility — a concern dormant for any duration remains a valid identity match target (SME-8).
4. WHEN a dormant concern is reactivated, THE SIE_Pipeline SHALL update the last-active timestamp and record the reactivation event in the concern's mutation history.
5. THE SIE_Pipeline SHALL include dormant concerns in standard retrieval candidate sets — DORMANT status does not filter a concern from retrieval results.
6. WHEN multiple dormant concerns are potential matches, THE SIE_Pipeline SHALL apply the same identity resolution logic (exact concern continuity > historical trajectory > scope compatibility) rather than preferring the most recently active dormant concern.
7. WHEN an UNRESOLVED packet from a prior pipeline run is later matched to a dormant concern through new evidence, THE SIE_Pipeline SHALL resolve the pending state and assign ownership to the reactivated concern.
