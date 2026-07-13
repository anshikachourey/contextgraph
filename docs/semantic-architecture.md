# ContextGraph — Canonical Semantic Architecture

This document defines the internal world model that ContextGraph maintains. All future implementations — V2, V3, and beyond — must conform to this architecture. The implementation is derived from this model, not the other way around.

---

## 1. The Smallest Semantic Unit: The Utterance

The atom of ContextGraph is the **utterance** — a single message from either the user or the assistant.

An utterance is:
- Immutable after creation (content never changes once persisted)
- Attributed to exactly one author (user or assistant)
- Ordered temporally within its conversation
- Optionally branched from a specific point in history

Utterances are NOT the unit of graph construction. They are raw material. The graph is built from what utterances *mean*, not from the utterances themselves.

---

## 2. Semantic Units (in order of derivation)

### 2.1 Utterance (immutable, authored)

```
utterance:
  id: uuid
  author: user | assistant
  content: text
  conversation_id: uuid
  created_at: timestamp
  temporal_position: integer
  branch_id: uuid | null
  branch_path: [uuid]  (ordered ancestor branch IDs)
  branch_point_message_id: uuid | null  (the message this branch diverged from)
  tombstoned: boolean  (user-requested deletion — content preserved but hidden)
  tombstoned_at: timestamp | null
```

**Nature:** Immutable ground truth. Content is never silently rewritten. "Immutable" means the system cannot alter what was said — but user-requested deletion is represented as tombstoning (content preserved for provenance, marked hidden for display). A tombstoned utterance remains in the derivation chain but is excluded from future LLM input and UI rendering.

**Branch provenance model:**
- `branch_id`: identifies which branch this utterance belongs to (null = main branch)
- `branch_path`: ordered list of ancestor branch IDs from root to current (enables shared history)
- `branch_point_message_id`: the specific message after which this branch diverged (enables sibling branch rendering and shared-history identification)
- Original and edited continuations are sibling branches sharing the same `branch_point_message_id`

### 2.2 Proposition (derived, attributed)

A proposition is the smallest meaningful claim, question, preference, or intent expressed within one or more utterances.

```
proposition:
  id: uuid
  type: claim | question | preference | intent | decision | emotional_state | example | request
  content: text (concise natural-language statement)
  source_utterance_ids: [uuid]
  authored_by: user | assistant
  provenance: direct | paraphrase | interpretation | inference
  confirmed_by_user: boolean
  status: active | superseded | retracted | invalidated
  supersedes_proposition_id: uuid | null
  confidence: 0.0 - 1.0
```

**Nature:** Derived by LLM from utterances. A single utterance may contain multiple propositions. A proposition is attributed to its author — an assistant proposition about user intent is marked `provenance: interpretation` and `confirmed_by_user: false` until the user explicitly confirms.

**Lifecycle:**
1. Extracted from utterance(s) by LLM
2. Attributed to author
3. May be confirmed/denied by later user utterances
4. Never mutated — corrections create new propositions with `status: superseded` on the original and `supersedes_proposition_id` pointing backward
5. Retracted if the user explicitly takes back a claim
6. Invalidated if subsequent evidence contradicts it

**Critical rule:** A proposition attributed to the user (`authored_by: user`) must have `provenance: direct` — meaning the user actually stated it. Assistant interpretations about user meaning have `authored_by: assistant` and `provenance: interpretation`.

### 2.3 Thread (derived, deterministic + LLM)

A thread is a temporally contiguous sequence of utterances about the same subject. Threads are the connective tissue between raw utterances and meaningful objects.

```
thread:
  id: uuid
  utterance_ids: [uuid] (ordered)
  proposition_ids: [uuid]
  subject: text (what this thread is about)
  branch_id: uuid | null
  origin_thread_id: uuid | null  (thread this diverged from)
  divergence_utterance_id: uuid | null  (where the split happened)
  status: active | completed | abandoned | branched
```

**Nature:** Derived through a combination of deterministic and LLM methods:
- **Deterministic:** temporal order, branch ancestry, adjacency, and explicit reply structure
- **Embedding-based:** subject coherence detection (cosine similarity between consecutive utterances)
- **LLM (when ambiguous):** topic-shift detection when embeddings are inconclusive

**Lifecycle:**
1. Started by a new subject appearing in an utterance
2. Grows as related utterances continue
3. Ends when subject changes, conversation branches, or goes silent
4. May be retrospectively split if a topic shift is identified late

**Critical rule:** Temporal adjacency is necessary but not sufficient for thread membership. A topic shift creates a new thread even when messages are consecutive.

### 2.4 Object (derived, the primary graph unit)

An object is a meaningful conversational entity that merits a place in the graph. It is the unit of navigation, recall, and structure.

