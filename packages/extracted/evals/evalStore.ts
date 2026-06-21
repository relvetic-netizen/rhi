// Eval store — JSON persistence for eval suites, runs, and baselines.
//
// Follows the residualIndex.ts pattern: readFile + JSON.parse + try-catch
// fallback to empty, writeFile + JSON.stringify(null, 2) + mkdir -p.

import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import {
  type EvalSuite,
  type EvalRun,
  parseEvalSuite,
  parseEvalRun,
} from './evalTypes.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUITE_FILENAME = 'suite.json'
const RUNS_DIR = 'runs'
const BASELINES_DIR = 'baselines'

// ---------------------------------------------------------------------------
// Suite persistence
// ---------------------------------------------------------------------------

export async function readEvalSuite(dir: string): Promise<EvalSuite> {
  try {
    const raw = await readFile(join(dir, SUITE_FILENAME), 'utf8')
    return parseEvalSuite(JSON.parse(raw))
  } catch {
    return { version: 1, cases: [] }
  }
}

export async function writeEvalSuite(dir: string, suite: EvalSuite): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, SUITE_FILENAME), JSON.stringify(suite, null, 2))
}

// ---------------------------------------------------------------------------
// Run persistence
// ---------------------------------------------------------------------------

export async function readEvalRun(dir: string, runId: string): Promise<EvalRun | null> {
  try {
    const raw = await readFile(join(dir, RUNS_DIR, `${runId}.json`), 'utf8')
    return parseEvalRun(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function writeEvalRun(dir: string, run: EvalRun): Promise<void> {
  const runsDir = join(dir, RUNS_DIR)
  await mkdir(runsDir, { recursive: true })
  await writeFile(join(runsDir, `${run.runId}.json`), JSON.stringify(run, null, 2))
}

export async function listEvalRuns(dir: string): Promise<string[]> {
  try {
    const files = await readdir(join(dir, RUNS_DIR))
    return files
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace(/\.json$/, ''))
      .sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Baseline persistence
// ---------------------------------------------------------------------------

export async function readBaseline(dir: string, baselineId: string): Promise<unknown> {
  try {
    const raw = await readFile(join(dir, BASELINES_DIR, `${baselineId}.json`), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function writeBaseline(dir: string, baselineId: string, data: unknown): Promise<void> {
  const baselinesDir = join(dir, BASELINES_DIR)
  await mkdir(baselinesDir, { recursive: true })
  await writeFile(join(baselinesDir, `${baselineId}.json`), JSON.stringify(data, null, 2))
}

export async function listBaselines(dir: string): Promise<string[]> {
  try {
    const files = await readdir(join(dir, BASELINES_DIR))
    return files
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace(/\.json$/, ''))
      .sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Missing-entry records — fed by distillVerifier.setOnMissingEntry callback
// (Memory Hardening Phase 5 T5-5). Each record represents a distilled entry
// that the verifier could not re-find via the search pipeline; downstream
// `auto-eval-generator` consumes the file to seed novel eval cases that
// pin the gap.
//
// File layout: one JSON object per line at
// `<evalDir>/missing-entries/YYYY-MM-DD.jsonl`. Append-only.
// ---------------------------------------------------------------------------

const MISSING_DIR = 'missing-entries'

export type MissingEntryRecord = {
  entryId: string
  summary: string
  concepts: string[]
  observedAt: string
}

export async function appendMissingEntryRecord(
  dir: string,
  record: MissingEntryRecord,
): Promise<void> {
  const missingDir = join(dir, MISSING_DIR)
  await mkdir(missingDir, { recursive: true })
  const day = record.observedAt.slice(0, 10) // YYYY-MM-DD
  const path = join(missingDir, `${day}.jsonl`)
  const { appendFile } = await import('fs/promises')
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
}
