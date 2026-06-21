// MemoryRetrievalEngine — unified entry point for memory search.
//
// Phase H root re-design (Codex review out 2026-05-19 + perf-test report v1).
// Replaces the three divergent entry points (MemorySearchTool /
// findRelevantMemories / distillVerifier) with a single contract that
// preserves their semantics through `mode` while making the 5 internal
// stages explicit:
//
//   [1] gate        — absolute relevance gate (BM25 + screening)
//   [2] candidates  — generate retrieval candidates
//   [3] score       — relevance score (raw, no popularity)
//   [4] fuse        — merge / dedupe by topicPath / source
//   [5] observe     — telemetry emission (no rank impact)
//
// Phase H-1 deliverable: contract + Zod schema + default impl that
// wraps existing `searchMemoryWithScreening` so the surface is callable
// while Phase H-2/H-3/H-4 progressively migrate internals.

import { z } from 'zod/v4'
import { logScreeningEvent } from '../screening/screeningLog.js'
import { searchMemoryWithScreening, type SearchResult } from '../screening/memorySearch.js'
import { getScreeningConfig } from '../screening/screeningConfig.js'
import {
  screenMultiResolution,
  type MultiResolutionConfig,
} from '../screening/multiResolutionScreening.js'
import { scanMemoryFiles } from '../screening/scanMemoryFiles.js'
import { getDefaultSearchCache } from '../screening/searchCache.js'
import type { MemoryHeaderLike } from '../screening/memoryScreening.js'
import {
  readConceptGraph,
  augmentQueryWithConcepts,
} from './conceptGraph.js'
import { readResidualIndex } from './residualIndex.js'
import { topicPathForEntry } from './topicPathForEntry.js'
import {
  isPrivateEntry,
  isPrivatePath,
  shouldIncludePrivate,
} from './memoryPrivacy.js'
import {
  CorpusManifestSchema,
  getDefaultCorpusManifest,
  type CorpusManifest,
} from './CorpusManifest.js'

// ---------------------------------------------------------------------------
// Zod schemas (runtime validation + type inference)
// ---------------------------------------------------------------------------

export const RetrievalModeSchema = z.enum(['tool', 'multiResolution', 'verify'])
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>

export const SortBySchema = z.enum(['raw', 'usage'])
export type SortBy = z.infer<typeof SortBySchema>

export const RetrievalOptionsSchema = z.object({
  mode: RetrievalModeSchema.default('tool'),
  maxResults: z.number().int().min(1).max(200).default(10),
  /** When false, skip telemetry side-effects (stats writes / hit recording).
   *  Default matches Codex P1-1 "verifier path" philosophy. */
  observe: z.boolean().default(false),
  /** Codex P0-1 fix: default ranking is `raw` (BM25 + screening only),
   *  caller opts into `usage` for the legacy popularity-weighted ordering. */
  sortBy: SortBySchema.default('raw'),
  /** Phase 2 iter 2 — optional corpus boundary threaded into the active gate.
   *  When unset, the gate falls back to its own default (Path A keeps the bare
   *  `getDefaultCorpusManifest`, Path C overrides with `logs` excluded). */
  corpus: CorpusManifestSchema.optional(),
})
export type RetrievalOptions = z.infer<typeof RetrievalOptionsSchema>

/** Caller-supplied side data for `retrieve`. Separate from
 *  `RetrievalOptions` (which is Zod-validated and emitted in diagnostics)
 *  because `preScanned` is a heavyweight in-memory array. */
export type RetrievalSideData = {
  /** Pre-scanned memory headers passed through to the gate via
   *  `GateContext.preScanned` (see `findRelevantMemories` for the canonical
   *  caller that avoids double-scan by supplying this). */
  preScanned?: MemoryHeaderLike[]
}

