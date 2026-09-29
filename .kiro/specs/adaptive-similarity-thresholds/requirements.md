# Requirements Document

## Introduction

The knowledge graph decides whether two nodes are related by comparing the cosine similarity of their embeddings against two edge thresholds: a strongly-related threshold and a possibly-related threshold. Today these thresholds are fixed compile-time constants (0.7 and 0.6) that do not adapt to the actual distribution of a given dataset's embedding scores.

This feature adds the ability to calibrate these two thresholds from the geometry of existing node embeddings so they reflect the real data distribution. Calibration is a deterministic, offline, statistics-only procedure derived purely from pairwise similarity scores. It runs only when explicitly triggered through a debug-gated endpoint, produces a single global calibration value, and persists the result. The overriding guarantee is revert-to-safe: whenever the data does not clearly justify new thresholds, the system keeps the existing compile-time constants and behaves exactly as it does today.

### Locked Scope (not reopened by these requirements)

- Calibrates only the two main edge thresholds (strongly-related, possibly-related). Topic-shift thresholds and all other configuration are out of scope.
- Global scope only — one calibration value shared across the whole system. No per-workspace or per-user calibration.
- Recompute occurs only on explicit trigger via a debug-gated endpoint. Never on user requests, never on a schedule, never automatically during chat or graph flows.
- No user labels, no confirmed/rejected feedback, no experimentation on users. Calibration is derived purely from embedding score geometry.
- No LLM involvement — deterministic statistics only.
- No human-facing histogram/distribution endpoint — separability is a self-check inside the code.

## Glossary

- **Node**: A knowledge graph entity that may carry an embedding vector.
- **Embedding**: The numeric vector representation associated with a Node.
- **Pairwise_Similarity_Score**: The cosine similarity between the embeddings of two distinct Nodes.
- **Strongly_Related_Threshold**: The similarity value at or above which two Nodes are considered strongly related.
- **Possibly_Related_Threshold**: The similarity value at or above which (but below the Strongly_Related_Threshold) two Nodes are considered possibly related.
- **Edge_Thresholds**: The pair consisting of the Strongly_Related_Threshold and the Possibly_Related_Threshold currently in effect.
- **Compile_Time_Constants**: The fixed default thresholds defined in code (strongly-related = 0.7, possibly-related = 0.6) used as the safe fallback.
- **Calibration_Engine**: The deterministic, pure, offline component that derives candidate thresholds from Pairwise_Similarity_Scores and decides whether to apply or revert.
- **Calibration_Result**: The output of the Calibration_Engine, including the effective thresholds, an applied/reverted decision, and provenance diagnostics.
- **Calibration_Store**: The persistence layer holding a single global Calibration_Result row.
- **Threshold_Accessor**: The single accessor callers use to resolve the Edge_Thresholds currently in effect.
- **Calibration_Endpoint**: The debug-gated HTTP endpoint that reports the current calibration (GET) and triggers a recompute (POST).
- **Debug_Access_Guard**: The access control check that gates the Calibration_Endpoint.
- **Bimodality_Coefficient**: Sarle's bimodality coefficient computed over the Pairwise_Similarity_Scores, used to judge separability.
- **Valley_Score**: The Pairwise_Similarity_Score at the deepest anti-mode between the two dominant peaks of the score histogram.
- **Edge_Suggestion_Flow**: The runtime process that selects candidate edges and computes suggested edges using the Edge_Thresholds.

## Requirements

### Requirement 1: Safe default behavior

**User Story:** As a graph maintainer, I want the system to behave exactly as it does today unless a calibration was explicitly applied, so that adding calibration never silently changes existing edge behavior.

#### Acceptance Criteria

