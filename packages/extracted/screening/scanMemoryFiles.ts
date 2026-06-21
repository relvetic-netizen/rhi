// scanMemoryFiles — shared helper that walks a memory directory and produces
// `MemoryHeaderLike[]` records suitable for screening + retrieval.
//
// Extracted from `findRelevantMemories.ts` as part of the Phase 1 iter 1
// (`memory-search-improvement-loop`) engine migration: both the legacy
// `findRelevantMemories` pipeline and the new `MultiResolutionScreeningGate`
// strategy in `MemoryRetrievalEngine.ts` need the same scan semantics. Keeping
// the helper in a single module avoids a circular import between
// `findRelevantMemories.ts` (which will delegate to the engine in Phase 1-2)
// and `MemoryRetrievalEngine.ts` (which calls the gate immediately).
//
// Behavior parity contract (Karpathy 5 — Verify, don't assume):
//   - Returns at most MAX_FILES `.md` files (excluding `MEMORY.md`).
//   - Filters out `private/` private files when not opted in.
//   - Reads first SNIPPET_BYTES of each file body for screening signal.
//   - Sorts newest-first by mtime.
//
// Phase 4b followup (2026-05-23, MAX_FILES truncation structural fix):
//   - default `CorpusManifest` (`.backup` / `.staging` / `tmp-*` excluded) is
//     auto-applied when caller passes no manifest, so design-noise dirs that
//     existed before Phase 2 iter 2 are no longer competing for the cap slot.
//   - post-stat **mtime gate** keeps only files modified at or after
//     `.last-distill`. The Layer B file scan exists to cover content not yet
//     reflected in `index.json`; older files are already represented as
//     residual entries, so re-scoring them on every query is wasted work and
//     made the 200-file cap politically expensive. With the gate in place the
//     scan corpus shrinks to "what changed since the last distill" (typically
//     0–30 files) and the cap is no longer load-bearing.
//   - `MAX_FILES` bumped 200 → 2000 as a pure safety ceiling against
//     readdir pathology (memoryDir suddenly explodes to 10k+ files). With
//     the manifest + mtime filters in place, hitting it should be impossible
//     in normal operation.
//   - `MEMORY_SCAN_LEGACY_FULL=1` env restores pre-fix behavior (no default
//     manifest, no mtime gate, MAX_FILES=200). Same shape as the
//     `MEMORY_SEARCH_LEGACY_DEFAULT` rollback knob in `memorySearch.ts`.
//
// Output filenames are returned **as readdir reports them** (OS-native
// separators). Callers that compare filenames against forward-slash paths
// (e.g., `topicPathForEntry()` output) MUST normalize before lookup. The
// `MultiResolutionScreeningGate` does this normalization at the boundary.

import { readdir, readFile, stat } from 'fs/promises'
import type { Stats } from 'fs'
import { basename, join } from 'path'
import { type MemoryHeaderLike } from './memoryScreening.js'
import { isPrivatePath, shouldIncludePrivate } from '../memory/memoryPrivacy.js'
import {
  matchesCorpus,
  type CorpusManifest,
} from '../memory/CorpusManifest.js'
import { getDefaultSearchCache, manifestKey } from './searchCache.js'
import { readLastDistillMtimeMs } from './lastDistillMtime.js'
import {
  isLegacyFullScan,
  getCurrentMaxFiles,
  resolveEffectiveManifest,
} from './scanLimits.js'

const SNIPPET_BYTES = 500

/**
 * memory-kind-framework Phase 2a: detect `memory_kind: meta-inventory`
 * declaration in YAML frontmatter at file start. meta-inventory files are
 * human-readable plans / harnesses (e.g. preferences-inventory.md) that should
 * not enter the search corpus — they would contaminate Recall scoring by
 * matching queries about their target topic without containing the answers.
 *
 * Detection scans the first ~20 lines of the snippet (which is SNIPPET_BYTES =
 * 500 bytes, easily covers a typical frontmatter block). Returns true for
 * exact `memory_kind: meta-inventory` token match within the leading
 * `---` ... `---` block; false otherwise (incl. no frontmatter at all, which
 * is the dominant case for legacy topic files until Phase 2b backfill).
 */
export function hasMetaInventoryFrontmatter(content: string): boolean {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return false
  const lines = content.split(/\r?\n/)
  let closingIdx = -1
  for (let i = 1; i < Math.min(20, lines.length); i++) {
    if (lines[i] === '---') {
      closingIdx = i
      break
    }
  }
  if (closingIdx === -1) return false
  for (let i = 1; i < closingIdx; i++) {
    const m = lines[i].match(/^memory_kind:\s*(\S+)\s*$/)
    if (m && m[1] === 'meta-inventory') return true
  }
  return false
}

export type ScanMemoryFilesOptions = {
  /** Optional corpus boundary. When provided, files that don't satisfy the
   *  manifest's include/exclude/layer conditions are dropped before stat.
   *  `freshness` is evaluated against `fileMtimeMs` after stat. */
  manifest?: CorpusManifest
}