```
object:
  id: uuid
  type: inquiry | insight | problem | task | decision | preference | plan | explanation | comparison | unresolved
  title: text (faithful representation, not synthesis)
  description: text
  source_proposition_ids: [uuid]
  source_thread_ids: [uuid]
  maturity: nascent | developing | stable
  status: active | resolved | deferred | discarded
```

**Nature:** Derived by LLM from propositions and threads. This is where meaning crystallizes. An object is NOT a summary of messages — it is a representation of a conversational entity (a question asked, a decision made, a problem identified, etc.)

**Lifecycle:**
1. Created when a coherent set of propositions forms a recognizable entity
2. Develops as more propositions strengthen it
3. Stabilizes when the conversation moves past it
4. May be resolved (question answered), deferred (topic postponed), or discarded (noise)
5. May be split (too broad) or merged (duplicates discovered)

**Critical rules:**
- An object's title must be directly supported by its source propositions
- Questions remain questions unless the conversation resolves them
- Assistant interpretations cannot establish an object about user intent

---

## 3. Relationships (the graph edges)

Relationships connect objects. They are the structure of the graph.

### 3.1 Relationship types by nature

**Deterministic relationships** (can be computed without LLM):
- `temporal_sequence`: object B appeared after object A in the conversation
- `shared_thread`: objects share source utterances/threads
- `branch_from`: object exists in a branched conversation path

**LLM-generated relationships** (require semantic understanding):
- `child_of`: B is a subtopic or specific instance of A
- `answers`: B provides an answer to inquiry A
- `raises_question`: B introduces a question about A
- `elaborates`: B adds detail to A
- `evidence_for`: B supports A with concrete evidence
- `example_of`: B is a concrete instance of abstract A
- `reframes`: B presents A from a different angle
- `contrasts_with`: B opposes or offers alternative to A
- `leads_to`: A causally/logically precedes B

**Structural relationships** (provenance/navigation):
- `tangent_from`: B is a digression from A
- `diverged_from`: conversation shifted from A to unrelated B (weak temporal link)
- `merged_from`: B was created by merging multiple objects
- `continued_from`: B resumes a previously deferred A

**Manual relationships** (user-created):
- `user_linked`: user explicitly connected A and B
- `manual_merge`: user merged A and B

### 3.2 Relationship properties

```
relationship:
  id: uuid
  source_object_id: uuid
  target_object_id: uuid
  type: (one of the above)
  strength: 0.0 - 1.0
  explanation: text
  provenance: deterministic | llm_generated | user_created
  visual_class: semantic | structural | weak | manual
```

---

## 4. How Hierarchy Emerges

**Hierarchy is NOT directly generated.** It is emergent from relationships.

The rules:
1. An object with no `child_of` relationship pointing to it is a **root**.
2. An object with a `child_of` relationship to another is a **child** of that object.
3. Multiple children of the same parent are **siblings**.
4. A connected set of objects reachable through `child_of` edges forms a **tree**.
5. Multiple disconnected trees form a **forest**.
6. Cross-tree relationships (`tangent_from`, `leads_to`, `contrasts_with`) create **bridges** between trees.
7. An object connected to a tree only by `diverged_from` is a **new root** with a weak origin link, not a child.

**Computed properties (never stored, always derived):**
- `depth` = number of `child_of` edges from root
- `tree_id` = the root object's id (propagated to all descendants)
- `subtree_size` = count of descendants

**This means:** The LLM never says "this is depth 3 in tree X." It says "object B is a child_of object A." The system computes the hierarchy from the relationship graph.

---

## 5. How Structures Naturally Arise

### Trees
A user explores a topic in depth:
```
Career anxiety (root)
  └── Physical symptoms of anxiety (child_of)
  └── Avoidance patterns (child_of)
       └── Specific avoidance example (child_of)
```

### Forests
A conversation covers unrelated topics:
```
Tree 1: Career anxiety
Tree 2: Recipe for dal khichdi
Tree 3: Coding bug fix
```
These are separate roots. No forced unification.

### Tangents
Mid-discussion, user goes on a digression:
```
Career anxiety (root)
  └── Physical symptoms (child_of)
Tangent → Song translation request (tangent_from: Physical symptoms)
```
The tangent retains a weak origin link but is NOT a child.

### Merges
User manually combines two related threads:
```
Object A: "Foods for skin health"
Object B: "Supplements for skin"
→ Merged into: "Nutrition and supplementation for skin"
   (merged_from: A, B)
```

### Branches
User edits an earlier message → creates a branch:
```
Original path: Q1 → A1 → Q2 → A2
Branch from Q1: Q1 → A1 → Q2' → A2'

Object X lives in original path
Object Y lives in branch
Both share ancestry through Q1/A1
```

### Bridges
Two separate trees discover a connection:
```
Tree 1: Anxiety → Physical symptoms
Tree 2: Exercise habits → Running benefits

Bridge: "Running benefits" —contrasts_with→ "Physical symptoms of anxiety"
(the user noted that running reduces the same symptoms)
```