export const RetrievalCandidateSchema = z.object({
  /** Topic-relative path (e.g. `topics/architecture.md`). */
  topicPath: z.string(),
  /** Absolute file path on disk (kept for downstream Read tool integration). */
  filePath: z.string(),
  /** Entry IDs from the residual index whose canonical topicPath equals
   *  `topicPath`. Empty when the hit is a file-layer or log-line result
   *  with no entry-layer mapping. */
  entryIds: z.array(z.string()).default([]),
  /** Relevance score from gate + score stages only (Codex P0-1 fix:
   *  popularity is NOT folded in here). */
  rawRelevanceScore: z.number(),
  /** Legacy `rawRelevanceScore × usageMultiplier(stats)`. Kept for
   *  backward compatibility with callers that opted into `sortBy: 'usage'`. */
  usageAdjustedScore: z.number(),
  /** Origin of the candidate so observability can attribute drift. */
  source: z.enum(['entry-bm25', 'file-bm25', 'log-line', 'literal', 'legacy']),
  /** Concept tags attached to the entry / file, if known. */
  concepts: z.array(z.string()).default([]),
  /** Snippet preview (first ~300 chars). */
  snippet: z.string().default(''),
})
export type RetrievalCandidate = z.infer<typeof RetrievalCandidateSchema>

export const RetrievalResultSchema = z.object({
  hits: z.array(RetrievalCandidateSchema),
  diagnostics: z.object({
    mode: RetrievalModeSchema,
    sortBy: SortBySchema,
    totalCandidates: z.number().int().min(0),
    afterGate: z.number().int().min(0),
    afterFuse: z.number().int().min(0),
    durationMs: z.number().min(0),
  }),
})
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>

// ---------------------------------------------------------------------------
// Stage interfaces — strategy plug points for future extensions
// (LLM reranker, semantic candidate generator, etc.).
//
// Phase H-1 ships exactly one implementation of each stage: the default
// BM25 + screening pipeline. Phase H-3 / H-4 will refactor the default
// to expose raw vs usage scores separately. Phase H+1 sprints may add
// alternative strategies behind the same interface without changing
// `MemoryRetrievalEngine.retrieve`.
// ---------------------------------------------------------------------------

export interface RetrievalStage {
  readonly name: string
}

/** Context the engine threads through `GateStrategy.gate` so callers can
 *  share work that would otherwise duplicate in the gate (e.g.,
 *  `MemoryHeaderLike[]` already scanned by `findRelevantMemories`). All
 *  fields are optional; gates that ignore the context behave exactly as
 *  the 2-arg form (engine remains backward compatible). */
export type GateContext = {
  /** Optional pre-scanned memory headers (already filtered for privacy
   *  and `alreadySurfaced`, with forward-slash normalized filenames). When
   *  provided the gate MAY skip its own `scanMemoryFiles` call.
   *
   *  Caller contract: pre-scanned lists must have ALREADY been filtered by
   *  the active corpus manifest (see `findRelevantMemories` for the canonical
   *  caller that does this). The gate trusts this and does NOT re-filter. */
  preScanned?: MemoryHeaderLike[]
  /** Optional corpus boundary. Gates that scan internally MUST pass this
   *  manifest down to `scanMemoryFiles` / `readMemoryFiles`. When omitted,
   *  the gate falls back to its own default. */
  corpus?: CorpusManifest
}

export interface GateStrategy extends RetrievalStage {
  /** Run the absolute relevance gate. Returns whatever passed the threshold,
   *  with raw scores ONLY (no popularity). Implementations MAY enrich with
   *  entryIds / concepts as a side effect of accessing the residual index. */
  gate(memoryDir: string, query: string, ctx?: GateContext): Promise<RetrievalCandidate[]>
}

export interface ScoreStrategy extends RetrievalStage {
  /** Refine scores for the gate-passing candidates. Idempotent w.r.t. `gate`
   *  output — most strategies will be a no-op here unless they re-score
   *  (e.g. RRF fusion, LLM semantic rerank).
   *
   *  Phase 3 iter 3 (memory-search-improvement-loop saga) made this async so
   *  out-of-process scorers (LLM rerankers, embedding-similarity rankers) fit
   *  the same contract as the in-process default. Legacy sync NoopScoreStrategy
   *  resolves immediately so the call cost stays effectively zero. */
  score(candidates: RetrievalCandidate[], query: string): Promise<RetrievalCandidate[]>
}

