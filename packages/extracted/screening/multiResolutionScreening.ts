// Multi-resolution screening — inspired by PHOTON's hierarchical approach.
//
// PHOTON processes information at multiple resolutions simultaneously
// (chunk → context state → local window). This module applies the same
// principle to memory search: screen at multiple abstraction levels and
// union the results.
//
// Resolution levels:
//   1. Raw content  — original file text (current behavior)
//   2. Concept tags — normalized keywords from the residual index
//   3. Topic summary — topic-level summaries from MEMORY.md or topic files
//
// Each resolution uses its own threshold (more abstract = more lenient),
// and results are unioned + deduplicated before passing to Stage 2 (Sonnet).
//
// This addresses the vocabulary mismatch problem: a query for
// "パッケージマネージャ" won't match raw text about "bun", but will match
// the concept tag "package-manager" at the concept resolution level.

import {
  screenItems,
  screenItemsBM25,
  type ScreeningConfig,
  type ScoredItem,
} from './screening.js'
import {
  readResidualIndex,
  entryToSearchText,
  allConcepts,
  findByConcepts,
  type ResidualIndex,
  type ResidualEntry,
} from '../memory/residualIndex.js'
import {
  isPrivateEntry,
  isPrivatePath,
  shouldIncludePrivate,
} from '../memory/memoryPrivacy.js'
import { topicPathForEntry } from '../memory/topicPathForEntry.js'
import { type MemoryHeaderLike } from './memoryScreening.js'
import { logScreeningEvent } from './screeningLog.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MultiResolutionConfig = {
  /** Threshold for raw content screening (strictest). */
  contentThreshold: number
  /** Threshold for concept tag screening (medium). */
  conceptThreshold: number
  /** Threshold for topic summary screening (most lenient). */
  topicThreshold: number
  /** Max results per resolution before union. */
  maxPerResolution: number
  /** Final max results after union + dedup. */
  maxResults: number
  /** Recency boost settings. */
  boostRecency: boolean
  recencyHalfLifeMs: number
}

export type MultiResolutionResult = {
  /** Memory headers that passed at least one resolution. */
  memories: MemoryHeaderLike[]
  /** Diagnostics: how many passed at each resolution. */
  diagnostics: {
    contentPassed: number
    conceptPassed: number
    topicPassed: number
    unionTotal: number
    dedupedTotal: number
  }
}

// ---------------------------------------------------------------------------
// Phase 3 T5: BM25 default with TF-IDF fallback.
// MEMORY_SEARCH_LEGACY_TFIDF=1 restores the pre-T5 TF-IDF path for emergency
// rollback. The fallback exists only because TF-IDF was the production path
// before screenItemsBM25 reached parity; remove once one full distill cycle
// has run under BM25 without regression.
// ---------------------------------------------------------------------------

function screenFn<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  cfg: ScreeningConfig,
  getAge?: (item: T) => number,
): ScoredItem<T>[] {
  return process.env.MEMORY_SEARCH_LEGACY_TFIDF === '1'
    ? screenItems(items, getText, query, cfg, getAge)
    : screenItemsBM25(items, getText, query, cfg, getAge)
}

// ---------------------------------------------------------------------------
// Resolution 1: Raw content (existing behavior, wrapped)
// ---------------------------------------------------------------------------

function screenByContent(
  memories: MemoryHeaderLike[],
  query: string,
  config: MultiResolutionConfig,
): ScoredItem<MemoryHeaderLike>[] {
  const cfg: ScreeningConfig = {
    threshold: config.contentThreshold,
    maxResults: config.maxPerResolution,
    boostRecency: config.boostRecency,
    recencyHalfLifeMs: config.recencyHalfLifeMs,
  }

  // Defense-in-depth: scanMemoryFiles already filters but a private file that
  // slips through here would taint the union below.
  const includePrivate = shouldIncludePrivate()
  const visible = includePrivate
    ? memories
    : memories.filter(m => !isPrivatePath(m.filename))

  const now = Date.now()
  return screenFn(
    visible,
    m => {
      const parts: string[] = [m.filename.replace(/[-_./]/g, ' ')]
      if (m.description) parts.push(m.description)
      if (m.contentSnippet) parts.push(m.contentSnippet)
      return parts.join(' ')
    },
    query,
    cfg,
    config.boostRecency ? (m: MemoryHeaderLike) => now - m.mtimeMs : undefined,
  )
}