---

## 6. Immutable vs. Derived vs. Persisted

| Unit | Immutable? | Derived? | Persisted? |
|------|-----------|----------|-----------|
| Utterance | ✅ Yes | No (source) | ✅ Always |
| Proposition | ✅ After extraction | Yes (from utterances) | ✅ Yes (for provenance) |
| Thread | No (may be retrospectively split) | Yes (from utterances) | 🔲 Optional (recomputable) |
| Object | No (may develop/merge/split) | Yes (from propositions) | ✅ Yes (the graph nodes) |
| Relationship | No (may be reclassified) | Yes (from objects) | ✅ Yes (the graph edges) |
| Hierarchy | No (emergent) | Yes (from relationships) | 🔲 Derived (never stored directly) |

---

## 7. What is Persisted vs. Recomputed

**Always persisted (source of truth):**
- Utterances (messages table — already exists)
- Objects (nodes table — with provenance fields)
- Relationships (edges/relations table — with typed edges)
- Proposition provenance (which user messages support which claims)

**Recomputed on demand (cached but not authoritative):**
- Thread groupings
- Hierarchy depth/tree membership
- Object maturity scoring
- Relationship strength

**Never persisted (ephemeral):**
- LLM intermediate reasoning
- Candidate/segment state (V1 concept — not carried forward)
- Confidence scores during planning

---

## 8. Provenance Model

Every derived unit must answer: **"Where did this come from?"**

```
provenance:
  source_type: user_utterance | assistant_utterance | llm_derivation | user_action | system_rule
  source_ids: [uuid]  (utterance IDs, proposition IDs, etc.)
  confidence: 0.0 - 1.0
  confirmed: boolean (user explicitly validated this)
  contested: boolean (contradicted by later content)
```

**The hierarchy of trust:**
1. User utterance (direct) — highest trust
2. User confirmation of assistant interpretation — high trust
3. Deterministic derivation (temporal sequence, thread grouping) — high trust
4. LLM-generated relationship — medium trust
5. LLM-generated proposition extraction — medium trust
6. Assistant interpretation (unconfirmed) — low trust, flagged

---

## 9. Lifecycle State Machine

### Object lifecycle:
```
             ┌─────────┐
             │ nascent  │ (just identified, few propositions)
             └────┬─────┘
                  │ more propositions accumulate
                  ▼
            ┌───────────┐
            │ developing │ (growing, not yet stable)
            └─────┬──────┘
                  │ conversation moves on / topic resolved
                  ▼
             ┌─────────┐
             │  stable  │ (complete representation)
             └────┬─────┘
                  │
        ┌─────────┼──────────┐
        ▼         ▼          ▼
   ┌────────┐ ┌────────┐ ┌──────────┐
   │resolved│ │deferred│ │discarded │
   └────────┘ └────────┘ └──────────┘
```

### Relationship lifecycle:
```
proposed → validated → active → [reclassified | weakened | removed]
```

---

## 10. What This Architecture Forbids

1. **No cross-topic synthesis without explicit user connection.** Objects cannot be merged or placed in one hierarchy across unrelated threads unless the user explicitly makes the connection. The system MAY propose a semantic cross-tree bridge when conversation content supports it — but such a bridge must remain typed, provenance-aware, confidence-scored, reversible, and must not collapse the trees into one.

2. **No assistant speculation as ground truth.** An assistant saying "maybe you use music for comfort" does not create an object about the user's coping mechanisms.

3. **No forced hierarchical coherence.** If two objects are unrelated, they remain in separate trees. The system does not invent a parent concept to unify them.

4. **No retroactive narrative construction.** The system does not rewrite the history of how ideas developed to fit a cleaner story.

5. **No single-thesis compression.** A conversation about multiple topics produces multiple objects, not one summary.

6. **No hierarchy without evidence.** A child relationship requires that the child is genuinely about a sub-aspect of the parent — temporal adjacency is not evidence.

7. **Cross-tree bridges are not merges.** A `leads_to` or `contrasts_with` relationship between objects in different trees does NOT make them parent-child, does NOT merge their trees, and does NOT collapse their separate identity. Bridges are connections, not hierarchy.

---

## 11. Design Principles

1. **The graph is a map, not a thesis.** It represents how ideas developed, not what they concluded.

2. **Faithfulness over elegance.** A faithful but messy graph is better than a clean but hallucinated one.

3. **Structure before summary.** Understand how objects relate before trying to name them.

4. **User primacy.** The user's words are the only source of truth about user meaning.

5. **Incremental growth.** The graph grows with the conversation, never requires full recomputation.

6. **Reversible decisions.** Any structural decision (child_of, merge, etc.) can be undone.

7. **Explicit provenance.** Every node and edge can answer "why do you exist?" with specific utterance references.
