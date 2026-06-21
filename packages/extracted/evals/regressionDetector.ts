// Regression detector — compares current eval results against a baseline
// to detect performance regressions at the case and category level.

import type { EvalRun } from './evalTypes.js'
import type { BaselineRecord } from './evalBaseline.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegressedCase = {
  caseId: string
  category: string
  baselineScore: number
  currentScore: number
  delta: number
}

export type CategoryRegression = {
  baselinePassRate: number
  currentPassRate: number
  delta: number
}

export type RegressionReport = {
  baselineId: string
  currentRunId: string
  overallRegression: boolean
  regressedCases: RegressedCase[]
  newFailures: string[]
  newPasses: string[]
  categoryRegressions: Record<string, CategoryRegression>
  recommendation: 'safe' | 'review-regressions' | 'do-not-merge'
}

export type RegressionThresholds = {
  /** Overall pass rate drop to trigger regression (default 0.05 = 5%). */
  overallDelta: number
  /** Per-case score drop to flag as regressed (default 0.1). */
  caseDelta: number
}

const DEFAULT_THRESHOLDS: RegressionThresholds = {
  overallDelta: 0.05,
  caseDelta: 0.1,
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectRegressions(
  baseline: BaselineRecord,
  currentRun: EvalRun,
  thresholds?: Partial<RegressionThresholds>,
): RegressionReport {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds }

  // Merge both opt and holdout baseline results for full comparison
  const allBaselineResults = [
    ...baseline.optimizationRun.results,
    ...baseline.holdoutRun.results,
  ]
  const baseMap = new Map(allBaselineResults.map(r => [r.caseId, r]))

  const regressedCases: RegressedCase[] = []
  const newFailures: string[] = []
  const newPasses: string[] = []

  // Compare case by case
  for (const current of currentRun.results) {
    const base = baseMap.get(current.caseId)
    if (!base) continue

    const delta = current.score - base.score

    if (delta < -t.caseDelta) {
      // Derive category from caseId pattern (e.g., "seed_search_001" → "search")
      const category = current.caseId.replace(/^(seed|auto)_/, '').replace(/_\d+$/, '').replace(/_/g, '-')
      regressedCases.push({
        caseId: current.caseId,
        category,
        baselineScore: base.score,
        currentScore: current.score,
        delta,
      })
    }

    if (base.passed && !current.passed) {
      newFailures.push(current.caseId)
    } else if (!base.passed && current.passed) {
      newPasses.push(current.caseId)
    }
  }

  // Category-level comparison — weighted average by case count
  const optCount = baseline.optimizationRun.summary.totalCases
  const holdCount = baseline.holdoutRun.summary.totalCases
  const totalCount = optCount + holdCount
  const baselineCombinedPassRate = totalCount > 0
    ? (baseline.optimizationRun.summary.passRate * optCount + baseline.holdoutRun.summary.passRate * holdCount) / totalCount
    : 0
  const overallDelta = currentRun.summary.passRate - baselineCombinedPassRate
  const overallRegression = overallDelta < -t.overallDelta

  // Category regressions — collect scores from both runs, then average
  const optCatScores = baseline.optimizationRun.summary.categoryScores
  const holdCatScores = baseline.holdoutRun.summary.categoryScores
  const allCats = new Set([...Object.keys(optCatScores), ...Object.keys(holdCatScores)])

  const baselineCatScores: Record<string, number> = {}
  for (const cat of allCats) {
    const hasOpt = cat in optCatScores
    const hasHold = cat in holdCatScores
    if (hasOpt && hasHold) {
      baselineCatScores[cat] = (optCatScores[cat]! + holdCatScores[cat]!) / 2
    } else if (hasOpt) {
      baselineCatScores[cat] = optCatScores[cat]!
    } else {
      baselineCatScores[cat] = holdCatScores[cat]!
    }
  }

  const categoryRegressions: Record<string, CategoryRegression> = {}
  for (const cat of Object.keys(currentRun.summary.categoryScores)) {
    const baseCatRate = baselineCatScores[cat] ?? 0
    const currentCatRate = currentRun.summary.categoryScores[cat] ?? 0
    categoryRegressions[cat] = {
      baselinePassRate: baseCatRate,
      currentPassRate: currentCatRate,
      delta: currentCatRate - baseCatRate,
    }
  }

  // Recommendation
  let recommendation: RegressionReport['recommendation'] = 'safe'
  if (overallRegression) {
    recommendation = 'do-not-merge'
  } else if (newFailures.length > 0 || regressedCases.length > 0) {
    recommendation = 'review-regressions'
  }

  return {
    baselineId: baseline.baselineId,
    currentRunId: currentRun.runId,
    overallRegression,
    regressedCases,
    newFailures,
    newPasses,
    categoryRegressions,
    recommendation,
  }
}
