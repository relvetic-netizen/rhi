// Memory Search Performance Test — E2E benchmark schema.
//
// Distinct from EvalCaseSchema (evalTypes.ts) which is pure-function eval with
// inline memoryEntries. PerfBenchmarkCase references real entry IDs in a
// production-like temp-dir corpus, so the harness reads the real index.json /
// topics / logs (Codex P1-3 "eval too pure-function biased" resolution).
//
// Schema follows Codex review out (2026-05-19 architectural REVISE) Section
// "Benchmark dataset 設計" — 60 cases across 7 categories.

import { z } from 'zod/v4'

// ---------------------------------------------------------------------------
// Category — 7 buckets per Codex (15/10/10/10/5/5/5 = 60)
// ---------------------------------------------------------------------------

export const PerfBenchmarkCategorySchema = z.enum([
  'direct-keyword',      // 15: query contains commonly-indexed concept name
  'semantic-gap',        // 10: query uses different wording for same concept
  'cjk-mixed',           //  10: query contains JP characters or mixed JP/EN
  'recent-new',          // 10: newest entries (added 2026-05-15..2026-05-17)
  'stale-rejection',     //  5: query about deprecated topic — should hit
                         //     the transition/deprecation entry, not stale state
  'privacy-pollution',   //  5: query that should NOT surface private content
                         //     (private diary / .backup paths)
  'unrelated-negative',  //  5: query unrelated to corpus — expect empty/low
])
export type PerfBenchmarkCategory = z.infer<typeof PerfBenchmarkCategorySchema>

export const PerfFreshnessSchema = z.enum(['recent', 'current', 'older', 'any'])
export type PerfFreshness = z.infer<typeof PerfFreshnessSchema>

export const PerfLanguageSchema = z.enum(['ja', 'en', 'mixed'])
export type PerfLanguage = z.infer<typeof PerfLanguageSchema>

// ---------------------------------------------------------------------------
// PerfBenchmarkCase — single E2E test case
// ---------------------------------------------------------------------------

export const PerfBenchmarkCaseSchema = z.object({
  id: z.string().regex(/^perf_[a-z0-9_-]+$/, 'id must be perf_<slug>'),
  query: z.string().min(1),
  category: PerfBenchmarkCategorySchema,
  freshness: PerfFreshnessSchema,
  language: PerfLanguageSchema,

  // Hit assertions
  mustHitEntryIds: z.array(z.string()).default([]),
  mustNotHitEntryIds: z.array(z.string()).default([]),
  expectedTopicPaths: z.array(z.string()).default([]),

  // Path-prefix exclusion — Codex P1-2 corpus boundary + privacy
  mustNotHitPathPrefixes: z.array(z.string()).default([]),

  // Human notes — purpose / rationale / known sensitivity
  notes: z.string().default(''),
})
export type PerfBenchmarkCase = z.infer<typeof PerfBenchmarkCaseSchema>

// ---------------------------------------------------------------------------
// Per-category target counts (Codex section "Benchmark dataset 設計")
// ---------------------------------------------------------------------------

export const PERF_CATEGORY_TARGETS: Record<PerfBenchmarkCategory, number> = {
  'direct-keyword': 15,
  'semantic-gap': 10,
  'cjk-mixed': 10,
  'recent-new': 10,
  'stale-rejection': 5,
  'privacy-pollution': 5,
  'unrelated-negative': 5,
}
export const PERF_TOTAL_CASES = Object.values(PERF_CATEGORY_TARGETS).reduce((a, b) => a + b, 0)