1. WHEN the Threshold_Accessor is queried and no Calibration_Result has ever been persisted, THE Threshold_Accessor SHALL return the Compile_Time_Constants for both the strongly-related and possibly-related Edge_Thresholds.
2. WHEN the Threshold_Accessor is queried and the most recently persisted Calibration_Result records a reverted decision, THE Threshold_Accessor SHALL return the Compile_Time_Constants for both the strongly-related and possibly-related Edge_Thresholds.
3. WHEN the Threshold_Accessor is queried and the most recently persisted Calibration_Result records an applied decision, THE Threshold_Accessor SHALL return the strongly-related and possibly-related Edge_Thresholds stored in that Calibration_Result.
4. WHEN the Threshold_Accessor returns the Compile_Time_Constants, THE Threshold_Accessor SHALL return a calibration-status indicator whose value denotes not-calibrated.
5. WHEN the Threshold_Accessor returns the stored applied Edge_Thresholds, THE Threshold_Accessor SHALL return a calibration-status indicator whose value denotes calibrated.
6. IF the most recently persisted Calibration_Result cannot be read or fails integrity validation, THEN THE Threshold_Accessor SHALL return the Compile_Time_Constants with a calibration-status indicator whose value denotes not-calibrated.

### Requirement 2: Fail-safe threshold reads

**User Story:** As a graph maintainer, I want threshold resolution to never break edge suggestions, so that a calibration or database problem can never degrade or halt normal graph flows.

#### Acceptance Criteria

1. IF reading the Calibration_Store fails for any reason, THEN THE Threshold_Accessor SHALL return the Compile_Time_Constants as the Edge_Thresholds value.
2. IF reading the Calibration_Store fails for any reason, THEN THE Threshold_Accessor SHALL record a log entry indicating that the Calibration_Store read failed and that the Compile_Time_Constants were used as a fallback.
3. THE Threshold_Accessor SHALL return an Edge_Thresholds value to the Edge_Suggestion_Flow without propagating an error to the Edge_Suggestion_Flow.
4. WHEN the Edge_Suggestion_Flow requires Edge_Thresholds, THE Edge_Suggestion_Flow SHALL resolve them through the Threshold_Accessor.
5. IF reading the Calibration_Store does not complete within 500 milliseconds, THEN THE Threshold_Accessor SHALL abandon the read, return the Compile_Time_Constants as the Edge_Thresholds value, and record a log entry indicating a Calibration_Store read timeout.
6. IF the value read from the Calibration_Store is missing, malformed, or outside the valid Edge_Thresholds range, THEN THE Threshold_Accessor SHALL return the Compile_Time_Constants as the Edge_Thresholds value and record a log entry indicating an invalid Calibration_Store value.

### Requirement 3: Explicitly-triggered calibration only

**User Story:** As a graph maintainer, I want calibration to run only when I explicitly ask for it, so that the expensive computation never runs on normal request paths or on a schedule.

#### Acceptance Criteria

1. WHEN a recompute request is received at the Calibration_Endpoint, THE Calibration_Engine SHALL compute a new Calibration_Result and persist it as the stored Calibration_Result before returning a response.
2. IF a recompute request received at the Calibration_Endpoint fails to complete computation, THEN THE Calibration_Engine SHALL retain the previously stored Calibration_Result unchanged and return a response indicating computation failure.
3. WHILE the system handles chat, graph, or edge-suggestion requests, THE Calibration_Engine SHALL NOT compute a new Calibration_Result.
4. THE Calibration_Engine SHALL compute a new Calibration_Result only in response to a recompute request received at the Calibration_Endpoint, and SHALL NOT compute a new Calibration_Result on any time-based schedule or automatic trigger.
5. WHEN Edge_Thresholds are resolved for the Edge_Suggestion_Flow, THE Threshold_Accessor SHALL read the stored Calibration_Result without computing Pairwise_Similarity_Scores.
6. IF no stored Calibration_Result exists WHEN Edge_Thresholds are resolved for the Edge_Suggestion_Flow, THEN THE Threshold_Accessor SHALL return the Compile_Time_Constants without triggering the Calibration_Engine to compute one.

### Requirement 4: Access-gated calibration endpoint

**User Story:** As a system operator, I want the calibration endpoint to be access-controlled, so that arbitrary callers cannot inspect or trigger calibration.

#### Acceptance Criteria