export interface FuseStrategy extends RetrievalStage {
  /** Dedupe / merge candidates from possibly multiple gate strategies. */
  fuse(candidates: RetrievalCandidate[]): RetrievalCandidate[]
}

export interface ObserveStrategy extends RetrievalStage {
  /** Emit telemetry. MUST NOT mutate `result`. Side effects (stats writes)
   *  are gated by `options.observe`. */
  observe(result: RetrievalResult, query: string, options: RetrievalOptions): Promise<void>
}

// ---------------------------------------------------------------------------
// Default strategy implementations
//
// `DefaultBm25ScreeningGate` thin-wraps the legacy `searchMemoryWithScreening`
// so existing call-sites can migrate without behaviour change. Phase H-3
// will refactor this so the gate returns raw relevance only, and the
// engine combines with `usageAdjustedScore` per `options.sortBy`.
// ---------------------------------------------------------------------------

export class DefaultBm25ScreeningGate implements GateStrategy {
  readonly name = 'bm25-screening'

  async gate(memoryDir: string, query: string, ctx: GateContext = {}): Promise<RetrievalCandidate[]> {
    const cfg = getScreeningConfig()
    const legacy = await searchMemoryWithScreening(memoryDir, query, {
      threshold: cfg.searchThreshold,
      maxResults: cfg.searchMaxResults,
    }, { manifest: ctx.corpus ?? getDefaultCorpusManifest() })
    // Enrich each legacy SearchResult with entryIds via the residual index.
    // Saga 11 engine-cache-layer: dedup the per-call residual index read.
    // memorySearch.ts already caches this same blob; both callers share the
    // cache entry so the second call inside one search is a hit.
    const idx = await getDefaultSearchCache()
      .getBlob(memoryDir, 'residualIndex', () => readResidualIndex(memoryDir))
      .catch(() => null)
    const includePrivate = shouldIncludePrivate()
    const pathToEntryIds = new Map<string, string[]>()
    if (idx) {
      for (const entry of Object.values(idx.entries ?? {})) {
        if (!includePrivate && isPrivateEntry(entry)) continue
        const tp = topicPathForEntry(entry)
        const list = pathToEntryIds.get(tp) ?? []
        list.push(entry.id)
        pathToEntryIds.set(tp, list)
      }
    }
    return legacy.map((r): RetrievalCandidate => ({
      topicPath: r.path,
      filePath: r.filePath,
      entryIds: pathToEntryIds.get(r.path) ?? [],
      // Phase H-3: searchMemoryWithScreening now surfaces `rawScore`
      // (BM25 + screening, no popularity). When absent (log-line / literal
      // fallback hits) the two scores are equal by construction.
      rawRelevanceScore: r.rawScore ?? r.score,
      usageAdjustedScore: r.score,
      source: mapLegacySource(r.source),
      concepts: r.concepts ?? [],
      snippet: r.snippet,
    }))
  }
}

function mapLegacySource(s: SearchResult['source']): RetrievalCandidate['source'] {
  switch (s) {
    case 'bm25': return 'entry-bm25'
    case 'log-line': return 'log-line'
    case 'literal': return 'literal'
    case 'tfidf': return 'legacy'
    default: return 'legacy'
  }
}

// ---------------------------------------------------------------------------
// MultiResolutionScreeningGate — Phase 1 iter 1
// (`memory-search-improvement-loop` saga).
//
// Wraps the existing `findRelevantMemories` Stage 0 + Stage 1 (concept
// expansion + multi-resolution screening) under the `GateStrategy` contract.
// Drops the legacy Sonnet selector — that lives outside the gate as an
// engine-external post-processor (handoff Decision #3).
//
// The crucial behavior change vs the legacy `findRelevantMemories` path is
// **forward-slash normalization** of every `MemoryHeaderLike.filename` before
// `screenMultiResolution` runs. On Windows, `readdir({ recursive: true })`
// emits backslash-separated relative paths, while `topicPathForEntry()` and
// `entry.sources` are always forward-slash. The mismatch caused
// `screenByConcepts` and `screenByTopicSummary` to look up backslash keys in
// forward-slash maps → both resolutions returned 0 matches on Windows, and
// the bench's `filenameToEntryIds` lookup missed every hierarchical-topic
// hit → Path C strict Recall@5 = 0% (six-axis-v0).
//
// Normalizing inside the gate fixes both layers in one place. The output
// `RetrievalCandidate.topicPath` is the normalized filename, so downstream
// consumers (engine fuse, bench mapping, Sonnet selector) all see the
// canonical path representation.
// ---------------------------------------------------------------------------

