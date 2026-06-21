// LlmRerankerScoreStrategy — Phase 3 iter 3 (memory-search-improvement-loop saga).
//
// Plugs into `MemoryRetrievalEngine.scorer` slot to apply LLM-driven semantic
// reranking + diversity-aware top-K selection on top of the gate's RRF-fused
// candidates. Designed to lift Path C strict Recall@5 (Phase 2 baseline 52.9%
// → target ≥80%) AND drop Diversity max-exposure (Phase 2 baseline 86.7% on
// `topics/troubleshooting-relvetia.md` → target <60%) in one strategy.
//
// Decoupling contract: this module lives in `relvetia-extracted` (zero
// Anthropic SDK dependency). The actual LLM call is injected via an
// `LlmAdapter` interface — concrete implementations live in `relvetia-daemon`
// where the SDK is available, and the benchmark runner wires them together
// at the entry-point. The default adapter (`NullLlmAdapter`) is a passthrough
// so the strategy behaves exactly like `NoopScoreStrategy` when no adapter is
// supplied — keeping legacy callers safe.
//
// Phase 3-1 ships the skeleton (interface + Zod config schema + passthrough).
// Phase 3-2 ships the real Anthropic adapter + weighted score combination +
// per-file diversity cap. Phase 3-3 wires the strategy through the engine
// constructor + entry-point pass-through.

import { z } from 'zod/v4'
import type {
  RetrievalCandidate,
  ScoreStrategy,
} from '../memory/MemoryRetrievalEngine.js'
import { logScreeningEvent } from './screeningLog.js'

// ---------------------------------------------------------------------------
// Adapter contract — pluggable LLM call boundary
//
// `rerank()` receives the gate-passing candidates (already RRF-ordered) and
// returns an array of the same length where each entry carries a semantic
// score in [0, 1]. The strategy combines this with the gate's RRF score
// (`rawRelevanceScore`) per `config.llmWeight` before applying diversity.
//
// Adapters MUST be deterministic for the same (query, candidates) input
// within a single benchmark run (LLM-call jitter is acceptable across runs;
// non-deterministic adapters break the consecutive-sprint stability check).
// ---------------------------------------------------------------------------

export type LlmRerankItem = {
  /** Index into the input `candidates` array. Adapters MUST return one
   *  entry per input candidate; missing indices = adapter dropped them
   *  (treated as score 0 by the strategy). */
  index: number
  /** Semantic relevance score in [0, 1]. Higher = more relevant. */
  semanticScore: number
}

export interface LlmAdapter {
  readonly name: string
  /** Rerank the supplied candidates. Returns one `LlmRerankItem` per input
   *  candidate (order does not matter — the strategy re-sorts). May throw
   *  on transient failure; the strategy catches and falls back to the
   *  gate-only ordering (graceful degrade, Verify-first §5). */
  rerank(
    query: string,
    candidates: RetrievalCandidate[],
  ): Promise<LlmRerankItem[]>
}

/** Default passthrough adapter — returns every input candidate at the
 *  semantic score implied by its current rank (1 / (rank + 1), matching the
 *  RRF-derived scoring contract from `MultiResolutionScreeningGate`). With
 *  this adapter, the strategy reduces to `NoopScoreStrategy` semantically.
 *  Used as the safety default and as the unit-test baseline. */
export class NullLlmAdapter implements LlmAdapter {
  readonly name = 'null-llm-adapter'
  async rerank(
    _query: string,
    candidates: RetrievalCandidate[],
  ): Promise<LlmRerankItem[]> {
    return candidates.map((_, index) => ({
      index,
      semanticScore: 1 / (index + 1),
    }))
  }
}

// ---------------------------------------------------------------------------
// Zod config schema (runtime validation + type inference)
//
// Defaults track the orchestrator's Decisions for Phase 3 (handoff gen-0004
// §Open questions Q1-Q4):
//   - topNRerank=20    : gate output top-20 fed to the LLM
//   - llmWeight=0.6    : 60% LLM semantic + 40% gate RRF (weighted sum)
//   - diversityCap=2   : max 2 results per topic file in top-K
//   - llmModel="claude-haiku-4-5-20251001"  (cost-effective, low latency)
//   - timeoutMs=5000   : adapter timeout (per-query budget guard)
//   - mode="hybrid"    : Phase 3 Option (E) = LLM rerank + per-file cap
//                        (see handoff §Architecture table)
// ---------------------------------------------------------------------------

