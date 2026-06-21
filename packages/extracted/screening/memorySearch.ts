// Screening-aware full-text memory search.
//
// Replaces pure grep-based memory search with TF-IDF + Trim-and-Square
// screening. Items below the absolute relevance threshold are completely
// excluded from results — unlike grep which returns all keyword matches
// regardless of overall relevance.
//
// Extended with residual index support: when index.json exists, concept tags
// from the residual index are used to augment file content for screening,
// reducing vocabulary mismatch (e.g., "bun" query matches entries tagged
// with "package-manager" concept).

import { readdir, readFile, stat } from 'fs/promises'
import type { Stats } from 'fs'
import { basename, join } from 'path'
import {
  buildCorpusBundle,
  screenItemsBM25,
  screenItemsBM25WithBundle,
  setBm25Diagnostics,
  type ScreeningConfig,
  type ScoredItem,
  type Bm25ScreeningStats,
} from './screening.js'
import { getDefaultSearchCache, manifestKey } from './searchCache.js'
import { logScreeningEvent } from './screeningLog.js'

// Phase 1.5: emit BM25 diagnostics on every screenItemsBM25 call. Module-level
// registration so all paths through searchMemoryWithScreening / scoreEntries
// share one callback (RELVETIA_SCREENING_SEARCH=1 controls actual emit via
// screeningLog._enabled, evaluated at import time).
setBm25Diagnostics((stats: Bm25ScreeningStats) => {
  logScreeningEvent('bm25_screening', stats as unknown as Record<string, unknown>)
})
import {
  readResidualIndex,
  entryToSearchText,
  type ResidualEntry,
  type ResidualIndex,
} from '../memory/residualIndex.js'
import { topicPathForEntry } from '../memory/topicPathForEntry.js'
import {
  readMemoryStats,
  usageMultiplier,
  type MemoryStatsData,
} from '../memory/memoryStats.js'
import {
  isPrivatePath,
  isPrivateEntry,
  shouldIncludePrivate,
} from '../memory/memoryPrivacy.js'
import {
  hasCJK,
  isLiteralFallbackEnabled,
  literalSubstringSearch,
} from './literalFallback.js'
import { searchRecentLogLines } from './logLineSearch.js'
import {
  matchesCorpus,
  type CorpusManifest,
} from '../memory/CorpusManifest.js'
import { readLastDistillMtimeMs } from './lastDistillMtime.js'
import {
  isLegacyFullScan,
  getCurrentMaxFiles,
  resolveEffectiveManifest,
} from './scanLimits.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchResult = {
  /** Relative path within memory directory. */
  path: string
  /** Absolute file path. */
  filePath: string
  /** First ~300 chars of file content as preview snippet. */
  snippet: string
  /** Screening score (higher = more relevant).
   *
   *  Until Phase H-3 (2026-05-19) this was `rawBm25 * usageMultiplier(stats)`,
   *  conflating relevance with popularity. The composition is preserved here
   *  for backward compatibility; callers that want pure relevance must read
   *  `rawScore` instead. See Codex P0-1 (memorySearch architectural review,
   *  2026-05-19) and `MemoryRetrievalEngine.sortBy`. */
  score: number
  /** Raw relevance score from BM25 + screening, BEFORE usageMultiplier is
   *  applied. Populated by Phase H-3 for entry- / file-layer hits; absent
   *  for log-line / literal fallback hits where no usage adjustment is
   *  applied (in which case `score === rawScore` by construction). */
  rawScore?: number
  /** Concept tags from residual index, if available. */
  concepts?: string[]
  /** Origin of the hit. 'bm25' = BM25 screening (Phase 1.5+),
   *  'log-line' = recent log line scan (Phase 2), 'tfidf' = legacy TF-IDF
   *  (kept for back-compat with serialized SearchResult logs),
   *  'literal' = substring fallback. */
  source?: 'tfidf' | 'bm25' | 'log-line' | 'literal'
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

export type MemoryFile = {
  relativePath: string
  filePath: string
  content: string
}