export class MultiResolutionScreeningGate implements GateStrategy {
  readonly name = 'multi-resolution-screening'

  async gate(
    memoryDir: string,
    query: string,
    ctx: GateContext = {},
  ): Promise<RetrievalCandidate[]> {
    const screeningCfg = getScreeningConfig()

    // Stage 0: concept expansion — best-effort, graph absence is non-fatal.
    let expandedQuery = query
    try {
      const graph = await readConceptGraph(memoryDir)
      if (Object.keys(graph.concepts).length > 0) {
        expandedQuery = augmentQueryWithConcepts(query, graph)
        if (expandedQuery !== query) {
          logScreeningEvent('engine_gate_concept_expansion', {
            original: query.slice(0, 100),
            expanded: expandedQuery.slice(0, 200),
          })
        }
      }
    } catch {
      // Concept graph not available — proceed with raw query.
    }

    // Honor a pre-scanned list from the caller when supplied (avoids
    // double-scan when `findRelevantMemories` already walked the dir). The
    // caller contract (GateContext.preScanned doc) says the list is already
    // manifest-filtered, so we trust it. When scanning ourselves we MUST
    // pass the corpus down so the gate's own scan matches the caller's intent.
    let memories: MemoryHeaderLike[]
    if (ctx.preScanned) {
      memories = ctx.preScanned
    } else {
      const rawMemories = await scanMemoryFiles(memoryDir, {
        manifest: ctx.corpus ?? getDefaultCorpusManifest(),
      })
      memories = rawMemories.map(m => ({
        ...m,
        filename: m.filename.replace(/\\/g, '/'),
      }))
    }
    if (memories.length === 0) return []

    // Multi-resolution screening (content + concept + topic, RRF fused).
    const multiCfg: MultiResolutionConfig = {
      contentThreshold: screeningCfg.memoryThreshold,
      conceptThreshold: screeningCfg.conceptThreshold,
      topicThreshold: screeningCfg.topicThreshold,
      maxPerResolution: screeningCfg.multiResolutionMaxPerResolution,
      maxResults: screeningCfg.memoryMaxResults,
      boostRecency: screeningCfg.boostRecency,
      recencyHalfLifeMs: screeningCfg.recencyHalfLifeMs,
    }
    const multi = await screenMultiResolution(
      memories,
      expandedQuery,
      multiCfg,
      memoryDir,
    )

    if (multi.memories.length === 0) return []

    // Build path → entryIds + concepts maps from the residual index. Both
    // canonical topic paths (`topicPathForEntry`) AND source file paths
    // (`entry.sources`) are indexed so the gate output can surface log-file
    // hits with the right entry attribution.
    // Saga 11 engine-cache-layer: dedup the per-call residual index read.
    // memorySearch.ts already caches this same blob; both callers share the
    // cache entry so the second call inside one search is a hit.
    const idx = await getDefaultSearchCache()
      .getBlob(memoryDir, 'residualIndex', () => readResidualIndex(memoryDir))
      .catch(() => null)
    const includePrivate = shouldIncludePrivate()
    const pathToEntryIds = new Map<string, string[]>()
    const pathToConcepts = new Map<string, string[]>()
    if (idx) {
      const recordEntry = (path: string, id: string, concepts: string[]) => {
        const idList = pathToEntryIds.get(path) ?? []
        if (!idList.includes(id)) idList.push(id)
        pathToEntryIds.set(path, idList)
        const cList = pathToConcepts.get(path) ?? []
        for (const c of concepts) if (!cList.includes(c)) cList.push(c)
        pathToConcepts.set(path, cList)
      }
      for (const entry of Object.values(idx.entries ?? {})) {
        if (!includePrivate && isPrivateEntry(entry)) continue
        const tp = topicPathForEntry(entry)
        recordEntry(tp, entry.id, entry.concepts)
        for (const source of entry.sources) {
          const filePath = source.replace(/:L\d+$/, '')
          if (!includePrivate && isPrivatePath(filePath)) continue
          recordEntry(filePath, entry.id, entry.concepts)
        }
      }
    }

    // Convert RRF-ordered memories to RetrievalCandidate[]. The internal RRF
    // fused score is not exposed by screenMultiResolution, so we use a
    // rank-derived monotonically-decreasing score that preserves ordering
    // through the engine's `sortBy: 'raw'` sort. (Phase 1 iter 2+ can plumb
    // the fused score directly if needed.)
    return multi.memories.map((m, rank): RetrievalCandidate => {
      const rankScore = 1 / (rank + 1)
      return {
        topicPath: m.filename,
        filePath: m.filePath,
        entryIds: pathToEntryIds.get(m.filename) ?? [],
        rawRelevanceScore: rankScore,
        usageAdjustedScore: rankScore,
        source: 'file-bm25',
        concepts: pathToConcepts.get(m.filename) ?? [],
        snippet: (m.contentSnippet ?? m.description ?? '').slice(0, 300),
      }
    })
  }
}

