// Phase 4b followup (2026-05-23): structural fix for the MAX_FILES=200
// truncation problem documented at [log:2026-05-22 21:00]. Two changes are
// covered here:
//
//   1. **Default `CorpusManifest`** — `scanMemoryFiles` / `readMemoryFiles`
//      auto-apply `getDefaultCorpusManifest()` when the caller passes no
//      manifest, so `.backup` / `.staging` / `tmp-*` (which existed before
//      Phase 2 iter 2 introduced the manifest seam) are excluded from the
//      Layer B scan corpus.
//   2. **Mtime gate** — files older than `<memoryDir>/.last-distill` are
//      dropped, because the residual index (Layer A) already covers them.
//      The Layer B file scan only needs to surface content the most recent
//      distillation has not yet captured.
//
// `MEMORY_SCAN_LEGACY_FULL=1` env restores the pre-fix behavior (no default
// manifest, no gate, MAX_FILES=200). The env-var rollback shape mirrors
// `MEMORY_SEARCH_LEGACY_DEFAULT` used by the older MAX_FILE_BYTES bump so
// operators have a single muscle-memory for emergency rollback.

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  scanMemoryFiles,
  scanMemoryFilesUncached,
} from '../../extracted/screening/scanMemoryFiles.js'
import {
  readMemoryFilesUncached,
  searchMemoryWithScreening,
} from '../../extracted/screening/memorySearch.js'
import { resetDefaultSearchCache } from '../../extracted/screening/searchCache.js'

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface FixtureFile {
  path: string // relative to memoryDir
  body: string
  mtimeMs: number
}

function makeMemoryDir(files: FixtureFile[], lastDistillIso?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-mtime-gate-'))
  for (const f of files) {
    const abs = join(dir, f.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.body, 'utf8')
    const seconds = f.mtimeMs / 1000
    utimesSync(abs, seconds, seconds)
  }
  if (lastDistillIso !== undefined) {
    writeFileSync(join(dir, '.last-distill'), lastDistillIso, 'utf8')
  }
  return dir
}

// ---------------------------------------------------------------------------
// Env helpers — `MEMORY_SCAN_LEGACY_FULL` is read on every call via
// `isLegacyFullScan()`, so toggling between tests is safe without module reload.
// The `MAX_FILES` constant itself IS captured at module init, but these tests
// don't assert on the cap value — only on the manifest + mtime gate behavior.
// ---------------------------------------------------------------------------

const ENV_KEY = 'MEMORY_SCAN_LEGACY_FULL'

beforeEach(() => {
  delete process.env[ENV_KEY]
  resetDefaultSearchCache()
})

afterEach(() => {
  delete process.env[ENV_KEY]
  resetDefaultSearchCache()
})

// ---------------------------------------------------------------------------
// Default manifest exclusion (rule B)
// ---------------------------------------------------------------------------

