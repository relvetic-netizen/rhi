// Eval baseline — records and compares baseline performance snapshots.
//
// A baseline captures the screening pipeline's performance at a point in time,
// enabling regression detection and optimization validation.

import type { ScreeningConfigShape } from '../screening/screeningConfig.js'
import type { EvalRun } from './evalTypes.js'
import type { SplitMeta } from './evalSplit.js'
import { writeBaseline, readBaseline, listBaselines } from './evalStore.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BaselineRecord = {
  baselineId: string
  createdAt: string
  config: ScreeningConfigShape
  optimizationRun: EvalRun
  holdoutRun: EvalRun
  splitMeta: SplitMeta
}

export type BaselineComparison = {
  configDiff: Record<string, { old: number | boolean; new: number | boolean }>
  optimizationDelta: {
    passRateDelta: number
    avgScoreDelta: number
    categoryDeltas: Record<string, number>
    regressions: string[]
    improvements: string[]
  }
  holdoutDelta: {
    passRateDelta: number
    avgScoreDelta: number
    categoryDeltas: Record<string, number>
  }
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

function generateBaselineId(): string {
  const now = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `baseline_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`
}

export async function recordNewBaseline(
  dir: string,
  config: ScreeningConfigShape,
  optimizationRun: EvalRun,
  holdoutRun: EvalRun,
  splitMeta: SplitMeta,
): Promise<BaselineRecord> {
  const record: BaselineRecord = {
    baselineId: generateBaselineId(),
    createdAt: new Date().toISOString(),
    config,
    optimizationRun,
    holdoutRun,
    splitMeta,
  }

  await writeBaseline(dir, record.baselineId, record)
  return record
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function readLatestBaseline(dir: string): Promise<BaselineRecord | null> {
  const ids = await listBaselines(dir)
  if (ids.length === 0) return null

  const latestId = ids[ids.length - 1]!
  const raw = await readBaseline(dir, latestId)
  if (!raw || typeof raw !== 'object') return null
  return raw as BaselineRecord
}

export async function readBaselineById(dir: string, baselineId: string): Promise<BaselineRecord | null> {
  const raw = await readBaseline(dir, baselineId)
  if (!raw || typeof raw !== 'object') return null
  return raw as BaselineRecord
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export function compareWithBaseline(
  baseline: BaselineRecord,
  newOptRun: EvalRun,
  newHoldoutRun: EvalRun,
  newConfig: ScreeningConfigShape,
): BaselineComparison {
  // Config diff
  const configDiff: BaselineComparison['configDiff'] = {}
  for (const key of Object.keys(baseline.config) as (keyof ScreeningConfigShape)[]) {
    const oldVal = baseline.config[key]
    const newVal = newConfig[key]
    if (oldVal !== newVal) {
      configDiff[key] = { old: oldVal as number | boolean, new: newVal as number | boolean }
    }
  }

  // Optimization delta
  const optDelta = computeRunDelta(baseline.optimizationRun, newOptRun)

  // Holdout delta
  const holdoutDelta = computeRunDelta(baseline.holdoutRun, newHoldoutRun)

  return {
    configDiff,
    optimizationDelta: optDelta,
    holdoutDelta: {
      passRateDelta: holdoutDelta.passRateDelta,
      avgScoreDelta: holdoutDelta.avgScoreDelta,
      categoryDeltas: holdoutDelta.categoryDeltas,
    },
  }
}

function computeRunDelta(
  baseRun: EvalRun,
  newRun: EvalRun,
): {
  passRateDelta: number
  avgScoreDelta: number
  categoryDeltas: Record<string, number>
  regressions: string[]
  improvements: string[]
} {
  const passRateDelta = newRun.summary.passRate - baseRun.summary.passRate
  const avgScoreDelta = newRun.summary.avgScore - baseRun.summary.avgScore

  // Category deltas
  const categoryDeltas: Record<string, number> = {}
  const allCategories = new Set([
    ...Object.keys(baseRun.summary.categoryScores),
    ...Object.keys(newRun.summary.categoryScores),
  ])
  for (const cat of allCategories) {
    const oldScore = baseRun.summary.categoryScores[cat] ?? 0
    const newScore = newRun.summary.categoryScores[cat] ?? 0
    categoryDeltas[cat] = newScore - oldScore
  }

  // Case-level regressions/improvements
  const baseResults = new Map(baseRun.results.map(r => [r.caseId, r]))
  const regressions: string[] = []
  const improvements: string[] = []

  for (const newResult of newRun.results) {
    const baseResult = baseResults.get(newResult.caseId)
    if (!baseResult) continue

    if (baseResult.passed && !newResult.passed) {
      regressions.push(newResult.caseId)
    } else if (!baseResult.passed && newResult.passed) {
      improvements.push(newResult.caseId)
    }
  }

  return { passRateDelta, avgScoreDelta, categoryDeltas, regressions, improvements }
}
