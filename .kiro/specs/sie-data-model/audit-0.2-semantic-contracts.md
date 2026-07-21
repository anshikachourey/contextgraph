# Audit 0.2 — V2 Semantic and UI Contracts

**Task**: Inspect current V2 semantic and UI contracts  
**Date**: Audit performed as read-only inspection; no files modified.

---

## 1. Current Type Definitions (schemas.ts)

**File**: `src/lib/intelligence-v2/schemas.ts`

### 1.1 Proposition

```typescript
interface Proposition {
  propositionId: string;
  propositionType: PropositionType;  // "claim" | "question" | "preference" | "intent" | "decision" | "emotional_state" | "example" | "request"
  normalizedContent: string;
  sourceUtteranceIds: string[];
  authoredBy: "user" | "assistant";
  provenance: PropositionProvenance;  // "direct" | "paraphrase" | "interpretation" | "inference"
  confirmedByUser: boolean;
  confidence: number;
  status: PropositionStatus;  // "active" | "superseded" | "retracted" | "invalidated"
  supersedesPropositionId: string | null;
}
```

**SIE gap notes**:
- V2 `Proposition` lacks `conversationId`, `messageSeqRange`, `extractionVersion`, `createdAt`, and multi-role retention fields required by SIE.
- V2 uses `sourceUtteranceIds` (utterance-level), while SIE `Proposition` uses `source_message_ids` (message-level).
- V2 `PropositionType` has 8 values; SIE design extends to 14 types (adds GOAL, CONSTRAINT, PLAN, CORRECTION, REJECTION, UPDATE).
- V2 uses a numeric `confidence: number`; SIE uses `BehavioralConfidenceBand` (HIGH/MEDIUM/LOW).
- V2 has `confirmedByUser: boolean`; SIE has no equivalent — confirmation may be modeled as a provenance upgrade.

### 1.2 Thread

```typescript
interface Thread {
  threadId: string;
  utteranceIds: string[];
  propositionIds: string[];
  subject: string;
  branchId: string | null;
  originThreadId: string | null;
  divergenceUtteranceId: string | null;
  status: ThreadStatus;  // "active" | "completed" | "abandoned" | "branched"
}
```

### 1.3 ConversationalObject

```typescript
interface ConversationalObject {
  objectId: string;
  objectType: ObjectType;  // 13 types: "inquiry" | "insight" | "problem" | "task" | "project" | "goal" | "decision" | "preference" | "explanation" | "plan" | "comparison" | "unresolved" | "noise"
  title: string;
  description: string;
  propositionIds: string[];
  threadIds: string[];
  supportingUtteranceIds: string[];
  contextualAssistantUtteranceIds: string[];
  maturity: ObjectMaturity;  // "nascent" | "developing" | "stable"
  status: ObjectStatus;  // "active" | "resolved" | "deferred" | "discarded"
  provenanceSummary: string;
}
```

### 1.4 Relationship

```typescript
interface Relationship {
  relationshipId: string;
  sourceObjectId: string;
  targetObjectId: string;
  type: RelationType;  // Union of SemanticRelationType (13) + StructuralRelationType (7) + ManualRelationType (2)
  family: RelationFamily;  // "semantic" | "structural" | "manual"
  sourcePropositionIds: string[];
  provenance: string;
  confidence: number;
  createdBy: "system" | "user";
  status: RelationStatus;  // "proposed" | "validated" | "active" | "reclassified" | "removed"
  visualClass: VisualClass;  // "semantic" | "structural" | "weak" | "manual"
  explanation: string;
}
```

### 1.5 DerivedHierarchyNode & DerivedTree

```typescript
interface DerivedHierarchyNode {
  objectId: string;
  treeId: string;
  depth: number;
  parentObjectId: string | null;
  childObjectIds: string[];
  siblingObjectIds: string[];
}

interface DerivedTree {
  treeId: string;
  rootObjectId: string;
  objectIds: string[];
  bridges: Array<{ targetTreeId: string; relation: RelationType; explanation: string }>;
}
```

### 1.6 V2GraphPlan (Full Pipeline Output)

```typescript
interface V2GraphPlan {
  conversationId: string;
  timestamp: string;
  utterances: Utterance[];
  propositions: Proposition[];
  threads: Thread[];
  objects: ConversationalObject[];
  semanticRelationships: Relationship[];
  structuralRelationships: Relationship[];
  manualRelationships: Relationship[];
  derivedHierarchy: DerivedHierarchyNode[];
  trees: DerivedTree[];
  unsupportedClaims: string[];
  supersededPropositions: Proposition[];
  validationResults: ValidationResult[];
  proposedOperations: MutationOperation[];
}
```

---

## 2. V2Snapshot (Incremental Engine State)