// Phase 4b followup (2026-05-23, MAX_FILES truncation structural fix):
// the file-count cap is no longer load-bearing — the load-bearing work is
// done by the default `CorpusManifest` (excludes `.backup` / `.staging` /
// `tmp-*`) and the mtime gate (only files modified at or after
// `.last-distill` survive — older files are already represented in
// `index.json` so re-scoring them is wasted BM25 budget). The cap (now
// 2000, see `scanLimits.ts`) is applied AFTER the gate + sort, so it acts
// as a pure defensive ceiling against `readdir` pathology. The Codex PR #77
// review pass surfaced this ordering bug — the original revise had the cap
// before the gate, defeating the contract.
//
// `MEMORY_SCAN_LEGACY_FULL=1` env restores pre-fix behavior (no default
// manifest, no mtime gate, MAX_FILES=200). Shape mirrors the
// `MEMORY_SEARCH_LEGACY_DEFAULT` knob already established for MAX_FILE_BYTES.

// Phase 3 T4: bumped from 10_000 to 100_000 (10x) so topic files past the
// legacy cap are tokenized in full. Topic file growth is bounded by the
// topology hard limit (~500 lines / ~40KB) and source daily logs rarely
// exceed ~30KB, so 100KB comfortably covers realistic memory dir contents.
// Pre-fix 10KB cap caused fixture #1 (cap-10kb-truncation) to drop keywords
// past byte 10_000 before tokenization, hiding them from BM25 regardless of
// whether index.json had an entry for the file.
//
// MEMORY_SEARCH_LEGACY_DEFAULT=1 restores the 10KB cap for emergency rollback
// if a future memory dir contains pathologically large files that degrade
// BM25 throughput.
const LEGACY_MAX_FILE_BYTES = 10_000
const DEFAULT_MAX_FILE_BYTES = 100_000
const MAX_FILE_BYTES =
  process.env.MEMORY_SEARCH_LEGACY_DEFAULT === '1'
    ? LEGACY_MAX_FILE_BYTES
    : DEFAULT_MAX_FILE_BYTES
const SNIPPET_LENGTH = 300

// Backward-compat re-export. Privacy gate moved to `../memory/memoryPrivacy.ts`
// in the Phase 2 memory-hardening sprint so the 5 retrieval paths share a
// single source of truth. memoryStats.ts and any external consumers can keep
// importing `isPrivatePrivatePath` from this module.
export const isPrivatePrivatePath = isPrivatePath
const shouldIncludePrivateMemory = shouldIncludePrivate
const isPrivatePrivateEntry = isPrivateEntry

export type ReadMemoryFilesOptions = {
  /** Optional corpus boundary. When supplied, paths not matching the manifest
   *  are skipped before the file is read. `freshness` is ignored here because
   *  `readMemoryFiles` is BM25-input shaped (no mtime contract); callers that
   *  need freshness filtering should compose with `scanMemoryFiles`. */
  manifest?: CorpusManifest
}

export async function readMemoryFiles(
  memoryDir: string,
  opts: ReadMemoryFilesOptions = {},
): Promise<MemoryFile[]> {
  const cache = getDefaultSearchCache()
  // Cache key on the EFFECTIVE manifest so flipping
  // `MEMORY_SCAN_LEGACY_FULL` (which changes the manifest fallback) lands
  // in a different cache slot. Without this, env toggles silently return
  // stale results from the wrong mode (Codex PR #77 P1 #2).
  const mk = manifestKey(resolveEffectiveManifest(opts))
  return cache.getFiles<MemoryFile[]>(memoryDir, mk, () =>
    readMemoryFilesUncached(memoryDir, opts),
  )
}

/** Cache-bypass variant of `readMemoryFiles`. Production callers go through
 *  `readMemoryFiles` (cached); tests use this directly when they want to
 *  observe disk-side behavior without the cache layer. */
