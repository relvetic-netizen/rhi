// Two-stage memory relevance pipeline.
//
// Combines fast BM25 / TF-IDF screening (Stage 1) with accurate Sonnet
// semantic selection (Stage 2) to find the most relevant memories for a
// query.
//
// Architecture mirrors ClaudeCLI288/src/memdir/findRelevantMemories.ts but
// uses `claude -p` instead of direct API calls (covered by Max plan).
//
//   Stage 1: MemoryRetrievalEngine.retrieve({mode:'multiResolution'})
//            (gate = MultiResolutionScreeningGate: concept expansion +
//             PHOTON-inspired 3-resolution screen + RRF fusion + residual
//             entry-id enrichment). For `enableMultiResolution: false` the
//             legacy single-resolution `screenMemories` path is preserved.
//   Stage 2: selectWithSonnet() — Claude Sonnet via CLI (~2-5s, no API
//            cost)
//
// If Stage 2 fails (timeout, CLI not available), falls back to Stage 1
// results.
//
// Phase 1 iter 1 (`memory-search-improvement-loop`) migration:
//   The multi-resolution branch now delegates to `MemoryRetrievalEngine`
//   via `getDefaultEngine()`. This unifies Path A (`MemorySearchTool`) and
//   Path C (`findRelevantMemories`) under a single retrieval contract and
//   normalizes Windows backslash filenames to forward slash, unblocking
//   the residual-index entry-id mapping that drove the bench's strict
//   Recall@5 from 0% toward Path A parity.

import {
  screenMemories,
  memoryScreeningConfig,
  type MemoryHeaderLike,
} from './memoryScreening.js'
import { getScreeningConfig } from './screeningConfig.js'
import {
  selectWithSonnet,
  type MemoryCandidate,
  type SemanticSelectorOptions,
} from './semanticSelector.js'
import { logScreeningEvent } from './screeningLog.js'
import {
  readConceptGraph,
  augmentQueryWithConcepts,
} from '../memory/conceptGraph.js'
// `screenMultiResolution` is now invoked inside `MultiResolutionScreeningGate`
// via `getDefaultEngine()`; the direct import here would be dead weight.
import {
  isPrivatePath,
  shouldIncludePrivate,
} from '../memory/memoryPrivacy.js'
import { scanMemoryFiles } from './scanMemoryFiles.js'
import { getDefaultSearchCache } from './searchCache.js'
import { recursiveSignature } from './memoryDirWatcher.js'
import {
  getDefaultEngine,
  MemoryRetrievalEngine,
  type ScoreStrategy,
} from '../memory/MemoryRetrievalEngine.js'
import {
  getDefaultPathCCorpusManifest,
  type CorpusManifest,
} from '../memory/CorpusManifest.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelevantMemory = {
  /** Absolute file path. */
  path: string
  /** File modification time for freshness indication. */
  mtimeMs: number
  /** Relative filename. */
  filename: string
}

export type FindMemoriesOptions = {
  /** Filenames to exclude (already surfaced in this session). */
  alreadySurfaced?: ReadonlySet<string>
  /** Enable Stage 2 Sonnet selection. Default: true.
   *  When false, only TF-IDF screening is used (faster, offline). */
  enableSonnet?: boolean
  /** Options for the Sonnet selector. */
  sonnetOptions?: SemanticSelectorOptions
  /** Enable multi-resolution screening (PHOTON-inspired). Default: true.
   *  When true, screens at content + concept + topic levels and unions results.
   *  Falls back to single-resolution if no residual index exists. */
  enableMultiResolution?: boolean
  /** Phase 2 iter 2 (`memory-search-improvement-loop` saga): corpus boundary
   *  for the Path C scan. Default = bare manifest plus `logs` exclusion so
   *  the recall path stops surfacing daily-log files in its top-K (the log
   *  dominance fix that drove Phase 1 iter 1 Path C strict Recall@5 to a 35.3%
   *  ceiling). Caller-supplied manifest fully overrides the default and is
   *  threaded through to the engine + `scanMemoryFiles`. */
  corpus?: CorpusManifest
  /** Phase 3 iter 3 (`memory-search-improvement-loop` saga): score-stage
   *  override. When provided, the multi-resolution path runs against a fresh
   *  `MemoryRetrievalEngine` whose `scorer` slot is replaced; otherwise the
   *  singleton (with `NoopScoreStrategy`) is reused. The benchmark wires
   *  `LlmRerankerScoreStrategy` here via `--score-strategy=llm-reranker`. */
  scoreStrategy?: ScoreStrategy
}