export class NoopScoreStrategy implements ScoreStrategy {
  readonly name = 'noop-score'
  async score(candidates: RetrievalCandidate[]): Promise<RetrievalCandidate[]> {
    return candidates
  }
}

export class TopicPathFuseStrategy implements FuseStrategy {
  readonly name = 'topicPath-fuse'
  fuse(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    const byPath = new Map<string, RetrievalCandidate>()
    for (const c of candidates) {
      const cur = byPath.get(c.topicPath)
      if (!cur) byPath.set(c.topicPath, c)
      else if (c.rawRelevanceScore > cur.rawRelevanceScore) {
        // Merge entryIds + concepts so the winning bucket carries both
        const merged: RetrievalCandidate = {
          ...c,
          entryIds: Array.from(new Set([...cur.entryIds, ...c.entryIds])),
          concepts: Array.from(new Set([...cur.concepts, ...c.concepts])),
        }
        byPath.set(c.topicPath, merged)
      } else {
        cur.entryIds = Array.from(new Set([...cur.entryIds, ...c.entryIds]))
        cur.concepts = Array.from(new Set([...cur.concepts, ...c.concepts]))
      }
    }
    return [...byPath.values()]
  }
}

export class PipelineEventObserver implements ObserveStrategy {
  readonly name = 'pipeline-event'
  async observe(result: RetrievalResult, query: string, options: RetrievalOptions): Promise<void> {
    // Codex P1-1 reflection: emit pipeline_used event so retroactive analysis
    // can attribute behaviour to a specific retrieval path. NOT a stats write.
    logScreeningEvent('pipeline_used', {
      mode: options.mode,
      sortBy: options.sortBy,
      observe: options.observe,
      hitCount: result.hits.length,
      topScore: result.hits[0]?.rawRelevanceScore ?? 0,
      queryPreview: query.slice(0, 100),
    })
  }
}

// ---------------------------------------------------------------------------
// MemoryRetrievalEngine — orchestrates the 5 stages.
//
// `retrieve` is the single entry point. Callers compose the engine once
// and reuse it; injected strategies stay live for the lifetime of the
// engine, which keeps observability cheap (no re-import / re-init per
// query).
// ---------------------------------------------------------------------------

export type RetrievalEngineConfig = {
  /** Fallback gate used when `gateByMode` has no entry for the active mode. */
  gate?: GateStrategy
  /** Per-mode gate override. Defaults wire `multiResolution` →
   *  `MultiResolutionScreeningGate`. Callers can pass a partial map to
   *  override a single mode while inheriting the rest. */
  gateByMode?: Partial<Record<RetrievalMode, GateStrategy>>
  score?: ScoreStrategy
  fuse?: FuseStrategy
  observer?: ObserveStrategy
}

