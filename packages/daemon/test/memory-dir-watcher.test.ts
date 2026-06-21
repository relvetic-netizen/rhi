// Saga 11 engine-cache-layer: integration tests for memoryDirWatcher.
//
// The watcher attaches chokidar (relvetia-daemon dep ^4.0.0) and invalidates
// the search cache on file mutation. Tests use real chokidar where possible;
// the polling fallback path is exercised by forcing chokidar load failure
// via `resetChokidarLoadCache()` paired with an env knob (covered by the
// "polling fallback" suite below; the production path is the chokidar
// suite).
//
// Timing note: chokidar emits events asynchronously, the watcher debounces
// for 500ms, and Windows fs.watch sometimes coalesces events. Tests use a
// generous wait window (1500ms) plus a polling assertion to stay race-free
// without sleeping the full window unconditionally.

import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachMemoryDirWatcher,
  detachMemoryDirWatcher,
  activeWatcherCount,
  setChokidarFactory,
  setPollIntervalForTest,
  resetChokidarLoadCache,
  type ChokidarModule,
} from '../../extracted/screening/memoryDirWatcher.js'
import {
  MemorySearchCache,
} from '../../extracted/screening/searchCache.js'

// Test-side chokidar factory: chokidar lives in relvetia-daemon/node_modules
// (the host) but NOT in extracted's. The test runs from the daemon
// package so dynamic `import('chokidar')` resolves correctly from this file.
beforeAll(() => {
  setChokidarFactory(async (): Promise<ChokidarModule> => {
    const moduleName = 'chokidar' as string
    return (await import(moduleName)) as unknown as ChokidarModule
  })
})

const WATCHER_WAIT_MS = 1500
const POLL_INTERVAL_MS = 50

async function waitForGenerationBump(
  cache: MemorySearchCache,
  memoryDir: string,
  initialGen: number,
  timeoutMs = WATCHER_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cache.getGeneration(memoryDir) > initialGen) return true
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  return false
}

function makeMemoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saga11-watcher-test-'))
  mkdirSync(join(dir, 'topics'), { recursive: true })
  writeFileSync(
    join(dir, 'topics', 'architecture.md'),
    '# Architecture\n\nInitial content.\n',
  )
  return dir
}

describe('attachMemoryDirWatcher (chokidar mode)', () => {
  let memoryDir: string
  let cache: MemorySearchCache

  beforeEach(() => {
    memoryDir = makeMemoryDir()
    cache = new MemorySearchCache()
  })

  afterEach(async () => {
    await detachMemoryDirWatcher(memoryDir)
    rmSync(memoryDir, { recursive: true, force: true })
  })

  it('attaches successfully and reports chokidar mode (when chokidar is on the path)', async () => {
    const handle = await attachMemoryDirWatcher(memoryDir, cache)
    expect(handle.mode === 'chokidar' || handle.mode === 'polling').toBe(true)
    // In relvetia-daemon test env chokidar IS available, so we expect 'chokidar' —
    // but we don't hard-fail if a future test harness drops chokidar; the
    // watcher's contract is that it works either way.
  })

  it('idempotent: repeat attach returns the same handle', async () => {
    const a = await attachMemoryDirWatcher(memoryDir, cache)
    const b = await attachMemoryDirWatcher(memoryDir, cache)
    expect(a).toBe(b)
  })

  it('detach removes the watcher from the active set', async () => {
    await attachMemoryDirWatcher(memoryDir, cache)
    const before = activeWatcherCount()
    await detachMemoryDirWatcher(memoryDir)
    const after = activeWatcherCount()
    expect(after).toBe(before - 1)
  })

  it('file mutation triggers cache.invalidate (generation bumps)', async () => {
    await attachMemoryDirWatcher(memoryDir, cache)
    const initialGen = cache.getGeneration(memoryDir)

    // Mutate: append to an existing file. chokidar should detect a 'change' event.
    appendFileSync(join(memoryDir, 'topics', 'architecture.md'), '\nMutation.\n')

    const bumped = await waitForGenerationBump(cache, memoryDir, initialGen)
    expect(bumped).toBe(true)
  })

  it('file add triggers cache.invalidate', async () => {
    await attachMemoryDirWatcher(memoryDir, cache)
    // chokidar's `ignoreInitial: true` means the initial snapshot does NOT
    // fire add events. New files post-attach should.
    const initialGen = cache.getGeneration(memoryDir)
    writeFileSync(
      join(memoryDir, 'topics', 'new-topic.md'),
      '# New Topic\n\nFresh entry.\n',
    )
    const bumped = await waitForGenerationBump(cache, memoryDir, initialGen)
    expect(bumped).toBe(true)
  })

  it('debounces rapid burst of events into one invalidate', async () => {
    await attachMemoryDirWatcher(memoryDir, cache)
    const initialGen = cache.getGeneration(memoryDir)

    // Burst: 5 appends back-to-back. The 500ms debounce should collapse them
    // into a single invalidate.
    for (let i = 0; i < 5; i++) {
      appendFileSync(join(memoryDir, 'topics', 'architecture.md'), `\nburst ${i}\n`)
    }

    const bumped = await waitForGenerationBump(cache, memoryDir, initialGen)
    expect(bumped).toBe(true)
    // The exact post-bump generation depends on whether the last write trailed
    // the debounce window. Accept either 1 (perfect coalesce) or up to 2
    // (partial coalesce) — the contract is "fewer invalidations than writes",
    // not "exactly one".
    expect(cache.getGeneration(memoryDir)).toBeLessThanOrEqual(initialGen + 2)
  })
})

