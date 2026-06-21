// MemorySearchTool — screening-aware memory search.
//
// Exposes searchMemoryWithScreening as a model-callable tool. Unlike grep,
// returns only results whose overall content relevance passes an absolute
// threshold (Trim-and-Square from "Screening Is Enough", arXiv:2604.01178).
//
// Follows the CronListTool pattern: lazy Zod schemas, read-only,
// concurrency-safe, deferred.

import { z } from 'zod/v4'
import { getScreeningConfig } from '../screening/screeningConfig.js'
import { getDefaultSearchCache } from '../screening/searchCache.js'
import { recursiveSignature } from '../screening/memoryDirWatcher.js'
import { recordHits } from '../memory/memoryStats.js'
import { readResidualIndex } from '../memory/residualIndex.js'
import { topicPathForEntry } from '../memory/topicPathForEntry.js'
import { isPrivateEntry, shouldIncludePrivate } from '../memory/memoryPrivacy.js'
import {
  getDefaultEngine,
  MemoryRetrievalEngine,
  type ScoreStrategy,
} from '../memory/MemoryRetrievalEngine.js'
import type { CorpusManifest } from '../memory/CorpusManifest.js'
import type { MemoryHit } from '../memory/types.js'

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

export const MEMORY_SEARCH_TOOL_NAME = 'MemorySearch'

export const MEMORY_SEARCH_DESCRIPTION =
  'Search persistent memory files using relevance-based screening. ' +
  'Returns only results that pass an absolute relevance threshold — ' +
  'unlike grep, irrelevant files are completely excluded, not just ranked lower.'

export const MEMORY_SEARCH_PROMPT =
  'Use this tool to search memory files when you need to find specific ' +
  'context, decisions, preferences, or project notes. The search uses ' +
  'TF-IDF similarity with absolute threshold screening: results below the ' +
  'threshold are completely excluded. Prefer this over grep for memory search ' +
  'as it avoids noise from keyword-only matching.'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

