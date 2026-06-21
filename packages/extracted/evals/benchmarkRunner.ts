// Benchmark runner — executes scenarios across 3 conditions and scores results.
//
// Conditions:
//   A (Vanilla):     No memory search — empty results
//   B (Flat Memory): All entries returned with uniform score (no Screening)
//   C (Relvetia):      screenItems() with Trim-and-Square filtering
//
// Each category has a specific scoring function that measures a different
// dimension of memory system quality.

import {
  screenItems,
  type ScreeningConfig,
  type ScoredItem,
} from '../screening/screening.js'
import {
  type ScreeningConfigShape,
  getScreeningConfig,
} from '../screening/screeningConfig.js'
import type {
  BenchmarkScenario,
  BenchmarkCondition,
  ConditionResult,
  ScenarioResult,
  BenchmarkRun,
  BenchmarkSummary,
  CategoryScore,
} from './benchmarkTypes.js'

// ---------------------------------------------------------------------------
// Indexed item type (avoids indexOf ambiguity)
// ---------------------------------------------------------------------------

type IndexedItem = { text: string; i: number }

// ---------------------------------------------------------------------------
// Condition runners
// ---------------------------------------------------------------------------

function runVanilla(): ScoredItem<IndexedItem>[] {
  return []
}

function runFlatMemory(entries: string[]): ScoredItem<IndexedItem>[] {
  return entries.map((text: string, i: number) => ({
    item: { text, i },
    score: 1.0,
  }))
}

function runRelvetia(
  entries: string[],
  query: string,
  config: ScreeningConfigShape,
): ScoredItem<IndexedItem>[] {
  const indexed = entries.map((text: string, i: number) => ({ text, i }))
  return screenItems(
    indexed,
    (x: IndexedItem) => x.text,
    query,
    { threshold: config.searchThreshold, maxResults: config.searchMaxResults },
  )
}

// ---------------------------------------------------------------------------
// Category scorers
// ---------------------------------------------------------------------------

/** Cross-Session Recall: fraction of expected entries found. */
function scoreCrossSessionRecall(
  returned: ScoredItem<IndexedItem>[],
  expected: number[],
): number {
  if (expected.length === 0) return 1.0
  const found = new Set(returned.map((s: ScoredItem<IndexedItem>) => s.item.i))
  const hits = expected.filter((i: number) => found.has(i)).length
  return hits / expected.length
}

/** Preference Adherence: Mean Reciprocal Rank of preference entries. */
function scorePreferenceAdherence(
  returned: ScoredItem<IndexedItem>[],
  prefIndices: number[],
): number {
  if (prefIndices.length === 0) return 1.0
  if (returned.length === 0) return 0

  const prefSet = new Set(prefIndices)
  let rrSum = 0
  for (const pref of prefIndices) {
    const rank = returned.findIndex((s: ScoredItem<IndexedItem>) => s.item.i === pref)
    if (rank >= 0) {
      rrSum += 1 / (rank + 1)
    }
  }
  return rrSum / prefIndices.length
}

/**
 * Context Token Efficiency: recall-weighted compression ratio.
 * Score = recall * (1 - context_ratio)
 * Vanilla gets 0 (not 100%) because 0 tokens with 0 recall is useless.
 */
function scoreContextEfficiency(
  returned: ScoredItem<IndexedItem>[],
  expected: number[],
  totalCorpusChars: number,
): number {
  if (totalCorpusChars === 0) return 0
  const returnedChars = returned.reduce((sum: number, s: ScoredItem<IndexedItem>) => sum + s.item.text.length, 0)
  const contextRatio = returnedChars / totalCorpusChars
  const compression = 1 - contextRatio

  // Recall component
  const found = new Set(returned.map((s: ScoredItem<IndexedItem>) => s.item.i))
  const recall = expected.length > 0
    ? expected.filter((i: number) => found.has(i)).length / expected.length
    : 0

  return recall * compression
}

/**
 * Task Accuracy: correct entries found / (correct + outdated found).
 * Measures whether current info is preferred over contradicted info.
 */
function scoreTaskAccuracy(
  returned: ScoredItem<IndexedItem>[],
  correctIndices: number[],
  outdatedIndices: number[],
): number {
  const found = new Set(returned.map((s: ScoredItem<IndexedItem>) => s.item.i))
  const correctFound = correctIndices.filter((i: number) => found.has(i)).length
  const outdatedFound = outdatedIndices.filter((i: number) => found.has(i)).length
  const total = correctFound + outdatedFound
  if (total === 0) return 0.5 // No info = random guess baseline
  return correctFound / total
}

/**
 * Noise Rejection: precision (true positives / total returned).
 * Returns -1 for Vanilla (N/A, nothing returned).
 */