export async function scanMemoryFiles(
  memoryDir: string,
  opts: ScanMemoryFilesOptions = {},
): Promise<MemoryHeaderLike[]> {
  const cache = getDefaultSearchCache()
  // Cache key on the EFFECTIVE manifest so flipping
  // `MEMORY_SCAN_LEGACY_FULL` (which changes the fallback) lands in a
  // different cache slot. Without this the cached wrapper would keep
  // returning non-legacy results to a legacy caller (Codex PR #77 P1 #2).
  const mk = manifestKey(resolveEffectiveManifest(opts))
  return cache.getHeaders<MemoryHeaderLike[]>(memoryDir, mk, () =>
    scanMemoryFilesUncached(memoryDir, opts),
  )
}

/** Cache-bypass version of `scanMemoryFiles`. Tests use this to verify the
 *  cache layer is the source of speedup (cache hit returns same shape as a
 *  fresh scan). Production callers go through `scanMemoryFiles` so cache + */
/*  watcher invalidation are honored. */
export async function scanMemoryFilesUncached(
  memoryDir: string,
  opts: ScanMemoryFilesOptions = {},
): Promise<MemoryHeaderLike[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const includePrivate = shouldIncludePrivate()
    const legacy = isLegacyFullScan()
    const manifest = resolveEffectiveManifest(opts)
    // Layer B mtime gate: skip files older than `.last-distill`. Their content
    // is already in `index.json` so re-scoring them in the file layer is
    // redundant. Missing `.last-distill` (fresh install / lost stamp) falls
    // back to 0 = no gate, preserving bootstrap behavior.
    const lastDistillMs = legacy ? 0 : await readLastDistillMtimeMs(memoryDir)
    const maxFiles = getCurrentMaxFiles()

    // Phase 1 — cheap path-level filters (no IO).
    const candidates = entries
      .filter(f => f.endsWith('.md') && basename(f) !== 'MEMORY.md')
      .filter(f => includePrivate || !isPrivatePath(f))
      .filter(f => !manifest || matchesCorpus(f, manifest))

    // Phase 2 — stat the path-survivors in parallel (cheap on NTFS, ~µs/file).
    // This MUST happen BEFORE the cap is applied so that fresh files which
    // happen to sort alphabetically last are not silently dropped by the
    // pre-stat `slice` (Codex PR #77 P1 #1). The cap only kicks in below
    // after the mtime gate has already shrunk the corpus.
    type StatedEntry = { relativePath: string; filePath: string; fstat: Stats }
    const stated = await Promise.allSettled(
      candidates.map(async (relativePath): Promise<StatedEntry> => {
        const filePath = join(memoryDir, relativePath)
        const fstat = await stat(filePath)
        return { relativePath, filePath, fstat }
      }),
    )
    const withStats = stated
      .filter(
        (r): r is PromiseFulfilledResult<StatedEntry> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)

    // Phase 3 — mtime gate + manifest freshness, then sort newest-first, then
    // cap. `maxFiles` is now a TRUE defensive ceiling (pathology guard); the
    // gate is the load-bearing corpus shrinker.
    const survivors = withStats
      .filter(({ relativePath, fstat }) =>
        !manifest?.freshness ||
          matchesCorpus(relativePath, manifest, fstat.mtimeMs),
      )
      .filter(({ fstat }) => lastDistillMs === 0 || fstat.mtimeMs >= lastDistillMs)
      .sort((a, b) => b.fstat.mtimeMs - a.fstat.mtimeMs)
      .slice(0, maxFiles)

    // Phase 4 — read file bodies only for survivors. Skipping the readFile
    // on dropped files is the bigger IO win on `readMemoryFiles` (100KB
    // bodies); for `scanMemoryFiles` the read is bounded by `SNIPPET_BYTES`
    // (~500 bytes) but the same shape applies.
    //
    // memory-kind-framework Phase 2a (2026-05-29): meta-inventory files are
    // dropped here — they declared themselves via frontmatter as
    // human-readable plans (e.g. preferences-inventory.md), not corpus.
    const results = await Promise.allSettled(
      survivors.map(async ({ relativePath, filePath, fstat }): Promise<MemoryHeaderLike | null> => {
        const buf = await readFile(filePath)
        const content = buf.toString('utf8', 0, SNIPPET_BYTES)

        if (hasMetaInventoryFrontmatter(content)) {
          return null
        }

        // Extract description from first non-empty, non-heading line
        const lines = content.split('\n')
        let description: string | null = null
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
            description = trimmed.slice(0, 200)
            break
          }
        }

        return {
          filename: relativePath,
          filePath,
          mtimeMs: fstat.mtimeMs,
          description,
          contentSnippet: content,
        }
      }),
    )

    return results
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeaderLike | null> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .filter((h): h is MemoryHeaderLike => h !== null)
  } catch {
    return []
  }
}
