# Benchmark: Rockstar, Identity & Authentic Connection

## Conversation Arc

A deeply personal conversation that evolved through:

1. Why the movie Rockstar is unforgettable — raw emotion, Jordan's journey
2. Heer and Jordan's relationship — unconditional love, creative partnership
3. Identifying with Heer — wanting to be someone's muse and anchor
4. Wanting that kind of authentic, deep relationship
5. Deciding not to force love — letting it come naturally
6. Self-care as foundation — taking care of yourself first
7. Anxiety and overthinking in social situations
8. Building confidence through authentic self-expression
9. Social skills as learnable, not innate
10. Becoming an authentic, interesting person

## Expected Engine Output (Correct)

### Nodes
| # | Title | Summary |
|---|-------|---------|
| 1 | Why Rockstar Resonates: Authenticity, Identity, and Emotional Connection | Rockstar isn't just a movie — it represents the kind of raw, unfiltered creative passion and deep love (Heer & Jordan) that feels authentic and emotionally profound. Identifying with Heer reveals a desire to be deeply connected to someone's creative journey. |
| 2 | Becoming My Authentic Self: Confidence Through Self-Expression | The realization that authentic confidence comes from self-care, managing anxiety, and developing genuine social skills — not performing or imitating. Building an interesting persona naturally by being genuinely curious and present. |

### Edges
| Source | Target | Relationship | Explanation |
|--------|--------|-------------|-------------|
| Node 1 | Node 2 | inspired the pursuit of | The yearning for authentic connection (like Heer & Jordan) naturally led to working on becoming someone capable of that depth — authentic, confident, emotionally present |

### Segmentation
- Segment 1 (exchanges 1-5): Rockstar → Heer/Jordan → wanting authentic love → not forcing it
- Segment 2 (exchanges 6-10): Self-care → anxiety → confidence → social skills → authentic self

## Quality Criteria

1. **Emotional depth**: Nodes must capture the personal/emotional significance, not just the topics
2. **Evolutionary connection**: The edge must explain HOW discussing Rockstar/Heer LED TO thinking about personal growth
3. **Appropriate granularity**: 2 nodes (not 1 monolith, not 10 fragments)
4. **Future recall test**: Reading just the graph should evoke "I was reflecting on what authentic connection means and what kind of person I want to become"

## Evaluation Rubric

| Dimension | 1 (Fail) | 3 (Acceptable) | 5 (Excellent) |
|-----------|----------|-----------------|---------------|
| Title quality | "Exploring Rockstar" | "Connection Through Rockstar & Personal Growth" | "Why Rockstar Resonates: Authenticity and Emotional Depth" |
| Summary quality | "Discussed Rockstar and confidence" | "Reflects on authentic relationships and becoming confident" | "Rockstar's raw emotional authenticity sparked reflection on what it means to build genuine confidence and deep connection" |
| Edge quality | "related" | Has verb phrase relationship | Explains the causal/inspirational link between ideas |
| Segmentation | 1 or 10 segments | 2-4 reasonable chapters | Matches natural emotional arcs |
| Recall test | Meaningless without chat | Gets the emotional gist | Fully captures the personal journey |