export async function readMemoryFilesUncached(
  memoryDir: string,
  opts: ReadMemoryFilesOptions = {},
): Promise<MemoryFile[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const includePrivate = shouldIncludePrivateMemory()
    const legacy = isLegacyFullScan()
    const manifest = resolveEffectiveManifest(opts)
    // Layer B mtime gate: files older than `.last-distill` are already
    // covered by `index.json` entries (Layer A). Re-tokenizing them here
    // burns BM25 budget without adding recall. Missing stamp → 0 → no gate.
    const lastDistillMs = legacy ? 0 : await readLastDistillMtimeMs(memoryDir)
    const maxFiles = getCurrentMaxFiles()

    // Phase 1 — cheap path-level filters (no IO).
    const candidates = entries
      .filter(f => f.endsWith('.md') && basename(f) !== 'MEMORY.md')
      .filter(f => includePrivate || !isPrivatePrivatePath(f))
      .filter(f => !manifest || matchesCorpus(f, manifest))

    // Phase 2 — stat the path-survivors in parallel BEFORE the cap is
    // applied. The original revise had `slice(0, MAX_FILES)` here, which
    // dropped alphabetically-late fresh files before the mtime gate could
    // see them (Codex PR #77 P1 #1). Stat is cheap (~µs/file on NTFS) and
    // bounded by the manifest + privacy filters above, so paying for all
    // surviving candidates is cheap.
    type StatedEntry = { relativePath: string; filePath: string; fstat: Stats }
    const stated = await Promise.allSettled(
      candidates.map(async (relativePath): Promise<StatedEntry> => {
        const filePath = join(memoryDir, relativePath)
        const fstat = await stat(filePath)
        return { relativePath, filePath, fstat }
      }),
    )
    const withStats = stated
      .filter(
        (r): r is PromiseFulfilledResult<StatedEntry> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)

    // Phase 3 — mtime gate + (optional) manifest freshness, then sort
    // newest-first, then cap. `maxFiles` is a true defensive ceiling now,
    // never load-bearing.
    const survivors = withStats
      .filter(({ relativePath, fstat }) =>
        !manifest?.freshness ||
          matchesCorpus(relativePath, manifest, fstat.mtimeMs),
      )
      .filter(({ fstat }) => lastDistillMs === 0 || fstat.mtimeMs >= lastDistillMs)
      .sort((a, b) => b.fstat.mtimeMs - a.fstat.mtimeMs)
      .slice(0, maxFiles)

    // Phase 4 — read file bodies only for survivors. With the gate in
    // place this is typically 0–30 files (vs ~270 before), so 100KB-per-
    // file readFile cost drops by an order of magnitude on the steady
    // state.
    const results = await Promise.allSettled(
      survivors.map(async ({ relativePath, filePath }): Promise<MemoryFile> => {
        const buf = await readFile(filePath)
        const content = buf.toString('utf8', 0, MAX_FILE_BYTES)
        return { relativePath, filePath, content }
      }),
    )

    return results
      .filter(
        (r): r is PromiseFulfilledResult<MemoryFile> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Search memory files using TF-IDF + Trim-and-Square screening.
 *
 * Unlike grep, this returns only files whose overall content relevance
 * exceeds an absolute threshold. Files below the threshold receive exactly
 * zero relevance and are excluded — the core screening principle from
 * "Screening Is Enough" (arXiv:2604.01178).
 *
 * When a residual index (index.json) exists, concept tags from distilled
 * entries are appended to file content before screening. This reduces
 * vocabulary mismatch — e.g., a query for "パッケージマネージャ" can match
 * a file about "bun" if both share the concept tag "package-manager".
 *
 * @param memoryDir - Path to memory directory (~/.claude/memory)
 * @param query - Search query
 * @param config - Screening configuration
 * @returns Search results sorted by relevance score, descending.
 */
export type SearchMemoryOptions = {
  /** Optional corpus boundary applied to the file-layer scan AND the
   *  entry-layer's topicPath-derived results. The log-line layer is
   *  intentionally scoped to recent logs and is NOT manifest-gated — callers
   *  that want logs out entirely should drop the log-line layer separately
   *  (out of scope for Phase 2 iter 2). */
  manifest?: CorpusManifest
}

export async function searchMemoryWithScreening(
  memoryDir: string,
  query: string,
  config: ScreeningConfig,
  opts: SearchMemoryOptions = {},
): Promise<SearchResult[]> {
  if (!query.trim()) return []

  const includePrivate = shouldIncludePrivateMemory()
  // Use the shared resolver so env (`MEMORY_SCAN_LEGACY_FULL`) toggles
  // propagate consistently across the cached wrappers, Uncached scans, and
  // this top-level search entry point.
  const manifest = resolveEffectiveManifest(opts)

  // Saga 11 engine-cache-layer: residual index + memory stats are small JSON
  // blobs that don't change between back-to-back searches. Cache via getBlob,
  // invalidated by the memory dir watcher when either file mutates.
  const searchCache = getDefaultSearchCache()
  const [residualIndex, statsData] = await Promise.all([
    searchCache.getBlob(memoryDir, 'residualIndex', () => readResidualIndex(memoryDir)),
    searchCache.getBlob(memoryDir, 'memoryStats', () => readMemoryStats(memoryDir)),
  ])

  // ── Phase 1: per-entry scoring (案 A, Pi 推奨) ───────────────────────
  // Bypasses MAX_FILE_BYTES=10K truncation by treating each index entry as
  // an independent search target. summary + concepts (~300-500 byte each) are
  // tokenized individually instead of being aggregated into a 10KB file slice
  // where the tail entries get cut off.
  const entryResults = scoreEntriesAndDedupByTopic(
    memoryDir,
    residualIndex,
    statsData,
    query,
    config,
    manifest,
  )

  // ── Phase 2: file-layer fallback (covers in-flight logs not yet distilled) ─
  // The file scan still runs because today's log lines and any post-distill
  // residue are not yet in index.json. Entry-layer hits take precedence on
  // overlapping topic file paths.
  const files = await readMemoryFiles(memoryDir, { manifest })
  if (files.length === 0) {
    return entryResults.slice(0, config.maxResults)
  }
  const conceptMap = buildConceptMap(residualIndex, memoryDir, includePrivate)

  // Saga 11 engine-cache-layer: precompute augmented item texts once, then
  // memoize the (tokenize + Bm25 corpus stats) work for the file-layer corpus.
  // Cache hits skip both — the per-query cost shrinks to query tokenize +
  // N × per-doc BM25 score. The cache is invalidated by the memory dir watcher
  // when any underlying file (incl. index.json that drives `conceptMap`) mutates.
  const fileItemTexts = files.map(f => {
    const base = `${f.relativePath.replace(/[-_./]/g, ' ')} ${f.content}`
    const concepts = conceptMap.get(f.relativePath)
    return concepts ? `${base} ${concepts}` : base
  })
  // Bundle cache key MUST match the effective manifest used to build
  // `files` (Codex PR #77 R2 P1) — otherwise a non-legacy call warms a
  // bundle for the default-manifest corpus, a subsequent legacy call
  // produces a different `files` set, and `screenItemsBM25WithBundle`
  // throws on the length mismatch.
  const fileBundleKey = `file-layer:${manifestKey(manifest)}`
  const fileBundle = searchCache.getBundle(memoryDir, fileBundleKey, () =>
    buildCorpusBundle(fileItemTexts),
  )
  const scored = screenItemsBM25WithBundle(files, fileBundle, query, config)

  const fileResults: SearchResult[] = scored.map(s => {
    const concepts = getConceptsForFile(residualIndex, s.item.relativePath, includePrivate)
    const stats = statsData.entries[s.item.relativePath]
    const adjustedScore = s.score * usageMultiplier(stats)
    return {
      path: s.item.relativePath,
      filePath: s.item.filePath,
      snippet: s.item.content.slice(0, SNIPPET_LENGTH),
      score: adjustedScore,
      // Phase H-3: surface raw BM25/screening score so downstream callers
      // (MemoryRetrievalEngine sortBy:'raw') can rank without popularity.
      rawScore: s.score,
      ...(concepts.length > 0 ? { concepts } : {}),
      source: 'bm25' as const,
    }
  }).sort((a, b) => b.score - a.score)

  const logLineResults = await searchRecentLogLines(memoryDir, query, config)

  // Merge layer results in fixed precedence order. Entry hits win duplicate
  // file paths, file hits come next, and raw log lines are appended with a
  // line-level dedup key so multiple relevant lines in one log can survive.
  const tfidfResults = mergeSearchLayers(entryResults, fileResults, logLineResults)

  if (tfidfResults.length === 0 && files.length > 0) {
    logScreeningEvent('search_zero_results', {
      fileCount: files.length,
      entryCount: Object.keys(residualIndex.entries).length,
      query: query.slice(0, 100),
      message: 'Search returned no results — all entries and files below threshold',
      hasResidualIndex: Object.keys(residualIndex.entries).length > 0,
    })
  } else {
    logScreeningEvent('search_completed', {
      fileCount: files.length,
      entryCount: Object.keys(residualIndex.entries).length,
      entryHits: entryResults.length,
      fileHits: fileResults.length,
      logLineHits: logLineResults.length,
      resultCount: tfidfResults.length,
      topScore: tfidfResults.length > 0 ? Math.round(tfidfResults[0]!.score * 1000) / 1000 : 0,
    })
  }

  // Literal substring fallback: CJK queries that TF-IDF failed to screen.
  if (tfidfResults.length === 0 && hasCJK(query) && isLiteralFallbackEnabled()) {
    const literal = literalSubstringSearch(files, query)
    if (literal.length > 0) {
      logScreeningEvent('search_literal_fallback', {
        fileCount: files.length,
        query: query.slice(0, 100),
        resultCount: literal.length,
      })
      return literal
    }
  }

  return tfidfResults.slice(0, config.maxResults)
}

function mergeSearchLayers(
  entryResults: SearchResult[],
  fileResults: SearchResult[],
  logLineResults: SearchResult[],
): SearchResult[] {
  const merged: SearchResult[] = []
  const seen = new Set<string>()

  for (const layer of [entryResults, fileResults, logLineResults]) {
    for (const result of layer) {
      const key = searchResultDedupKey(result)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(result)
    }
  }

  return merged
}

function searchResultDedupKey(result: SearchResult): string {
  const maybeLogLine = result as unknown as { source?: string; lineNumber?: number }
  if (maybeLogLine.source === 'log-line' && typeof maybeLogLine.lineNumber === 'number') {
    return `${result.path}#L${maybeLogLine.lineNumber}`
  }
  return result.path
}

/**
 * Phase 1 entry-layer scoring: score each residual index entry independently,
 * then dedup to topic file paths (best entry per file wins, with all matching
 * entry IDs preserved on the result for observability).
 *
 * The private private gate is enforced by checking entry.sources for any path
 * starting with `private/` (matches the file-layer gate semantics).
 */
function scoreEntriesAndDedupByTopic(
  memoryDir: string,
  residualIndex: ResidualIndex,
  statsData: MemoryStatsData,
  query: string,
  config: ScreeningConfig,
  manifest: CorpusManifest | undefined,
): SearchResult[] {
  const includePrivate = shouldIncludePrivateMemory()

  type EntryItem = { entry: ResidualEntry; topicPath: string }
  const entryItems: EntryItem[] = Object.values(residualIndex.entries)
    .filter(e => includePrivate || !isPrivatePrivateEntry(e))
    .map(e => ({ entry: e, topicPath: topicPathForEntry(e) }))
    // Drop entries whose canonical topic path is outside the corpus manifest.
    // In practice every distilled entry maps to `topics/<topic>.md` so the
    // bare default never filters anything; the gate exists so Path C-style
    // manifests (which add `logs` exclusion) propagate correctly to the
    // entry layer too.
    .filter(it => !manifest || matchesCorpus(it.topicPath, manifest))

  if (entryItems.length === 0) return []

  // Saga 11 engine-cache-layer (Phase 4-5 expansion): cache the entry-layer
  // bundle (tokenized entry texts + BM25 stats). Each entry's search text is
  // derived from `entry.summary + entry.concepts` (residual index content),
  // which only changes when index.json mutates — the memory dir watcher
  // catches that. Saves the per-call tokenize × 142 entries + corpus stats
  // build (~50-80ms on production memory).
  const searchCache = getDefaultSearchCache()
  const entryBundleKey = `entry-layer:${manifestKey(manifest)}`
  const entryBundle = searchCache.getBundle(memoryDir, entryBundleKey, () =>
    buildCorpusBundle(entryItems.map(it => entryToSearchText(it.entry))),
  )
  // Bundle cache hit only valid if entry corpus shape (count + order) matches.
  // If residualIndex mutated between cache populate and now, the bundle has a
  // different length than entryItems — fall back to fresh build. This is a
  // defense-in-depth guard for the race between watcher fire and search call.
  const scored = entryBundle.itemTokens.length === entryItems.length
    ? screenItemsBM25WithBundle(entryItems, entryBundle, query, config)
    : screenItemsBM25(entryItems, it => entryToSearchText(it.entry), query, config)

  // Dedup: keep the best-scoring entry per topic file path; track all matching IDs.
  type DedupBucket = { item: EntryItem; score: number; entryIds: string[] }
  const byPath = new Map<string, DedupBucket>()
  for (const s of scored) {
    const cur = byPath.get(s.item.topicPath)
    if (!cur) {
      byPath.set(s.item.topicPath, { item: s.item, score: s.score, entryIds: [s.item.entry.id] })
    } else {
      cur.entryIds.push(s.item.entry.id)
      if (s.score > cur.score) {
        cur.score = s.score
        cur.item = s.item
      }
    }
  }

  return [...byPath.values()].map(({ item, score }) => {
    const stats = statsData.entries[item.topicPath]
    const adjustedScore = score * usageMultiplier(stats)
    return {
      path: item.topicPath,
      filePath: join(memoryDir, item.topicPath),
      snippet: item.entry.summary.slice(0, SNIPPET_LENGTH),
      score: adjustedScore,
      // Phase H-3: surface raw BM25/screening score so downstream callers
      // (MemoryRetrievalEngine sortBy:'raw') can rank without popularity.
      rawScore: score,
      ...(item.entry.concepts.length > 0 ? { concepts: item.entry.concepts } : {}),
      source: 'bm25' as const,
    }
  }).sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------------------
// Residual index helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of relative file path → concept text for search augmentation.
 * Entries in the residual index reference source log files; we map those
 * sources to their concept tags so the original log files become findable
 * by concept.
 */
function buildConceptMap(
  index: ResidualIndex,
  memoryDir: string,
  includePrivate: boolean,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of Object.values(index.entries)) {
    if (!includePrivate && isPrivatePrivateEntry(entry)) continue
    const conceptText = `${entry.concepts.join(' ')} ${entry.summary}`
    // Map source log files to concepts
    for (const source of entry.sources) {
      const filePath = source.replace(/:L\d+$/, '') // Strip line number
      const existing = map.get(filePath)
      map.set(filePath, existing ? `${existing} ${conceptText}` : conceptText)
    }
    // Map topic files to concepts
    const topicPath = topicPathForEntry(entry)
    const existing = map.get(topicPath)
    map.set(topicPath, existing ? `${existing} ${conceptText}` : conceptText)
  }
  return map
}

/**
 * Get concept tags for a given file path from the residual index.
 */
function getConceptsForFile(
  index: ResidualIndex,
  relativePath: string,
  includePrivate: boolean,
): string[] {
  const concepts = new Set<string>()
  for (const entry of Object.values(index.entries)) {
    if (!includePrivate && isPrivatePrivateEntry(entry)) continue
    const matchesSource = entry.sources.some(s => s.replace(/:L\d+$/, '') === relativePath)
    const matchesTopic = topicPathForEntry(entry) === relativePath
    if (matchesSource || matchesTopic) {
      for (const c of entry.concepts) {
        concepts.add(c)
      }
    }
  }
  return [...concepts]
}