function scoreNoiseRejection(
  returned: ScoredItem<IndexedItem>[],
  noiseIndices: number[],
): number {
  if (returned.length === 0) return -1 // N/A
  const noiseSet = new Set(noiseIndices)
  const noiseFound = returned.filter((s: ScoredItem<IndexedItem>) => noiseSet.has(s.item.i)).length
  return 1 - noiseFound / returned.length
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

function scoreCondition(
  scenario: BenchmarkScenario,
  returned: ScoredItem<IndexedItem>[],
): number {
  const totalChars = scenario.memoryEntries.reduce((s: number, e: string) => s + e.length, 0)

  switch (scenario.category) {
    case 'cross-session-recall':
      return scoreCrossSessionRecall(returned, scenario.expectedMatchIndices ?? [])
    case 'preference-adherence':
      return scorePreferenceAdherence(returned, scenario.preferenceIndices ?? [])
    case 'context-token-efficiency':
      return scoreContextEfficiency(returned, scenario.expectedMatchIndices ?? [], totalChars)
    case 'task-accuracy-prior':
      return scoreTaskAccuracy(returned, scenario.correctIndices ?? [], scenario.outdatedIndices ?? [])
    case 'noise-rejection':
      return scoreNoiseRejection(returned, scenario.noiseIndices ?? [])
    default:
      return 0
  }
}

function runScenario(
  scenario: BenchmarkScenario,
  config: ScreeningConfigShape,
): ScenarioResult {
  const conditions: BenchmarkCondition[] = ['vanilla', 'flat-memory', 'relvetia']
  const results: ConditionResult[] = conditions.map((condition: BenchmarkCondition) => {
    let returned: ScoredItem<IndexedItem>[]
    switch (condition) {
      case 'vanilla':
        returned = runVanilla()
        break
      case 'flat-memory':
        returned = runFlatMemory(scenario.memoryEntries)
        break
      case 'relvetia':
        returned = runRelvetia(scenario.memoryEntries, scenario.query, config)
        break
    }

    const score = scoreCondition(scenario, returned)
    const returnedCharCount = returned.reduce((s: number, r: ScoredItem<IndexedItem>) => s + r.item.text.length, 0)

    return {
      condition,
      score: Math.max(0, score), // Clamp N/A (-1) to 0 for storage
      returnedCount: returned.length,
      returnedCharCount,
      details: { rawScore: score }, // Preserve -1 for N/A detection
    }
  })

  return { scenarioId: scenario.id, category: scenario.category, results }
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

function computeSummary(scenarioResults: ScenarioResult[]): BenchmarkSummary {
  const catGroups = new Map<string, ScenarioResult[]>()
  for (const sr of scenarioResults) {
    const group = catGroups.get(sr.category) ?? []
    group.push(sr)
    catGroups.set(sr.category, group)
  }

  const categoryScores: Record<string, CategoryScore> = {}

  for (const [cat, group] of catGroups) {
    const avg = (condition: BenchmarkCondition): number => {
      const scores = group.map((sr: ScenarioResult) => {
        const cr = sr.results.find((r: ConditionResult) => r.condition === condition)
        const rawScore = (cr?.details as { rawScore?: number } | undefined)?.rawScore ?? cr?.score ?? 0
        return rawScore
      }).filter((s: number) => s >= 0) // Exclude N/A (-1)
      return scores.length > 0 ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : 0
    }

    const vanilla = avg('vanilla')
    const flatMemory = avg('flat-memory')
    const relvetia = avg('relvetia')

    categoryScores[cat] = {
      vanilla,
      flatMemory,
      relvetia,
      deltaKV: relvetia - vanilla,
    }
  }

  // Overall: average across categories
  const cats = Object.values(categoryScores)
  const overall: CategoryScore = {
    vanilla: cats.reduce((s: number, c: CategoryScore) => s + c.vanilla, 0) / cats.length,
    flatMemory: cats.reduce((s: number, c: CategoryScore) => s + c.flatMemory, 0) / cats.length,
    relvetia: cats.reduce((s: number, c: CategoryScore) => s + c.relvetia, 0) / cats.length,
    deltaKV: cats.reduce((s: number, c: CategoryScore) => s + c.deltaKV, 0) / cats.length,
  }

  return { categoryScores, overall }
}

// ---------------------------------------------------------------------------
// Run ID
// ---------------------------------------------------------------------------

function generateRunId(): string {
  const now = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `bench_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runBenchmarkSuite(
  scenarios: BenchmarkScenario[],
  config?: ScreeningConfigShape,
): BenchmarkRun {
  const effectiveConfig = config ?? getScreeningConfig()
  const scenarioResults = scenarios.map((s: BenchmarkScenario) => runScenario(s, effectiveConfig))
  const summary = computeSummary(scenarioResults)

  const configSnapshot: Record<string, number | boolean> = {}
  for (const [k, v] of Object.entries(effectiveConfig)) {
    if (typeof v === 'number' || typeof v === 'boolean') configSnapshot[k] = v
  }

  return {
    runId: generateRunId(),
    timestamp: new Date().toISOString(),
    configSnapshot,
    scenarioResults,
    summary,
  }
}
