#!/usr/bin/env node
// eval-runner — standalone CLI for running Relvetia eval suites.
//
// Follows the verify-runner.ts pattern: process.argv parsing, main() + catch.
//
// Usage:
//   npx tsx evals/evalCli.ts --seed                   # Generate seed suite
//   npx tsx evals/evalCli.ts                           # Run all evals
//   npx tsx evals/evalCli.ts --category search-recall  # Filter by category
//   npx tsx evals/evalCli.ts --baseline                # Record baseline
//   npx tsx evals/evalCli.ts --optimize                # Hill-Climb optimize
//   npx tsx evals/evalCli.ts --regression              # Regression check
//   npx tsx evals/evalCli.ts --recommend               # Show recommended config

import { join } from 'path'
import { homedir } from 'os'
import { readEvalSuite, writeEvalSuite, writeEvalRun } from './evalStore.js'
import { runEvalSuite, runEvalCases } from './evalRunner.js'
import { seedEvalSuite } from './seedConverter.js'
import { getScreeningConfig } from '../screening/screeningConfig.js'
import { splitEvalSuite } from './evalSplit.js'
import { recordNewBaseline, readLatestBaseline, compareWithBaseline } from './evalBaseline.js'
import { runHillClimb } from './hillClimb.js'
import { buildRecommendedConfig, writeRecommendedConfig, readRecommendedConfig, updateRecommendedStatus, formatConfigDiff } from './recommendedConfig.js'
import { detectRegressions } from './regressionDetector.js'

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  evalDir: string
  seed: boolean
  category: string | null
  baseline: boolean
  optimize: boolean
  regression: boolean
  recommend: boolean
  status: boolean
  approve: boolean
  reject: boolean
  benchmark: boolean
} {
  const args = argv.slice(2)
  let evalDir = process.env.RELVETIA_EVAL_DIR ?? join(homedir(), '.claude', 'relvetia-evals')
  let seed = false
  let category: string | null = null
  let baseline = false
  let optimize = false
  let regression = false
  let recommend = false
  let status = false
  let approve = false
  let reject = false
  let benchmark = false

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--eval-dir':
        evalDir = args[++i] ?? evalDir
        break
      case '--seed':
        seed = true
        break
      case '--category':
        category = args[++i] ?? null
        break
      case '--baseline':
        baseline = true
        break
      case '--optimize':
        optimize = true
        break
      case '--regression':
        regression = true
        break
      case '--recommend':
        recommend = true
        break
      case '--status':
        status = true
        break
      case '--approve':
        approve = true
        break
      case '--reject':
        reject = true
        break
      case '--benchmark':
        benchmark = true
        break
    }
  }

  return { evalDir, seed, category, baseline, optimize, regression, recommend, status, approve, reject, benchmark }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv)

  // --benchmark: run Relvetia vs Vanilla A/B benchmark
  if (opts.benchmark) {
    const { buildBenchmarkScenarios } = await import('./benchmarkScenarios.js')
    const { runBenchmarkSuite } = await import('./benchmarkRunner.js')
    const { formatBenchmarkReport } = await import('./benchmarkReporter.js')
    const scenarios = buildBenchmarkScenarios()
    const config = getScreeningConfig()
    const run = runBenchmarkSuite(scenarios, config)
    console.log(formatBenchmarkReport(run))
    return
  }

  // --status: show latest run results
  if (opts.status) {
    const runIds = await (await import('./evalStore.js')).listEvalRuns(opts.evalDir)
    if (runIds.length === 0) {
      console.error('[eval-runner] No eval runs found. Run evals first.')
      process.exit(1)
    }
    const latestRun = await (await import('./evalStore.js')).readEvalRun(opts.evalDir, runIds[runIds.length - 1]!)
    if (!latestRun) {
      console.error('[eval-runner] Failed to read latest run.')
      process.exit(1)
    }
    console.log(JSON.stringify({ action: 'status', ...latestRun.summary, runId: latestRun.runId }, null, 2))
    return
  }

  // --approve: approve recommended config
  if (opts.approve) {
    await updateRecommendedStatus(opts.evalDir, 'approved')
    console.log('[eval-runner] Recommended config marked as approved.')
    return
  }

  // --reject: reject recommended config
  if (opts.reject) {
    await updateRecommendedStatus(opts.evalDir, 'rejected')
    console.log('[eval-runner] Recommended config marked as rejected.')
    return
  }

  // --seed: generate seed eval suite
  if (opts.seed) {
    const suite = seedEvalSuite()
    await writeEvalSuite(opts.evalDir, suite)
    console.log(JSON.stringify({
      action: 'seed',
      totalCases: suite.cases.length,
      categories: Object.fromEntries(
        [...new Set(suite.cases.map((c: { category: string }) => c.category))].map((cat: string) => [
          cat,
          suite.cases.filter((c: { category: string }) => c.category === cat).length,
        ]),
      ),
      evalDir: opts.evalDir,
    }, null, 2))
    return
  }

  // --baseline: record baseline
  if (opts.baseline) {
    const suite = await readEvalSuite(opts.evalDir)
    if (suite.cases.length === 0) {
      console.error('[eval-runner] No eval cases found. Run with --seed first.')
      process.exit(1)
    }
    const config = getScreeningConfig()
    const split = splitEvalSuite(suite)
    const optRun = runEvalCases(split.optimization, config)
    const holdoutRun = runEvalCases(split.holdout, config)
    const baseline = await recordNewBaseline(opts.evalDir, config, optRun, holdoutRun, split.splitMeta)
    console.log(JSON.stringify({
      action: 'baseline',
      baselineId: baseline.baselineId,
      optimizationPassRate: optRun.summary.passRate,
      holdoutPassRate: holdoutRun.summary.passRate,
      splitMeta: split.splitMeta,
    }, null, 2))
    return
  }

  // --optimize: hill-climb optimization
  if (opts.optimize) {
    const suite = await readEvalSuite(opts.evalDir)
    if (suite.cases.length === 0) {
      console.error('[eval-runner] No eval cases found. Run with --seed first.')
      process.exit(1)
    }
    const baseline = await readLatestBaseline(opts.evalDir)
    if (!baseline) {
      console.error('[eval-runner] No baseline found. Run with --baseline first.')
      process.exit(1)
    }
    const split = splitEvalSuite(suite)
    const result = runHillClimb(split, baseline)

    // Write recommended config if changes were accepted
    const lastAccepted = result.accepted[result.accepted.length - 1]
    const rec = buildRecommendedConfig(
      baseline.config,
      result.recommendedConfig,
      baseline.baselineId,
      lastAccepted?.optimizationPassRate ?? baseline.optimizationRun.summary.passRate,
      lastAccepted?.holdoutPassRate ?? baseline.holdoutRun.summary.passRate,
    )
    await writeRecommendedConfig(opts.evalDir, rec)

    console.log(JSON.stringify({
      action: 'optimize',
      candidatesTested: result.candidatesTested,
      candidatesAccepted: result.candidatesAccepted,
      accepted: result.accepted.map((a: { candidate: { id: string; description: string }; optimizationPassRate: number; holdoutPassRate: number }) => ({
        id: a.candidate.id,
        description: a.candidate.description,
        optPassRate: a.optimizationPassRate,
        holdoutPassRate: a.holdoutPassRate,
      })),
    }, null, 2))
    return
  }

  // --regression: regression check against latest baseline
  if (opts.regression) {
    const suite = await readEvalSuite(opts.evalDir)
    if (suite.cases.length === 0) {
      console.error('[eval-runner] No eval cases found. Run with --seed first.')
      process.exit(1)
    }
    const baseline = await readLatestBaseline(opts.evalDir)
    if (!baseline) {
      console.error('[eval-runner] No baseline found. Run with --baseline first.')
      process.exit(1)
    }
    const config = getScreeningConfig()
    const currentRun = runEvalSuite(suite, config)
    const report = detectRegressions(baseline, currentRun)
    console.log(JSON.stringify({
      action: 'regression',
      ...report,
    }, null, 2))
    return
  }

  // --recommend: show recommended config
  if (opts.recommend) {
    const rec = await readRecommendedConfig(opts.evalDir)
    if (!rec) {
      console.error('[eval-runner] No recommended config found. Run with --optimize first.')
      process.exit(1)
    }
    console.log(formatConfigDiff(rec))
    return
  }

  // Default: run eval suite
  const suite = await readEvalSuite(opts.evalDir)

  if (suite.cases.length === 0) {
    console.error('[eval-runner] No eval cases found. Run with --seed first.')
    process.exit(1)
  }

  // Filter by category if specified
  const filteredSuite = opts.category
    ? { ...suite, cases: suite.cases.filter((c: { category: string }) => c.category === opts.category) }
    : suite

  if (filteredSuite.cases.length === 0) {
    console.error(`[eval-runner] No cases match category "${opts.category}".`)
    process.exit(1)
  }

  const config = getScreeningConfig()
  const run = runEvalSuite(filteredSuite, config)
  await writeEvalRun(opts.evalDir, run)

  console.log(JSON.stringify({
    action: 'run',
    runId: run.runId,
    ...run.summary,
    evalDir: opts.evalDir,
  }, null, 2))
}

main().catch(e => {
  console.error('[eval-runner] fatal:', e)
  process.exit(1)
})
