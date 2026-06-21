// CorpusManifest — single source of truth for memory search corpus boundaries.
//
// Codex P1-2 review (memory-search-improvement-loop saga, 2026-05-19) flagged
// the search/grep corpus boundary as the next structural fix after the Phase 1
// findRelevantMemories engine migration: search Path A scans
// `scanMemoryFiles → readdir({recursive:true})`, search Path C delegates
// to the same scan, and `grep-baseline-runner.mjs` runs `grep -r --exclude-dir`
// with its own ad-hoc exclusion list. The three were free to drift, and Phase 1
// iter 1 measurements (six-axis-v1.json) confirmed the drift surfaced as
// `logs/YYYY/MM/*.md` dominating Path C top-5 with max-exposure 58.3%.
//
// This module gives all three paths a single, Zod-validated description of
// which files they may see:
//
//   - `includedRoots`: when set, only paths matching at least one included
//     pattern are kept (whitelist semantics, default = unset = all)
//   - `excludedRoots`: paths matching any excluded pattern are dropped
//     (blacklist, default = `[.backup, .staging, tmp-*]`)
//   - `layer`: when set, restricts to a single top-level directory (`topics`,
//     `logs`, `concepts`) or all (default)
//   - `freshness`: optional mtime cutoff (`withinDays` keeps recent files,
//     `beforeDate` keeps older files; useful for time-window benchmarks)
//
// Pattern matching is **forward-slash native** (Phase 1 iter 1 lesson — Windows
// `readdir` emits backslashes, so callers normalize at the boundary before
// calling `matchesCorpus`). Patterns may contain `*` glob wildcards that match
// any sequence of non-`/` characters.

import { z } from 'zod/v4'

// ---------------------------------------------------------------------------
// Zod schema (runtime validation + type inference)
// ---------------------------------------------------------------------------

export const CorpusLayerSchema = z.enum(['topics', 'logs', 'concepts', 'all'])
export type CorpusLayer = z.infer<typeof CorpusLayerSchema>

const FreshnessSchema = z.object({
  withinDays: z.number().int().positive().optional(),
  beforeDate: z.string().optional(),
})

export const CorpusManifestSchema = z.object({
  includedRoots: z.array(z.string()).optional(),
  excludedRoots: z.array(z.string()).optional(),
  layer: CorpusLayerSchema.optional(),
  freshness: FreshnessSchema.optional(),
})
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>

// ---------------------------------------------------------------------------
// Default factory
//
// Mirrors the implicit defaults that `grep-baseline-runner.mjs` ships today
// (`--exclude-dir=.backup --exclude-dir=.staging --exclude-dir=tmp`), with the
// addition of `tmp-*` glob coverage for date-stamped temp directories created
// by `perf-benchmark-runner.mjs` and friends.
// ---------------------------------------------------------------------------

export function getDefaultCorpusManifest(): CorpusManifest {
  return {
    excludedRoots: ['.backup', '.staging', 'tmp-*'],
    layer: 'all',
  }
}

// ---------------------------------------------------------------------------
// Path C default — base defaults + `logs` exclusion.
//
// Phase 2-3 (memory-search-improvement-loop, six-axis-v1 analysis): Path C's
// `MultiResolutionScreeningGate` surfaced log files in top-5 with max-exposure
// 58.3% (top exposed: `logs/2026/05/2026-05-13.md` × 35/60 cases). The bench's
// `filenameToEntryIds` map only keys on canonical topic paths
// (`topicPathForEntry()` output → `topics/...`), so log-file hits never count
// toward strict Recall@5. Excluding the `logs/` root from Path C's corpus
// lifts the structural ceiling — `findRelevantMemories` consumers care about
// topic-level recall, not raw log lines (those are reached separately via
// `logLineSearch.ts` inside Path A).
// ---------------------------------------------------------------------------

export function getDefaultPathCCorpusManifest(): CorpusManifest {
  const base = getDefaultCorpusManifest()
  const baseExclusions = base.excludedRoots ?? []
  return {
    ...base,
    excludedRoots: [...baseExclusions, 'logs'],
  }
}

// ---------------------------------------------------------------------------
// Pure matching function
//
// `matchesCorpus(filePath, manifest, fileMtimeMs?)` evaluates a file against
// every condition in the manifest with AND semantics. Returns true iff the
// file passes the include filter, no exclude filter, the layer constraint,
// and the freshness window.
//
// Path normalization contract: callers MUST forward-slash normalize `filePath`
// before calling. The function does a defensive re-normalize so a stray
// backslash from a tested entry doesn't silently change result.
// ---------------------------------------------------------------------------

export function matchesCorpus(
  filePath: string,
  manifest: CorpusManifest,
  fileMtimeMs?: number,
): boolean {
  const path = filePath.replace(/\\/g, '/')

  if (manifest.excludedRoots && manifest.excludedRoots.length > 0) {
    for (const pattern of manifest.excludedRoots) {
      if (matchesPattern(path, pattern)) return false
    }
  }

  if (manifest.includedRoots && manifest.includedRoots.length > 0) {
    let anyMatch = false
    for (const pattern of manifest.includedRoots) {
      if (matchesPattern(path, pattern)) {
        anyMatch = true
        break
      }
    }
    if (!anyMatch) return false
  }

  if (manifest.layer && manifest.layer !== 'all') {
    if (!matchesPattern(path, manifest.layer)) return false
  }

  if (manifest.freshness && fileMtimeMs !== undefined) {
    const { withinDays, beforeDate } = manifest.freshness
    if (withinDays !== undefined) {
      const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000
      if (fileMtimeMs < cutoff) return false
    }
    if (beforeDate !== undefined) {
      const cutoff = new Date(beforeDate).getTime()
      if (fileMtimeMs >= cutoff) return false
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// Pattern matching — top-level prefix with optional `*` glob.
//
// Examples (path on left, pattern on right, result):
//   `logs/2026/05/2026-05-19.md`   `logs`        → true
//   `topics/log-aggregate.md`      `logs`        → false
//   `tmp-perf-test/file.md`        `tmp-*`       → true
//   `topics/architecture.md`       `topics`      → true
//   `archive/topics/old.md`        `topics`      → false (not top-level)
// ---------------------------------------------------------------------------

function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes('*')) {
    return path === pattern || path.startsWith(pattern + '/')
  }
  // Glob: `*` → `[^/]*`. Anchor at start; allow `/` or end-of-string after.
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '(/|$)',
  )
  return re.test(path)
}