describe('scanMemoryFiles — default manifest exclusion', () => {
  it('drops .backup / .staging / tmp-* paths by default', async () => {
    const now = Date.now()
    const dir = makeMemoryDir([
      { path: 'topics/keep.md', body: 'keep this', mtimeMs: now },
      { path: '.backup/snapshot.md', body: 'old snapshot', mtimeMs: now },
      { path: '.staging/draft.md', body: 'wip', mtimeMs: now },
      { path: 'tmp-perf/runs.md', body: 'bench', mtimeMs: now },
    ])
    try {
      const result = await scanMemoryFilesUncached(dir)
      const names = result.map(r => r.filename.replace(/\\/g, '/'))
      expect(names).toContain('topics/keep.md')
      expect(names).not.toContain('.backup/snapshot.md')
      expect(names).not.toContain('.staging/draft.md')
      expect(names).not.toContain('tmp-perf/runs.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects caller-supplied manifest (overrides default)', async () => {
    const now = Date.now()
    const dir = makeMemoryDir([
      { path: 'topics/keep.md', body: 'keep', mtimeMs: now },
      { path: '.backup/snapshot.md', body: 'snap', mtimeMs: now },
    ])
    try {
      // Empty manifest (no exclusions) — caller wants everything in scope.
      const result = await scanMemoryFilesUncached(dir, { manifest: {} })
      const names = result.map(r => r.filename.replace(/\\/g, '/'))
      expect(names).toContain('topics/keep.md')
      expect(names).toContain('.backup/snapshot.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('legacy mode (env opt-out) includes .backup / .staging', async () => {
    process.env[ENV_KEY] = '1'
    const now = Date.now()
    const dir = makeMemoryDir([
      { path: 'topics/keep.md', body: 'keep', mtimeMs: now },
      { path: '.backup/snapshot.md', body: 'snap', mtimeMs: now },
    ])
    try {
      const result = await scanMemoryFilesUncached(dir)
      const names = result.map(r => r.filename.replace(/\\/g, '/'))
      expect(names).toContain('topics/keep.md')
      expect(names).toContain('.backup/snapshot.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Mtime gate (rule D)
// ---------------------------------------------------------------------------

describe('scanMemoryFiles — mtime gate', () => {
  it('drops files older than .last-distill', async () => {
    const now = Date.now()
    const oneHourAgo = now - 3_600_000
    const cutoff = new Date(now - 1_800_000) // 30 min ago
    const dir = makeMemoryDir(
      [
        { path: 'topics/fresh.md', body: 'fresh content', mtimeMs: now },
        { path: 'topics/stale.md', body: 'stale content', mtimeMs: oneHourAgo },
      ],
      cutoff.toISOString(),
    )
    try {
      const result = await scanMemoryFilesUncached(dir)
      const names = result.map(r => r.filename.replace(/\\/g, '/'))
      expect(names).toContain('topics/fresh.md')
      expect(names).not.toContain('topics/stale.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats missing .last-distill as no gate (fallback safety)', async () => {
    const now = Date.now()
    const oneYearAgo = now - 365 * 86_400_000
    const dir = makeMemoryDir(
      [
        { path: 'topics/fresh.md', body: 'fresh', mtimeMs: now },
        { path: 'topics/ancient.md', body: 'ancient', mtimeMs: oneYearAgo },
      ],
      // No .last-distill file.
    )
    try {
      const result = await scanMemoryFilesUncached(dir)
      const names = result.map(r => r.filename.replace(/\\/g, '/'))
      expect(names).toContain('topics/fresh.md')
      expect(names).toContain('topics/ancient.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('legacy mode (env opt-out) bypasses the gate', async () => {
    process.env[ENV_KEY] = '1'
    const now = Date.now()
    const oneHourAgo = now - 3_600_000
    const cutoff = new Date(now - 1_800_000)
    const dir = makeMemoryDir(
      [
        { path: 'topics/fresh.md', body: 'fresh', mtimeMs: now },
        { path: 'topics/stale.md', body: 'stale', mtimeMs: oneHourAgo },
      ],
      cutoff.toISOString(),
    )
    try {
      const result = await scanMemoryFilesUncached(dir)
      const names = result.map(r => r.filename.replace(/\\/g, '/'))
      expect(names).toContain('topics/fresh.md')
      expect(names).toContain('topics/stale.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives an unparseable .last-distill stamp', async () => {
    const now = Date.now()
    const oneYearAgo = now - 365 * 86_400_000
    const dir = makeMemoryDir(
      [
        { path: 'topics/fresh.md', body: 'fresh', mtimeMs: now },
        { path: 'topics/ancient.md', body: 'ancient', mtimeMs: oneYearAgo },
      ],
      'not-a-real-timestamp',
    )
    try {
      // Unparseable → readLastDistillMtimeMs returns 0 → gate disabled.
      const result = await scanMemoryFilesUncached(dir)
      const names = result.map(r => r.filename.replace(/\\/g, '/'))
      expect(names).toContain('topics/fresh.md')
      expect(names).toContain('topics/ancient.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// readMemoryFiles parity — same gates apply on the BM25-input path used by
// `searchMemoryWithScreening` Layer B.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regression: cap is applied AFTER the mtime gate + sort (Codex PR #77 P1 #1)
// ---------------------------------------------------------------------------
//
// Reproduces the structural bug that the first revise missed: when the cap
// was applied BEFORE the mtime gate, alphabetically-late fresh files were
// silently dropped because they never reached the gate.
//
// Pre-patch shape:   filter(.md/priv/corpus) → slice(MAX_FILES) → stat → gate
//                    ^^ fresh files at the alphabetical tail get sliced away.
// Post-patch shape:  filter(.md/priv/corpus) → stat → gate → sort → slice
//                    ^^ fresh files survive regardless of alphabetical order.
//
// To make the bug observable in CI we temporarily shrink the cap by flipping
// `MEMORY_SCAN_LEGACY_FULL=1` (which forces cap=200 + disables the gate +
// disables the default manifest). Building the fixture around the 200 cap
// is cheap; building it around the 2000 ceiling would require 2000+ temp
// files in /tmp and is wasteful for a regression assertion.
//
// We test the post-patch order by leaving env in non-legacy mode (gate on)
// and confirming alphabetically-late fresh files survive. We do NOT test
// the pre-patch failing case here because the patch is already applied; the
// test file is the regression marker for future structural drift.
// ---------------------------------------------------------------------------

describe('scanMemoryFiles — cap is applied AFTER gate + sort (regression)', () => {
  it('alphabetically-late fresh file survives even with many older candidates', async () => {
    const now = Date.now()
    const fiveDaysAgo = now - 5 * 86_400_000
    const cutoff = new Date(now - 86_400_000) // 24h ago
    // 300 stale topic files spread across a..t prefixes, plus ONE fresh
    // file at z-fresh (alphabetical tail). Pre-patch order would
    // .slice(0, 200) before stating mtimes — z-fresh would be cut.
    // Post-patch order stats everything first, then applies the gate
    // BEFORE the cap kicks in.
    const fixture: FixtureFile[] = []
    const alphabet = 'abcdefghijklmnopqrst'
    for (let i = 0; i < 300; i++) {
      const letter = alphabet[i % alphabet.length]
      fixture.push({
        path: `topics/${letter}-stale-${String(i).padStart(3, '0')}.md`,
        body: `stale ${i}`,
        mtimeMs: fiveDaysAgo,
      })
    }
    fixture.push({
      path: 'topics/z-fresh.md',
      body: 'fresh tail',
      mtimeMs: now,
    })
    const dir = makeMemoryDir(fixture, cutoff.toISOString())
    try {
      const result = await scanMemoryFilesUncached(dir)
      const names = result.map(r => r.filename.replace(/\\/g, '/'))
      // The single fresh file MUST survive.
      expect(names).toContain('topics/z-fresh.md')
      // The 300 stale files MUST NOT survive (gate rejects them).
      expect(names.filter(n => n.includes('-stale-')).length).toBe(0)
      // Only 1 survivor in total (gate + sort + cap leaves just z-fresh).
      expect(result.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('legacy mode cap (200) still applies as a true ceiling, not a load-bearing filter', async () => {
    process.env[ENV_KEY] = '1'
    const now = Date.now()
    // 250 files all fresh; legacy mode has gate disabled + cap=200 +
    // no default manifest. Post-patch: sort by mtime desc, then cap → 200
    // survivors (the 50 oldest are cut). Pre-patch: same result because
    // the gate is disabled either way; this test just confirms legacy
    // mode's cap behavior is preserved.
    const fixture: FixtureFile[] = []
    for (let i = 0; i < 250; i++) {
      fixture.push({
        path: `topics/file-${String(i).padStart(3, '0')}.md`,
        body: `body ${i}`,
        // Stagger mtimes so the sort is deterministic.
        mtimeMs: now - i * 1000,
      })
    }
    const dir = makeMemoryDir(fixture)
    try {
      const result = await scanMemoryFilesUncached(dir)
      expect(result.length).toBe(200)
      // First survivor should be the most recently modified (file-000).
      expect(result[0].filename.replace(/\\/g, '/')).toBe('topics/file-000.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('non-legacy cap (2000) is a defensive ceiling but the gate normally keeps the corpus far below', async () => {
    // 50 fresh files. No legacy env. Gate is active but `.last-distill` is
    // older than all files so they all pass the gate. Cap is 2000, well
    // above the corpus. All 50 survive.
    const now = Date.now()
    const oneHourAgo = now - 3_600_000
    const cutoff = new Date(now - 2 * 3_600_000)
    const fixture: FixtureFile[] = []
    for (let i = 0; i < 50; i++) {
      fixture.push({
        path: `topics/keeper-${String(i).padStart(2, '0')}.md`,
        body: `k${i}`,
        mtimeMs: oneHourAgo - i * 1000,
      })
    }
    const dir = makeMemoryDir(fixture, cutoff.toISOString())
    try {
      const result = await scanMemoryFilesUncached(dir)
      expect(result.length).toBe(50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Env-aware cache key (Codex PR #77 P1 #2)
// ---------------------------------------------------------------------------
//
// Validates that flipping `MEMORY_SCAN_LEGACY_FULL` between cached calls
// lands in a different cache slot, so the cached wrapper does not return
// non-legacy results to a legacy caller (or vice versa).
// ---------------------------------------------------------------------------

describe('scanMemoryFiles — env-aware cache key (regression)', () => {
  it('env toggle invalidates the default-manifest cache slot', async () => {
    const now = Date.now()
    const dir = makeMemoryDir([
      { path: 'topics/keep.md', body: 'keep', mtimeMs: now },
      { path: '.backup/snapshot.md', body: 'snap', mtimeMs: now },
    ])
    try {
      resetDefaultSearchCache()
      // First call: non-legacy mode. Default manifest excludes .backup.
      delete process.env[ENV_KEY]
      const firstCall = await scanMemoryFiles(dir)
      const firstNames = firstCall.map(r => r.filename.replace(/\\/g, '/'))
      expect(firstNames).toContain('topics/keep.md')
      expect(firstNames).not.toContain('.backup/snapshot.md')

      // Flip env. Cache key for "no caller manifest" must change so that
      // the cached non-legacy result is NOT returned to the legacy caller.
      process.env[ENV_KEY] = '1'
      const secondCall = await scanMemoryFiles(dir)
      const secondNames = secondCall.map(r => r.filename.replace(/\\/g, '/'))
      expect(secondNames).toContain('topics/keep.md')
      // .backup MUST appear under legacy mode — pre-fix this would still be
      // hidden because the cache returned the non-legacy result.
      expect(secondNames).toContain('.backup/snapshot.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('searchMemoryWithScreening — env-aware bundle cache key (regression R2)', () => {
  // Codex PR #77 R2 P1: the file-layer bundle cache key was still using
  // `manifestKey(opts.manifest)` (raw caller arg) while the file corpus
  // itself was built from `resolveEffectiveManifest(opts)`. Warming the
  // bundle in non-legacy mode and then flipping the env to legacy used to
  // throw `items.length=2 != bundle.itemTokens.length=1` when the new
  // file set surfaced `.backup` paths the cached bundle never tokenized.
  it('env toggle no longer throws via the file-layer bundle path', async () => {
    const now = Date.now()
    const dir = makeMemoryDir([
      {
        path: 'topics/keep.md',
        body: 'kubernetes infrastructure observability dashboard',
        mtimeMs: now,
      },
      {
        path: '.backup/snapshot.md',
        body: 'kubernetes legacy snapshot archived deployment',
        mtimeMs: now,
      },
    ])
    try {
      resetDefaultSearchCache()
      const config = { threshold: 0.05, maxResults: 10 }

      // Warm: non-legacy. Default manifest hides .backup/.
      delete process.env[ENV_KEY]
      const nonLegacy = await searchMemoryWithScreening(dir, 'kubernetes', config)
      const nonLegacyPaths = nonLegacy.map(r => r.path.replace(/\\/g, '/'))
      expect(nonLegacyPaths).toContain('topics/keep.md')
      expect(nonLegacyPaths).not.toContain('.backup/snapshot.md')

      // Flip env. Legacy caller MUST get .backup/ — and the call must not
      // throw from a stale bundle. The pre-fix bundle key used
      // `manifestKey(opts.manifest)` (= 'default' for both modes) so the
      // cached 1-item bundle would mismatch the 2-item legacy corpus.
      process.env[ENV_KEY] = '1'
      const legacy = await searchMemoryWithScreening(dir, 'kubernetes', config)
      const legacyPaths = legacy.map(r => r.path.replace(/\\/g, '/'))
      expect(legacyPaths).toContain('topics/keep.md')
      expect(legacyPaths).toContain('.backup/snapshot.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readMemoryFiles — same gates as scanMemoryFiles', () => {
  it('default manifest + mtime gate both active', async () => {
    const now = Date.now()
    const oneHourAgo = now - 3_600_000
    const cutoff = new Date(now - 1_800_000)
    const dir = makeMemoryDir(
      [
        { path: 'topics/fresh-keep.md', body: 'fresh keeper', mtimeMs: now },
        { path: 'topics/stale-drop.md', body: 'stale dropped by gate', mtimeMs: oneHourAgo },
        { path: '.backup/fresh-noise.md', body: 'fresh noise dropped by manifest', mtimeMs: now },
      ],
      cutoff.toISOString(),
    )
    try {
      const result = await readMemoryFilesUncached(dir)
      const paths = result.map(r => r.relativePath.replace(/\\/g, '/'))
      expect(paths).toContain('topics/fresh-keep.md')
      expect(paths).not.toContain('topics/stale-drop.md')
      expect(paths).not.toContain('.backup/fresh-noise.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('legacy mode preserves pre-fix behavior across both gates', async () => {
    process.env[ENV_KEY] = '1'
    const now = Date.now()
    const oneHourAgo = now - 3_600_000
    const cutoff = new Date(now - 1_800_000)
    const dir = makeMemoryDir(
      [
        { path: 'topics/fresh.md', body: 'fresh', mtimeMs: now },
        { path: 'topics/stale.md', body: 'stale', mtimeMs: oneHourAgo },
        { path: '.backup/snapshot.md', body: 'snap', mtimeMs: now },
      ],
      cutoff.toISOString(),
    )
    try {
      const result = await readMemoryFilesUncached(dir)
      const paths = result.map(r => r.relativePath.replace(/\\/g, '/'))
      expect(paths).toContain('topics/fresh.md')
      expect(paths).toContain('topics/stale.md')
      expect(paths).toContain('.backup/snapshot.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