**File**: `src/lib/intelligence-v2/incremental/schemas.ts`

```typescript
interface V2Snapshot {
  conversationId: string;
  objects: ConversationalObject[];
  relationships: Relationship[];
  propositions: Proposition[];
  threads: Thread[];
  hierarchy: DerivedHierarchyNode[];
  trees: DerivedTree[];
}
```

The `V2Snapshot` is the in-memory working graph for the incremental update runner. It is stored in `v2_graph_snapshots.graph_payload` as JSON.

---

## 3. Thread Responsibilities — What Remains Necessary

Threads serve the following roles in V2:

| Responsibility | Where Used | Necessary for SIE Compatibility? |
|---|---|---|
| **Ordering/temporal grouping** | `formThreads()` groups utterances by subject coherence for downstream object formation | **No** — SIE propositions carry `messageSeqRange` natively |
| **Object formation scope** | `formObjects()` processes threads independently, limiting object scope | **No** — SIE uses packets (concern-cohesive) instead of threads |
| **UI display (snapshot)** | `SnapshotPayload.threads` contains `threadId` + `subject`; referenced by `ConversationalObject.threadIds` | **Yes** — backward compatibility for V2 snapshot projection |
| **Relationship structural candidates** | Same-thread pairs get structural candidate consideration | **No** — SIE uses explicit associations |
| **Hierarchy direction validation** | `isValidChildDirection()` in normalize-graph rejects cross-thread `child_of` | **Partial** — SIE concerns have explicit parenthood; but the V2 projection still needs thread association for correct rendering |
| **Node panel context** | `V2NodePanel` shows thread subject for selected nodes | **Yes** — V2 projection must derive a compatible thread for display |

**Conclusion**: After SIE cutover, Threads must be **derived for backward compatibility** with the V2 snapshot format. They are no longer an authoritative semantic structure. The V2 projection layer (task 5.3) must synthesize thread-like groupings from SIE packet/message-sequence data to satisfy the existing `SnapshotPayload.threads` contract.

---

## 4. Exact V2GraphPlan/Snapshot Shape Consumed by React Flow UI

**File**: `src/components/graph-v2/V2GraphPreview.tsx`

The React Flow UI fetches `GET /api/v2/graph-snapshot` and expects:

```typescript
type SnapshotPayload = {
  objects: Array<{
    objectId: string;
    objectType: string;
    title: string;
    description: string;
    propositionIds: string[];
    threadIds: string[];
    supportingUtteranceIds: string[];
    contextualAssistantUtteranceIds: string[];
    maturity: string;
    status: string;
    provenanceSummary: string;
  }>;
  relationships: Array<{
    relationshipId: string;
    sourceObjectId: string;
    targetObjectId: string;
    type: string;
    family: string;
    confidence: number;
    explanation: string;
    sourcePropositionIds: string[];
  }>;
  hierarchy: Array<{
    objectId: string;
    depth: number;
    parentObjectId: string | null;
    childObjectIds: string[];
    treeId: string;
  }>;
  trees: Array<{ treeId: string; rootObjectId: string; objectIds: string[] }>;
  propositions: Array<{
    propositionId: string;
    propositionType: string;
    normalizedContent: string;
    authoredBy: string;
    provenance: string;
    sourceUtteranceIds: string[];
  }>;
  threads: Array<{ threadId: string; subject: string }>;
};
```

### UI Data Flow

1. `V2GraphPreview` calls `normalizeGraph(gp.objects, gp.relationships)` → produces `DisplayGraph`
2. `DisplayGraph` is passed to `V2GraphCanvas` which uses:
   - `layoutDisplayForest(displayGraph)` — dagre layout positions
   - `buildFlowNodes(...)` — converts to React Flow nodes
   - `buildVisibleEdges(...)` — converts to React Flow edges
3. `V2NodePanel` directly reads `gp.propositions`, `gp.relationships`, `gp.objects`, `gp.threads` for the selected node detail view

### Snapshot Response Envelope

```typescript
type SnapshotResponse = {
  status: "none" | "generating" | "generating_initial" | "ready" | "failed";
  snapshotStatus?: "none" | "generating_initial" | "ready" | "failed";
  updateStatus?: "idle" | "queued" | "updating" | "failed";
  graphPayload?: SnapshotPayload;
  diagnostics?: { objectCount; relationshipCount; treeCount; maxDepth };
  errorMessage?: string;
  lastUpdateError?: string | null;
  generatedAt?: string;
  loadedFromSnapshot?: boolean;
};
```

### Graph-Payload Written by Commit

