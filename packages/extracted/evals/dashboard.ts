// Dashboard — CLI-friendly formatting of eval results.
//
// Provides human-readable output for /relvetia eval, /relvetia optimize, etc.

import type { EvalRun } from './evalTypes.js'
import type { RegressionReport } from './regressionDetector.js'
import type { OptimizationResult } from './hillClimb.js'
import type { RecommendedConfig } from './recommendedConfig.js'

// ---------------------------------------------------------------------------
// Progress bar helper
// ---------------------------------------------------------------------------

function progressBar(ratio: number, width = 12): string {
  const filled = Math.round(ratio * width)
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled)
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + '%'
}

function delta(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${(n * 100).toFixed(1)}%`
}

// ---------------------------------------------------------------------------
// Eval dashboard
// ---------------------------------------------------------------------------

export function formatEvalDashboard(run: EvalRun): string {
  const lines: string[] = [
    '=== Relvetia Eval Dashboard ===',
    `Run: ${run.runId}`,
    `Total: ${run.summary.totalCases} cases | Passed: ${run.summary.passedCases} (${pct(run.summary.passRate)}) | Failed: ${run.summary.totalCases - run.summary.passedCases}`,
    '',
    'Category Breakdown:',
  ]

  for (const [cat, score] of Object.entries(run.summary.categoryScores).sort()) {
    lines.push(`  ${cat.padEnd(22)} ${progressBar(score)} ${pct(score)}`)
  }

  lines.push('')
  lines.push(`Average Score: ${pct(run.summary.avgScore)}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Regression report
// ---------------------------------------------------------------------------

export function formatRegressionReport(report: RegressionReport): string {
  const lines: string[] = [
    '=== Regression Report ===',
    `Baseline: ${report.baselineId}`,
    `Current: ${report.currentRunId}`,
    `Overall Regression: ${report.overallRegression ? 'YES' : 'NO'}`,
    `Recommendation: ${report.recommendation}`,
    '',
  ]

  if (report.newFailures.length > 0) {
    lines.push(`New Failures (${report.newFailures.length}):`)
    for (const id of report.newFailures) {
      lines.push(`  - ${id}`)
    }
    lines.push('')
  }

  if (report.newPasses.length > 0) {
    lines.push(`New Passes (${report.newPasses.length}):`)
    for (const id of report.newPasses) {
      lines.push(`  + ${id}`)
    }
    lines.push('')
  }

  if (report.regressedCases.length > 0) {
    lines.push(`Regressed Cases (${report.regressedCases.length}):`)
    for (const rc of report.regressedCases) {
      lines.push(`  ${rc.caseId}: ${pct(rc.baselineScore)} -> ${pct(rc.currentScore)} (${delta(rc.delta)})`)
    }
    lines.push('')
  }

  lines.push('Category Deltas:')
  for (const [cat, data] of Object.entries(report.categoryRegressions)) {
    lines.push(`  ${cat.padEnd(22)} ${pct(data.currentPassRate)} (${delta(data.delta)})`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Optimization summary
// ---------------------------------------------------------------------------

export function formatOptimizationSummary(result: OptimizationResult): string {
  const lines: string[] = [
    '=== Optimization Summary ===',
    `Baseline: ${result.baselineId}`,
    `Candidates Tested: ${result.candidatesTested}`,
    `Candidates Accepted: ${result.candidatesAccepted}`,
    '',
  ]

  if (result.accepted.length > 0) {
    lines.push('Accepted Changes:')
    for (const a of result.accepted) {
      lines.push(`  + ${a.candidate.description} (opt: ${pct(a.optimizationPassRate)}, holdout: ${pct(a.holdoutPassRate)})`)
    }
    lines.push('')
  }

  if (result.accepted.length === 0) {
    lines.push('No improvements found — current config is optimal for this eval suite.')
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Recommended config review
// ---------------------------------------------------------------------------

export function formatRecommendedConfigReview(rec: RecommendedConfig): string {
  const lines: string[] = [
    '=== Recommended Config Review ===',
    `Based on: ${rec.basedOnBaseline}`,
    `Status: ${rec.status}`,
    '',
  ]

  if (rec.changes.length === 0) {
    lines.push('No changes recommended — current config is optimal.')
  } else {
    lines.push('Proposed Changes:')
    for (const c of rec.changes) {
      const d = typeof c.oldValue === 'number' && typeof c.newValue === 'number'
        ? ` (${c.newValue > c.oldValue ? '+' : ''}${Math.round((c.newValue - c.oldValue) * 1000) / 1000})`
        : ''
      lines.push(`  ${c.param}: ${c.oldValue} -> ${c.newValue}${d}`)
    }
  }

  lines.push('')
  lines.push(`Optimization pass rate: ${pct(rec.optimizationPassRate)}`)
  lines.push(`Holdout pass rate: ${pct(rec.holdoutPassRate)}`)
  lines.push('')
  lines.push(`Approve: /relvetia eval approve`)
  lines.push(`Reject:  /relvetia eval reject`)

  return lines.join('\n')
}