1. IF a request to the Calibration_Endpoint does not satisfy the Debug_Access_Guard, THEN THE Calibration_Endpoint SHALL reject the request without invoking the Calibration_Engine, without returning any Edge_Thresholds or Calibration_Result, and SHALL return a response indicating access is denied.
2. WHEN a request to report the current calibration satisfies the Debug_Access_Guard, THE Calibration_Endpoint SHALL return the effective Edge_Thresholds and the applied-or-reverted status, leaving the effective Edge_Thresholds unchanged.
3. WHEN a recompute request satisfies the Debug_Access_Guard, THE Calibration_Endpoint SHALL invoke the Calibration_Engine and return the Calibration_Result within 30 seconds.
4. IF a recompute request satisfies the Debug_Access_Guard but the calibration computation raises an error, THEN THE Calibration_Endpoint SHALL return an error response indicating the computation failed, SHALL leave the effective Edge_Thresholds unchanged, and SHALL log the error.
5. IF the calibration computation does not complete within 30 seconds, THEN THE Calibration_Endpoint SHALL return an error response indicating a timeout and SHALL leave the effective Edge_Thresholds unchanged.
6. IF a request satisfies the Debug_Access_Guard but does not specify a recognized report or recompute operation, THEN THE Calibration_Endpoint SHALL reject the request without invoking the Calibration_Engine and SHALL return an error response indicating the request is invalid.

### Requirement 5: Deterministic, offline, statistics-only calibration

**User Story:** As a graph maintainer, I want calibration derived purely from embedding score geometry using deterministic statistics, so that results are reproducible and free of model or user-signal influence.

#### Acceptance Criteria

1. THE Calibration_Engine SHALL derive the Calibration_Result solely from the Pairwise_Similarity_Scores of the set of distinct unordered pairs of Nodes that have an embedding.
2. WHEN the Calibration_Engine runs more than once on the same set of embeddings, THE Calibration_Engine SHALL produce a Calibration_Result with identical applied-or-reverted decision, identical threshold values, and identical provenance diagnostics.
3. WHEN the Calibration_Engine runs on the same set of embeddings presented in a different order, THE Calibration_Engine SHALL produce a Calibration_Result identical to the result for any other ordering of that set.
4. THE Calibration_Engine SHALL exclude any Node without an embedding from the set of pairs used to compute Pairwise_Similarity_Scores.
5. THE Calibration_Engine SHALL derive the Calibration_Result without reading any user labels or confirmed-or-rejected feedback signals.
6. THE Calibration_Engine SHALL derive the Calibration_Result without invoking any language model.
7. WHEN the Calibration_Engine completes a run, THE input Nodes and their Embeddings SHALL remain unchanged from their state before the run.

### Requirement 6: Minimum-data guard (revert to safe)

**User Story:** As a graph maintainer, I want calibration to refuse when there is too little data, so that thresholds are never derived from statistically meaningless samples.

#### Acceptance Criteria

1. IF the count of Nodes with embeddings is strictly less than the minimum node count of 20, THEN THE Calibration_Engine SHALL revert the active thresholds to the Compile_Time_Constants and record a reverted decision that identifies the observed Node count and the minimum node count of 20.
2. IF the count of Pairwise_Similarity_Scores is strictly less than the minimum pair count of 100, THEN THE Calibration_Engine SHALL revert the active thresholds to the Compile_Time_Constants and record a reverted decision that identifies the observed Pairwise_Similarity_Scores count and the minimum pair count of 100.
3. WHEN the Calibration_Engine reverts for insufficient data, THE Calibration_Engine SHALL record a reason identifying which minimum was not met (node count, pair count, or both) and the corresponding observed and required counts.
4. WHILE the active thresholds are reverted to the Compile_Time_Constants due to insufficient data, THE Calibration_Engine SHALL apply the Compile_Time_Constants as the effective thresholds and SHALL NOT apply any calibrated thresholds derived from the insufficient sample.

### Requirement 7: Separability guard (revert to safe)

**User Story:** As a graph maintainer, I want calibration to refuse when the score distribution is a single blob, so that thresholds are only derived when related and unrelated pairs are genuinely distinguishable.

#### Acceptance Criteria

1. WHEN at least the minimum pair count of Pairwise_Similarity_Scores is available, THE Calibration_Engine SHALL compute the Bimodality_Coefficient of the scores.
2. IF the Bimodality_Coefficient is strictly below the minimum bimodality coefficient of 0.555, THEN THE Calibration_Engine SHALL revert to the Compile_Time_Constants and record a reverted decision.
3. IF the Bimodality_Coefficient is at or above the minimum bimodality coefficient of 0.555 but no Valley_Score exists (no local minimum in score density separating the two highest-density score peaks), THEN THE Calibration_Engine SHALL revert to the Compile_Time_Constants and record a reverted decision.
4. WHEN the Calibration_Engine reverts for non-separable data, THE Calibration_Engine SHALL record the computed Bimodality_Coefficient as provenance.

