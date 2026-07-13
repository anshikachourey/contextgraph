# V2 ContextGraph — Design Document Coverage Matrix

Maps every requirement from the ContextGraph Design Notes to V2 implementation.

## Trees / Subtrees / Forests

| Requirement | V2 Component | Status | Future Step | DB Impact | UI Impact |
|-------------|-------------|--------|-------------|-----------|-----------|
| Tree structure | `schemas.ts: TreeStructure` | ✅ Defined | Persist tree_id on nodes | Add `tree_id` column | Tree grouping in canvas |
| Subtree membership | `schemas.ts: HierarchyEntry` | ✅ Defined | Persist parent_id | Add `parent_node_id` column | Indented rendering |
| Forest (multiple trees) | `hierarchy.ts: planHierarchy` | ✅ Implemented | Separate rendering per tree | None | Visual tree separation |
| Weak cross-tree links | `schemas.ts: TreeStructure.weakLinks` | ✅ Defined | Store as special edge type | Edge type column | Dashed cross-links |

## Dynamic Hierarchy

| Requirement | V2 Component | Status | Future Step |
|-------------|-------------|--------|-------------|
| Node split | `schemas.ts: split_node` | ✅ Schema defined | Implement split logic |
| Node merge | `schemas.ts: merge_nodes` | ✅ Schema defined | Implement merge + provenance |
| Move subtree | `schemas.ts: move_subtree` | ✅ Schema defined | Implement reparenting |
| Edge reclassification | `schemas.ts: reclassify_edge` | ✅ Schema defined | Update edge type |
| Child → independent root | `schemas.ts: detach_subtree` | ✅ Schema defined | Remove parent_id |
| Separate roots → related | `hierarchy.ts` | ✅ Planned | Create weak link edge |

## Node Actions

| Requirement | V2 Component | Status |
|-------------|-------------|--------|
| Create node | `planner.ts: create_node/create_root` | ✅ Implemented |
| Update node | `planner.ts: update_node` | ✅ Schema defined |
| Append messages | `planner.ts: append_messages` | ✅ Schema defined |
| Discard noise | `planner.ts: discard_noise` | ✅ Implemented |
| Defer object | `planner.ts: defer_object` | ✅ Implemented |

## Message Branching

| Requirement | V2 Component | Status | Future Step |
|-------------|-------------|--------|-------------|
| Branch from message | `schemas.ts: branch_from_message` | ✅ Defined | Tie to branch_root_message_id |
| Shared history | Existing `parent_node_id` on messages | ✅ Working (V1) | Preserve |
| Sibling branches | `schemas.ts: sibling_context` | ✅ Defined | Render as parallel paths |

## Merge and Create Chat

| Requirement | V2 Component | Status | Future Step |
|-------------|-------------|--------|-------------|
| Manual merge | `schemas.ts: manual_merge` | ✅ Defined | UI merge action |
| Merge provenance | `schemas.ts: merged_from` | ✅ Defined | Store source node IDs |
| Create chat from node | Existing branch mode | ✅ Working (V1) | Preserve |

## Automatic Graph Construction

| Requirement | V2 Component | Status |
|-------------|-------------|--------|
| Event extraction | `events.ts` | ✅ Implemented |
| Object formation | `objects.ts` | ✅ Implemented |
| Hierarchy planning | `hierarchy.ts` | ✅ Implemented |
| Mutation planning | `planner.ts` | ✅ Implemented |
| Validation | `validator.ts` | ✅ Implemented |
| Provenance tracking | All layers | ✅ Implemented |
| Incremental updates | `index.ts` (designed for) | 🔲 Cursor-based incremental |

## Graph-First Navigation

| Requirement | V2 Component | Status | Future Step |
|-------------|-------------|--------|-------------|
| Graph as primary nav | — | 🔲 Future | Replace sidebar with graph |
| Spatial memory | — | 🔲 Future | Position persistence |
| Click → conversation context | Existing node click | ✅ Working (V1) | Preserve |

## Persistent Non-Forgetful Memory

| Requirement | V2 Component | Status |
|-------------|-------------|--------|
| Never discard user content | `validator.ts` rejects unsupported deletions | ✅ Designed |
| All messages preserved | Messages table unchanged | ✅ Working |
| Objects track all source messages | `supportingUserMessageIds` | ✅ Implemented |

## Provenance and Trust

| Requirement | V2 Component | Status |
|-------------|-------------|--------|
| User vs assistant authorship | `ConversationEvent.authoredBy` | ✅ Implemented |
| Explicit vs inferred claims | `ConversationalObject.explicitClaims/inferredClaims` | ✅ Implemented |
| Unsupported claim detection | `validator.ts` | ✅ Implemented |
| Assistant interpretation ≠ user fact | Event provenance field | ✅ Implemented |

## Future Database Migration (Proposed)

Based on V2 benchmark outputs, the minimum schema extension:

```sql
-- Structural relations (replaces simple edge table for hierarchy)
CREATE TABLE node_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_node_id uuid NOT NULL REFERENCES nodes(id),
  target_node_id uuid NOT NULL REFERENCES nodes(id),
  relation_type text NOT NULL,  -- child_of, sibling_context, answers, etc.
  visual_class text DEFAULT 'normal_semantic',
  strength real DEFAULT 0.7,
  explanation text,
  provenance text,  -- user_evidence, structural_analysis, manual
  created_at timestamptz DEFAULT now()
);

-- Tree membership
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tree_id uuid;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS parent_node_id uuid REFERENCES nodes(id);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS object_type text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS depth integer DEFAULT 0;

-- Provenance metadata
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS supporting_user_message_ids uuid[];
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS explicit_claims jsonb DEFAULT '[]';
```

This does NOT replace the existing `edges` table — it adds structural relations alongside semantic edges.
