# Identity Resolution SMT Evaluation Suite

Labeled evaluation cases for the SIE identity-resolution subsystem, covering
Requirement 12 acceptance criteria.

## Evaluation Domains

Cases intentionally include domains **absent** from development examples:
- Agriculture / crop management
- Classical music composition
- Maritime logistics
- Clinical trial coordination
- Competitive gaming / esports

Development domains already covered (for representative cases):
- Software architecture (ContextGraph itself)
- Machine learning / model selection

## Case ID Convention

`IRID-NNN` — Identity Resolution Identity Decision

## Coverage Categories (Requirement 12.2)

| Category | Cases |
|----------|-------|
| Same vocabulary / different identity | IRID-001 |
| Different vocabulary / same identity | IRID-002 |
| Dormant return | IRID-003 |
| Retired reopening | IRID-004 |
| Merge redirect | IRID-005 |
| Parent-vs-child ambiguity | IRID-006 |
| Duplicate concerns | IRID-007 |
| Multiple competitive candidates | IRID-008 |
| Assistant-generated material | IRID-009 |
| Extraction correction | IRID-010 |
| Channel failure | IRID-011 |
| Pending reactivation | IRID-012 |
| State evolution without identity change | IRID-013 |

## Case Attributes

Each case is labeled with:
- `category`: The semantic scenario being tested
- `domain`: The conversational domain (representative, adversarial, domain-diverse)
- `length`: `short` or `long` (message count)
- `difficulty`: `representative`, `adversarial`, or `multilingual`
- `expectedOutcome`: The ground-truth identity outcome
- `expectedAction`: The ground-truth action
- `qualityMetrics`: Which Req 12.3 metrics this case contributes to

## Scoring

Cases that produce the wrong outcome contribute to error metrics:
- `false_assignment` — incorrectly assigned to wrong existing concern
- `false_novelty` — incorrectly declared new when match exists
- `missed_reactivation` — failed to reactivate dormant/retired
- `unresolved_defer_calibration` — over/under use of UNRESOLVED/DEFER
- `retrieval_sufficiency_error` — declared adequate when not, or vice versa
- `retry_version_determinism` — non-deterministic across retries

## Integration with Existing Harness

These cases extend the `contextgraph-eval-harness-v1` format with
identity-resolution-specific fields. They can be loaded by the same
fixture loader infrastructure.
