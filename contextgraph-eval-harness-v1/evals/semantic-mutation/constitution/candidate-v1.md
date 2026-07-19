# ContextGraph Object Decision & Semantic Mutation Algorithm

## Evidence-Driven Revision — Candidate v1

This revision incorporates the findings of SMT-001 through SMT-010.

The underlying semantic constitution remains unchanged.

The revision adds five operational mechanisms:

1. Semantic retrieval sufficiency gates.
2. Canonical Parent Resolution.
3. Primary Identity + Cross-Object Impact Analysis.
4. Longitudinal Sub-Concern Emergence.
5. Conservative Structural Restructuring.

---

# 1. Revised Semantic Execution Pipeline

```text
SEMANTIC PACKET
        │
        ▼
0. DURABLE SEMANTIC SIGNIFICANCE
        │
        ├── no durable significance
        │       ↓
        │   NO_GRAPH_MUTATION
        │
        ▼
1. INITIAL IDENTITY RETRIEVAL
        │
        ▼
2. PRIMARY IDENTITY RESOLUTION
        │
        ├── precise SAME identity found
        │       ↓
        │   EXTEND / REOPEN
        │
        └── no SAME found
                ↓
3. IDENTITY RETRIEVAL SUFFICIENCY
        │
        ├── insufficient
        │       ↓
        │   WIDEN IDENTITY SEARCH
        │       ↓
        │   RE-RUN IDENTITY RESOLUTION
        │
        └── sufficient, still no SAME
                ↓
            NEW IDENTITY
        │
        ▼
4. LONGITUDINAL SUB-CONCERN ANALYSIS
        │
        ├── same concern
        │       ↓
        │     EXTEND
        │
        ├── emerging narrower concern
        │       ↓
        │     EXTEND
        │     + ACCUMULATE EMERGENCE EVIDENCE
        │
        └── established narrower concern
                ↓
            PROMOTE / CREATE CHILD
        │
        ▼
5. PARENT CANDIDATE RETRIEVAL
   (for new identities requiring placement)
        │
        ▼
6. PARENT ASSESSMENT
        │
        ├── no valid parent found
        │       ↓
        │   STRUCTURAL RETRIEVAL SUFFICIENCY
        │       │
        │       ├── insufficient
        │       │      ↓
        │       │   WIDEN STRUCTURAL SEARCH
        │       │      ↓
        │       │   RE-RUN PARENT ASSESSMENT
        │       │
        │       └── sufficient
        │              ↓
        │       STRUCTURAL PARENT = NONE
        │
        └── one or more valid parents
                ↓
7. CANONICAL PARENT RESOLUTION
                ↓
          ONE STRUCTURAL PARENT
        │
        ▼
8. CROSS-OBJECT IMPACT ANALYSIS
        │
        ▼
9. RELATIONSHIP ANALYSIS
        │
        ▼
10. STATE / SUPERSESSION ANALYSIS
        │
        ▼
11. RESTRUCTURING SIGNAL DETECTION
        │
        ├── possible duplicate
        ├── possible merge
        └── possible reparent
        │
        ▼
12. ASSEMBLE SEMANTIC MUTATION SET
        │
        ▼
13. DETERMINISTIC VALIDATION
        │
        ▼
14. VERSIONED GRAPH COMMIT
```

---

# 2. Primary Identity Resolution

Every Semantic Packet may have one **primary persistent concern**.

Primary identity answers:

> Which persistent concern most directly represents what the user is currently advancing, revisiting, deciding, correcting, or developing?

This does not mean only one object may be affected.

It means there is a distinction between:

```text
PRIMARY SEMANTIC OWNERSHIP
```

and:

```text
SECONDARY OBJECT IMPACT
```

Example:

```text
"I'll only move to Mumbai if the Netflix role works out."
```

Primary identity:

```text
Potential Move to Mumbai
```

Secondary impacted object:

```text
Netflix Marketing Opportunity
```

The packet may therefore produce:

```text
EXTEND Mumbai Move
+
EXTEND Netflix Opportunity
+
ADD_RELATIONSHIP
+
SUPERSEDE prior move state
```

without pretending both objects are equally the primary semantic owner.

---

# 3. Exact Identity Resolution Rule

When multiple objects can accommodate a packet, select the object representing the most precise existing persistent concern.

Priority:

```text
1. Exact persistent concern continuity

2. Exact historical trajectory continuity

3. Most precise coherent future return path

4. Semantic scope compatibility

5. Retrieval similarity / recency / evidence volume
```