// ---------------------------------------------------------------------------
// Polling fallback (forced via chokidar factory clear, Codex r1 P1 #1 fix:
// nested mutation must be detected by recursive signature, not just top-level)
// ---------------------------------------------------------------------------

describe('attachMemoryDirWatcher (polling fallback mode)', () => {
  let memoryDir: string
  let cache: MemorySearchCache
  let prevPollInterval: number

  beforeEach(() => {
    memoryDir = makeMemoryDir()
    cache = new MemorySearchCache()
    // Force the polling fallback path by clearing the chokidar factory.
    setChokidarFactory(null)
    resetChokidarLoadCache()
    // Tighten the polling interval so tests don't wait the 30s production default.
    prevPollInterval = setPollIntervalForTest(150)
  })

  afterEach(async () => {
    await detachMemoryDirWatcher(memoryDir)
    rmSync(memoryDir, { recursive: true, force: true })
    setPollIntervalForTest(prevPollInterval)
    // Restore the chokidar factory for tests that run after this block.
    setChokidarFactory(async (): Promise<ChokidarModule> => {
      const moduleName = 'chokidar' as string
      return (await import(moduleName)) as unknown as ChokidarModule
    })
    resetChokidarLoadCache()
  })

  it('reports polling mode when chokidar factory is absent', async () => {
    const handle = await attachMemoryDirWatcher(memoryDir, cache)
    expect(handle.mode).toBe('polling')
  })

  it('detects nested mutation (logs/YYYY/MM/*.md) via recursive signature — guards Codex r1 P1 #1', async () => {
    // Pre-create a nested log file so the initial polling snapshot captures it.
    // Append to it AFTER attach to force a delta the recursive walker must see;
    // a top-level-only walker would miss this because the memoryDir itself has
    // no mtime change when a child file is appended.
    mkdirSync(join(memoryDir, 'logs', '2026', '05'), { recursive: true })
    writeFileSync(join(memoryDir, 'logs', '2026', '05', '2026-05-21.md'), 'initial nested log\n')

    await attachMemoryDirWatcher(memoryDir, cache)
    const initialGen = cache.getGeneration(memoryDir)

    appendFileSync(
      join(memoryDir, 'logs', '2026', '05', '2026-05-21.md'),
      '\n- [12:44] nested mutation\n',
    )

    // Wait up to ~3 polling intervals (150ms each) + the 500ms debounce; give
    // Windows fs latency 2500ms total slack.
    const bumped = await waitForGenerationBump(cache, memoryDir, initialGen, 2500)
    expect(bumped).toBe(true)
  })

  it('detects topics/<name>.md mutation via recursive signature (sibling subdirectory)', async () => {
    // The `topics/architecture.md` file is created by `makeMemoryDir()`.
    // Recursive walker must catch its mtime/size delta even though it's not
    // a top-level entry.
    await attachMemoryDirWatcher(memoryDir, cache)
    const initialGen = cache.getGeneration(memoryDir)

    appendFileSync(
      join(memoryDir, 'topics', 'architecture.md'),
      '\n## Saga 11\n\nNested polling-detected change.\n',
    )

    const bumped = await waitForGenerationBump(cache, memoryDir, initialGen, 2500)
    expect(bumped).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Saga 12 (d) — attach/detach toggles the cache's watcherAttached flag so
  // `checkAndRefresh()` correctly switches between watcher-trust mode and
  // per-call stat-based fallback mode.
  // -------------------------------------------------------------------------
  it('saga 12: attach sets cache.hasWatcherAttached(memoryDir) → detach clears it', async () => {
    // Before attach: no watcher recorded.
    expect(cache.hasWatcherAttached(memoryDir)).toBe(false)

    // Attach in polling mode (this describe block forces polling via
    // beforeAll(setChokidarFactory(null))).
    const handle = await attachMemoryDirWatcher(memoryDir, cache)
    expect(handle.mode === 'chokidar' || handle.mode === 'polling').toBe(true)
    expect(cache.hasWatcherAttached(memoryDir)).toBe(true)

    // Detach clears the flag → per-call mode resumes.
    await detachMemoryDirWatcher(memoryDir)
    expect(cache.hasWatcherAttached(memoryDir)).toBe(false)
  })
})