// ---------------------------------------------------------------------------
// Resolution 2: Concept tags from residual index
// ---------------------------------------------------------------------------

function screenByConcepts(
  memories: MemoryHeaderLike[],
  query: string,
  index: ResidualIndex,
  config: MultiResolutionConfig,
): ScoredItem<MemoryHeaderLike>[] {
  // Build concept-augmented text for each memory
  const includePrivate = shouldIncludePrivate()
  const conceptTexts = new Map<string, string>()
  for (const entry of Object.values(index.entries)) {
    if (!includePrivate && isPrivateEntry(entry)) continue
    const text = entry.concepts.join(' ') + ' ' + entry.summary
    // Map to source files (skip private source paths so private concepts
    // cannot pollute the score of any public file that shares a path).
    for (const source of entry.sources) {
      const filePath = source.replace(/:L\d+$/, '')
      if (!includePrivate && isPrivatePath(filePath)) continue
      const existing = conceptTexts.get(filePath) ?? ''
      conceptTexts.set(filePath, existing + ' ' + text)
    }
    // Map to topic file
    const topicPath = topicPathForEntry(entry)
    if (!includePrivate && isPrivatePath(topicPath)) continue
    const existing = conceptTexts.get(topicPath) ?? ''
    conceptTexts.set(topicPath, existing + ' ' + text)
  }

  // Only screen memories that have concept data and that are themselves visible.
  const augmented = memories.filter(
    m => conceptTexts.has(m.filename) && (includePrivate || !isPrivatePath(m.filename)),
  )
  if (augmented.length === 0) return []

  const cfg: ScreeningConfig = {
    threshold: config.conceptThreshold,
    maxResults: config.maxPerResolution,
  }

  return screenFn(
    augmented,
    m => conceptTexts.get(m.filename) ?? '',
    query,
    cfg,
  )
}

// ---------------------------------------------------------------------------
// Resolution 3: Topic summaries
// ---------------------------------------------------------------------------