### Requirement 8: Derived thresholds and range guard (revert to safe)

**User Story:** As a graph maintainer, I want derived thresholds to be sane and correctly ordered, so that calibration can never install absurd or inverted thresholds.

#### Acceptance Criteria

1. WHEN a Valley_Score is found, THE Calibration_Engine SHALL set the candidate possibly-related threshold to the Valley_Score.
2. WHEN a Valley_Score is found and at least one Pairwise_Similarity_Score is at or above the Valley_Score, THE Calibration_Engine SHALL set the candidate strongly-related threshold to the arithmetic mean of the Pairwise_Similarity_Scores at or above the Valley_Score.
3. IF no Valley_Score is found, THEN THE Calibration_Engine SHALL revert to the Compile_Time_Constants and record a reverted decision indicating that no Valley_Score was found.
4. IF the candidate possibly-related threshold is less than 0.3 or greater than 0.85, THEN THE Calibration_Engine SHALL revert to the Compile_Time_Constants and record a reverted decision indicating the candidate possibly-related threshold was out of range.
5. IF the candidate strongly-related threshold is less than or equal to the candidate possibly-related threshold, THEN THE Calibration_Engine SHALL revert to the Compile_Time_Constants and record a reverted decision indicating the candidate thresholds were not correctly ordered.
6. IF the candidate strongly-related threshold is greater than 0.98, THEN THE Calibration_Engine SHALL revert to the Compile_Time_Constants and record a reverted decision indicating the candidate strongly-related threshold was out of range.
7. WHEN a Valley_Score is found and no Pairwise_Similarity_Score is at or above the Valley_Score, THE Calibration_Engine SHALL revert to the Compile_Time_Constants and record a reverted decision.
8. WHEN a Valley_Score is found and the candidate thresholds satisfy the range checks (criteria 4, 5, and 6), THE Calibration_Engine SHALL record an applied decision with the derived possibly-related and strongly-related thresholds as the effective thresholds.

### Requirement 9: Global singleton persistence with provenance

**User Story:** As a graph maintainer, I want each calibration outcome persisted as a single global record with diagnostics, so that the current decision is auditable and shared system-wide.

#### Acceptance Criteria

1. WHEN a Calibration_Result is produced, THE Calibration_Store SHALL persist it by replacing the single global record in place so that exactly one global record remains.
2. THE Calibration_Store SHALL hold at most one global calibration record at any time.
3. WHEN a Calibration_Result records a reverted decision, THE Calibration_Store SHALL store threshold values equal to the Compile_Time_Constants and record the reverted status.
4. WHEN a Calibration_Result records an applied decision, THE Calibration_Store SHALL store the derived threshold values and record the applied status.
5. WHEN a Calibration_Result is persisted, THE Calibration_Store SHALL store the node count, sample pair count, bimodality coefficient, valley score, reason, and computation time as provenance.
6. THE Calibration_Store SHALL reject any stored record in which the strongly-related value is less than the possibly-related value.
7. THE Calibration_Store SHALL persist only calibration output and provenance, and SHALL NOT persist embeddings, user content, or per-pair scores.
8. IF persisting a Calibration_Result fails, THEN THE Calibration_Store SHALL leave the previously stored global record unchanged and surface the failure to the caller.

### Requirement 10: Reporting the current calibration

**User Story:** As a graph maintainer, I want to inspect the current calibration state, so that I can confirm which thresholds are in effect and why.

#### Acceptance Criteria

1. WHEN a report request satisfies the Debug_Access_Guard and no Calibration_Result has been persisted, THE Calibration_Endpoint SHALL report that the Compile_Time_Constants are in effect and that no calibration has been computed.
2. WHEN a report request satisfies the Debug_Access_Guard and a persisted Calibration_Result exists, THE Calibration_Endpoint SHALL report the effective Edge_Thresholds, the applied-or-reverted status, the reason, and the computation time.
3. IF a report request satisfies the Debug_Access_Guard but reading the persisted Calibration_Result fails, THEN THE Calibration_Endpoint SHALL report that the Compile_Time_Constants are in effect and SHALL log the read failure.
