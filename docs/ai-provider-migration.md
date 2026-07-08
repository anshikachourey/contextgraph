# AI Provider Migration Plan

## Architecture

```
src/lib/ai/
├── index.ts          — Public API (re-exports all domain functions)
├── provider.ts       — Provider routing (OpenAI, Anthropic)
├── models.ts         — Config-driven model selection (env vars)
├── chat.ts           — generateChatResponse()
├── graph.ts          — materializeNode(), generateSemanticEdge(), synthesizeLocalGraph(), ...
├── embeddings.ts     — embed(), buildNodeEmbeddingText()
└── benchmark-harness.ts — Side-by-side model comparison
```

## Environment Variables

```env
# Reasoning
AI_PROVIDER=openai              # or "anthropic"
CHAT_MODEL=gpt-4o-mini          # conversational responses
NODE_MODEL=gpt-4o-mini          # node title/summary generation
EDGE_MODEL=gpt-4o-mini          # semantic edge generation
GRAPH_SYNTHESIS_MODEL=gpt-4o-mini # graph synthesis pass
STRUCTURE_MODEL=gpt-4o-mini     # structure-conversation
SUMMARY_MODEL=gpt-4o-mini       # evidence + graph summaries

# Embeddings (independent provider)
EMBEDDING_PROVIDER=openai       # or "voyage", "jina"
EMBEDDING_MODEL=text-embedding-3-small

# API Keys
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...           # only needed if AI_PROVIDER=anthropic
```

## Call Sites (Audit)

### Reasoning Calls (8 locations)

| Location | Function | Purpose | Recommended Model |
|----------|----------|---------|-------------------|
| `/api/chat` | Chat response | Conversational AI | Claude 3.5 Sonnet |
| `intelligence/engine.ts` | materializeToNode | Node title/summary | Claude 3.5 Sonnet |
| `intelligence/engine.ts` | generateSemanticEdge | Edge relationships | GPT-4o-mini |
| `intelligence/engine.ts` | runGraphSynthesisPass | Local graph review | Claude 3.5 Sonnet |
| `/api/structure-conversation` | Cluster labeling | Node title/summary | Claude 3.5 Sonnet |
| `/api/generate-node-suggestion` | Draft node | Node suggestion | GPT-4o-mini |
| `/api/graph-summary` | Graph narrative | Summary | GPT-4o-mini |
| `/api/draft-node` | Draft node | Node suggestion | GPT-4o-mini |
| `src/lib/edgeSuggestions.ts` | Edge explanation | Edge text | GPT-4o-mini |
| `src/lib/embeddings.ts` | Evidence summary | Bullet points | GPT-4o-mini |

### Embedding Calls (1 location, used everywhere)

| Location | Function | Purpose |
|----------|----------|---------|
| `src/lib/embeddings.ts` | generateEmbedding() | All node/segment/exchange embeddings |

## Recommended Model Assignment

Optimized for **ContextGraph graph quality**, not generic benchmarks:

| Task | Recommended | Why |
|------|-------------|-----|
| **Chat** | Claude 3.5 Sonnet | Better at nuanced, empathetic conversation. More natural follow-ups. |
| **Node generation** | Claude 3.5 Sonnet | Superior at synthesis, emotional depth, insight extraction. GPT-4o-mini produces topic labels. |
| **Graph synthesis** | Claude 3.5 Sonnet | Requires understanding relationships between ideas — Claude excels at reasoning about conceptual connections. |
| **Edge generation** | GPT-4o-mini | Simple structured output (verb phrase + sentence). Doesn't need deep reasoning. Cost-efficient. |
| **Evidence summaries** | GPT-4o-mini | Bullet-point extraction. Simple task. |
| **Graph summaries** | GPT-4o-mini | Brief narrative. Simple task. |
| **Node suggestions** | GPT-4o-mini | Draft quality — user can edit. |
| **Embeddings** | OpenAI text-embedding-3-small | Best cost/quality ratio for semantic search. No reason to switch. |

### Why Claude for the insight-heavy tasks:

- Claude excels at understanding **emotional subtext** and **personal meaning** — exactly what makes nodes feel like "externalized memory" rather than topic labels.
- Claude produces more **naturalistic, essay-like** titles ("Finding Myself Through Heer and Jordan") vs GPT-4o-mini's tendency toward academic labels ("Exploring the Impact of Rockstar").
- Claude's synthesis is more **holistic** — it sees the forest, not just the trees.

### Why GPT-4o-mini for structured/simple tasks:

- Faster and cheaper for tasks that don't require deep insight
- Adequate for structured JSON output (edge generation, evidence bullets)
- Cost control: ~10x cheaper than Claude per token

## Migration Steps

1. ✅ AI abstraction layer created (`src/lib/ai/`)
2. ⬜ Install Anthropic SDK: `npm i @anthropic-ai/sdk`
3. ⬜ Add `ANTHROPIC_API_KEY` to `.env.local` and Vercel
4. ⬜ Set env vars to route tasks to appropriate models
5. ⬜ Migrate call sites to use `src/lib/ai/` functions instead of direct OpenAI
6. ⬜ Run benchmarks comparing current (GPT-4o-mini) vs recommended (Claude mix)
7. ⬜ Deploy with optimized model routing

## Benchmark Instructions

### Running benchmarks:

```bash
# 1. Set up both API keys in .env.local
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...

# 2. Run the same conversation through both providers
# Use /api/debug/benchmark?id=<conversationId> to score existing graphs

# 3. For side-by-side comparison:
# - Set AI_PROVIDER=openai, run conversation, score
# - Set AI_PROVIDER=anthropic, run same conversation, score
# - Compare scores
```

### Scoring dimensions:
- Title quality (1-5): insight vs topic label
- Summary quality (1-5): conclusion vs replay
- Edge quality (1-5): semantic relationship vs "related"
- Segmentation (1-5): natural chapters vs fragments
- Recall test (1-5): can you understand the journey from the graph alone?

## Cost Estimate

| Task | GPT-4o-mini | Claude 3.5 Sonnet |
|------|-------------|-------------------|
| Chat (per response) | ~$0.0003 | ~$0.003 |
| Node generation | ~$0.0005 | ~$0.005 |
| Edge generation | ~$0.0002 | ~$0.002 |
| Synthesis pass | ~$0.0005 | ~$0.005 |
| Embedding | ~$0.00002 | N/A |
| **Per materialization** | ~$0.002 | ~$0.015 |

At ~2-3 materializations per conversation, the Claude mix adds ~$0.03-0.05 per conversation vs ~$0.005 with GPT-4o-mini. Easily within acceptable cost for a premium product.
