// Hill-Climb optimizer — greedy search over screening config parameters.
//
// Generates candidate changes (one parameter at a time), tests each against
// the optimization set, and accepts only if holdout doesn't regress.
// This is the "1 change at a time" principle from Better-Harness.
//
// Key constraint: screeningConfig.ts is immutable. We use setScreeningConfig()
// runtime override for testing, and output recommendations to a separate file.

import {
  type ScreeningConfigShape,
  getScreeningConfig,
  setScreeningConfig,
} from '../screening/screeningConfig.js'
import type { EvalSuite, EvalRun } from './evalTypes.js'
import type { EvalSplit } from './evalSplit.js'
import type { BaselineRecord } from './evalBaseline.js'
import { runEvalCases } from './evalRunner.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeCandidate = {
  id: string
  description: string
  type: 'threshold-adjust' | 'maxResults-adjust'
  configOverride: Partial<ScreeningConfigShape>
}

export type CandidateOutcome = {
  candidate: ChangeCandidate
  outcome: 'accepted' | 'rejected-no-improvement' | 'rejected-holdout-regression'
  optimizationPassRate: number
  holdoutPassRate: number
}

export type OptimizationResult = {
  baselineId: string
  candidatesTested: number
  candidatesAccepted: number
  accepted: CandidateOutcome[]
  rejected: CandidateOutcome[]
  recommendedConfig: ScreeningConfigShape
  timestamp: string
}

