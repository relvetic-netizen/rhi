// Eval split — stratified splitting of eval cases into optimization and holdout sets.
//
// Prevents overfitting by ensuring the optimization loop never sees holdout cases.
// Uses deterministic seeded shuffle for reproducibility.

import type { EvalCase, EvalSuite, EvalCategory } from './evalTypes.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvalSplitConfig = {
  /** Fraction of cases used for optimization (default 0.70). */
  optimizationRatio: number
  /** Minimum holdout cases per category (default 1). */
  minHoldoutPerCategory: number
  /** Deterministic seed for reproducible splits. */
  seed: number
}

export type SplitMeta = {
  seed: number
  optimizationCount: number
  holdoutCount: number
  categoryDistribution: Record<string, { optimization: number; holdout: number }>
}

export type EvalSplit = {
  optimization: EvalCase[]
  holdout: EvalCase[]
  splitMeta: SplitMeta
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SPLIT_CONFIG: EvalSplitConfig = {
  optimizationRatio: 0.70,
  minHoldoutPerCategory: 1,
  seed: 42,
}

// ---------------------------------------------------------------------------
// Deterministic shuffle (seeded PRNG)
// ---------------------------------------------------------------------------

/** Simple mulberry32 PRNG — deterministic, fast, good enough for shuffling. */
function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr]
  const rng = mulberry32(seed)
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = result[i]!
    result[i] = result[j]!
    result[j] = tmp
  }
  return result
}

/** Simple string hash for combining seed with category name. */
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h
}

// ---------------------------------------------------------------------------
// Split logic
// ---------------------------------------------------------------------------

/**
 * Split an eval suite into optimization and holdout sets using
 * tag-stratified sampling. Each category maintains the split ratio
 * independently, guaranteeing at least minHoldoutPerCategory in holdout.
 */
export function splitEvalSuite(
  suite: EvalSuite,
  config?: Partial<EvalSplitConfig>,
): EvalSplit {
  const cfg = { ...DEFAULT_SPLIT_CONFIG, ...config }

  // Group by category
  const groups = new Map<string, EvalCase[]>()
  for (const c of suite.cases) {
    const group = groups.get(c.category) ?? []
    group.push(c)
    groups.set(c.category, group)
  }

  const optimization: EvalCase[] = []
  const holdout: EvalCase[] = []
  const categoryDistribution: Record<string, { optimization: number; holdout: number }> = {}

  for (const [category, cases] of groups) {
    // Deterministic shuffle per category
    const shuffled = seededShuffle(cases, cfg.seed + hashString(category))

    // Compute holdout count: at least minHoldoutPerCategory, but leave at least 1 for optimization
    const desiredHoldout = Math.max(
      cfg.minHoldoutPerCategory,
      Math.floor(cases.length * (1 - cfg.optimizationRatio)),
    )
    const holdoutCount = Math.min(desiredHoldout, cases.length - 1)

    holdout.push(...shuffled.slice(0, holdoutCount))
    optimization.push(...shuffled.slice(holdoutCount))

    categoryDistribution[category] = {
      optimization: cases.length - holdoutCount,
      holdout: holdoutCount,
    }
  }

  return {
    optimization,
    holdout,
    splitMeta: {
      seed: cfg.seed,
      optimizationCount: optimization.length,
      holdoutCount: holdout.length,
      categoryDistribution,
    },
  }
}