The `graph-snapshot` POST route and the `update-runner` both write `graph_payload` with the following structure (derived from the V2GraphPlan):
- `objects`: stripped to UI-relevant fields (objectId, objectType, title, description, propositionIds, threadIds, supportingUtteranceIds, contextualAssistantUtteranceIds, maturity, status, provenanceSummary)
- `relationships`: flattened semantic + structural (relationshipId, sourceObjectId, targetObjectId, type, family, confidence, explanation, sourcePropositionIds)
- `hierarchy`: DerivedHierarchyNode[]
- `trees`: DerivedTree[]
- `propositions`: stripped subset (propositionId, propositionType, normalizedContent, sourceUtteranceIds, authoredBy, provenance)
- `threads`: minimal (threadId, subject, utteranceIds — though UI only reads threadId + subject)

**Important**: The `hierarchy` stored in `graph_payload` uses `siblingObjectIds` from `DerivedHierarchyNode`, but the UI's `SnapshotPayload` type does NOT include `siblingObjectIds`. The normalize-graph re-derives hierarchy from objects + relationships. The stored hierarchy is informational/diagnostic only; the UI re-computes it via `normalizeGraph()`.

---

## 5. Runtime Validators

### 5.1 Graph-Level Validator (validator.ts)

**File**: `src/lib/intelligence-v2/validator.ts`

`validateGraphPlan(plan: V2GraphPlan): ValidationResult[]` checks:
1. Objects must have user-proposition support (non-empty `supportingUtteranceIds`)
2. No `child_of` cycles in relationships
3. `diverged_from` must not co-exist with `child_of` between same objects
4. Propositions with provenance "interpretation" cannot be sole support for user-attributed objects
5. Superseded propositions cannot be sole support for an object

This is called after the full V2 pipeline completes (`index.ts` line 125).

### 5.2 Policy Validators (per-entity)

**Directory**: `src/lib/intelligence-v2/policies/`

| File | Function | What It Validates |
|---|---|---|
| `proposition-policy.ts` | `validateProposition()` | User/assistant provenance consistency, content length, source utterance refs |
| `thread-policy.ts` | `validateThread()` | Subject presence, utterance presence |
| `object-policy.ts` | `validateObject()` | (imported in tests) Object formation rules |
| `relationship-policy.ts` | `validateRelationship()` | Self-referential rejection, type validity |
| `hierarchy-policy.ts` | `validateHierarchy()` | Cycle detection in hierarchy |
| `confidence-policy.ts` | — | Confidence thresholds |
| `lifecycle-policy.ts` | — | State transition rules |

These are hand-written TypeScript functions — no schema-based codegen, no Zod/Ajv runtime validators.

### 5.3 Normalize-Graph Validator

**File**: `src/lib/intelligence-v2/normalize-graph.ts`

`normalizeGraph()` performs deterministic structural validation during display preparation:
- Direction validation for `child_of` (isValidChildDirection)
- Multi-parent conflict resolution (picks highest confidence)
- Cycle removal
- Self-reference rejection
- Cross-thread hierarchy rejection

### 5.4 No JSON-Schema or Zod Runtime Validators