The last category may support retrieval.

It must not override the first four.

Constitutional rule:

> A broad parent's ability to contain a packet does not make the parent the SAME object when a more precise existing object already owns the persistent concern.

This operationalizes SMT-001 and SMT-003.

---

# 4. Identity Retrieval Sufficiency

If no confident SAME identity is found, the engine must decide whether:

```text
NO SAME IDENTITY EXISTS
```

or:

```text
NO SAME IDENTITY HAS BEEN FOUND YET
```

Identity retrieval is semantically insufficient when strong evidence suggests an unseen historical identity may exist.

## Identity Recall Warning Signals

### IRS-1 — Explicit revisit language

Examples:

```text
again
back to
another shot
reconsidering
returning to
still
we talked about this before
I had put that aside
I used to
```

---

### IRS-2 — Historical referent

Examples:

```text
that idea
that issue
the thing we discussed
the old plan
what we decided earlier
```

when the referent is not adequately represented by retrieved objects.

---

### IRS-3 — Implied prior state

The packet semantically implies:

```text
concern existed before
↓
became dormant
↓
is active again
```

but no matching historical identity was retrieved.

---

### IRS-4 — Broad-candidate mismatch

The retrieved set contains several broad or adjacent objects but no object that precisely explains the packet's persistent concern.

---

### IRS-5 — Alias or vocabulary drift

Examples:

```text
Mumbai ↔ Bombay

AI model ↔ classifier

incremental processor ↔ update engine
```

when identity may be hidden by changed vocabulary.

---

### IRS-6 — Continuation/history mismatch

Current conversational context implies prior discussion not explained by retrieved identities.

---

## Identity Retrieval Decision

If strong warning signals exist:

```text
WIDEN_IDENTITY_SEARCH
```

Widen through multiple channels:

```text
larger embedding retrieval

dormant/inactive objects

historical identity summaries

alias-normalized retrieval

lexical/entity retrieval

older conversation regions

alternate semantic query formulation
```

Critical law:

> Failure to retrieve an existing identity is not evidence that the identity does not exist.

---

# 5. Longitudinal Sub-Concern Emergence

Sub-concern emergence must be evaluated across time.

The semantic state progression is:

```text
NO DISTINCT SUB-CONCERN
        ↓
EMERGING SUB-CONCERN
        ↓
ESTABLISHED CHILD
```

A concern may accumulate evidence across non-contiguous episodes.

Conversation interruption does not reset emergence.

---

## Emergence Evidence Record

The exact persistence implementation remains open.

Semantically, the engine must be able to access:

```text
candidate concern meaning

supporting proposition IDs

episodes in which it appeared

distinct questions

distinct constraints

distinct alternatives

independent decisions

focused returns

evidence of independent state trajectory
```

This may later be implemented through:

```text
parent semantic state

proposition/thread history

decision traces

or another lightweight mechanism
```

No separate `EmergingSubconcern` database entity is required by the Constitution.

---

## Promotion Threshold

Promotion requires:

```text
STRICT CONTAINMENT
+
INDEPENDENT RETURNABILITY
+
CREDIBLE AUTONOMY
```

The engine must avoid:

```text
one narrow question
→ immediate child
```

and:

```text
non-contiguous discussion
→ evidence forgotten forever
```

---

## Historical Evidence After Promotion

When a concern becomes a child:

```text
CREATE CHILD B
```

earlier propositions that contributed to B may become semantic evidence for B.

But original conversational provenance remains immutable.

Therefore both may be true:

```text
The proposition originally occurred
while Parent A was the active semantic home.

AND

The proposition is now recognized as evidence
for Child B's persistent concern.
```

Historical provenance is never rewritten.

---

# 6. Structural Parent Retrieval Sufficiency

After establishing a genuinely new identity, failure to find a valid parent does not immediately prove the object is a root.

Ask:

> Does the candidate parent set adequately represent the defining semantic problem, purpose, and scope of the new concern?

Structural recall may be insufficient when:

```text
the new concern has a defining constraint
not represented by any candidate

the retrieved parents explain HOW
but fail to represent WHY the concern exists

all candidates are broad or adjacent

the packet clearly belongs to a known semantic domain
but no domain-level object was retrieved

a more precise historical parent may be dormant
```

If structural recall is doubtful:

```text
WIDEN_STRUCTURAL_SEARCH
```

Possible widening:

```text
ancestor expansion

broader-scope object retrieval

dormant parent objects

project-level object retrieval

semantic-scope query

aliases

historical structural objects
```

Critical law:

> Failure to retrieve the correct parent is not evidence that no parent exists.

---

# 7. Canonical Parent Resolution

Each object may have at most one canonical structural parent.

A parent may have any number of children.

When exactly one valid containing parent exists:

```text
select it
```

When multiple valid containing parents exist, evaluate canonical semantic home.

---

## Canonical Parent Criteria

For child C and valid parents A and B, evaluate:

### CPR-1 — Identity-defining containment

Which parent most directly contains the persistent concern that makes C the object it is?

---

### CPR-2 — Context-loading coherence

If the user returns specifically to C months later, which parent provides the most necessary surrounding context for coherent continuation?

---

### CPR-3 — Primary semantic scope

Which parent represents C's main conceptual domain rather than a secondary mechanism, dependency, constraint, or implementation effect?

---

### CPR-4 — Historical development

Within which concern did C's identity principally develop?

This is supporting evidence only.

Conversational origin alone is not decisive.

---

### CPR-5 — Counterfactual identity test

Ask separately:

```text
If Parent A's concern disappeared,
would C remain substantially the same concern?

If Parent B's concern disappeared,
would C remain substantially the same concern?
```

The parent whose removal more fundamentally changes C's identity may be the stronger canonical home.

This is evidence, not an automatic universal law.

---

## Canonical Parent Decision

Choose:

> The most specific valid container that best represents the object's primary semantic home and gives the most coherent focused return path.

Do not use:

```text
highest embedding score

most recent object

largest object

first retrieved candidate
```

as decisive criteria.

If ambiguity remains substantial:

```text
prefer less structural commitment
```

rather than confidently selecting a false parent.

The unselected valid concern may still receive a semantic relationship if independently warranted.

---

# 8. Cross-Object Impact Analysis

After primary identity resolution, ask:

> Which other existing objects have their persistent state materially changed by this packet?

This layer is independent from primary ownership.

Possible outcomes:

```text
NONE

EXTEND secondary object

REOPEN secondary object

UPDATE secondary object state
```

An object qualifies as materially impacted when the packet changes something durable about:

```text
its role

its current importance

its constraints

its decision state

its dependency structure

its progress/status
```

Mere mention is insufficient.

---

## Example

Packet:

```text
"I'll only move to Mumbai if the Netflix role works out."
```

Primary:

```text
Potential Move to Mumbai
```

Cross-object impact:

```text
Netflix Opportunity
```

because the job changes from:

```text
interesting opportunity
```

to:

```text
decisive condition for relocation
```

Mutation:

```text
EXTEND both
```

This resolves SMT-008 without abandoning the idea of a primary semantic identity.

---

# 9. Relationship Analysis

Relationship analysis remains orthogonal.

It runs after primary identity and cross-object impact analysis.

A packet may produce:

```text
NO object creation
+
ADD_RELATIONSHIP
```

or:

```text
EXTEND A
+
EXTEND B
+
ADD_RELATIONSHIP A→B
```

or:

```text
CREATE CHILD C
+
ADD_RELATIONSHIP C→D
```

Relationships require explicit user-grounded meaningful bearing.

Under uncertainty:

```text
NO EDGE
```

---

# 10. State and Supersession Analysis

State change does not imply identity change.

When a new proposition changes the current state of an existing concern:

```text
EXTEND_OBJECT
+
SUPERSEDE prior proposition
```

Historical propositions remain.

The graph distinguishes:

```text
historically true user state
```

from:

```text
current user state
```

---

# 11. Conservative Restructuring Lifecycle

High-consequence structural changes must not be executed casually during ordinary packet processing.

Restructuring uses three stages:

```text
SIGNAL
↓
VALIDATE
↓
APPLY
```

---

## Stage A — Signal

The normal semantic pass may emit:

```text
POSSIBLE_DUPLICATE

POSSIBLE_MERGE

POSSIBLE_REPARENT
```

This does not alter existing structural history.

---

## Stage B — Validate

A dedicated restructuring evaluation checks:

```text
persistent identity evidence

semantic containment

independent returnability

historical trajectories

existing parent relationships

cycle risk

canonical-parent rule

provenance preservation

impact on return paths
```

---

## Stage C — Apply

Only a validated restructuring operation may emit:

```text
MERGE_OBJECTS

REPARENT_OBJECT

CANONICALIZE_DUPLICATE
```

All changes are recorded as explicit graph mutations.

