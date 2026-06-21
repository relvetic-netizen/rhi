// Eval runner — executes eval cases against the screening pipeline.
//
// Core insight: screenItems() and screenForNovelty() are synchronous pure
// functions that take string arrays — no file I/O dependency. This means
// evals run entirely in-memory without temp directories or production memory.

import {
  screenItems,
  type ScreeningConfig,
  type ScoredItem,
} from '../screening/screening.js'
import {
  screenForNovelty,
  type NoveltyConfig,
} from '../screening/noveltyScreening.js'
import {
  type ScreeningConfigShape,
  getScreeningConfig,
} from '../screening/screeningConfig.js'
import {
  type EvalCase,
  type EvalResult,
  type EvalSuite,
  type EvalRun,
  type EvalRunSummary,
  type EvalCategory,
} from './evalTypes.js'

// ---------------------------------------------------------------------------
// Run ID generation
// ---------------------------------------------------------------------------

function generateRunId(): string {
  const now = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `run_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

// ---------------------------------------------------------------------------
// Single case execution
// ---------------------------------------------------------------------------

export function runEvalCase(
  evalCase: EvalCase,
  config: ScreeningConfigShape,
): EvalResult {
  const executedAt = new Date().toISOString()

  switch (evalCase.category) {
    case 'search-recall':
    case 'cross-lingual':
    case 'concept-expansion':
    case 'multi-resolution': {
      return runSearchRecallCase(evalCase, config, executedAt)
    }
    case 'search-precision': {
      return runSearchPrecisionCase(evalCase, config, executedAt)
    }
    case 'novelty-accept':
    case 'novelty-reject': {
      return runNoveltyCase(evalCase, config, executedAt)
    }
    case 'privacy-safety-valve':
    case 'stale-hit-reject': {
      return runEntryIdRejectionCase(evalCase, config, executedAt)
    }
    default: {
      return {
        caseId: evalCase.id,
        passed: false,
        score: 0,
        details: { error: `Unknown category: ${evalCase.category}` },
        executedAt,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Search recall: expected items should appear in results
// ---------------------------------------------------------------------------

function runSearchRecallCase(
  evalCase: EvalCase,
  config: ScreeningConfigShape,
  executedAt: string,
): EvalResult {
  const expected = evalCase.expectedMatchIndices ?? []
  const expectedIds = evalCase.mustHitEntryIds ?? []
  if (expected.length === 0 && expectedIds.length === 0) {
    return { caseId: evalCase.id, passed: true, score: 1.0, executedAt }
  }

  const screeningConfig: ScreeningConfig = {
    threshold: config.searchThreshold,
    maxResults: config.searchMaxResults,
  }

  // Use indexed wrappers to avoid indexOf ambiguity with duplicate entries
  const indexed = evalCase.memoryEntries.map((text: string, i: number) => ({ text, i }))
  const scored = screenItems(
    indexed,
    (x: { text: string; i: number }) => x.text,
    evalCase.query,
    screeningConfig,
  )

  const passedIndices = new Set(scored.map((s: ScoredItem<{ text: string; i: number }>) => s.item.i))
  const passedIds = collectPassedEntryIds(scored, evalCase)

  // Indices-based metric (legacy)
  const found = expected.filter((i: number) => passedIndices.has(i))
  const recallIdx = expected.length === 0 ? 1.0 : found.length / expected.length

  // Entry-id-based metric (Memory Hardening Phase 5 T5-3)
  const foundIds = expectedIds.filter((id: string) => passedIds.has(id))
  const recallIds = expectedIds.length === 0 ? 1.0 : foundIds.length / expectedIds.length

  // Combined recall: average when both expectations are provided
  const recall = (expected.length > 0 && expectedIds.length > 0)
    ? (recallIdx + recallIds) / 2
    : (expected.length > 0 ? recallIdx : recallIds)

  return {
    caseId: evalCase.id,
    passed: recall >= 0.5, // At least half of expected items found
    score: recall,
    details: {
      expectedCount: expected.length + expectedIds.length,
      foundCount: found.length + foundIds.length,
      totalPassed: scored.length,
      foundIndices: found,
      missedIndices: expected.filter((i: number) => !passedIndices.has(i)),
      foundEntryIds: foundIds,
      missedEntryIds: expectedIds.filter((id: string) => !passedIds.has(id)),
      recallIdx,
      recallIds,
    },
    executedAt,
  }
}

// ---------------------------------------------------------------------------
// Helper: collect entry IDs of items that passed screening (when
// memoryEntryIds is provided 1:1 with memoryEntries).
// ---------------------------------------------------------------------------

function collectPassedEntryIds(
  scored: ScoredItem<{ text: string; i: number }>[],
  evalCase: EvalCase,
): Set<string> {
  const ids = evalCase.memoryEntryIds
  if (!ids || ids.length !== evalCase.memoryEntries.length) return new Set()
  const out = new Set<string>()
  for (const s of scored) {
    const id = ids[s.item.i]
    if (id) out.add(id)
  }
  return out
}

// ---------------------------------------------------------------------------
// Search precision: irrelevant items should NOT appear
// ---------------------------------------------------------------------------

function runSearchPrecisionCase(
  evalCase: EvalCase,
  config: ScreeningConfigShape,
  executedAt: string,
): EvalResult {
  const expected = evalCase.expectedMatchIndices ?? []

  const screeningConfig: ScreeningConfig = {
    threshold: config.searchThreshold,
    maxResults: config.searchMaxResults,
  }

  // Use indexed wrappers to avoid indexOf ambiguity with duplicate entries
  const indexed = evalCase.memoryEntries.map((text: string, i: number) => ({ text, i }))
  const scored = screenItems(
    indexed,
    (x: { text: string; i: number }) => x.text,
    evalCase.query,
    screeningConfig,
  )

  const passedIndices = new Set(scored.map((s: ScoredItem<{ text: string; i: number }>) => s.item.i))

  const expectedSet = new Set(expected)
  const falsePositives = [...passedIndices].filter((i: number) => !expectedSet.has(i))
  const precision = scored.length === 0 ? 1.0 : 1 - falsePositives.length / scored.length

  return {
    caseId: evalCase.id,
    passed: precision >= 0.7,
    score: Math.max(0, precision),
    details: {
      totalPassed: scored.length,
      truePositives: scored.length - falsePositives.length,
      falsePositives: falsePositives.length,
      falsePositiveIndices: falsePositives,
    },
    executedAt,
  }
}

// ---------------------------------------------------------------------------
// Novelty: novel observations should pass, redundant should be rejected
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Privacy-safety-valve / stale-hit-reject (Memory Hardening Phase 5 T5-2):
// entry IDs in `mustNotHitEntryIds` and any ID matching `forbiddenIdPrefixes`
// must NOT appear in screening results. Pass = no forbidden ID leaked.
// ---------------------------------------------------------------------------

function runEntryIdRejectionCase(
  evalCase: EvalCase,
  config: ScreeningConfigShape,
  executedAt: string,
): EvalResult {
  const mustNot = new Set(evalCase.mustNotHitEntryIds ?? [])
  const forbiddenPrefixes = evalCase.forbiddenIdPrefixes ?? []
  if (mustNot.size === 0 && forbiddenPrefixes.length === 0) {
    return {
      caseId: evalCase.id,
      passed: false,
      score: 0,
      details: { error: 'category requires mustNotHitEntryIds or forbiddenIdPrefixes' },
      executedAt,
    }
  }

  const screeningConfig: ScreeningConfig = {
    threshold: config.searchThreshold,
    maxResults: config.searchMaxResults,
  }

  const indexed = evalCase.memoryEntries.map((text: string, i: number) => ({ text, i }))
  const scored = screenItems(
    indexed,
    (x: { text: string; i: number }) => x.text,
    evalCase.query,
    screeningConfig,
  )

  const passedIds = collectPassedEntryIds(scored, evalCase)
  const explicitLeaks = [...passedIds].filter((id: string) => mustNot.has(id))
  const prefixLeaks = [...passedIds].filter((id: string) =>
    forbiddenPrefixes.some((p: string) => id.includes(p))
  )
  const leaks = [...new Set([...explicitLeaks, ...prefixLeaks])]

  return {
    caseId: evalCase.id,
    passed: leaks.length === 0,
    score: leaks.length === 0 ? 1.0 : 0.0,
    details: {
      mustNotCount: mustNot.size,
      forbiddenPrefixCount: forbiddenPrefixes.length,
      leakedEntryIds: leaks,
      totalPassed: scored.length,
      passedEntryIds: [...passedIds],
    },
    executedAt,
  }
}

function runNoveltyCase(
  evalCase: EvalCase,
  config: ScreeningConfigShape,
  executedAt: string,
): EvalResult {
  const noveltyConfig: NoveltyConfig = {
    threshold: config.noveltyThreshold,
    maxObservations: config.noveltyMaxObservations,
  }

  const scored = screenForNovelty(
    [evalCase.query],
    evalCase.memoryEntries,
    noveltyConfig,
  )

  const isNovel = scored.length > 0
  const expectedNovel = evalCase.expectedNovel ?? true

  const passed = isNovel === expectedNovel
  const score = passed ? 1.0 : 0.0

  return {
    caseId: evalCase.id,
    passed,
    score,
    details: {
      expectedNovel,
      actualNovel: isNovel,
      noveltyScore: scored[0]?.score ?? 0,
    },
    executedAt,
  }
}

// ---------------------------------------------------------------------------
// Suite execution
// ---------------------------------------------------------------------------

function computeSummary(
  results: EvalResult[],
  cases: EvalCase[],
): EvalRunSummary {
  const totalCases = results.length
  const passedCases = results.filter(r => r.passed).length
  const passRate = totalCases === 0 ? 0 : passedCases / totalCases
  const avgScore = totalCases === 0 ? 0 : results.reduce((s, r) => s + r.score, 0) / totalCases

  // Category-level scores
  const categoryScores: Record<string, number> = {}
  const categoryGroups = new Map<string, EvalResult[]>()
  for (let i: number = 0; i < results.length; i++) {
    const cat: string = cases[i]?.category ?? 'unknown'
    const group = categoryGroups.get(cat) ?? []
    group.push(results[i]!)
    categoryGroups.set(cat, group)
  }
  for (const [cat, group] of categoryGroups) {
    categoryScores[cat] = group.reduce((s, r) => s + r.score, 0) / group.length
  }

  return { totalCases, passedCases, passRate, avgScore, categoryScores }
}

export function runEvalSuite(
  suite: EvalSuite,
  config?: ScreeningConfigShape,
): EvalRun {
  const effectiveConfig = config ?? getScreeningConfig()
  const results: EvalResult[] = suite.cases.map(c => runEvalCase(c, effectiveConfig))
  const summary = computeSummary(results, suite.cases)

  // Build config snapshot (numeric + boolean values only)
  const configSnapshot: Record<string, number | boolean> = {}
  for (const [k, v] of Object.entries(effectiveConfig)) {
    if (typeof v === 'number' || typeof v === 'boolean') {
      configSnapshot[k] = v
    }
  }

  return {
    runId: generateRunId(),
    configSnapshot,
    timestamp: new Date().toISOString(),
    results,
    summary,
  }
}

/** Run a subset of cases (e.g., only optimization or holdout set). */
export function runEvalCases(
  cases: EvalCase[],
  config?: ScreeningConfigShape,
): EvalRun {
  return runEvalSuite({ version: 1, cases }, config)
}
