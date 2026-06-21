// Memory pre-filter adapter for screening.
//
// Sits between scanMemoryFiles() and the Sonnet selectRelevantMemories() call
// in findRelevantMemories.ts. Applies TF-IDF + Trim-and-Square screening to
// reduce the memory manifest from ~200 items to ~20-30, cutting the Sonnet
// call's input size and preventing dilution across irrelevant memories.
//
// Follows the paper's philosophy: items below an absolute threshold receive
// exactly zero relevance and are completely excluded — not deprioritized.

import {
  screenItems,
  type ScreeningConfig,
  type ScoredItem,
} from './screening.js'
import { logScreeningEvent } from './screeningLog.js'

// ---------------------------------------------------------------------------
// Safety valve callback — notifies eval framework when all items are rejected.
// Same pattern as setScreeningDiagnostics() in screening.ts.
// ---------------------------------------------------------------------------

let _onSafetyValve: ((query: string, memoryTexts: string[]) => void) | null = null

/** Register a callback invoked when the safety valve activates (all rejected). */
export function setOnSafetyValve(
  cb: ((query: string, memoryTexts: string[]) => void) | null,
): void {
  _onSafetyValve = cb
}

// ---------------------------------------------------------------------------
// Types — mirrors MemoryHeader from ClaudeCLI288/src/memdir/memoryScan.ts
// without importing from the leaked source. Adapter callers convert between
// the two at the integration boundary.
// ---------------------------------------------------------------------------

export type MemoryHeaderLike = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type?: string
  /** Optional content snippet (first ~500 chars of file body) for richer
   *  screening signal beyond just filename + description. */
  contentSnippet?: string
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Build a screening-friendly text representation of a memory header.
 * Combines filename, type tag, description, and content snippet into a
 * single string for TF-IDF vectorization.
 */
function memoryToText(m: MemoryHeaderLike): string {
  const parts: string[] = []
  // Filename often contains meaningful terms (e.g., "db-migration-guide.md")
  parts.push(m.filename.replace(/[-_./]/g, ' ').replace(/\.md$/, ''))
  if (m.type) parts.push(m.type)
  if (m.description) parts.push(m.description)
  if (m.contentSnippet) parts.push(m.contentSnippet)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Screen memory headers against a query, returning only those that pass
 * the absolute relevance threshold.
 *
 * @param memories - Memory headers from scanMemoryFiles()
 * @param query - User query to match against
 * @param config - Screening configuration (threshold, sharpness, maxResults)
 * @returns Memories that passed screening, sorted by score descending.
 *          Returns the full input list as fallback when screening rejects everything
 *          (safety valve to avoid silent information loss).
 */
export function screenMemories(
  memories: MemoryHeaderLike[],
  query: string,
  config: ScreeningConfig,
): MemoryHeaderLike[] {
  if (memories.length === 0 || query.trim().length === 0) {
    return memories
  }

  const now = Date.now()
  const scored = screenItems(
    memories,
    memoryToText,
    query,
    config,
    config.boostRecency
      ? (m: MemoryHeaderLike) => now - m.mtimeMs
      : undefined,
  )

  // Safety valve: if screening rejects ALL memories, fall back to the full
  // list. This prevents the rare case where a query shares zero TF-IDF terms
  // with any memory but Sonnet's semantic understanding could still match
  // (e.g., "CI/CD pipeline" vs memory titled "deployment workflow").
  if (scored.length === 0) {
    logScreeningEvent('memory_safety_valve', {
      inputCount: memories.length,
      query: query.slice(0, 100),
      message: 'All memories rejected — returning full list as fallback',
    })
    // Notify eval framework for auto-case generation
    if (_onSafetyValve) {
      _onSafetyValve(query, memories.map(memoryToText))
    }
    return memories
  }

  logScreeningEvent('memory_screened', {
    inputCount: memories.length,
    passedCount: scored.length,
    rejectedCount: memories.length - scored.length,
    topScore: Math.round(scored[0]!.score * 1000) / 1000,
  })

  return scored.map(s => s.item)
}

/**
 * Build a ScreeningConfig for memory pre-filtering from the global config.
 * Convenience helper so callers don't need to destructure screeningConfig.
 */
export function memoryScreeningConfig(globalConfig: {
  memoryThreshold: number
  memoryMaxResults: number
  boostRecency: boolean
  recencyHalfLifeMs: number
}): ScreeningConfig {
  return {
    threshold: globalConfig.memoryThreshold,
    maxResults: globalConfig.memoryMaxResults,
    boostRecency: globalConfig.boostRecency,
    recencyHalfLifeMs: globalConfig.recencyHalfLifeMs,
  }
}