- **No Zod schemas** are used in source code. `zod` is an optional peer dependency of the AI SDK but not imported anywhere in `src/`.
- **No Ajv/JSON-Schema validators** exist in source. The `ajv` package is a transitive dev dependency of ESLint only.
- **No generated TypeScript types** from Python contracts exist yet. All types are hand-written in `schemas.ts`.
- **No OpenAPI contract artifacts** are checked in for the SIE pipeline (none exists yet — only FastAPI's auto-generated OpenAPI for the clustering endpoint).

---

## 6. Schema Generation — Current State and Where It Belongs

### Current State

- **Python side**: FastAPI + Pydantic 2 (`pydantic>=2.0.0`). The only endpoint is `/cluster-conversation`. FastAPI auto-generates an OpenAPI spec at `/docs` but no schema artifact is checked into the repo.
- **TypeScript side**: All types are manually defined in `schemas.ts` and `incremental/schemas.ts`. No code generation tooling is configured.
- **No cross-language contract enforcement** exists today.

### Where Schema Generation Should Live (per design.md)

The SIE design specifies:
1. **Python Pydantic models** are the source of truth for transport types
2. **OpenAPI/JSON-Schema** is generated from FastAPI Pydantic models (Task 3.4)
3. **TypeScript types + runtime validators** are generated from that OpenAPI artifact (Task 4.1)
4. A CI test fails if generated artifacts are stale (Task 4.3)

**Recommended toolchain** (based on existing stack):
- Python: FastAPI auto-generates OpenAPI from Pydantic models
- TypeScript generation: `openapi-typescript` or `quicktype` (neither is currently installed; must be chosen at Task 4.1)
- Runtime validation: Either Zod schemas generated from OpenAPI, or Ajv with JSON-Schema — to be decided during implementation

---

## 7. Summary of Compatibility Facts for SIE V2 Projection

| V2 Concept | SIE Equivalent | Projection Required |
|---|---|---|
| `ConversationalObject` | `PersistentConcern` | Yes — map concern fields to object shape |
| `ObjectType` (13 values) | No direct equivalent (SIE doesn't classify concerns by "type") | Must derive a legacy `objectType` for compatibility (design 5.3) |
| `ObjectMaturity` (nascent/developing/stable) | **Retired** — `semanticVersion` is unrelated | Must derive from proposition count for V2 compat |
| `Thread` | SemanticPacket (processing unit, not display) | Must derive synthetic threads from packet/seq data |
| `Relationship` (semantic + structural) | Explicit `PropositionAssociation` + concern parent | Must project associations to relationship format |
| `DerivedHierarchyNode` / `DerivedTree` | Concern `canonical_parent_id` hierarchy | Must derive from concern parenthood |
| `Proposition` (V2) | `Proposition` (SIE — richer) | Must strip to V2 subset for snapshot |
| Numeric confidence (0.0–1.0) | `BehavioralConfidenceBand` (HIGH/MEDIUM/LOW) | Must map band to numeric for V2 compat |

---

## 8. Key Findings / Potential Issues

1. **No existing SIE files** — `src/lib/intelligence-v2/sie/` does not exist yet. Implementation starts clean.

2. **Thread → Packet is not 1:1** — V2 threads are subject-coherent message groupings used as object-formation scope. SIE packets are concern-cohesive processing units. The projection must synthesize thread-like groups.

3. **ObjectType has no SIE parallel** — SIE concerns don't have an "inquiry"/"insight"/"task" type. V2 projection must derive a display type from proposition types, content, or metadata.

4. **ObjectMaturity is explicitly retired** — The design confirms this is not semantically meaningful. Projection must still produce it for the snapshot schema.

5. **Proposition ID strategy differs** — V2 uses sequential `prop-0`, `prop-1` within a pipeline run. SIE uses stable UUIDv5 from creation keys. The V2 snapshot projection must use the SIE IDs (they're strings either way — UI doesn't care about format).

6. **No runtime schema validation infrastructure** — Everything is hand-written policy functions. SIE will need to introduce a schema-validated contract layer (Zod, Ajv, or generated validators) for cross-language type safety.

7. **UI only reads a subset** — The `SnapshotPayload` consumed by React Flow is a strict subset of the full `V2GraphPlan`. The SIE projection only needs to produce this subset, not the full V2GraphPlan with validationResults, proposedOperations, unsupportedClaims, etc.

8. **`normalizeGraph()` re-derives hierarchy from objects + relationships** — The stored hierarchy is not directly consumed by the UI. The projection must produce valid `objects` + `relationships` and the UI will re-derive display hierarchy.

---

## 9. Files Inspected

| File | Purpose |
|---|---|
| `src/lib/intelligence-v2/schemas.ts` | Canonical V2 type definitions |
| `src/lib/intelligence-v2/objects.ts` | Thread → Object formation (LLM-based) |
| `src/lib/intelligence-v2/threads.ts` | Utterance → Thread grouping (LLM-based) |
| `src/lib/intelligence-v2/propositions.ts` | Utterance → Proposition extraction (LLM-based) |
| `src/lib/intelligence-v2/relationships.ts` | Object → Relationship classification (LLM + embedding) |
| `src/lib/intelligence-v2/hierarchy.ts` | Deterministic hierarchy from structural relationships |
| `src/lib/intelligence-v2/normalize-graph.ts` | Display-ready graph normalization (cycles, multi-parent) |
| `src/lib/intelligence-v2/validator.ts` | V2GraphPlan deterministic validation |
| `src/lib/intelligence-v2/incremental/schemas.ts` | V2Snapshot type + mutation types |
| `src/lib/intelligence-v2/incremental/update-runner.ts` | Cursor-based incremental processing + v2_commit_update RPC |
| `src/lib/intelligence-v2/policies/*.ts` | Per-entity policy validators |
| `src/components/graph-v2/V2GraphPreview.tsx` | React Flow UI — SnapshotPayload type + rendering |
| `src/components/graph-v2/V2GraphCanvas.tsx` | React Flow rendering (uses @xyflow/react) |
| `app/api/v2/graph-snapshot/route.ts` | GET/POST endpoints for snapshot retrieval/generation |
| `ml-service/app/main.py` | FastAPI app (clustering only, no SIE endpoints) |
| `ml-service/app/models.py` | Pydantic models (clustering only) |
| `ml-service/requirements.txt` | Python dependencies |
| `package.json` | Node dependencies + scripts |
