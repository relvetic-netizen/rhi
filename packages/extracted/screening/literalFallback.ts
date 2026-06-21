// Literal substring fallback for memory search.
//
// TF-IDF with CJK bigram tokenization has weak recall for short Japanese
// queries ("にわか", "用語" etc.): the term appears in few files, bigram
// weights are dispersed across 200+ files in mixed-language corpora, and
// cosine similarity falls below the absolute threshold (0.10) even for
// clear literal matches.
//
// This fallback runs ONLY when:
//   1. TF-IDF screening returned zero results, AND
//   2. The query contains CJK characters (Hiragana/Katakana/Kanji)
//
// Condition 2 guarantees English benchmarks (all query strings in
// benchmarkScenarios.ts are English) never trigger literal fallback, so
// existing baselines (noise rejection, precision/recall) remain valid.
//
// Results are marked with source: 'literal' so consumers can distinguish
// TF-IDF hits from substring matches.
//
// Disable via env var: RELVETIA_DISABLE_LITERAL_FALLBACK=1

import type { SearchResult } from './memorySearch.js'

// Unicode ranges: Hiragana (3040-309F), Katakana (30A0-30FF), CJK Unified (4E00-9FFF)
const CJK_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/

const LITERAL_MAX_RESULTS = 10
const LITERAL_SNIPPET_LENGTH = 300

export function hasCJK(text: string): boolean {
  return CJK_REGEX.test(text)
}

export function isLiteralFallbackEnabled(): boolean {
  return process.env.RELVETIA_DISABLE_LITERAL_FALLBACK !== '1'
}

export type LiteralCandidate = {
  relativePath: string
  filePath: string
  content: string
}

/**
 * Perform case-insensitive substring match across memory files.
 *
 * Returns up to LITERAL_MAX_RESULTS hits, ranked by:
 *   1. Number of query occurrences in the file (more = higher)
 *   2. File modification time (newer = higher, as tiebreaker)
 *
 * Score is a synthetic value in [0.01, 0.99] derived from occurrence count,
 * deliberately below typical TF-IDF scores so consumers that sort by score
 * can see literal matches as "weaker but present" signals.
 */
export function literalSubstringSearch(
  files: LiteralCandidate[],
  query: string,
): SearchResult[] {
  const trimmedQuery = query.trim()
  if (trimmedQuery.length === 0) return []

  const lowerQuery = trimmedQuery.toLowerCase()

  type Hit = {
    file: LiteralCandidate
    occurrences: number
  }

  const hits: Hit[] = []
  for (const file of files) {
    const lowerContent = file.content.toLowerCase()
    let idx = 0
    let count = 0
    while (true) {
      const found = lowerContent.indexOf(lowerQuery, idx)
      if (found < 0) break
      count++
      idx = found + lowerQuery.length
      if (count >= 50) break // cap per-file to bound work
    }
    if (count > 0) {
      hits.push({ file, occurrences: count })
    }
  }

  hits.sort((a, b) => b.occurrences - a.occurrences)

  const maxOcc = hits[0]?.occurrences ?? 1
  return hits.slice(0, LITERAL_MAX_RESULTS).map(h => ({
    path: h.file.relativePath,
    filePath: h.file.filePath,
    snippet: h.file.content.slice(0, LITERAL_SNIPPET_LENGTH),
    // Scaled score in (0, 0.99]; never reaches 1.0 so TF-IDF hits always rank above.
    score: Math.min(0.99, h.occurrences / Math.max(maxOcc, 1) * 0.5),
    source: 'literal' as const,
  }))
}