let _inputSchema: z.ZodObject<any> | null = null
function inputSchema() {
  if (!_inputSchema) {
    _inputSchema = z.strictObject({
      query: z.string().describe('Search query to match against memory files'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of results to return (default: 20)'),
    })
  }
  return _inputSchema
}

let _outputSchema: z.ZodObject<any> | null = null
function outputSchema() {
  if (!_outputSchema) {
    _outputSchema = z.object({
      results: z.array(
        z.object({
          path: z.string(),
          snippet: z.string(),
          score: z.number(),
        }),
      ),
      hits: z.array(
        z.object({
          entryId: z.string(),
          summary: z.string(),
          topic: z.string(),
          topicPath: z.string(),
          sources: z.array(z.string()),
          score: z.number(),
          updated: z.string(),
          confidence: z.number(),
          scoreBreakdown: z.record(z.string(), z.number()).optional(),
        }),
      ),
    })
  }
  return _outputSchema
}

export type MemorySearchInput = { query: string; maxResults?: number }
export type MemorySearchOutput = {
  results: { path: string; snippet: string; score: number }[]
  hits: MemoryHit[]
}

// ---------------------------------------------------------------------------
// Tool definition (standalone, not using buildTool to avoid CLI dependencies)
// ---------------------------------------------------------------------------

/** Options for executeMemorySearch internal callers. Not exposed via the Zod-validated
 *  external surface — used by tooling like distillVerifier to skip usage recording
 *  when running diagnostic queries. */
export type ExecuteMemorySearchOptions = {
  /** When false, skip the fire-and-forget usage recording. Default: true. */
  recordUsage?: boolean
  /** Phase 2 iter 2 corpus override. Defaults to the bare
   *  `getDefaultCorpusManifest()` inside the gate when omitted, preserving the
   *  Path A behaviour from before this iter (logs still allowed in file-layer
   *  + log-line layer). */
  corpus?: CorpusManifest
  /** Phase 3 iter 3 score-stage override. When provided, the tool runs against
   *  a fresh `MemoryRetrievalEngine` whose `scorer` slot is replaced; the
   *  default singleton engine (with `NoopScoreStrategy`) is otherwise reused
   *  so legacy callers see zero behavior change. The benchmark runner wires
   *  `LlmRerankerScoreStrategy` here via `--score-strategy=llm-reranker`. */
  scoreStrategy?: ScoreStrategy
}

/**
 * Execute a screening-aware memory search.
 *
 * @param memoryDir - Absolute path to the memory directory
 * @param input - Tool input (query, optional maxResults)
 * @param options - Internal-caller options (recordUsage flag)
 * @returns Search results with path, snippet, and relevance score
 */
export async function executeMemorySearch(
  memoryDir: string,
  input: MemorySearchInput,
  options: ExecuteMemorySearchOptions = {},
): Promise<MemorySearchOutput> {
  // Saga 12 (d): per-call freshness check for MCP sidecar processes that lack
  // an attached chokidar watcher. No-op when a watcher is attached
  // (daemon-side). Cost ~10-30ms recursive readdir+stat when active.
  await getDefaultSearchCache().checkAndRefresh(memoryDir, () => recursiveSignature(memoryDir))

  const globalConfig = getScreeningConfig()
  const maxResults = input.maxResults ?? globalConfig.searchMaxResults
  const recordUsage = options.recordUsage ?? true

  // Phase H-2: route through MemoryRetrievalEngine.
  // Phase H-3: flip default to `sortBy: 'raw'` so the tool's ordering is
  // BM25 + screening only — popularity (usageMultiplier) is observed but
  // not used for ranking. Codex P0-1 fix realized at the tool surface;
  // callers that depended on the legacy popularity-weighted ordering can
  // pass `sortBy: 'usage'` explicitly during a migration window.
  // Phase 3 iter 3: per-call score override → instantiate a fresh engine
  // with the supplied scorer; otherwise reuse the singleton (zero overhead
  // for the 99% case of NoopScoreStrategy).
  const engine = options.scoreStrategy
    ? new MemoryRetrievalEngine({ score: options.scoreStrategy })
    : getDefaultEngine()
  const engineResult = await engine.retrieve(memoryDir, input.query, {
    mode: 'tool',
    sortBy: 'raw',
    observe: recordUsage,
    maxResults,
    corpus: options.corpus,
  })

  // Project engine hits back into the legacy `SearchResult`-shaped slice
  // that `buildMemoryHits` / external callers expect. The score surfaced
  // on the legacy `results[]` is the *raw* relevance (post-Phase-H-3
  // semantics); `hits[]` carries the same raw score, while stats writes
  // (recordHits) still occur via the legacy path keys.
  const projected = engineResult.hits.map(h => ({
    path: h.topicPath,
    snippet: h.snippet,
    score: h.rawRelevanceScore,
  }))

  // Record hits for usage-based weighting (legacy Phase 3 stats path).
  // Uses file paths as keys — entries with residual index IDs are
  // correlated via the residual index in scoring.
  if (recordUsage && projected.length > 0) {
    const hitKeys = projected.map(r => r.path)
    // Fire-and-forget: don't block search results on stats write
    recordHits(memoryDir, hitKeys).catch(() => {})
  }

  // T2 dual-output: intersect result paths with residual index to surface
  // entry-centric MemoryHit metadata (entryId / sources / confidence / updated).
  // Legacy `results` is preserved unchanged; consumers migrate to `hits` in T3.
  const hits = await buildMemoryHits(memoryDir, projected)

  return {
    results: projected.map(r => ({
      path: r.path,
      snippet: r.snippet,
      score: Math.round(r.score * 1000) / 1000, // Round for readability
    })),
    hits,
  }
}

async function buildMemoryHits(
  memoryDir: string,
  results: Array<{ path: string; score: number }>,
): Promise<MemoryHit[]> {
  if (results.length === 0) return []

  // Saga 11 engine-cache-layer: share the residual index blob with the
  // search call that produced `results`. Within one executeMemorySearch
  // invocation this is a guaranteed cache hit.
  const index = await getDefaultSearchCache()
    .getBlob(memoryDir, 'residualIndex', () => readResidualIndex(memoryDir))
    .catch(() => null)
  if (!index || Object.keys(index.entries).length === 0) return []

  // Map result path → score (best score wins if multiple results share a path,
  // which shouldn't happen but is defensively handled).
  const scoreByPath = new Map<string, number>()
  for (const r of results) {
    const prev = scoreByPath.get(r.path)
    if (prev === undefined || r.score > prev) scoreByPath.set(r.path, r.score)
  }

  const includePrivate = shouldIncludePrivate()
  const hits: MemoryHit[] = []
  for (const entry of Object.values(index.entries)) {
    if (!includePrivate && isPrivateEntry(entry)) continue
    const path = topicPathForEntry(entry)
    const score = scoreByPath.get(path)
    if (score === undefined) continue
    hits.push({
      entryId: entry.id,
      summary: entry.summary,
      topic: entry.topic,
      topicPath: path,
      sources: entry.sources,
      score: Math.round(score * 1000) / 1000,
      updated: entry.updated,
      confidence: entry.confidence,
    })
  }

  // Highest-score first; stable tiebreak by entryId for snapshot determinism.
  hits.sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId))
  return hits
}

/**
 * Format search results as a human-readable tool result string.
 */
export function formatSearchResults(output: MemorySearchOutput): string {
  if (output.results.length === 0) {
    return 'No relevant memories found (all items fell below the screening threshold).'
  }
  return output.results
    .map(
      (r: { path: string; snippet: string; score: number }) =>
        `[${r.score.toFixed(3)}] ${r.path}\n  ${r.snippet.replace(/\n/g, '\n  ')}`,
    )
    .join('\n\n')
}