Historical structure remains reconstructable through mutation history.

---

# 12. Legitimate Broader Parent Emergence

A broader parent may emerge later.

Example:

Initially:

```text
V2 Reliability

V2 Performance
```

Later the user establishes:

```text
V2 Incremental Engine
```

as a persistent, independently returnable concern.

Then:

```text
CREATE V2 Incremental Engine
+
POSSIBLE_REPARENT Reliability
+
POSSIBLE_REPARENT Performance
```

This is permitted because the broader concern is now:

```text
user-grounded
persistent
semantically coherent
independently returnable
```

This is different from inventing an umbrella merely to tidy the graph.

---

# 13. Revised Semantic Mutation Set

```ts
interface SemanticMutationSet {
  primaryObjectResolution: {
    objectId?: string;
    action:
      | "NONE"
      | "EXTEND"
      | "REOPEN"
      | "CREATE";
  };

  objectMutations: ObjectMutation[];

  structuralMutations: StructuralMutation[];

  relationshipMutations: RelationshipMutation[];

  propositionStateMutations: PropositionStateMutation[];

  restructuringSignals: RestructuringSignal[];

  semanticDiagnostics?: {
    identitySearchWidened?: boolean;
    structuralSearchWidened?: boolean;
    primaryIdentityConfidence?: number;
    canonicalParentConfidence?: number;
  };
}
```

`primaryObjectResolution` records ownership.

`objectMutations` may contain mutations affecting multiple objects.

This prevents:

```text
multiple affected objects
```

from being confused with:

```text
multiple equal semantic owners
```

---

# 14. Revised Core Invariants

### SME-1

Persistent concern identity outranks lexical similarity.

### SME-2

Retrieval proposes candidates; it never determines ownership.

### SME-3

Retrieval absence is not semantic absence.

### SME-4

Identity search and structural-parent search have independent semantic sufficiency gates.

### SME-5

Exact persistent concern outranks broad compatibility.

### SME-6

A Semantic Packet may have one primary persistent concern while materially affecting multiple existing objects.

### SME-7

Cross-object impact must be evaluated separately from primary semantic ownership.

### SME-8

Temporal distance does not break identity.

### SME-9

State change does not automatically create a new identity.

### SME-10

Sub-concern emergence may accumulate across non-contiguous episodes.

### SME-11

Sub-concern evidence must survive conversational interruption.

### SME-12

Strict semantic containment is required for hierarchy.

### SME-13

Each object has at most one canonical structural parent.

### SME-14

A parent may have any number of independently valid children.

### SME-15

Canonical parenthood is determined by primary semantic home, not retrieval rank.

### SME-16

Shared dependency, project, entity, mechanism, or goal does not alone establish containment.

### SME-17

Relationships are orthogonal to hierarchy and object ownership.

### SME-18

Relationship uncertainty produces no edge.

### SME-19

Continuation origin is provenance, not semantic ownership.

### SME-20

Assistant context aids interpretation; durable user-state claims require user evidence.

### SME-21

No artificial umbrella objects.

### SME-22

Legitimate broader concerns may emerge later.

### SME-23

Duplicate, merge, and reparent operations follow signal → validate → apply.

### SME-24

Historical provenance is immutable even when later semantic interpretation associates evidence with a newly promoted concern.

### SME-25

One packet may produce multiple simultaneous semantic mutations.

### SME-26

Structural uncertainty should reduce structural commitment rather than increase invented hierarchy.

### SME-27

Full-batch and incremental processing should converge toward materially equivalent graphs.

---

# 15. Revised Decision Pseudocode

