// In-process cache for memory search corpus content + per-corpus-shape BM25
// bundles. Drops Path A warm p50 from ~1043ms toward proposal §7.1 target
// (<100ms) by skipping disk reads and per-query tokenize / buildBm25CorpusStats
// when the underlying memory dir content has not changed.
//
// Invalidation strategy — dual mode (saga 11 watcher push + saga 12 per-call
// stat-based fallback):
//   - Watcher mode (preferred, daemon-side): `memoryDirWatcher.ts` attaches a
//     chokidar (or polling-fallback) watcher and calls `markWatcherAttached`
//     here, then invokes `cache.invalidate(memoryDir)` on file mutation.
//     `checkAndRefresh()` is a no-op when the watcher is attached.
//   - Per-call mode (saga 12, MCP sidecar processes without a watcher): each
//     search entry (`executeMemorySearch`, `findRelevantMemories`) calls
//     `checkAndRefresh(memoryDir, computeSignature)` once at the top. If the
//     signature has changed since the last check, the cache is invalidated.
//     The injected `computeSignature` fn (`memoryDirWatcher.recursiveSignature`)
//     does one readdir + N stat. **Saga 12 revB note**: empirical p50 on the
//     production memory dir is ~450ms (497k-char signature over many nested
//     entries), not the 10-30ms initially estimated for a ~200-file synthetic
//     case. A TTL gate (`FRESHNESS_TTL_MS`, default 1000ms) amortizes this
//     cost: within the TTL window, `checkAndRefresh` skips the signature
//     computation entirely (Date.now compare only, ~1ms). The trade-off is
//     bounded stale visibility — a worker write becomes visible to the next
//     `memory_search` after the TTL elapses (≤1s lag for the canonical
//     cross-session-log-visibility use case the user identified).
//
// Why the dual mode: daemon-side has a long-lived chokidar watcher that pushes
// invalidate events; MCP sidecar processes (one per Claude session) do NOT
// share the daemon's watcher and would otherwise return stale results when
// another process (e.g., a worker session) writes to the memory dir during the
// orchestrator's session lifetime (saga 11 Lesson H NEW).
//
// Thread safety:
//   - Node JS event loop is single-threaded; Map operations are atomic per
//     microtask. A search in flight holds a reference to a cached array
//     (snapshot semantics); an invalidate between the get and the search's
//     downstream use does NOT mutate the held reference — it only swaps the
//     Map entry for subsequent gets. No torn reads.

import { createHash } from 'node:crypto'

import type { CorpusBundle } from './screening.js'
import type { CorpusManifest } from '../memory/CorpusManifest.js'

// Re-export for callers that import the bundle type via the cache module.
export type { CorpusBundle } from './screening.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Freshness TTL in ms — within this window, `checkAndRefresh` skips the
 *  signature computation entirely. Default 1000ms balances cross-session
 *  worker→orchestrator log visibility (≤1s stale lag) with the cost of the
 *  ~450ms recursive signature on the production memory dir.
 *  Visible-for-testing via `setFreshnessTtlForTest`. */
let FRESHNESS_TTL_MS = 1000

/** Visible-for-testing: override the per-call freshness TTL. Returns the
 *  previous value so a test can restore it in `afterEach`. Production code
 *  must never call this. */
export function setFreshnessTtlForTest(ms: number): number {
  const prev = FRESHNESS_TTL_MS
  FRESHNESS_TTL_MS = ms
  return prev
}

/** Derive a stable cache key from a corpus manifest. `undefined` collapses to
 *  the literal `'default'` so callers that omit the manifest share an entry.
 *  Two manifests with the same JSON.stringify representation collapse to the
 *  same key — the property-insertion-order convention in
 *  `getDefaultCorpusManifest()` / `getDefaultPathCCorpusManifest()` makes this
 *  deterministic for production callers. */