export class MemoryRetrievalEngine {
  readonly gate: GateStrategy
  readonly gateByMode: Partial<Record<RetrievalMode, GateStrategy>>
  readonly scorer: ScoreStrategy
  readonly fuser: FuseStrategy
  readonly observer: ObserveStrategy

  constructor(config: RetrievalEngineConfig = {}) {
    this.gate = config.gate ?? new DefaultBm25ScreeningGate()
    // Default mode-specific gates. Caller-supplied entries win per mode;
    // any mode without a mapping falls back to `this.gate` at dispatch time.
    this.gateByMode = {
      multiResolution: new MultiResolutionScreeningGate(),
      ...(config.gateByMode ?? {}),
    }
    this.scorer = config.score ?? new NoopScoreStrategy()
    this.fuser = config.fuse ?? new TopicPathFuseStrategy()
    this.observer = config.observer ?? new PipelineEventObserver()
  }

  /** Resolve the gate to invoke for `mode`. Mode-specific override wins,
   *  fallback to `this.gate` so legacy callers (default `tool` mode) keep
   *  the historical `DefaultBm25ScreeningGate` path. */
  private gateForMode(mode: RetrievalMode): GateStrategy {
    return this.gateByMode[mode] ?? this.gate
  }

  async retrieve(
    memoryDir: string,
    query: string,
    options: Partial<RetrievalOptions> = {},
    sideData: RetrievalSideData = {},
  ): Promise<RetrievalResult> {
    const opts = RetrievalOptionsSchema.parse(options)
    const startedAt = Date.now()

    if (!query.trim()) {
      const empty: RetrievalResult = {
        hits: [],
        diagnostics: {
          mode: opts.mode, sortBy: opts.sortBy,
          totalCandidates: 0, afterGate: 0, afterFuse: 0,
          durationMs: 0,
        },
      }
      return empty
    }

    // [1] gate — absolute relevance threshold (mode-dispatched). The
    // gate receives a context object so callers that already scanned the
    // memory dir can let the gate skip the duplicate I/O. `opts.corpus`
    // (Phase 2 iter 2) threads through here so gates that scan internally
    // can apply the boundary.
    const activeGate = this.gateForMode(opts.mode)
    const gated = await activeGate.gate(memoryDir, query, {
      preScanned: sideData.preScanned,
      corpus: opts.corpus,
    })

    // [2] candidates already inside gate output for Phase H-1
    // [3] score — refine (no-op default). Phase 3 iter 3 made this async so
    //     LLM rerankers fit the same contract as the sync default.
    const scored = await this.scorer.score(gated, query)

    // [4] fuse — dedupe by topicPath
    const fused = this.fuser.fuse(scored)

    // Sort: raw (default, Codex P0-1 fix) vs usage (legacy compat)
    const sortKey = opts.sortBy === 'raw' ? 'rawRelevanceScore' : 'usageAdjustedScore'
    fused.sort((a, b) => b[sortKey] - a[sortKey])
    const limited = fused.slice(0, opts.maxResults)

    const result: RetrievalResult = {
      hits: limited,
      diagnostics: {
        mode: opts.mode,
        sortBy: opts.sortBy,
        totalCandidates: gated.length,
        afterGate: gated.length,
        afterFuse: fused.length,
        durationMs: Date.now() - startedAt,
      },
    }

    // [5] observe — telemetry (does not mutate result)
    await this.observer.observe(result, query, opts)

    return result
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton — most callers want a shared instance. Tests can
// always `new MemoryRetrievalEngine({...})` with custom strategies.
// ---------------------------------------------------------------------------

let _defaultEngine: MemoryRetrievalEngine | null = null

export function getDefaultEngine(): MemoryRetrievalEngine {
  if (!_defaultEngine) _defaultEngine = new MemoryRetrievalEngine()
  return _defaultEngine
}