function screenByTopicSummary(
  memories: MemoryHeaderLike[],
  query: string,
  index: ResidualIndex,
  config: MultiResolutionConfig,
): ScoredItem<MemoryHeaderLike>[] {
  // Group entries by topic and build summary text (skip private entries).
  const includePrivate = shouldIncludePrivate()
  const topicSummaries = new Map<string, string>()
  for (const entry of Object.values(index.entries)) {
    if (!includePrivate && isPrivateEntry(entry)) continue
    const topicPath = topicPathForEntry(entry)
    if (!includePrivate && isPrivatePath(topicPath)) continue
    const existing = topicSummaries.get(topicPath) ?? ''
    topicSummaries.set(topicPath, existing + ' ' + entryToSearchText(entry))
  }

  // Propagate topic summaries to source files (skip private entries +
  // private source paths).
  const fileSummaries = new Map<string, string>()
  for (const entry of Object.values(index.entries)) {
    if (!includePrivate && isPrivateEntry(entry)) continue
    const topicSummary = topicSummaries.get(topicPathForEntry(entry)) ?? ''
    for (const source of entry.sources) {
      const filePath = source.replace(/:L\d+$/, '')
      if (!includePrivate && isPrivatePath(filePath)) continue
      const existing = fileSummaries.get(filePath) ?? ''
      fileSummaries.set(filePath, existing + ' ' + topicSummary)
    }
  }

  // Merge topic-level and file-level summaries
  const allSummaries = new Map([...topicSummaries, ...fileSummaries])

  const augmented = memories.filter(
    m => allSummaries.has(m.filename) && (includePrivate || !isPrivatePath(m.filename)),
  )
  if (augmented.length === 0) return []

  const cfg: ScreeningConfig = {
    threshold: config.topicThreshold,
    maxResults: config.maxPerResolution,
  }

  return screenFn(
    augmented,
    m => allSummaries.get(m.filename) ?? '',
    query,
    cfg,
  )
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Screen memories at multiple resolutions and union the results.
 *
 * This is the PHOTON-inspired enhancement to the existing single-resolution
 * screening. Each resolution captures different aspects:
 *   - Content: exact term matches in raw text
 *   - Concepts: normalized keyword matches via residual index
 *   - Topics: broad thematic matches at summary level
 *
 * Results are unioned (OR semantics) and deduplicated, then passed to
 * Stage 2 (Sonnet) for semantic selection.
 *
 * Falls back to content-only screening if no residual index exists.
 *
 * @param memories - Memory headers from scanMemoryFiles()
 * @param query - User query
 * @param config - Multi-resolution screening configuration
 * @param memoryDir - Path to memory directory (for loading residual index)
 * @returns Unioned, deduplicated memories that passed at least one resolution.
 */
export async function screenMultiResolution(
  memories: MemoryHeaderLike[],
  query: string,
  config: MultiResolutionConfig,
  memoryDir: string,
): Promise<MultiResolutionResult> {
  if (memories.length === 0 || !query.trim()) {
    return {
      memories: [],
      diagnostics: {
        contentPassed: 0,
        conceptPassed: 0,
        topicPassed: 0,
        unionTotal: 0,
        dedupedTotal: 0,
      },
    }
  }

  // Load residual index
  const index = await readResidualIndex(memoryDir)
  const hasIndex = Object.keys(index.entries).length > 0

  // Phase 16: run the three resolutions in parallel via Promise.all.
  // Each resolver is wrapped in an async function so that any future I/O
  // (e.g., on-disk concept cache, streamed topic embeddings) parallelizes
  // naturally. TF-IDF / BM25 work is CPU-bound and still runs on a single
  // thread, so current speedup is negligible — the win is structural:
  // failures in one resolution don't block the others, and future async
  // resolvers slot in without touching the call site.
  const [contentScored, conceptScored, topicScored] = await Promise.all([
    Promise.resolve().then(() => screenByContent(memories, query, config)),
    hasIndex
      ? Promise.resolve().then(() => screenByConcepts(memories, query, index, config))
      : Promise.resolve([] as ScoredItem<MemoryHeaderLike>[]),
    hasIndex
      ? Promise.resolve().then(() => screenByTopicSummary(memories, query, index, config))
      : Promise.resolve([] as ScoredItem<MemoryHeaderLike>[]),
  ])

  // Phase 3 T5: Reciprocal Rank Fusion (RRF). Each resolver returns a list
  // sorted by its own score; RRF fuses them by summing 1/(k+rank) per
  // resolver where the filename appears. The fused score determines the
  // final ranking — replacing the pre-T5 Set-union + input-order behavior
  // that surfaced recency-only weak matches above strong score matches
  // (fixture #2 multi-res-score-preserving).
  //
  // k=60 is the canonical default from the original RRF paper
  // (Cormack/Clarke/Buettcher 2009 "Reciprocal Rank Fusion outperforms
  // Condorcet and individual rank learning methods", SIGIR).
  const RRF_K = 60
  const fusedScores = new Map<string, number>()
  for (const layer of [contentScored, conceptScored, topicScored]) {
    layer.forEach((s, rank) => {
      // rank is 0-indexed inside the layer; RRF expects 1-indexed.
      const contribution = 1 / (RRF_K + rank + 1)
      const cur = fusedScores.get(s.item.filename) ?? 0
      fusedScores.set(s.item.filename, cur + contribution)
    })
  }

  // Order filenames by fused score descending.
  const orderedFilenames = [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([fn]) => fn)
  const orderIndex = new Map(orderedFilenames.map((fn, i) => [fn, i]))

  // Return MemoryHeaderLike objects in RRF-fused order (not input order).
  const result = memories
    .filter(m => orderIndex.has(m.filename))
    .sort((a, b) => (orderIndex.get(a.filename) ?? 0) - (orderIndex.get(b.filename) ?? 0))

  // Cap at maxResults
  const capped = result.slice(0, config.maxResults)

  const diagnostics = {
    contentPassed: contentScored.length,
    conceptPassed: conceptScored.length,
    topicPassed: topicScored.length,
    unionTotal: fusedScores.size,
    dedupedTotal: capped.length,
  }

  logScreeningEvent('multi_resolution_screened', {
    inputCount: memories.length,
    hasResidualIndex: hasIndex,
    ...diagnostics,
  })

  return { memories: capped, diagnostics }
}