export const LlmRerankerModeSchema = z.enum(['llm-only', 'cap-only', 'hybrid'])
export type LlmRerankerMode = z.infer<typeof LlmRerankerModeSchema>

export const LlmRerankerConfigSchema = z.object({
  /** How many top gate candidates to feed the LLM. Larger N = more
   *  semantic coverage but linear cost / latency. */
  topNRerank: z.number().int().min(1).max(100).default(20),
  /** Weighted blend coefficient for combining LLM semantic score with
   *  gate RRF score. `final = llmWeight * llm + (1 - llmWeight) * gate`. */
  llmWeight: z.number().min(0).max(1).default(0.6),
  /** Maximum candidates per topic file path in the strategy output.
   *  Implements the per-file exposure cap (handoff Option E) to break the
   *  `topics/troubleshooting-relvetia.md × 52/60` dominance pattern. */
  diversityCap: z.number().int().min(1).max(20).default(2),
  /** Anthropic model id passed to the adapter. */
  llmModel: z.string().default('claude-haiku-4-5-20251001'),
  /** Per-query timeout (ms) for the LLM rerank call. Exceeding triggers
   *  graceful degrade to gate-only ordering. */
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  /** Strategy mode: 'llm-only' skips the cap; 'cap-only' skips the LLM
   *  (deterministic per-file diversity); 'hybrid' applies both. */
  mode: LlmRerankerModeSchema.default('hybrid'),
})
export type LlmRerankerConfig = z.infer<typeof LlmRerankerConfigSchema>

// ---------------------------------------------------------------------------
// LlmRerankerScoreStrategy — Phase 3 impl
//
// Phase 3-1 (`4ceb14e`) shipped the skeleton (interface + Zod config +
// passthrough). Phase 3-2 (this file) lights up:
//
//   1. **Mode dispatch** (`config.mode`):
//        - `'llm-only'` → LLM rerank only (no per-file cap; legacy ordering
//          where duplicates are allowed; useful for A/B isolating the
//          semantic-rerank contribution from the diversity contribution)
//        - `'cap-only'` → deterministic per-file cap with no LLM call (zero
//          API cost; useful for isolating the diversity contribution)
//        - `'hybrid'`   → both. Phase 3 Option (E) "Hybrid LLM + per-file
//          exposure cap" from handoff §Architecture
//
//   2. **Weighted combination** (`config.llmWeight`):
//        final = llmWeight × normalized(llmScore) + (1 - llmWeight) × normalized(gateScore)
//        Both scores normalized to [0,1] so the blend is meaningful across
//        different gate scoring schemes (RRF, BM25, identity).
//
//   3. **Per-file exposure cap** (`config.diversityCap`):
//        After rerank/score, walk results in descending score order. Each
//        `topicPath` is allowed at most `config.diversityCap` entries in the
//        "promoted" tier; 3rd+ hits get demoted (negative bias) so they
//        fall behind other-topic hits in the engine's final sort. Breaks
//        the `topics/troubleshooting-relvetia.md × 52/60` dominance pattern
//        observed in baseline-v2 Path C (max-exposure 86.7%).
//
//   4. **Graceful degrade** (Verify-first §5):
//        Adapter throw / timeout / parse error → fall back to gate-only
//        ordering AND emit `logScreeningEvent('llm_reranker_fallback', ...)`
//        with the failure reason. Silent-fail invariant from
//        `relvetia-operations.md` (Phase H S-tier lesson) maintained.
//
// The benchmark wires the real Anthropic adapter in Phase 3-3.
// ---------------------------------------------------------------------------

export type LlmRerankerOptions = {
  /** Concrete LLM adapter. Defaults to `NullLlmAdapter` (passthrough). */
  adapter?: LlmAdapter
  /** Partial config — merged with `LlmRerankerConfigSchema` defaults. */
  config?: Partial<LlmRerankerConfig>
}

export class LlmRerankerScoreStrategy implements ScoreStrategy {
  readonly name = 'llm-reranker'
  readonly adapter: LlmAdapter
  readonly config: LlmRerankerConfig

  constructor(opts: LlmRerankerOptions = {}) {
    this.adapter = opts.adapter ?? new NullLlmAdapter()
    this.config = LlmRerankerConfigSchema.parse(opts.config ?? {})
  }