// `getDefaultPathCCorpusManifest` lives in `../memory/CorpusManifest.ts` so the
// engine fallback path can hold the same default without an import cycle.

// ---------------------------------------------------------------------------
// Main pipeline
//
// Memory scanning lives in `./scanMemoryFiles` so the new
// `MultiResolutionScreeningGate` (Phase 1 iter 1) can share the contract.
// ---------------------------------------------------------------------------

/**
 * Find relevant memories for a query using a two-stage pipeline.
 *
 * Stage 1: TF-IDF + Trim-and-Square screening (local, fast)
 * Stage 2: Claude Sonnet semantic selection via CLI (accurate, Max plan)
 *
 * Falls back to Stage 1 results if Stage 2 fails.
 *
 * @param query - User query or task context
 * @param memoryDir - Path to memory directory (~/.claude/memory)
 * @param opts - Options
 * @returns Array of relevant memories, sorted by relevance.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  opts: FindMemoriesOptions = {},
): Promise<RelevantMemory[]> {
  // Saga 12 (d): per-call freshness check for MCP sidecar processes that lack
  // an attached chokidar watcher. No-op when a watcher is attached
  // (daemon-side). Mirrors the Path A check in `MemorySearchTool.executeMemorySearch`.
  await getDefaultSearchCache().checkAndRefresh(memoryDir, () => recursiveSignature(memoryDir))

  const {
    alreadySurfaced = new Set(),
    enableSonnet = true,
    sonnetOptions,
    enableMultiResolution = true,
    corpus = getDefaultPathCCorpusManifest(),
    scoreStrategy,
  } = opts

  // Scan all memory files under the active corpus manifest + normalize
  // forward-slash. Normalization is the canonical contract going forward: the
  // engine gate normalizes inside its boundary too, so doing it once here lets
  // `alreadySurfaced` lookups, `byFilename` mapping, and the bench's
  // `filenameToEntryIds` lookups all share one separator regardless of OS
  // (Windows backslash trap fix). The corpus filter is applied inside
  // `scanMemoryFiles` so log file paths never enter the Path C pipeline.
  const allMemories = (await scanMemoryFiles(memoryDir, { manifest: corpus }))
    .map(m => ({ ...m, filename: m.filename.replace(/\\/g, '/') }))
    .filter(m => !alreadySurfaced.has(m.filename))

  if (allMemories.length === 0) return []

  // ── Stage 1: Screening (single or multi-resolution) ────────────────────
  // Multi-resolution path now delegates to MemoryRetrievalEngine
  // (`mode: 'multiResolution'`). Concept expansion + RRF fusion + entry-id
  // enrichment happen inside the gate. Single-resolution path keeps the
  // legacy `screenMemories` flow with its own concept expansion.
  const screeningCfg = getScreeningConfig()
  let screened: MemoryHeaderLike[]
  let expandedQuery = query

  if (enableMultiResolution) {
    // Phase 3 iter 3: per-call score override → fresh engine with replaced
    // scorer slot; otherwise reuse the singleton (zero overhead for the 99%
    // case of NoopScoreStrategy default).
    const engine = scoreStrategy
      ? new MemoryRetrievalEngine({ score: scoreStrategy })
      : getDefaultEngine()
    // Hand the engine our already-scanned list so the
    // MultiResolutionScreeningGate skips its own scanMemoryFiles call.
    // Without this opt, the engine scans again on every query (~50 ms /
    // 200 files) which doubled the per-query latency budget in baseline-v1.
    const result = await engine.retrieve(
      memoryDir,
      query,
      {
        mode: 'multiResolution',
        sortBy: 'raw',
        maxResults: screeningCfg.memoryMaxResults,
        corpus,
      },
      { preScanned: allMemories },
    )

    // Map engine candidates back to full MemoryHeaderLike records so the
    // Sonnet selector keeps the same input fidelity (description +
    // contentSnippet) as the pre-migration pipeline. `alreadySurfaced`
    // filter is re-applied here because the engine scans the raw memory
    // dir without that knowledge.
    const byFilename = new Map(allMemories.map(m => [m.filename, m]))
    screened = result.hits
      .map(hit => byFilename.get(hit.topicPath))
      .filter((m): m is MemoryHeaderLike => m !== undefined)

    logScreeningEvent('pipeline_stage1_multi_engine', {
      inputCount: allMemories.length,
      engineHitCount: result.hits.length,
      mappedCount: screened.length,
      durationMs: result.diagnostics.durationMs,
      query: query.slice(0, 200),
    })
  } else {
    // Single-resolution legacy path — concept expansion happens locally.
    try {
      const graph = await readConceptGraph(memoryDir)
      if (Object.keys(graph.concepts).length > 0) {
        expandedQuery = augmentQueryWithConcepts(query, graph)
        if (expandedQuery !== query) {
          logScreeningEvent('pipeline_concept_expansion', {
            original: query.slice(0, 100),
            expanded: expandedQuery.slice(0, 200),
          })
        }
      }
    } catch {
      // Graph not available — proceed with original query
    }

    screened = screenMemories(
      allMemories,
      expandedQuery,
      memoryScreeningConfig(screeningCfg),
    )

    logScreeningEvent('pipeline_stage1', {
      inputCount: allMemories.length,
      screenedCount: screened.length,
      query: expandedQuery.slice(0, 200),
    })
  }

  if (screened.length === 0) {
    // Safety valve: no memories passed any resolution — return top 5 by recency.
    // Redundant privacy filter (defense-in-depth): scanMemoryFiles already drops
    // private files when opt-in is off, but a second gate guarantees the
    // safety-valve contract regardless of any future upstream regression.
    const includePrivate = shouldIncludePrivate()
    const fallback = includePrivate
      ? allMemories
      : allMemories.filter(m => !isPrivatePath(m.filename))
    return fallback.slice(0, 5).map(toRelevantMemory)
  }

  // ── Stage 2: Sonnet semantic selection ─────────────────────────────────
  if (!enableSonnet) {
    return screened.slice(0, 5).map(toRelevantMemory)
  }

  const candidates: MemoryCandidate[] = screened.map(m => ({
    filename: m.filename,
    description: m.description,
    type: m.type,
    contentSnippet: m.contentSnippet,
  }))

  const selectedFilenames = await selectWithSonnet(query, candidates, sonnetOptions)

  logScreeningEvent('pipeline_stage2', {
    candidateCount: candidates.length,
    selectedCount: selectedFilenames.length,
    selectedFiles: selectedFilenames,
  })

  if (selectedFilenames.length === 0) {
    // Sonnet returned nothing or failed — fall back to Stage 1 top results
    logScreeningEvent('pipeline_stage2_fallback', {
      reason: 'Sonnet returned empty — using Stage 1 results',
      fallbackCount: Math.min(screened.length, 5),
    })
    return screened.slice(0, 5).map(toRelevantMemory)
  }

  // Map selected filenames back to full memory headers
  const byFilename = new Map(screened.map(m => [m.filename, m]))
  return selectedFilenames
    .map(f => byFilename.get(f))
    .filter((m): m is MemoryHeaderLike => m !== undefined)
    .map(toRelevantMemory)
}

function toRelevantMemory(m: MemoryHeaderLike): RelevantMemory {
  return {
    path: m.filePath,
    mtimeMs: m.mtimeMs,
    filename: m.filename,
  }
}