export type HillClimbOptions = {
  maxCandidates?: number
  holdoutRegressionTolerance?: number
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

const THRESHOLD_PARAMS: (keyof ScreeningConfigShape)[] = [
  'memoryThreshold',
  'searchThreshold',
  'noveltyThreshold',
  'conceptThreshold',
  'topicThreshold',
  // Phase 14: retention threshold is benchmark-tuned alongside read-side
  // thresholds so the Screening-Is-Enough philosophy applies uniformly.
  'retentionThreshold',
]

// Phase 14: retention weights get their own delta schedule. They're
// non-negative, unbounded (in practice 0-10), and need larger perturbations
// than read-side thresholds because individual signals can be noisy.
const RETENTION_WEIGHT_PARAMS: (keyof ScreeningConfigShape)[] = [
  'retentionW_hit',
  'retentionW_centrality',
  'retentionW_novelty',
  'retentionW_diversity',
  'retentionW_recency',
  'retentionW_bridge',
]

const MAX_RESULTS_PARAMS: (keyof ScreeningConfigShape)[] = [
  'memoryMaxResults',
  'searchMaxResults',
]

const THRESHOLD_DELTAS = [-0.05, -0.02, -0.01, 0.01, 0.02, 0.05]
const MAX_RESULTS_DELTAS = [-5, 5, 10]
// Retention weight deltas are larger: weights live in [0, 10], starting at
// 1.0, so ±0.2 / ±0.5 explores both side steps and larger swings.
const RETENTION_WEIGHT_DELTAS = [-0.5, -0.2, 0.2, 0.5]

export function generateCandidates(baseConfig: ScreeningConfigShape): ChangeCandidate[] {
  const candidates: ChangeCandidate[] = []

  // Threshold adjustments
  for (const param of THRESHOLD_PARAMS) {
    const current = baseConfig[param] as number
    for (const delta of THRESHOLD_DELTAS) {
      const newVal = Math.round((current + delta) * 1000) / 1000
      if (newVal < 0.01 || newVal > 0.99) continue
      // Novelty threshold has stricter bounds
      if (param === 'noveltyThreshold' && newVal > 0.5) continue

      candidates.push({
        id: `${param}_${delta > 0 ? '+' : ''}${delta}`,
        description: `${param}: ${current} → ${newVal} (${delta > 0 ? '+' : ''}${delta})`,
        type: 'threshold-adjust',
        configOverride: { [param]: newVal },
      })
    }
  }

  // maxResults adjustments
  for (const param of MAX_RESULTS_PARAMS) {
    const current = baseConfig[param] as number
    for (const delta of MAX_RESULTS_DELTAS) {
      const newVal = current + delta
      if (newVal < 1 || newVal > 200) continue

      candidates.push({
        id: `${param}_${delta > 0 ? '+' : ''}${delta}`,
        description: `${param}: ${current} → ${newVal} (${delta > 0 ? '+' : ''}${delta})`,
        type: 'maxResults-adjust',
        configOverride: { [param]: newVal },
      })
    }
  }

  // Retention weight adjustments (Phase 14)
  for (const param of RETENTION_WEIGHT_PARAMS) {
    const current = baseConfig[param] as number
    for (const delta of RETENTION_WEIGHT_DELTAS) {
      const newVal = Math.round((current + delta) * 100) / 100
      if (newVal < 0 || newVal > 10) continue
      candidates.push({
        id: `${param}_${delta > 0 ? '+' : ''}${delta}`,
        description: `${param}: ${current} → ${newVal} (${delta > 0 ? '+' : ''}${delta})`,
        type: 'threshold-adjust',
        configOverride: { [param]: newVal },
      })
    }
  }

  return candidates
}

// ---------------------------------------------------------------------------
// Hill-Climb loop
// ---------------------------------------------------------------------------

/**
 * Run the greedy hill-climb optimization loop.
 *
 * For each candidate:
 *   1. Apply override via setScreeningConfig()
 *   2. Run optimization set → must improve over baseline
 *   3. Run holdout set → must not regress beyond tolerance
 *   4. If both pass, accept and update bestConfig
 *   5. Always clear override in finally block
 */
export function runHillClimb(
  split: EvalSplit,
  baseline: BaselineRecord,
  options?: HillClimbOptions,
): OptimizationResult {
  const maxCandidates = options?.maxCandidates ?? 50
  const holdoutTolerance = options?.holdoutRegressionTolerance ?? 0.05

  let bestConfig = { ...baseline.config }
  const baseOptPassRate = baseline.optimizationRun.summary.passRate
  const baseHoldoutPassRate = baseline.holdoutRun.summary.passRate

  let currentOptPassRate = baseOptPassRate
  let currentHoldoutPassRate = baseHoldoutPassRate

  const accepted: CandidateOutcome[] = []
  const rejected: CandidateOutcome[] = []

  const candidates = generateCandidates(bestConfig).slice(0, maxCandidates)

  for (const candidate of candidates) {
    const testConfig: ScreeningConfigShape = { ...bestConfig, ...candidate.configOverride }

    try {
      setScreeningConfig(testConfig)
      // Test on optimization set
      const optRun = runEvalCases(split.optimization, testConfig)
      const optPassRate = optRun.summary.passRate

      if (optPassRate <= currentOptPassRate) {
        rejected.push({
          candidate,
          outcome: 'rejected-no-improvement',
          optimizationPassRate: optPassRate,
          holdoutPassRate: currentHoldoutPassRate,
        })
        continue
      }

      // Test on holdout set
      const holdoutRun = runEvalCases(split.holdout, testConfig)
      const holdoutPassRate = holdoutRun.summary.passRate

      if (holdoutPassRate < baseHoldoutPassRate - holdoutTolerance) {
        rejected.push({
          candidate,
          outcome: 'rejected-holdout-regression',
          optimizationPassRate: optPassRate,
          holdoutPassRate,
        })
        continue
      }

      // Accept: update best config
      bestConfig = testConfig
      currentOptPassRate = optPassRate
      currentHoldoutPassRate = holdoutPassRate

      accepted.push({
        candidate,
        outcome: 'accepted',
        optimizationPassRate: optPassRate,
        holdoutPassRate,
      })
    } finally {
      setScreeningConfig(null)
    }
  }

  return {
    baselineId: baseline.baselineId,
    candidatesTested: candidates.length,
    candidatesAccepted: accepted.length,
    accepted,
    rejected,
    recommendedConfig: bestConfig,
    timestamp: new Date().toISOString(),
  }
}
