#!/usr/bin/env node
// regressionEvalCli.ts — CI gate runner for Memory Hardening Phase 5.
//
// Reads `relvetia-extracted/evals/regression-evalcases.jsonl`, runs every
// case through the screening pipeline via runEvalSuite, and exits 1 if
// the aggregate passRate drops below threshold.
//
// Threshold defaults to 0.7 (Phase 5 T5-6 baseline; tune via env
// `RELVETIA_EVAL_THRESHOLD` or per-category override file).
//
// Usage (CI):
//   npx tsx regressionEvalCli.ts
//
// Usage (local dogfood):
//   RELVETIA_EVAL_THRESHOLD=0.7 npx tsx regressionEvalCli.ts --verbose
//
// Stdout: one-line summary + JSON details on failure.
// Exit codes: 0 = pass, 1 = below threshold, 2 = config/parse error.

import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { parseEvalSuite, type EvalSuite, type EvalCase } from './evalTypes.js'
import { runEvalSuite } from './evalRunner.js'
import { getScreeningConfig } from '../screening/screeningConfig.js'

const DEFAULT_JSONL = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'regression-evalcases.jsonl',
)

const DEFAULT_THRESHOLD = Number(process.env.RELVETIA_EVAL_THRESHOLD ?? 0.7)

function parseArgs(argv: string[]): { jsonl: string; threshold: number; verbose: boolean } {
  const args = argv.slice(2)
  let jsonl = DEFAULT_JSONL
  let threshold = DEFAULT_THRESHOLD
  let verbose = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--jsonl') { jsonl = args[++i] ?? jsonl }
    else if (a === '--threshold') { threshold = Number(args[++i] ?? threshold) }
    else if (a === '--verbose' || a === '-v') { verbose = true }
    else if (a === '--help' || a === '-h') {
      console.error(`usage: tsx regressionEvalCli.ts [--jsonl <path>] [--threshold <0..1>] [--verbose]`)
      process.exit(0)
    }
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    console.error(`[regression-eval] invalid threshold ${threshold} (must be 0..1)`)
    process.exit(2)
  }
  return { jsonl, threshold, verbose }
}

function readJsonlSuite(path: string): EvalSuite {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    console.error(`[regression-eval] cannot read ${path}: ${(e as Error).message}`)
    process.exit(2)
  }
  const lines = raw.split(/\r?\n/).filter((l: string) => l.trim().length > 0)
  const cases: EvalCase[] = []
  let lineNo = 0
  for (const line of lines) {
    lineNo += 1
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch (e) {
      console.error(`[regression-eval] JSONL line ${lineNo} parse error: ${(e as Error).message}`)
      process.exit(2)
    }
    cases.push(obj as EvalCase)
  }
  const suite = parseEvalSuite({ version: 1, cases })
  if (suite.cases.length !== cases.length) {
    console.error(`[regression-eval] schema validation dropped ${cases.length - suite.cases.length} case(s) — fix schema or update evalcases.jsonl`)
    process.exit(2)
  }
  return suite
}

function main(): void {
  const { jsonl, threshold, verbose } = parseArgs(process.argv)
  const suite = readJsonlSuite(jsonl)
  if (suite.cases.length === 0) {
    console.error(`[regression-eval] no cases loaded from ${jsonl}`)
    process.exit(2)
  }

  const config = getScreeningConfig()
  const run = runEvalSuite(suite, config)
  const { totalCases, passedCases, passRate, avgScore, categoryScores } = run.summary

  const status = passRate >= threshold ? 'PASS' : 'FAIL'
  console.log(`[regression-eval] ${status} ${passedCases}/${totalCases} (passRate=${passRate.toFixed(3)} avgScore=${avgScore.toFixed(3)} threshold=${threshold}) runId=${run.runId}`)

  if (status === 'FAIL' || verbose) {
    console.log(`[regression-eval] categoryScores: ${JSON.stringify(categoryScores)}`)
    for (const r of run.results) {
      if (!r.passed || verbose) {
        const detailJson = r.details ? JSON.stringify(r.details) : ''
        console.log(`[regression-eval]   ${r.passed ? 'ok' : 'X '} ${r.caseId} score=${r.score.toFixed(3)} ${detailJson}`)
      }
    }
  }

  process.exit(status === 'PASS' ? 0 : 1)
}

main()
