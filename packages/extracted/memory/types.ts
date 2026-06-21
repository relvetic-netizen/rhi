// Memory module shared types.
//
// Phase 3 (memory-hardening sprint) T2 deliverable. Introduces the
// entry-centric `MemoryHit` shape that complements (does not replace) the
// file-centric `MemorySearchOutput.results` field.
//
// MemoryHit surfaces residual-index metadata (entryId / sources / confidence /
// updated) that the file-layer `results` lossily collapses. T3-T5 callers
// migrate to `hits` for path-vs-entryId disambiguation, hierarchical-topic
// support, and score-preserving multi-resolution fusion.

/**
 * Entry-centric memory search result.
 *
 * Each hit corresponds to one ResidualEntry that participated in the matched
 * topic file. `topicPath` is the relative path (`topics/<topic>.md` via
 * `topicPathForEntry`), `score` reflects the screening relevance of the hit's
 * topic file (intersection of entry-layer and overall pipeline output), and
 * `scoreBreakdown` is reserved for T5 RRF + BM25 fusion diagnostics.
 */
export type MemoryHit = {
  /** ResidualEntry id (e.g., `pref_001`). Stable across distill cycles. */
  entryId: string
  /** Entry summary (mirrors ResidualEntry.summary, no further truncation). */
  summary: string
  /** Topic slug (flat or hierarchical, e.g. `architecture/hooks`). */
  topic: string
  /** Relative topic file path, equals `topicPathForEntry(entry)`. */
  topicPath: string
  /** Source log paths (e.g. `logs/2026/05/2026-05-18.md:L42`). */
  sources: string[]
  /** Screening score from the search pipeline (rounded for readability). */
  score: number
  /** Last-updated date (`YYYY-MM-DD` as stored in residual index). */
  updated: string
  /** Confidence (0..1) carried from residual index. */
  confidence: number
  /** Optional per-resolver score breakdown. Populated by T5 (RRF + BM25). */
  scoreBreakdown?: Record<string, number>
}
