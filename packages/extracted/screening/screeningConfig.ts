// Screening configuration with Zod validation.
//
// Follows the cronJitterConfig.ts pattern: Zod schema with bounds checking,
// safeParse + fallback to defaults. In REPL contexts this would be wired to
// GrowthBook via getFeatureValue_CACHED_WITH_REFRESH; in daemon/SDK contexts
// the defaults apply directly.

import { z } from 'zod/v4'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export const DEFAULT_SCREENING_CONFIG = {
  // Memory pre-filter (Phase 2): applied before Sonnet selection call.
  // Items with cosine similarity below this threshold are completely rejected.
  // Sharpness r is derived as 1/(1-threshold).
  // Benchmark-tuned: at 0.10 (r≈1.11), precision=76%, recall=84%, zero safety
  // valve activations on a 36-entry corpus with 16 diverse queries.
  memoryThreshold: 0.10,
  memoryMaxResults: 30,

  // Context compaction (Phase 4): scores messages for relevance-aware keep.
  // Conservative (lower) threshold to avoid discarding useful context.
  compactThreshold: 0.10,

  // Memory search (Phase 3): aligned with memoryThreshold for consistency.
  // Previously 0.20 but caused 18.8% safety valve activation rate.
  // At 0.10: zero safety valve, recall=84%, precision=76%.
  searchThreshold: 0.10,
  searchMaxResults: 20,

  // Recency: newer items get a score boost via exponential decay.
  boostRecency: true,
  recencyHalfLifeMs: SEVEN_DAYS_MS,

  // Novelty screening (write-side): inverse Trim-and-Square.
  // Observations with max similarity above this threshold to any existing
  // memory are considered redundant and scored exactly zero.
  // r is derived as 1/threshold.
  // Benchmark-tuned: at 0.25 (r=4.0), 100% accuracy distinguishing
  // novel vs redundant observations against a 32-entry corpus.
  noveltyThreshold: 0.25,
  noveltyMaxObservations: 10,

  // Multi-resolution screening thresholds (Phase 2).
  // More abstract resolutions use lower thresholds to catch vocabulary mismatches.
  // conceptThreshold < memoryThreshold: concept tags are short, similarity is lower.
  // topicThreshold < conceptThreshold: topic summaries are broad, even lower similarity.
  conceptThreshold: 0.10,
  topicThreshold: 0.08,
  multiResolutionMaxPerResolution: 30,

  // ── Phase 11: Topic chunking (PHOTON C_2 equivalent) ──────────────────
  // Each topic file corresponds to PHOTON Level 2 in the memory hierarchy
  // (Level 0 = logs, 1 = index entries, 2 = topics, L = MEMORY.md).
  // Chunk size determines when a topic should be split/promoted rather than
  // accumulating indefinitely. Empirical calibration (2026-04-21): troubleshooting
  // had 20 entries at 409 lines (~20 lines/entry), already crowded — so soft=20
  // fires immediate signal, hard=35 gives ~6 months runway before forced split.
  //
  // Semantics:
  //   - soft: emit warning in daily log, surface split suggestions (non-binding)
  //   - hard: trigger forced promotion at next distill (split into sub-topics)
  //
  // Line-based limits are kept as legacy safety valve — pre-Phase 11 infra
  // (distill.md) uses line count. When both entry and line checks exist,
  // whichever triggers first wins.
  topicSoftLimitEntries: 20,
  topicHardLimitEntries: 35,
  topicSoftLimitLines: 500,
  topicHardLimitLines: 800,

  // ── Phase 14: Retention scoring (Screening-Is-Enough on write side) ───
  // Replaces the old implicit "first ~500 lines wins" retention with an
  // absolute-threshold, weighted signal combination. Low-scoring entries
  // are candidates for promotion/merge within their topic at the next
  // distill cycle — they are NEVER deleted silently.
  //
  // Initial weights are all 1.0 (neutral starting point). Hill-Climb on the
  // benchmark suite + LongMemEval will tune these empirically; hand-picked
  // values (e.g., llm_wiki's 3/4/1.5/1) are rejected in favor of
  // benchmark-driven calibration, per CLAUDE.md 行動原則.
  //
  // threshold=0.40 is a neutral middle ground — TF-IDF-derived signals
  // converge around 0.3-0.5 empirically; Hill-Climb will find the actual
  // value that maximizes retrieval on LongMemEval without degrading
  // holdout precision.
  retentionThreshold: 0.40,
  retentionW_hit: 1.0,
  retentionW_centrality: 1.0,
  retentionW_novelty: 1.0,
  retentionW_diversity: 1.0,
  retentionW_recency: 1.0,
  retentionW_bridge: 1.0,
  /** When true, log retention scores but DO NOT promote/merge.
   *  Graduated from dry-run on 2026-05-06 after 11-day observation
   *  (4/25-5/5) and 4 consecutive production verify runs stayed above
   *  MIN_HIT_RATE (70%). LongMemEval Hill-Climb tune deferred to Phase 4. */
  retentionDryRun: false,
} as const satisfies ScreeningConfigShape

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScreeningConfigShape = {
  memoryThreshold: number
  memoryMaxResults: number
  compactThreshold: number
  searchThreshold: number
  searchMaxResults: number
  boostRecency: boolean
  recencyHalfLifeMs: number
  noveltyThreshold: number
  noveltyMaxObservations: number
  // Multi-resolution screening (PHOTON-inspired)
  conceptThreshold: number
  topicThreshold: number
  multiResolutionMaxPerResolution: number
  // Topic chunking (Phase 11, PHOTON C_2)
  topicSoftLimitEntries: number
  topicHardLimitEntries: number
  topicSoftLimitLines: number
  topicHardLimitLines: number
  // Retention scoring (Phase 14, Screening-Is-Enough on write side)
  retentionThreshold: number
  retentionW_hit: number
  retentionW_centrality: number
  retentionW_novelty: number
  retentionW_diversity: number
  retentionW_recency: number
  retentionW_bridge: number
  retentionDryRun: boolean
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Lazy initialization to avoid top-level import cost in non-REPL contexts.
// Use z.ZodType<Output, Input> (zod v4: 2 generic params; v3 was 3) to allow
// .default() fields whose input type includes undefined.
let _schema: z.ZodType<ScreeningConfigShape, any> | null = null

function getSchema(): z.ZodType<ScreeningConfigShape, any> {
  if (!_schema) {
    _schema = z.object({
      // Read-side thresholds: similarity value below which items are rejected.
      // TF-IDF cosine similarities are typically low (0.0-0.3 for short texts),
      // so practical thresholds for TF-IDF are 0.05-0.30 (unlike neural
      // embeddings where the paper's r >= 2 / threshold >= 0.5 applies).
      memoryThreshold: z.number().min(0.01).max(0.99),
      memoryMaxResults: z.number().int().min(1).max(200),
      compactThreshold: z.number().min(0.01).max(0.99),
      searchThreshold: z.number().min(0.01).max(0.99),
      searchMaxResults: z.number().int().min(1).max(100),
      boostRecency: z.boolean().default(true),
      recencyHalfLifeMs: z
        .number()
        .int()
        .min(0)
        .max(THIRTY_DAYS_MS)
        .default(DEFAULT_SCREENING_CONFIG.recencyHalfLifeMs),
      // Write-side threshold: similarity above which observations are redundant.
      // Lower = stricter (rejects more as redundant). Range 0.1-0.5 is practical.
      noveltyThreshold: z.number().min(0.01).max(0.5)
        .default(DEFAULT_SCREENING_CONFIG.noveltyThreshold),
      noveltyMaxObservations: z.number().int().min(1).max(50)
        .default(DEFAULT_SCREENING_CONFIG.noveltyMaxObservations),
      // Multi-resolution thresholds
      conceptThreshold: z.number().min(0.01).max(0.99)
        .default(DEFAULT_SCREENING_CONFIG.conceptThreshold),
      topicThreshold: z.number().min(0.01).max(0.99)
        .default(DEFAULT_SCREENING_CONFIG.topicThreshold),
      multiResolutionMaxPerResolution: z.number().int().min(1).max(200)
        .default(DEFAULT_SCREENING_CONFIG.multiResolutionMaxPerResolution),
      // Topic chunking (Phase 11). Invariant: soft < hard.
      topicSoftLimitEntries: z.number().int().min(5).max(500)
        .default(DEFAULT_SCREENING_CONFIG.topicSoftLimitEntries),
      topicHardLimitEntries: z.number().int().min(10).max(1000)
        .default(DEFAULT_SCREENING_CONFIG.topicHardLimitEntries),
      topicSoftLimitLines: z.number().int().min(100).max(10000)
        .default(DEFAULT_SCREENING_CONFIG.topicSoftLimitLines),
      topicHardLimitLines: z.number().int().min(200).max(20000)
        .default(DEFAULT_SCREENING_CONFIG.topicHardLimitLines),
      // Retention (Phase 14). Weights are non-negative, threshold in [0, 1].
      retentionThreshold: z.number().min(0).max(1)
        .default(DEFAULT_SCREENING_CONFIG.retentionThreshold),
      retentionW_hit: z.number().min(0).max(10)
        .default(DEFAULT_SCREENING_CONFIG.retentionW_hit),
      retentionW_centrality: z.number().min(0).max(10)
        .default(DEFAULT_SCREENING_CONFIG.retentionW_centrality),
      retentionW_novelty: z.number().min(0).max(10)
        .default(DEFAULT_SCREENING_CONFIG.retentionW_novelty),
      retentionW_diversity: z.number().min(0).max(10)
        .default(DEFAULT_SCREENING_CONFIG.retentionW_diversity),
      retentionW_recency: z.number().min(0).max(10)
        .default(DEFAULT_SCREENING_CONFIG.retentionW_recency),
      retentionW_bridge: z.number().min(0).max(10)
        .default(DEFAULT_SCREENING_CONFIG.retentionW_bridge),
      retentionDryRun: z.boolean()
        .default(DEFAULT_SCREENING_CONFIG.retentionDryRun),
    })
  }
  return _schema
}

// ---------------------------------------------------------------------------
// Config accessor
// ---------------------------------------------------------------------------

// Overridable for testing — same pattern as cronJitterConfig.ts.
let _override: ScreeningConfigShape | null = null

/**
 * Get the current screening configuration. Returns DEFAULT_SCREENING_CONFIG
 * unless overridden via setScreeningConfig (testing) or wired to GrowthBook.
 */
export function getScreeningConfig(): ScreeningConfigShape {
  if (_override) return _override
  return DEFAULT_SCREENING_CONFIG
}

/**
 * Parse and validate a raw config object. Returns the validated config on
 * success, or DEFAULT_SCREENING_CONFIG on any validation failure (the whole
 * object is rejected on any bad field, not partially trusted).
 */
export function parseScreeningConfig(raw: unknown): ScreeningConfigShape {
  const parsed = getSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_SCREENING_CONFIG
}

/** Override config for testing. Pass null to clear. */
export function setScreeningConfig(
  config: ScreeningConfigShape | null,
): void {
  _override = config
}