export function manifestKey(manifest: CorpusManifest | undefined): string {
  if (!manifest) return 'default'
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------------------
// Types — kept loosely typed (string keys + opaque value generic) so the
// cache module has zero dependency on the concrete shapes of files / headers
// (the thin wrappers in scanMemoryFiles.ts + memorySearch.ts pin those at
// the call sites).
// ---------------------------------------------------------------------------

/** Stats counters surfaced for tests + observability. Never used for routing. */
export type SearchCacheCounters = {
  hits: number
  misses: number
  invalidations: number
}

// ---------------------------------------------------------------------------
// Cache class
// ---------------------------------------------------------------------------

export class MemorySearchCache {
  /** memoryDir → manifestKey → cached value */
  private filesByDir: Map<string, Map<string, unknown>> = new Map()
  /** memoryDir → manifestKey → cached value */
  private headersByDir: Map<string, Map<string, unknown>> = new Map()
  /** memoryDir → corpusShape:manifestKey → bundle */
  private bundlesByDir: Map<string, Map<string, CorpusBundle>> = new Map()
  /** memoryDir → small-disk-read cache (residualIndex, memoryStats, conceptGraph etc.) */
  private blobsByDir: Map<string, Map<string, unknown>> = new Map()
  /** Per-memoryDir generation counter (monotonic, increments on invalidate).
   *  Surfaced so tests can verify invalidation without race-prone retries. */
  private generations: Map<string, number> = new Map()
  /** Set of memoryDirs that have an active watcher (chokidar or polling)
   *  attached via `memoryDirWatcher.attachMemoryDirWatcher`. When attached,
   *  `checkAndRefresh()` is a no-op (the watcher is the freshness source).
   *  Saga 12 dual-mode flag. */
  private watcherAttached: Set<string> = new Set()
  /** Last freshness signature observed by `checkAndRefresh()` per memoryDir.
   *  Compared with the current signature on the next call to decide whether
   *  to invalidate. Cleared by `invalidate()` so a manual invalidate also
   *  resets the per-call check. */
  private lastFreshnessSig: Map<string, string> = new Map()
  /** Wall-clock timestamp (Date.now) of the last `checkAndRefresh` signature
   *  computation per memoryDir. Used by the TTL gate to amortize the
   *  ~450ms recursive signature cost — within `FRESHNESS_TTL_MS` of the last
   *  check, `checkAndRefresh` skips computation. Cleared by `invalidate()`
   *  so a manual invalidate forces the next check to recompute. */
  private lastSigCheckTime: Map<string, number> = new Map()

  /** Total cache hits across all key types. */
  hits = 0
  /** Total cache misses across all key types. */
  misses = 0
  /** Total invalidation events (per memoryDir). */
  invalidations = 0

  /** Get-or-load a `files` entry. `loader` is awaited only on miss. */
  async getFiles<T>(
    memoryDir: string,
    manifestKey: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const perDir = this.filesByDir.get(memoryDir)
    if (perDir) {
      const cached = perDir.get(manifestKey)
      if (cached !== undefined) {
        this.hits++
        return cached as T
      }
    }
    this.misses++
    const value = await loader()
    let pd = this.filesByDir.get(memoryDir)
    if (!pd) {
      pd = new Map()
      this.filesByDir.set(memoryDir, pd)
    }
    pd.set(manifestKey, value as unknown)
    return value
  }

  /** Get-or-load a `headers` entry. Same shape as getFiles for scanMemoryFiles output. */
  async getHeaders<T>(
    memoryDir: string,
    manifestKey: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const perDir = this.headersByDir.get(memoryDir)
    if (perDir) {
      const cached = perDir.get(manifestKey)
      if (cached !== undefined) {
        this.hits++
        return cached as T
      }
    }
    this.misses++
    const value = await loader()
    let pd = this.headersByDir.get(memoryDir)
    if (!pd) {
      pd = new Map()
      this.headersByDir.set(memoryDir, pd)
    }
    pd.set(manifestKey, value as unknown)
    return value
  }

  /** Get-or-build a corpus bundle (pre-tokenized items + BM25 stats).
   *  `builder` is sync — it runs against already-loaded item texts so there's
   *  no async work inside. */
  getBundle(
    memoryDir: string,
    cacheKey: string,
    builder: () => CorpusBundle,
  ): CorpusBundle {
    const perDir = this.bundlesByDir.get(memoryDir)
    if (perDir) {
      const cached = perDir.get(cacheKey)
      if (cached !== undefined) {
        this.hits++
        return cached
      }
    }
    this.misses++
    const value = builder()
    let pd = this.bundlesByDir.get(memoryDir)
    if (!pd) {
      pd = new Map()
      this.bundlesByDir.set(memoryDir, pd)
    }
    pd.set(cacheKey, value)
    return value
  }

  /** Get-or-load a "blob" entry (small disk reads: residualIndex, memoryStats,
   *  conceptGraph etc.). Same get-or-load shape as files/headers; separated
   *  into its own map for clarity. */
  async getBlob<T>(
    memoryDir: string,
    blobKey: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const perDir = this.blobsByDir.get(memoryDir)
    if (perDir) {
      const cached = perDir.get(blobKey)
      if (cached !== undefined) {
        this.hits++
        return cached as T
      }
    }
    this.misses++
    const value = await loader()
    let pd = this.blobsByDir.get(memoryDir)
    if (!pd) {
      pd = new Map()
      this.blobsByDir.set(memoryDir, pd)
    }
    pd.set(blobKey, value as unknown)
    return value
  }

  /** Invalidate all cached entries for `memoryDir`. Pass no arg to clear all
   *  memoryDirs (useful for tests). */
  invalidate(memoryDir?: string): void {
    this.invalidations++
    if (memoryDir === undefined) {
      this.filesByDir.clear()
      this.headersByDir.clear()
      this.bundlesByDir.clear()
      this.blobsByDir.clear()
      this.generations.clear()
      this.lastFreshnessSig.clear()
      this.lastSigCheckTime.clear()
      return
    }
    this.filesByDir.delete(memoryDir)
    this.headersByDir.delete(memoryDir)
    this.bundlesByDir.delete(memoryDir)
    this.blobsByDir.delete(memoryDir)
    this.generations.set(memoryDir, (this.generations.get(memoryDir) ?? 0) + 1)
    this.lastFreshnessSig.delete(memoryDir)
    this.lastSigCheckTime.delete(memoryDir)
  }

  /** Record that a watcher (chokidar or polling) is now attached for
   *  `memoryDir`. After this call, `checkAndRefresh()` is a no-op for this
   *  memoryDir — the watcher is trusted as the freshness source.
   *  Called by `memoryDirWatcher.attachMemoryDirWatcher` after successful
   *  attach. Idempotent. */
  markWatcherAttached(memoryDir: string): void {
    this.watcherAttached.add(memoryDir)
  }

  /** Record that the watcher for `memoryDir` has been detached. After this
   *  call, `checkAndRefresh()` will resume per-call stat-based checks.
   *  Called by `memoryDirWatcher.detachMemoryDirWatcher`. Idempotent. */
  markWatcherDetached(memoryDir: string): void {
    this.watcherAttached.delete(memoryDir)
  }

  /** Visible-for-testing + observability: whether `memoryDir` has a watcher
   *  attached. */
  hasWatcherAttached(memoryDir: string): boolean {
    return this.watcherAttached.has(memoryDir)
  }

  /** Per-call freshness check (saga 12 (d), MCP sidecar process freshness fix).
   *  When no watcher is attached for `memoryDir`, computes a fresh signature
   *  via the injected `computeSignature` fn and invalidates the cache if the
   *  signature has changed since the last check. No-op when a watcher is
   *  attached OR when the last check was within `FRESHNESS_TTL_MS` (TTL gate
   *  added in saga 12 revB after Codex r1 P1 #1 finding — empirical
   *  recursiveSignature cost on the production memory dir is ~450ms, far
   *  beyond the original 10-30ms estimate).
   *
   *  Cost when no watcher attached:
   *    - Within TTL window: ~1ms (Date.now compare only, no signature work).
   *    - After TTL elapses: ~450ms recursive readdir+stat (signature work).
   *  For a typical MCP session with multiple searches in a row, the first
   *  call pays the full cost, subsequent calls within TTL are nearly free.
   *  Stale lag bounded by `FRESHNESS_TTL_MS` (1s default).
   *
   *  First-call semantics: records the current signature without invalidating
   *  — no prior state to compare against, and the first search call already
   *  populates the cache fresh.
   *
   *  @param memoryDir         absolute path to the memory dir
   *  @param computeSignature  fn that returns a string signature of the
   *                           current memory dir state. Injected (rather than
   *                           imported here) to avoid a circular import with
   *                           `memoryDirWatcher.ts`. */
  async checkAndRefresh(
    memoryDir: string,
    computeSignature: () => Promise<string>,
  ): Promise<void> {
    if (this.watcherAttached.has(memoryDir)) return

    // TTL gate: skip the (expensive) signature computation if a recent check
    // already happened. Bounded stale lag = `FRESHNESS_TTL_MS`.
    const now = Date.now()
    const lastCheck = this.lastSigCheckTime.get(memoryDir)
    if (lastCheck !== undefined && now - lastCheck < FRESHNESS_TTL_MS) return
    this.lastSigCheckTime.set(memoryDir, now)

    const currentSig = await computeSignature()
    const lastSig = this.lastFreshnessSig.get(memoryDir)
    if (lastSig === undefined) {
      // First call for this memoryDir — record the signature but don't
      // invalidate (no prior cache state to drop).
      this.lastFreshnessSig.set(memoryDir, currentSig)
      return
    }
    if (currentSig !== lastSig) {
      this.invalidate(memoryDir)
      // `invalidate(memoryDir)` clears the last signature + TTL state too;
      // reseat the signature to the freshly observed value so the next call
      // doesn't double-invalidate. (lastSigCheckTime is intentionally left
      // cleared so the next call recomputes — invalidate is an explicit
      // freshness signal.)
      this.lastFreshnessSig.set(memoryDir, currentSig)
    }
  }

  /** Monotonic generation counter for `memoryDir`. Tests use this to assert
   *  that an invalidate actually happened (race-free). Starts at 0. */
  getGeneration(memoryDir: string): number {
    return this.generations.get(memoryDir) ?? 0
  }

  /** Counters snapshot. */
  counters(): SearchCacheCounters {
    return { hits: this.hits, misses: this.misses, invalidations: this.invalidations }
  }
}

// ---------------------------------------------------------------------------
// Singleton + factory
// ---------------------------------------------------------------------------

let _defaultCache: MemorySearchCache | null = null

/** Get the process-wide search cache. Lazily constructed. */
export function getDefaultSearchCache(): MemorySearchCache {
  if (!_defaultCache) _defaultCache = new MemorySearchCache()
  return _defaultCache
}

/** Reset the process-wide cache (testing only). After this call, the next
 *  `getDefaultSearchCache()` returns a fresh instance. */
export function resetDefaultSearchCache(): void {
  _defaultCache = null
}
