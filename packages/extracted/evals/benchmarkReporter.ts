// Benchmark reporter — model-release-style table output.
//
// Formats BenchmarkRun results into a human-readable comparison table
// similar to what you'd see in a model release announcement.

import type { BenchmarkRun, CategoryScore } from './benchmarkTypes.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return (n * 100).toFixed(1) + '%'
}

function signedPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${(n * 100).toFixed(1)}%`
}

function pad(s: string, w: number): string {
  return s.padEnd(w)
}

function rpad(s: string, w: number): string {
  return s.padStart(w)
}

const CATEGORY_LABELS: Record<string, string> = {
  'cross-session-recall': 'Cross-Session Recall',
  'preference-adherence': 'Preference Adherence',
  'context-token-efficiency': 'Context Token Efficiency',
  'task-accuracy-prior': 'Task Accuracy (Prior)',
  'noise-rejection': 'Noise Rejection',
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

export function formatBenchmarkReport(run: BenchmarkRun): string {
  const lines: string[] = []

  lines.push('=== Relvetia vs Vanilla Benchmark ===')
  lines.push(`Run: ${run.runId}`)
  lines.push(`Scenarios: ${run.scenarioResults.length}`)
  lines.push('')

  // Header
  const colW = { cat: 28, v: 9, f: 13, k: 9, d: 10 }
  lines.push(
    pad('Category', colW.cat) + ' | ' +
    rpad('Vanilla', colW.v) + ' | ' +
    rpad('Flat Memory', colW.f) + ' | ' +
    rpad('Relvetia', colW.k) + ' | ' +
    rpad('\u0394(K-V)', colW.d),
  )
  lines.push('\u2500'.repeat(colW.cat) + '\u2500\u253c\u2500' +
    '\u2500'.repeat(colW.v) + '\u2500\u253c\u2500' +
    '\u2500'.repeat(colW.f) + '\u2500\u253c\u2500' +
    '\u2500'.repeat(colW.k) + '\u2500\u253c\u2500' +
    '\u2500'.repeat(colW.d))

  // Category rows
  const order = [
    'cross-session-recall',
    'preference-adherence',
    'context-token-efficiency',
    'task-accuracy-prior',
    'noise-rejection',
  ]

  for (const cat of order) {
    const cs = run.summary.categoryScores[cat]
    if (!cs) continue
    const label = CATEGORY_LABELS[cat] ?? cat
    lines.push(
      pad(label, colW.cat) + ' | ' +
      rpad(pct(cs.vanilla), colW.v) + ' | ' +
      rpad(pct(cs.flatMemory), colW.f) + ' | ' +
      rpad(pct(cs.relvetia), colW.k) + ' | ' +
      rpad(signedPct(cs.deltaKV), colW.d),
    )
  }

  // Separator
  lines.push('\u2500'.repeat(colW.cat) + '\u2500\u253c\u2500' +
    '\u2500'.repeat(colW.v) + '\u2500\u253c\u2500' +
    '\u2500'.repeat(colW.f) + '\u2500\u253c\u2500' +
    '\u2500'.repeat(colW.k) + '\u2500\u253c\u2500' +
    '\u2500'.repeat(colW.d))

  // Overall
  const o = run.summary.overall
  lines.push(
    pad('Overall', colW.cat) + ' | ' +
    rpad(pct(o.vanilla), colW.v) + ' | ' +
    rpad(pct(o.flatMemory), colW.f) + ' | ' +
    rpad(pct(o.relvetia), colW.k) + ' | ' +
    rpad(signedPct(o.deltaKV), colW.d),
  )

  lines.push('')
  lines.push(`Config: searchThreshold=${run.configSnapshot.searchThreshold}, searchMaxResults=${run.configSnapshot.searchMaxResults}`)

  return lines.join('\n')
}
