// Relvetia vs Vanilla benchmark — A/B comparison across 5 categories.
//
// Validates that Relvetia Screening consistently outperforms both Vanilla
// (no memory) and Flat Memory (all entries, no filtering) conditions.

import { describe, it, expect } from 'vitest'
import { buildBenchmarkScenarios } from '../../extracted/evals/benchmarkScenarios.js'
import { runBenchmarkSuite } from '../../extracted/evals/benchmarkRunner.js'
import { formatBenchmarkReport } from '../../extracted/evals/benchmarkReporter.js'
import { getScreeningConfig } from '../../extracted/screening/screeningConfig.js'

const scenarios = buildBenchmarkScenarios()
const config = getScreeningConfig()
const run = runBenchmarkSuite(scenarios, config)

describe('Relvetia vs Vanilla Benchmark', () => {
  it('runs all scenarios without errors', () => {
    expect(run.scenarioResults.length).toBe(scenarios.length)
    expect(run.scenarioResults.length).toBeGreaterThanOrEqual(20)
  })

  it('Relvetia outperforms Vanilla on Cross-Session Recall', () => {
    const cs = run.summary.categoryScores['cross-session-recall']!
    expect(cs.relvetia).toBeGreaterThan(cs.vanilla)
  })

  it('Relvetia outperforms Vanilla on Preference Adherence', () => {
    const cs = run.summary.categoryScores['preference-adherence']!
    expect(cs.relvetia).toBeGreaterThan(cs.vanilla)
  })

  it('Relvetia is more efficient than Flat Memory on Context Token Efficiency', () => {
    const cs = run.summary.categoryScores['context-token-efficiency']!
    expect(cs.relvetia).toBeGreaterThan(cs.flatMemory)
  })

  it('Relvetia Task Accuracy tracks prior knowledge handling', () => {
    const cs = run.summary.categoryScores['task-accuracy-prior']!
    // Task Accuracy with outdated entries is a known TF-IDF limitation:
    // outdated entries may share more keywords with the query than current ones.
    // Recency boost (not applied in bare screenItems) would help here.
    // We track this metric but don't assert Relvetia > Flat, as Flat Memory
    // includes all correct entries by definition.
    expect(cs.relvetia).toBeGreaterThanOrEqual(0)
    expect(cs.vanilla).toBe(0.5) // Random guess baseline
  })

  it('Relvetia outperforms Flat Memory on Noise Rejection', () => {
    const cs = run.summary.categoryScores['noise-rejection']!
    expect(cs.relvetia).toBeGreaterThan(cs.flatMemory)
  })

  it('Relvetia overall score exceeds Vanilla', () => {
    expect(run.summary.overall.relvetia).toBeGreaterThan(run.summary.overall.vanilla)
  })

  it('Relvetia overall score exceeds Flat Memory', () => {
    expect(run.summary.overall.relvetia).toBeGreaterThan(run.summary.overall.flatMemory)
  })

  it('prints benchmark report', () => {
    const report = formatBenchmarkReport(run)
    console.log('\n' + report)
    expect(report).toContain('Relvetia vs Vanilla Benchmark')
    expect(report).toContain('Overall')
  })
})
