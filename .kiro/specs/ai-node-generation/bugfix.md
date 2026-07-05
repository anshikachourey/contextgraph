# Bugfix Requirements Document

## Introduction

The ContextGraph intelligence engine's purpose is to build an externalized memory of how ideas evolve — a knowledge graph that captures insights, realizations, and emotional themes from conversations. While the engine's infrastructure (segmentation, routing, persistence) functions correctly, the output quality does not meet the product's intent. Nodes read like conversation archives rather than crystallized ideas. This document specifies the graph quality standards the engine must achieve, using real conversation benchmarks to evaluate improvements over time.

### Design Principles

**Optimize for future recall, not transcript accuracy.** When revisiting a conversation months later, a user should understand from the graph alone — without rereading the chat — what they were thinking about, what they learned, what changed, how one idea led to another, and why the conversation was personally meaningful.

**Nodes summarize ideas, realizations, and enduring concepts — not messages.** Messages are transient. Ideas are what people actually remember. The graph should capture what endures.

**Edges explain conceptual evolution, not merely indicate similarity.** A connection between two nodes should tell the story of how one idea relates to another — not just that their embeddings are close.

**Benchmark-driven quality evaluation.** Whenever the engine is improved, quality is measured by comparing old and new graphs on benchmark conversations and asking: "If someone saw only the graph, would they understand the conversation?" If the answer keeps improving, the engine is moving in the right direction.

**Compress without losing meaning.** The graph's purpose is not to preserve every detail — the original chat already does that. The graph should compress a long conversation into the smallest number of concepts that still preserve its meaning and evolution. Every node should justify its existence. Every edge should communicate something meaningful. Removing a node or edge should noticeably reduce understanding of the conversation. The graph should be dense with meaning, not dense with objects.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the engine materializes a node from conversation segments THEN the system produces titles that describe the conversation topic as a shallow noun phrase (e.g., "Exploring the Soulful Impact of Rockstar") rather than synthesizing the insight or realization that emerged

1.2 WHEN the engine materializes a node from conversation segments THEN the system produces summaries that compress what was said in the messages, replaying the conversation rather than articulating what was concluded, realized, or emotionally resolved

1.3 WHEN the engine computes edges between nodes THEN the system assigns edges based solely on embedding cosine similarity exceeding a threshold, providing no semantic relationship type — all edges simply mean "related"

1.4 WHEN a conversation evolves gradually through semantically connected but distinct conceptual chapters (e.g., Rockstar → personal identity → authentic relationships → self-confidence) THEN the system either treats the entire flow as one oversized segment or fragments it into many tiny segments at each minor topic drift

1.5 WHEN the completed graph is viewed as a whole THEN the system presents what reads as a clustered transcript rather than an externalized memory or knowledge graph of the user's intellectual and emotional journey

1.6 WHEN evaluating graph quality THEN the system has no benchmark-driven evaluation mechanism — quality is assessed ad-hoc with no reproducible standard

### Expected Behavior (Correct)

2.1 WHEN the engine materializes a node from conversation segments THEN the system SHALL produce titles that capture the core insight, emotional theme, or realization (e.g., "Finding Myself Through Heer and Jordan" or "Why Rockstar Resonates: Authenticity and Emotional Connection") — synthesizing ideas rather than labeling topics

2.2 WHEN the engine materializes a node from conversation segments THEN the system SHALL produce summaries that answer "What was learned or concluded?" — articulating the takeaway, personal realization, or thematic conclusion rather than replaying what was discussed

2.3 WHEN the engine computes edges between nodes THEN the system SHALL assign a semantic relationship type that describes WHY two ideas are connected, using meaningful labels such as "evolved into," "emotionally connected to," "inspired by," "contrasts with," "supports," "caused by," "reflects," "prerequisite for," or "consequence of"

2.4 WHEN a conversation evolves gradually through semantically connected but distinct conceptual chapters THEN the system SHALL recognize natural chapter boundaries that a human would identify as major thematic arcs, producing nodes for each arc (e.g., a Rockstar → identity → confidence conversation yields approximately "Rockstar, Heer & Authentic Connection" and "Becoming My Authentic Self & Building Confidence" rather than one monolithic node or many fragments)

2.5 WHEN the completed graph is viewed as a whole THEN the system SHALL present an externalized memory that reads like a knowledge graph of the user's ideas, realizations, and emotional evolution — not a clustered transcript

2.6 WHEN evaluating graph quality THEN the system SHALL support benchmark-driven evaluation using real conversations with defined expected nodes (titles, summaries), expected edges (relationship types), and expected segmentation — enabling reproducible quality measurement by answering "If someone saw only the graph, would they understand the conversation?"

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a conversation has a clear hard topic change (e.g., from discussing music to asking about weather) THEN the system SHALL CONTINUE TO detect the boundary and create separate segments

3.2 WHEN a completed candidate meets materialization confidence thresholds THEN the system SHALL CONTINUE TO materialize it into a node with proper embedding, position, and neighborhood assignment

3.3 WHEN a new segment's embedding is highly similar to an existing node THEN the system SHALL CONTINUE TO route it as an extend_node decision rather than creating a duplicate

3.4 WHEN a new segment is semantically similar to an active candidate THEN the system SHALL CONTINUE TO accumulate it into that candidate (coherence gate still applies)

3.5 WHEN a candidate has insufficient evidence (below MIN_EVIDENCE_MESSAGES) THEN the system SHALL CONTINUE TO withhold materialization until enough evidence accumulates

3.6 WHEN edges are computed THEN the system SHALL CONTINUE TO require a minimum similarity threshold before creating an edge connection

3.7 WHEN a candidate exceeds message or segment guardrails THEN the system SHALL CONTINUE TO block materialization to prevent overly broad nodes

## Benchmarks

Quality improvements are evaluated against real conversation benchmarks stored in `/benchmarks/`:

| Benchmark | File | Key Test |
|-----------|------|----------|
| Art → Rock → Persona | `benchmarks/art-rock-persona.md` | Gradual evolution from dissatisfaction → genre discovery → identity construction should yield 2-3 insight nodes with evolutionary edges |

Each benchmark defines: expected segmentation, expected node titles/summaries, expected edge relationships, and a scoring rubric. Engine changes must be evaluated against all benchmarks before merging.
