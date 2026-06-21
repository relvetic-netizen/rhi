// Distill Verifier — self-verification loop for distillation quality.
//
// After nightly distillation, this module verifies that distilled entries
// can actually be found by the search system. It generates representative
// queries from today's log entries, runs them through searchMemoryWithScreening,
// and checks whether the corresponding distilled entries appear in results.
//
// If hit rate is below threshold, it suggests concept expansions to improve
// discoverability.
//
// Inspired by PHOTON's encoder/decoder co-optimization: the write side
// (distillation) and read side (search) must be tuned together.

import { readFile, readdir, appendFile, mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { executeMemorySearch } from '../tools/MemorySearchTool.js'
import { getScreeningConfig } from '../screening/screeningConfig.js'
import {
  readResidualIndex,
  writeResidualIndex,
  type ResidualIndex,
  type ResidualEntry,
} from './residualIndex.js'
import { logScreeningEvent } from '../screening/screeningLog.js'
import { todayJST, timeJST } from '../util/jstTime.js'

// ---------------------------------------------------------------------------
// Missing entry callback — notifies eval framework of verification misses.
// Same pattern as setScreeningDiagnostics() / setOnSafetyValve().
// ---------------------------------------------------------------------------

let _onMissingEntry: ((entryId: string, summary: string, concepts: string[]) => void) | null = null

/** Register a callback invoked for each entry that fails verification. */
export function setOnMissingEntry(
  cb: ((entryId: string, summary: string, concepts: string[]) => void) | null,
): void {
  _onMissingEntry = cb
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationResult = {
  /** Total entries verified. */
  totalEntries: number
  /** Entries that were found by at least one representative query. */
  foundEntries: number
  /** Hit rate (foundEntries / totalEntries). */
  hitRate: number
  /** Entries that could not be found — candidates for concept expansion. */
  missingEntries: MissingEntry[]
  /** Whether the verification passed the minimum hit rate threshold. */
  passed: boolean
}

type MissingEntry = {
  entry: ResidualEntry
  /** Queries that were tried. */
  queriesTried: string[]
  /** Suggested additional concepts to improve discoverability. */
  suggestedConcepts: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum hit rate to pass verification. */
const MIN_HIT_RATE = 0.7
/** Max entries to verify per run (for performance).
 *  Override via RELVETIA_MAX_VERIFY_ENTRIES env to widen one-shot scope=all runs. */
const MAX_VERIFY_ENTRIES = (() => {
  const raw = process.env.RELVETIA_MAX_VERIFY_ENTRIES
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 20
})()
/** Max queries per entry. */
const MAX_QUERIES_PER_ENTRY = 3

// ---------------------------------------------------------------------------
// Query generation
// ---------------------------------------------------------------------------

/**
 * Generate representative search queries from an entry's summary and concepts.
 * These queries simulate how a user might search for this information.
 *
 * Strategies:
 * 1. Use the summary as-is (exact match)
 * 2. Use a subset of concepts (concept-based)
 * 3. Use key terms from the summary (keyword-based)
 */
function generateQueries(entry: ResidualEntry): string[] {
  const queries: string[] = []

  // Strategy 1: summary (trimmed to first sentence)
  const firstSentence = entry.summary.split(/[.!?。！？]/)[0]?.trim()
  if (firstSentence && firstSentence.length >= 5) {
    queries.push(firstSentence)
  }

  // Strategy 2: concept-based query
  if (entry.concepts.length >= 2) {
    queries.push(entry.concepts.slice(0, 3).join(' '))
  }

  // Strategy 3: key terms from summary (longest words, likely most informative)
  const words = entry.summary
    .replace(/[^\w\s\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)

  if (words.length >= 2) {
    queries.push(words.join(' '))
  }

  return queries.slice(0, MAX_QUERIES_PER_ENTRY)
}

/**
 * Suggest additional concepts for entries that weren't found by search.
 * Uses simple heuristics to extract potential concept tags.
 */
function suggestConcepts(entry: ResidualEntry): string[] {
  const existing = new Set(entry.concepts.map(c => c.toLowerCase()))
  const suggestions: string[] = []

  // Extract multi-word terms from summary.
  // Split on whitespace AND symbol clusters so `max-turns/timeout` becomes
  // `max`, `turns`, `timeout` instead of the meaningless `maxturnstimeout`.
  const words = entry.summary
    .toLowerCase()
    .split(/[\s\-_./()=,:;!?+*<>"'\[\]{}|\\\u3001\u3002\u300c\u300d\u300e\u300f\u3010\u3011\u3008\u3009\u300a\u300b\u3014\u3015\uff1d\uff0b\uff0f]+/)
  for (const word of words) {
    const cleaned = word.replace(/[^\w\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, '')
    if (cleaned.length > 3 && !existing.has(cleaned)) {
      suggestions.push(cleaned)
    }
  }

  return [...new Set(suggestions)].slice(0, 5)
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Verify that recently distilled entries can be found by the search system.
 *
 * For each entry in the residual index that was updated today (or recently),
 * generates representative queries and checks if search returns the expected
 * topic file or source log.
 *
 * @param memoryDir - Path to memory directory
 * @param scope - 'today' to verify only today's entries, 'all' for everything
 * @returns Verification results with hit rate and missing entries
 */
export async function verifyDistillation(
  memoryDir: string,
  scope: 'today' | 'all' = 'today',
): Promise<VerificationResult> {
  const index = await readResidualIndex(memoryDir)
  const entries = Object.values(index.entries)

  // Filter to scope (JST: entries' `updated` field is JST-based)
  const today = todayJST()
  const targetEntries = scope === 'today'
    ? entries.filter(e => e.updated === today)
    : entries

  const toVerify = targetEntries.slice(0, MAX_VERIFY_ENTRIES)
  if (toVerify.length === 0) {
    // Fail-closed: empty target set was previously a silent pass that masked
    // the `updated` field being absent on most entries (schema drift to `addedAt`).
    // Surface it so verify-runner can exit non-zero and the daemon records failure.
    logScreeningEvent('distill_verification', {
      scope,
      totalEntries: 0,
      foundEntries: 0,
      hitRate: 0,
      missingCount: 0,
      passed: false,
      reason: 'no_target_entries',
      indexEntries: entries.length,
    })
    return { totalEntries: 0, foundEntries: 0, hitRate: 0, missingEntries: [], passed: false }
  }

  const config = getScreeningConfig()
  const maxResults = config.searchMaxResults

  let foundCount = 0
  const missing: MissingEntry[] = []

  for (const entry of toVerify) {
    const queries = generateQueries(entry)
    let found = false

    for (const query of queries) {
      // Phase 3 T3: switched from path-match on legacy `results` to entryId-match
      // on entry-centric `hits`. The previous path-derivation check could falsely
      // match unrelated entries that happened to share a topic file path; entryId
      // match is the precise semantic the verifier always wanted.
      // recordUsage:false — verification queries must not inflate usage stats.
      const output = await executeMemorySearch(
        memoryDir,
        { query, maxResults },
        { recordUsage: false },
      )

      if (output.hits.some(h => h.entryId === entry.id)) {
        found = true
        break
      }
    }

    if (found) {
      foundCount++
    } else {
      missing.push({
        entry,
        queriesTried: queries,
        suggestedConcepts: suggestConcepts(entry),
      })
      // Notify eval framework for auto-case generation
      if (_onMissingEntry) {
        _onMissingEntry(entry.id, entry.summary, entry.concepts)
      }
    }
  }

  const hitRate = toVerify.length > 0 ? foundCount / toVerify.length : 1.0
  const passed = hitRate >= MIN_HIT_RATE

  logScreeningEvent('distill_verification', {
    scope,
    totalEntries: toVerify.length,
    foundEntries: foundCount,
    hitRate: Math.round(hitRate * 100),
    missingCount: missing.length,
    passed,
  })

  return {
    totalEntries: toVerify.length,
    foundEntries: foundCount,
    hitRate,
    missingEntries: missing,
    passed,
  }
}

/**
 * Auto-remediate missing entries by expanding their concepts in the residual index.
 * Returns the number of entries that were updated.
 */
export async function remediateMissingEntries(
  memoryDir: string,
  missing: MissingEntry[],
): Promise<number> {
  if (missing.length === 0) return 0

  const index = await readResidualIndex(memoryDir)
  let updated = 0

  for (const m of missing) {
    const entry = index.entries[m.entry.id]
    if (!entry) continue

    const existingConcepts = new Set(entry.concepts)
    const newConcepts = m.suggestedConcepts.filter(c => !existingConcepts.has(c))

    if (newConcepts.length > 0) {
      entry.concepts = [...entry.concepts, ...newConcepts]
      index.entries[entry.id] = entry
      updated++
    }
  }

  if (updated > 0) {
    await writeResidualIndex(memoryDir, index)

    logScreeningEvent('distill_remediation', {
      updatedEntries: updated,
      totalMissing: missing.length,
    })
  }

  return updated
}

// ---------------------------------------------------------------------------
// Index-shape verification axes
// (memory-hardening-followup Phase C, 2026-05-19).
//
// In addition to the search-side hit-rate check above (verifyDistillation),
// the nightly verify pass scans for three structural silent-fails that
// previously slipped past every observation layer:
//
//   1. hier-id-rate     : numeric-id entries (`/^\d+$/`) leak past the
//                         distill prompt and the bootstrap normalizer.
//   2. mojibake-regex   : `?` substitution runs (CP932 fallback signature)
//                         in `_index.md` or topic-body files.
//   3. array-drift      : `index.json` `entries` field on disk is an Array
//                         instead of the canonical Record.
//
// Each axis emits its own PASSED/FAILED log line (parallel to the hit-rate
// line in logVerificationResults) and the aggregate `passed` flag fails
// closed if ANY axis fails, exactly mirroring the Phase 5 contract added
// for hit-rate verification.
//
// All three are intentionally bounded scans — they read the canonical
// state files, no daemon RPC, no LLM calls. Safe to fire every distill
// cycle even on large memory trees.
// ---------------------------------------------------------------------------

export type IndexShapeAxis = 'hier-id-rate' | 'mojibake-regex' | 'array-drift'

export type IndexShapeAxisResult = {
  axis: IndexShapeAxis
  passed: boolean
  message: string
  /** axis-specific counter (offenders found) — 0 on pass for clean state */
  offenderCount: number
  /** up to 5 representative offender ids / file paths for log triage */
  samples: string[]
}

export type IndexShapeVerificationResult = {
  axes: IndexShapeAxisResult[]
  passed: boolean
}

const NUMERIC_ID_RE = /^\d+$/
const MOJIBAKE_RE = /\?{4,}/

export async function checkHierIdRate(memoryDir: string): Promise<IndexShapeAxisResult> {
  try {
    const index = await readResidualIndex(memoryDir)
    const numericIds = Object.keys(index.entries).filter((id) => NUMERIC_ID_RE.test(id))
    const total = Object.keys(index.entries).length
    const passed = numericIds.length === 0
    return {
      axis: 'hier-id-rate',
      passed,
      message: passed
        ? `no numeric ids (total ${total} entries)`
        : `${numericIds.length}/${total} entries use bare numeric ids`,
      offenderCount: numericIds.length,
      samples: numericIds.slice(0, 5),
    }
  } catch (e) {
    return {
      axis: 'hier-id-rate',
      passed: false,
      message: `read failed: ${e instanceof Error ? e.message : String(e)}`,
      offenderCount: -1,
      samples: [],
    }
  }
}

export async function checkMojibakeAbsent(memoryDir: string): Promise<IndexShapeAxisResult> {
  const topicsDir = join(memoryDir, 'topics')
  const offenders: string[] = []
  try {
    await scanTopicsForMojibake(topicsDir, offenders)
  } catch (e) {
    return {
      axis: 'mojibake-regex',
      passed: false,
      message: `scan failed: ${e instanceof Error ? e.message : String(e)}`,
      offenderCount: -1,
      samples: [],
    }
  }
  const passed = offenders.length === 0
  return {
    axis: 'mojibake-regex',
    passed,
    message: passed
      ? `no mojibake found in topics/**/*.md`
      : `${offenders.length} file(s) contain /\\?{4,}/ runs`,
    offenderCount: offenders.length,
    samples: offenders.slice(0, 5).map((p) => p.replace(memoryDir, '<memory>')),
  }
}

async function scanTopicsForMojibake(dir: string, offenders: string[]): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    let s
    try {
      s = await stat(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      await scanTopicsForMojibake(full, offenders)
    } else if (s.isFile() && name.endsWith('.md')) {
      try {
        const content = await readFile(full, 'utf8')
        if (MOJIBAKE_RE.test(content)) offenders.push(full)
      } catch {
        // ignore individual file read errors
      }
    }
  }
}

export async function checkArrayDriftAbsent(memoryDir: string): Promise<IndexShapeAxisResult> {
  const indexPath = join(memoryDir, 'index.json')
  let parsed: unknown
  try {
    const raw = await readFile(indexPath, 'utf8')
    parsed = JSON.parse(raw)
  } catch (e) {
    // Missing file: pass — nothing to drift. Malformed file: fail.
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        axis: 'array-drift',
        passed: true,
        message: 'index.json absent (treated as clean canonical)',
        offenderCount: 0,
        samples: [],
      }
    }
    return {
      axis: 'array-drift',
      passed: false,
      message: `index.json read/parse failed: ${e instanceof Error ? e.message : String(e)}`,
      offenderCount: -1,
      samples: [],
    }
  }

  if (Array.isArray(parsed)) {
    return {
      axis: 'array-drift',
      passed: false,
      message: 'index.json top-level is an Array (legacy shape)',
      offenderCount: parsed.length,
      samples: [],
    }
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)) {
    const arr = (parsed as { entries: unknown[] }).entries
    return {
      axis: 'array-drift',
      passed: false,
      message: `index.json entries field is an Array(${arr.length}); canonical shape is Record`,
      offenderCount: arr.length,
      samples: [],
    }
  }
  return {
    axis: 'array-drift',
    passed: true,
    message: 'index.json entries is canonical Record',
    offenderCount: 0,
    samples: [],
  }
}

export async function verifyIndexShape(memoryDir: string): Promise<IndexShapeVerificationResult> {
  const axes = await Promise.all([
    checkHierIdRate(memoryDir),
    checkMojibakeAbsent(memoryDir),
    checkArrayDriftAbsent(memoryDir),
  ])
  return { axes, passed: axes.every((a) => a.passed) }
}

/**
 * Log verification results to the daily log for observability.
 */
export async function logVerificationResults(
  memoryDir: string,
  result: VerificationResult,
): Promise<void> {
  const now = new Date()
  // JST date for log file path (YYYY-MM-DD).
  const todayStr = todayJST(now)
  const [yearStr, monthStr] = todayStr.split('-')
  const logDir = join(memoryDir, 'logs', yearStr, monthStr)
  const logFile = join(logDir, `${todayStr}.md`)

  await mkdir(logDir, { recursive: true })

  const timestamp = timeJST(now)
  const lines = [
    `- [${timestamp}] [distill-verify] Hit rate: ${Math.round(result.hitRate * 100)}% (${result.foundEntries}/${result.totalEntries}) ${result.passed ? 'PASSED' : 'FAILED'}`,
  ]

  if (result.missingEntries.length > 0) {
    lines.push(`- [${timestamp}] [distill-verify] Missing entries: ${result.missingEntries.map(m => m.entry.id).join(', ')}`)
  }

  await appendFile(logFile, '\n' + lines.join('\n') + '\n', 'utf8')
}