```text
function processSemanticPacket(packet, graph):

    if not hasDurableSemanticSignificance(packet):
        return NO_GRAPH_MUTATION


    // --------------------------------------------------
    // PRIMARY IDENTITY
    // --------------------------------------------------

    identityCandidates =
        initialIdentityRetrieval(packet, graph)

    primaryIdentity =
        resolvePrecisePersistentIdentity(
            packet,
            identityCandidates
        )

    if no primaryIdentity:

        if not identityRetrievalIsSufficient(
            packet,
            identityCandidates
        ):
            identityCandidates =
                widenIdentitySearch(packet, graph)

            primaryIdentity =
                resolvePrecisePersistentIdentity(
                    packet,
                    identityCandidates
                )


    if primaryIdentity exists:

        if primaryIdentity is dormant:
            propose REOPEN(primaryIdentity)

        propose EXTEND(primaryIdentity)

        emergence =
            evaluateLongitudinalSubconcern(
                packet,
                primaryIdentity,
                historicalEvidence
            )

        if emergence == EMERGING:
            accumulateEmergenceEvidence(...)

        if emergence == ESTABLISHED:
            proposeChildPromotion(...)


    else:

        // --------------------------------------------------
        // NEW IDENTITY + STRUCTURAL PLACEMENT
        // --------------------------------------------------

        newObject =
            proposeNewObject(packet)

        parentCandidates =
            initialParentRetrieval(
                newObject,
                graph
            )

        validParents =
            assessParentCandidates(
                newObject,
                parentCandidates
            )

        if no validParents:

            if not structuralRetrievalIsSufficient(
                newObject,
                parentCandidates
            ):
                parentCandidates =
                    widenStructuralSearch(
                        newObject,
                        graph
                    )

                validParents =
                    assessParentCandidates(
                        newObject,
                        parentCandidates
                    )


        if one validParent:
            canonicalParent = validParent

        if multiple validParents:
            canonicalParent =
                resolveCanonicalSemanticHome(
                    newObject,
                    validParents
                )

        propose CREATE(newObject)

        if canonicalParent exists:
            propose CHILD_OF(
                newObject,
                canonicalParent
            )


    // --------------------------------------------------
    // CROSS-OBJECT EFFECTS
    // --------------------------------------------------

    impactedObjects =
        evaluateCrossObjectImpact(
            packet,
            primaryIdentity,
            graph
        )

    for each materially impacted object:
        propose appropriate object mutation


    // --------------------------------------------------
    // RELATIONSHIPS
    // --------------------------------------------------

    relationshipMutations =
        evaluateRelationships(
            packet,
            primaryIdentity,
            impactedObjects,
            graph
        )


    // --------------------------------------------------
    // STATE
    // --------------------------------------------------

    supersessionMutations =
        evaluateStateSupersession(
            packet,
            graph
        )


    // --------------------------------------------------
    // RESTRUCTURING
    // --------------------------------------------------

    restructuringSignals =
        detectRestructuringSignals(
            packet,
            proposedMutations,
            graph
        )


    mutationSet =
        assembleSemanticMutationSet(...)

    validatedSet =
        deterministicValidation(
            mutationSet,
            graph
        )

    return validatedSet
```

---

# 16. Regression Check Against SMT-001–010

## SMT-001

Correct SAME is candidate #5.

```text
PASS
```

Precise identity resolution evaluates all candidates.

No widening needed.

---

## SMT-002

Correct SAME is absent.

```text
PASS
```

Historical-return signals trigger insufficient identity recall.

Identity search widens.

Dormant object is reopened.

---

## SMT-003

Broad parent outranks precise child superficially.

```text
PASS
```

Exact persistent identity outranks broad compatibility, recency, evidence volume, and embedding score.

---

## SMT-004

Correct parent absent.

```text
PASS
```

Structural sufficiency gate detects missing defining semantic domain.

Parent search widens.

---

## SMT-005

Two valid parents.

```text
PASS, subject to canonical-parent confidence
```

Canonical Parent Resolution compares identity-defining containment, return context, semantic scope, development history, and counterfactual identity.

One parent selected.

Other warranted connection remains semantic.

---

## SMT-006

Parent already has many children.

```text
PASS
```

Existing child count is not considered.

---

## SMT-007

Continuation from A, SAME identity is dormant B.

```text
PASS
```

Continuation origin contributes retrieval context only.

Precise persistent identity B wins.

---

## SMT-008

One packet changes A and B.

```text
PASS
```

Primary Identity resolves A.

Cross-Object Impact identifies B.

Relationship and supersession passes produce remaining mutations.

---

## SMT-009

Emergence across non-contiguous episodes.

```text
PASS
```

Longitudinal emergence explicitly uses accumulated historical evidence.

Conversation interruption does not reset evidence.

---

## SMT-010

Legitimate broader parent emerges later.

```text
PASS
```

New broader object is created.

Possible reparent operations are signaled.

Dedicated validation is required before hierarchy changes.

---

# 17. Status

The revised algorithm now resolves all ten initial torture cases without requiring a change to the foundational semantic philosophy.

Therefore this specification may now be treated as:

# ContextGraph Object Decision & Semantic Mutation Algorithm — Candidate v1

It is not yet production-validated.

The next adversarial suite should attempt to falsify Candidate v1 rather than continuing to refine it abstractly.