  async score(
    candidates: RetrievalCandidate[],
    query: string,
  ): Promise<RetrievalCandidate[]> {
    if (candidates.length === 0) return candidates

    // Split into "to rerank" (top-N) and "tail" (pass through untouched).
    // This bounds LLM cost while preserving the gate's long-tail visibility
    // for downstream fuse + sort.
    const headCount = Math.min(this.config.topNRerank, candidates.length)
    const head = candidates.slice(0, headCount)
    const tail = candidates.slice(headCount)

    // Mode dispatch (handoff gen-0004 §Architecture table options).
    let rerankedHead: RetrievalCandidate[]
    if (this.config.mode === 'cap-only') {
      // Skip LLM call entirely. Head + tail pass through unchanged before cap.
      rerankedHead = head
    } else {
      // mode = 'llm-only' or 'hybrid' — invoke adapter.
      rerankedHead = await this.applyLlmRerank(head, query)
    }

    const combined = [...rerankedHead, ...tail]

    if (this.config.mode === 'llm-only') {
      // No diversity cap. Return rescored ordering; engine's final sort
      // by rawRelevanceScore drives the actual top-K selection.
      return combined
    }

    // mode = 'cap-only' or 'hybrid' — apply per-file diversity cap.
    return this.applyPerFileCap(combined)
  }

  /** Invoke the adapter, blend semantic score with gate score, and surface
   *  the result. On adapter failure, log + return the input unchanged. */
  private async applyLlmRerank(
    head: RetrievalCandidate[],
    query: string,
  ): Promise<RetrievalCandidate[]> {
    let rerankItems: LlmRerankItem[]
    try {
      rerankItems = await this.adapter.rerank(query, head)
    } catch (err) {
      logScreeningEvent('llm_reranker_fallback', {
        reason: err instanceof Error ? err.message : String(err),
        adapter: this.adapter.name,
        mode: this.config.mode,
        headCount: head.length,
        query: query.slice(0, 100),
      })
      return head
    }

    const semanticByIndex = new Map<number, number>()
    for (const item of rerankItems) {
      semanticByIndex.set(item.index, item.semanticScore)
    }

    // Normalize gate scores to [0,1] across the head so the weighted blend
    // is on a comparable axis with the semantic [0,1] adapter output.
    const gateMax = Math.max(
      ...head.map((c) => c.rawRelevanceScore),
      Number.EPSILON,
    )

    return head.map((c, index) => {
      const semanticScore = semanticByIndex.get(index)
      const gateNorm = c.rawRelevanceScore / gateMax
      const blended =
        semanticScore !== undefined
          ? this.config.llmWeight * semanticScore +
            (1 - this.config.llmWeight) * gateNorm
          : gateNorm
      return {
        ...c,
        rawRelevanceScore: blended,
        usageAdjustedScore: blended,
      }
    })
  }

  /** Walk results in descending score order; demote the 3rd+ occurrence of
   *  each `topicPath` so the engine's final sort pushes them behind
   *  other-topic candidates. Demotion uses a negative offset rather than
   *  removal so observability events (`PipelineEventObserver`) still see
   *  the full candidate set. */
  private applyPerFileCap(
    candidates: RetrievalCandidate[],
  ): RetrievalCandidate[] {
    // Sort descending for cap walk; we'll let the engine re-sort by
    // `sortBy` after (it's idempotent because we only mutate
    // `rawRelevanceScore` / `usageAdjustedScore`).
    const sorted = [...candidates].sort(
      (a, b) => b.rawRelevanceScore - a.rawRelevanceScore,
    )

    const seenPerPath = new Map<string, number>()
    const out: RetrievalCandidate[] = []
    let demoted = 0
    for (const c of sorted) {
      const count = seenPerPath.get(c.topicPath) ?? 0
      seenPerPath.set(c.topicPath, count + 1)
      if (count < this.config.diversityCap) {
        out.push(c)
      } else {
        // Subtract a fixed offset slightly greater than the largest possible
        // [0,1] score so the demoted entry strictly falls behind every
        // first-K hit of any topic. Tie-broken by original score within the
        // demoted tier (stable monotonicity inside the demoted bucket).
        demoted++
        out.push({
          ...c,
          rawRelevanceScore: c.rawRelevanceScore - 2,
          usageAdjustedScore: c.usageAdjustedScore - 2,
        })
      }
    }

    if (demoted > 0) {
      logScreeningEvent('llm_reranker_diversity_cap', {
        cap: this.config.diversityCap,
        demoted,
        uniquePaths: seenPerPath.size,
        totalCandidates: candidates.length,
      })
    }

    return out
  }
}
