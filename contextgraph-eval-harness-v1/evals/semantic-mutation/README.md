# ContextGraph Eval Harness Contract v1

This package converts SMT-001 through SMT-010 into canonical, repo-owned evaluation fixtures.

## Freeze point

The semantic policy under test is:

`ContextGraph Object Decision & Semantic Mutation Algorithm — Candidate v1`

The harness treats the following as implementation clarifications, not new semantic laws:

1. Resolve a `primaryObject` whether the packet maps to an existing identity or proposes a new object.
2. A relationship target is not automatically a cross-object state mutation. Cross-object impact requires the packet to materially change that secondary object's own persistent state.
3. Canonical Parent Resolution may abstain when multiple valid parents remain genuinely unresolved; structural uncertainty yields less structure.
4. One primary concern per Semantic Packet remains an invariant under adversarial evaluation rather than an unquestionable axiom.

## Directory layout

- `evals/semantic-mutation/golden/` — 10 manually solved golden SMT fixtures.
- `evals/semantic-mutation/variants/` — 30 metamorphic variant descriptors.
- `evals/semantic-mutation/schema/` — canonical fixture schema.
- `evals/semantic-mutation/scorers/` — deterministic scoring contract.

## Evaluation layers

### Layer 1 — Semantic Packet evals
Input: conversation exchange.
Checks: packet meaning, user evidence IDs, assistant context IDs, operative intent.

### Layer 2 — Retrieval evals
Input: Semantic Packet + graph.
Checks: identity Recall@K, dormant identity recall, parent Recall@K, widening triggers.

### Layer 3 — Semantic decision evals
Input: Semantic Packet + gold candidate set.
Checks: primary object, cross-object impacts, canonical parent, relationships, supersession.

### Layer 4 — Mutation assembly tests
Input: gold semantic decisions.
Checks: exact SemanticMutationSet construction.

### Layer 5 — Deterministic validators
Checks: one parent maximum, no cycles, no self-parent, no duplicate edges, valid provenance, valid IDs.

### Layer 6 — End-to-end SMTs
Runs the entire pipeline and uses the same fixture expectations.

## Individual golden-case pass rule

A case passes only if:

- every critical assertion passes;
- forbidden outcome violations = 0;
- structural invariant violations = 0.

Aggregate percentages are useful for diagnosis, but they do not override a failed golden case.

## Metamorphic testing

Each golden SMT currently has three variants. Variants should be applied as patches/transformations to the base fixture. They test invariance under:

- retrieval-rank changes;
- paraphrases and vocabulary drift;
- temporal gaps;
- distractor injection;
- alias changes;
- child-count changes;
- continuation-origin changes;
- clause-order changes;
- non-contiguous emergence;
- pre-existing semantic relationships.

## Model bake-off protocol

1. Use the exact same Candidate v1 constitution and structured-output schema for every model.
2. Pin model versions where the provider allows it.
3. Run each of the 10 golden cases 3 times per model/configuration.
4. Use isolated prompts; no cross-case conversational memory.
5. Record raw output, parsed output, trace, latency, token usage, and cost.
6. Score deterministically first.
7. Run the 30 metamorphic variants once on all models.
8. Re-run failed or unstable variants 3 times on the top two models.
9. Select the provisional semantic model using:
   - golden pass rate;
   - zero structural-invariant violations;
   - zero forbidden-outcome violations on golden cases;
   - repeat-run consistency;
   - variant robustness;
   - latency and cost as secondary criteria.

Do not use an LLM judge for deterministic object IDs, mutation types, parent IDs, widening flags, or forbidden outcomes. Human or LLM semantic grading should be reserved for genuinely fuzzy fields such as generated natural-language descriptions.

## Suggested implementation order

1. Add fixture loader.
2. Add deterministic scorer library.
3. Add component runners:
   - packet runner;
   - retrieval runner;
   - semantic-decision runner;
   - mutation-assembly runner;
   - end-to-end runner.
4. Add model adapter interface.
5. Run bake-off.
6. Freeze the winning provisional semantic model/configuration.
7. Implement the Semantic Mutation Engine against the same fixtures.
8. Make the benchmark a regression gate in CI.

## Exit gate before engine implementation

The pre-implementation semantic phase is complete when:

- Candidate v1 is frozen;
- all 10 golden fixtures are encoded;
- all 30 metamorphic variants are encoded;
- scorer contract is implemented;
- model bake-off is run;
- a provisional semantic model is selected;
- no unresolved constitutional contradiction remains in SMT-001 through SMT-010.

The additional SMT-011 through SMT-030 cases can then grow alongside implementation as regression coverage rather than blocking the first engine implementation.
