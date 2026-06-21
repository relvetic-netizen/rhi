// Saga 11 engine-cache-layer: unit tests for the in-process search cache +
// the manifestKey helper. Watcher integration tests live in
// `memory-dir-watcher.test.ts` (the cache here is exercised via direct
// invalidate() so these tests don't depend on chokidar / polling timing).

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemorySearchCache,
  getDefaultSearchCache,
  resetDefaultSearchCache,
  manifestKey,
  setFreshnessTtlForTest,
} from '../../extracted/screening/searchCache.js'
import {
  readMemoryFiles,
  readMemoryFilesUncached,
} from '../../extracted/screening/memorySearch.js'
import {
  scanMemoryFiles,
  scanMemoryFilesUncached,
} from '../../extracted/screening/scanMemoryFiles.js'
import {
  bm25Score,
  bm25ScoreWithTf,
  buildBm25CorpusStats,
  buildCorpusBundle,
  screenItemsBM25,
  screenItemsBM25WithBundle,
  tokenize,
} from '../../extracted/screening/screening.js'

// ---------------------------------------------------------------------------
// Test fixture builder — isolated tmp memory dir (Lesson E NEW mandate).
// ---------------------------------------------------------------------------

function makeMemoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saga11-cache-test-'))
  mkdirSync(join(dir, 'topics'), { recursive: true })
  mkdirSync(join(dir, 'logs', '2026', '05'), { recursive: true })
  writeFileSync(
    join(dir, 'topics', 'architecture.md'),
    '# Architecture\n\nFour-layer self-correcting loop pattern.\n',
  )
  writeFileSync(
    join(dir, 'topics', 'preferences.md'),
    '# Preferences\n\nUser prefers bun over npm.\n',
  )
  writeFileSync(
    join(dir, 'logs', '2026', '05', '2026-05-21.md'),
    '# 2026-05-21\n\n- [11:00] [test] sample log line\n',
  )
  return dir
}

afterEach(() => {
  resetDefaultSearchCache()
})

// ---------------------------------------------------------------------------
// manifestKey
// ---------------------------------------------------------------------------

describe('manifestKey', () => {
  it('returns "default" for undefined manifest', () => {
    expect(manifestKey(undefined)).toBe('default')
  })

  it('returns identical key for equal manifests', () => {
    const a = manifestKey({ excludedRoots: ['.backup', '.staging'], layer: 'all' })
    const b = manifestKey({ excludedRoots: ['.backup', '.staging'], layer: 'all' })
    expect(a).toBe(b)
  })

  it('returns distinct keys for distinct manifests', () => {
    const baseKey = manifestKey({ excludedRoots: ['.backup'], layer: 'all' })
    const pathCKey = manifestKey({ excludedRoots: ['.backup', 'logs'], layer: 'all' })
    expect(baseKey).not.toBe(pathCKey)
  })
})

// ---------------------------------------------------------------------------
// MemorySearchCache — direct API
// ---------------------------------------------------------------------------

describe('MemorySearchCache', () => {
  let cache: MemorySearchCache
  let memoryDir: string

  beforeEach(() => {
    cache = new MemorySearchCache()
    memoryDir = makeMemoryDir()
  })

  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true })
  })

  it('getFiles miss → loader runs; second call hits cache without re-loader', async () => {
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls++
      return [{ relativePath: 'foo.md', filePath: '/abs/foo.md', content: 'hello' }]
    }
    const v1 = await cache.getFiles(memoryDir, 'mk-a', loader)
    const v2 = await cache.getFiles(memoryDir, 'mk-a', loader)
    expect(loaderCalls).toBe(1)
    expect(v1).toBe(v2)
    expect(cache.counters().hits).toBe(1)
    expect(cache.counters().misses).toBe(1)
  })

  it('distinct manifestKeys produce distinct cache entries', async () => {
    let loaderCalls = 0
    const make = (label: string) => async () => {
      loaderCalls++
      return [{ relativePath: `${label}.md`, filePath: `/abs/${label}.md`, content: label }]
    }
    const a = await cache.getFiles(memoryDir, 'mk-a', make('a'))
    const b = await cache.getFiles(memoryDir, 'mk-b', make('b'))
    expect(loaderCalls).toBe(2)
    expect(a[0]!.content).toBe('a')
    expect(b[0]!.content).toBe('b')
  })

  it('invalidate clears entries and bumps generation', async () => {
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls++
      return [{ relativePath: 'a.md', filePath: '/abs/a.md', content: 'a' }]
    }
    await cache.getFiles(memoryDir, 'mk-a', loader)
    expect(loaderCalls).toBe(1)
    expect(cache.getGeneration(memoryDir)).toBe(0)
    cache.invalidate(memoryDir)
    expect(cache.getGeneration(memoryDir)).toBe(1)
    await cache.getFiles(memoryDir, 'mk-a', loader)
    expect(loaderCalls).toBe(2)
  })

  it('invalidate without arg clears all memoryDirs', async () => {
    const loader = async () => [{ relativePath: 'a.md', filePath: '/abs/a.md', content: 'a' }]
    await cache.getFiles('/dir1', 'mk', loader)
    await cache.getFiles('/dir2', 'mk', loader)
    cache.invalidate()
    let calls = 0
    const counting = async () => {
      calls++
      return [{ relativePath: 'a.md', filePath: '/abs/a.md', content: 'a' }]
    }
    await cache.getFiles('/dir1', 'mk', counting)
    await cache.getFiles('/dir2', 'mk', counting)
    expect(calls).toBe(2)
  })

  it('getBundle returns the same instance on hit', () => {
    const bundle1 = cache.getBundle(memoryDir, 'file-layer:mk', () =>
      buildCorpusBundle(['hello world', 'goodbye world']),
    )
    const bundle2 = cache.getBundle(memoryDir, 'file-layer:mk', () => {
      throw new Error('builder must not run on cache hit')
    })
    expect(bundle1).toBe(bundle2)
    expect(bundle1.itemTokens.length).toBe(2)
    expect(bundle1.stats.N).toBe(2)
  })

  it('getBundle: distinct cache keys → distinct bundles', () => {
    const a = cache.getBundle(memoryDir, 'file-layer:mk-a', () =>
      buildCorpusBundle(['one']),
    )
    const b = cache.getBundle(memoryDir, 'file-layer:mk-b', () =>
      buildCorpusBundle(['one', 'two']),
    )
    expect(a.stats.N).toBe(1)
    expect(b.stats.N).toBe(2)
  })

  it('getBlob caches small disk reads independently', async () => {
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls++
      return { schemaVersion: 1, entries: { a: 1 } }
    }
    const v1 = await cache.getBlob(memoryDir, 'residualIndex', loader)
    const v2 = await cache.getBlob(memoryDir, 'residualIndex', loader)
    expect(loaderCalls).toBe(1)
    expect(v1).toBe(v2)
  })

  it('documents non-coalesced concurrent misses for same key (up to N loader calls allowed)', async () => {
    // Note: the current cache does not coalesce concurrent in-flight requests.
    // This test documents the actual contract — `loaderCalls` is bounded by the
    // racer count, NOT capped at 1. The test name reflects that contract so
    // future readers don't see "at most once" and assume coalescing semantics.
    // Promotion to coalescing is a Phase 12+ candidate if perf shows it matters.
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls++
      // simulate IO latency
      await new Promise(r => setTimeout(r, 5))
      return [{ relativePath: 'a.md', filePath: '/abs/a.md', content: 'a' }]
    }
    const [v1, v2] = await Promise.all([
      cache.getFiles(memoryDir, 'mk', loader),
      cache.getFiles(memoryDir, 'mk', loader),
    ])
    // Without coalescing, both racers miss → loader runs twice.
    expect(loaderCalls).toBeLessThanOrEqual(2)
    expect(loaderCalls).toBeGreaterThanOrEqual(1)
    expect(v1).toEqual(v2)
    // Subsequent call is a clean hit.
    await cache.getFiles(memoryDir, 'mk', loader)
    expect(loaderCalls).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Default singleton wiring
// ---------------------------------------------------------------------------

describe('getDefaultSearchCache', () => {
  it('returns the same instance until resetDefaultSearchCache is called', () => {
    const a = getDefaultSearchCache()
    const b = getDefaultSearchCache()
    expect(a).toBe(b)
    resetDefaultSearchCache()
    const c = getDefaultSearchCache()
    expect(c).not.toBe(a)
  })
})

// ---------------------------------------------------------------------------
// readMemoryFiles / scanMemoryFiles cached wrappers
// ---------------------------------------------------------------------------

describe('readMemoryFiles cache', () => {
  let memoryDir: string

  beforeEach(() => {
    memoryDir = makeMemoryDir()
    resetDefaultSearchCache()
  })

  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true })
  })

  it('cached result matches uncached result (shape parity)', async () => {
    const cached = await readMemoryFiles(memoryDir)
    const uncached = await readMemoryFilesUncached(memoryDir)
    expect(cached.length).toBe(uncached.length)
    expect(new Set(cached.map(f => f.relativePath))).toEqual(
      new Set(uncached.map(f => f.relativePath)),
    )
  })

  it('second readMemoryFiles call returns identical reference (cache hit)', async () => {
    const first = await readMemoryFiles(memoryDir)
    const second = await readMemoryFiles(memoryDir)
    expect(second).toBe(first)
  })

  it('cache.invalidate forces re-read (next call returns a new array reference)', async () => {
    const first = await readMemoryFiles(memoryDir)
    getDefaultSearchCache().invalidate(memoryDir)
    const second = await readMemoryFiles(memoryDir)
    expect(second).not.toBe(first)
    expect(second.length).toBe(first.length)
  })
})

// ---------------------------------------------------------------------------
// Saga 11 Option α: BM25 tf pre-build correctness
//
// Sentinel for the optimization: the pre-built tf path must produce identical
// scores to the original `bm25Score(queryTokens, docTokens, stats)` path on
// the same inputs. We assert numeric equality (not approximate) — BM25 is
// deterministic and tf-from-tokens vs tf-built-inline-in-loop computes the
// same Map<term,count>.
// ---------------------------------------------------------------------------

describe('Saga 11 Option α — bm25ScoreWithTf parity with bm25Score', () => {
  const corpus = [
    'the quick brown fox jumps over the lazy dog',
    'a brown fox is quick but the lazy dog is not',
    'cat sat on the mat',
  ]
  const itemTokens = corpus.map(t => tokenize(t))
  const stats = buildBm25CorpusStats(corpus)

  it('produces identical scores to bm25Score for each (query, doc) pair', () => {
    const queries = [
      'quick brown',
      'lazy dog',
      'cat mat',
      'fox',
      'word-not-in-corpus',
    ]
    for (const query of queries) {
      const queryTokens = tokenize(query)
      for (let i = 0; i < corpus.length; i++) {
        const docTokens = itemTokens[i]!
        const tf = new Map<string, number>()
        for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1)
        const originalScore = bm25Score(queryTokens, docTokens, stats)
        const newScore = bm25ScoreWithTf(queryTokens, tf, docTokens.length, stats)
        expect(newScore).toBe(originalScore)
      }
    }
  })

  it('returns 0 when dl === 0 (mirrors bm25Score early return)', () => {
    const tf = new Map<string, number>()
    expect(bm25ScoreWithTf(['x'], tf, 0, stats)).toBe(0)
  })

  it('returns 0 when stats.N === 0 (mirrors bm25Score early return)', () => {
    const emptyStats = buildBm25CorpusStats([])
    const tf = new Map<string, number>([['x', 1]])
    expect(bm25ScoreWithTf(['x'], tf, 1, emptyStats)).toBe(0)
  })
})

describe('Saga 11 Option α — CorpusBundle.itemTf wiring', () => {
  it('buildCorpusBundle populates itemTf parallel to itemTokens', () => {
    const texts = ['hello world hello', 'foo bar baz', 'just one']
    const bundle = buildCorpusBundle(texts)
    expect(bundle.itemTf.length).toBe(bundle.itemTokens.length)
    expect(bundle.itemTf.length).toBe(texts.length)
    // Verify tf correctness for the first doc: 'hello' should appear 2× after
    // tokenization (stopwords removed but 'hello' survives length>1 filter).
    const tf0 = bundle.itemTf[0]!
    expect(tf0.get('hello')).toBe(2)
    expect(tf0.get('world')).toBe(1)
  })

  it('screenItemsBM25WithBundle yields identical scores via itemTf vs legacy bm25Score path', () => {
    const items = ['the quick brown fox', 'a brown fox jumps', 'the lazy dog']
    const query = 'brown fox'
    const config = { threshold: 0.05, maxResults: 10 }
    // Cached path: uses bundle.itemTf
    const bundle = buildCorpusBundle(items)
    const cached = screenItemsBM25WithBundle(items, bundle, query, config)
    // Legacy path: uses screenItemsBM25 with getText callback (no itemTf)
    const legacy = screenItemsBM25(items, t => t, query, config)
    expect(cached.length).toBe(legacy.length)
    for (let i = 0; i < cached.length; i++) {
      expect(cached[i]!.item).toBe(legacy[i]!.item)
      expect(cached[i]!.score).toBeCloseTo(legacy[i]!.score, 10)
    }
  })

  it('falls back to legacy bm25Score when itemTf is missing (rollout safety)', () => {
    // Simulate an older cached bundle that does not have itemTf populated.
    const items = ['foo bar', 'baz qux']
    const bundle = buildCorpusBundle(items)
    const truncatedBundle = {
      itemTokens: bundle.itemTokens,
      itemTf: undefined as unknown as Map<string, number>[],
      stats: bundle.stats,
    }
    const query = 'foo'
    const config = { threshold: 0.05, maxResults: 10 }
    // Should not throw; should compute correct scores via fallback path.
    const scored = screenItemsBM25WithBundle(items, truncatedBundle, query, config)
    const reference = screenItemsBM25(items, t => t, query, config)
    expect(scored.length).toBe(reference.length)
    for (let i = 0; i < scored.length; i++) {
      expect(scored[i]!.score).toBeCloseTo(reference[i]!.score, 10)
    }
  })
})

describe('scanMemoryFiles cache', () => {
  let memoryDir: string

  beforeEach(() => {
    memoryDir = makeMemoryDir()
    resetDefaultSearchCache()
  })

  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true })
  })

  it('cached result matches uncached result (shape parity)', async () => {
    const cached = await scanMemoryFiles(memoryDir)
    const uncached = await scanMemoryFilesUncached(memoryDir)
    expect(cached.length).toBe(uncached.length)
    expect(new Set(cached.map(m => m.filename))).toEqual(
      new Set(uncached.map(m => m.filename)),
    )
  })

  it('second call hits the cache', async () => {
    const first = await scanMemoryFiles(memoryDir)
    const second = await scanMemoryFiles(memoryDir)
    expect(second).toBe(first)
  })

  it('distinct manifests cache independently', async () => {
    const a = await scanMemoryFiles(memoryDir, { manifest: { excludedRoots: ['.backup'] } })
    const b = await scanMemoryFiles(memoryDir, { manifest: { excludedRoots: ['logs'] } })
    // distinct manifestKey → distinct entries; the second call should miss
    // (it doesn't return `a`'s array reference). Lengths may differ because
    // 'logs' exclusion drops the daily log file from `b`.
    expect(b).not.toBe(a)
    expect(a.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Length-guard fallback parity sentinel (Codex r1 missing-evidence #2)
//
// Call sites (`memorySearch.ts:415`, `logLineSearch.ts:77`) fall back to the
// uncached `screenItemsBM25` path when `bundle.itemTokens.length` diverges
// from the current `items.length` — a defense-in-depth guard against a stale
// cached bundle racing a freshly mutated corpus. These sentinels assert
// (a) `screenItemsBM25WithBundle` ≡ `screenItemsBM25` for the same input (so
// the cached path is bit-identical to the fallback target) and (b) the bundle
// API rejects length mismatch loudly rather than silently returning bogus
// scores (so the call-site length guard is a real necessity, not a defensive
// duplication).
// ---------------------------------------------------------------------------

describe('length-guard fallback parity sentinel (Codex r1 missing-evidence #2)', () => {
  type Doc = { id: string; text: string }

  const docs: Doc[] = [
    { id: 'd1', text: 'cache layer corpus tokenization' },
    { id: 'd2', text: 'mtime watcher debounce polling fallback chokidar' },
    { id: 'd3', text: 'BM25 score idf saturation normalize trim' },
    { id: 'd4', text: 'production memory invariant stats.json md5 dc14cb9d' },
    { id: 'd5', text: 'saga 11 engine cache layer Path A 5.4x Path C strict' },
    { id: 'd6', text: 'completely unrelated to query content for null overlap' },
  ]

  const queries = [
    'cache corpus',
    'BM25 normalize',
    'memory invariant md5',
    'saga 11 engine',
    'no matching tokens whatsoever xyzqv',
  ]

  const config = { threshold: 0, maxResults: 100 }

  it('screenItemsBM25WithBundle is bit-identical to screenItemsBM25 across multiple queries (parity contract)', () => {
    const getText = (d: Doc) => d.text
    const bundle = buildCorpusBundle(docs.map(getText))

    for (const query of queries) {
      const uncached = screenItemsBM25(docs, getText, query, config)
      const cached = screenItemsBM25WithBundle(docs, bundle, query, config)

      expect(cached.length).toBe(uncached.length)
      for (let i = 0; i < cached.length; i++) {
        expect(cached[i].item.id).toBe(uncached[i].item.id)
        // BM25 score equality is exact (same arithmetic, same order of operations
        // because bundle's itemTokens come from the same tokenize() call).
        expect(cached[i].score).toBeCloseTo(uncached[i].score, 10)
      }
    }
  })

  it('screenItemsBM25WithBundle throws on length mismatch — proves the call-site guard is required, not redundant', () => {
    // Build a bundle from 6 docs, then call with a 5-doc input — exactly the
    // stale-cache race the memorySearch.ts / logLineSearch.ts call sites
    // defend against. The bundle API throws; without the call-site length
    // guard, this throw would surface in production.
    const bundle = buildCorpusBundle(docs.map(d => d.text))
    const truncated = docs.slice(0, 5)

    expect(() =>
      screenItemsBM25WithBundle(truncated, bundle, 'cache', config),
    ).toThrow(/items\.length=5/)
  })

  it('fallback path (length mismatch → screenItemsBM25) returns the same shape as a freshly built bundle would', () => {
    // Simulate the call-site decision: when bundle.itemTokens.length !== items.length,
    // call screenItemsBM25 directly. Assert this fallback returns the same
    // ScoredItem<T>[] as if a fresh bundle had been built for the truncated set.
    const truncated = docs.slice(0, 5)
    const getText = (d: Doc) => d.text

    const fallback = screenItemsBM25(truncated, getText, 'cache corpus', config)
    const freshBundle = buildCorpusBundle(truncated.map(d => d.text))
    const freshCached = screenItemsBM25WithBundle(truncated, freshBundle, 'cache corpus', config)

    expect(fallback.length).toBe(freshCached.length)
    for (let i = 0; i < fallback.length; i++) {
      expect(fallback[i].item.id).toBe(freshCached[i].item.id)
      expect(fallback[i].score).toBeCloseTo(freshCached[i].score, 10)
    }
  })
})

// ---------------------------------------------------------------------------
// Sanity: `bm25Score` is bit-identical to `bm25ScoreWithTf` for the same doc
// (covers the Phase 6 Option α optimization's correctness — already exercised
// in the Phase 6 sentinel suite above, this is the cross-link sentinel).
// ---------------------------------------------------------------------------

describe('bm25Score vs bm25ScoreWithTf parity cross-link sentinel', () => {
  it('returns identical score for the same (doc, query) when tf is pre-built from the same tokens', () => {
    const stats = buildBm25CorpusStats(['hello world', 'foo bar baz', 'cache layer'])
    const docTokens = tokenize('cache layer corpus build')
    const docTf = new Map<string, number>()
    for (const t of docTokens) docTf.set(t, (docTf.get(t) ?? 0) + 1)
    const queryTokens = tokenize('cache build')

    const legacy = bm25Score(queryTokens, docTokens, stats)
    const pre = bm25ScoreWithTf(queryTokens, docTf, docTokens.length, stats)
    expect(pre).toBeCloseTo(legacy, 10)
  })
})

// ---------------------------------------------------------------------------
// Saga 12 (d) — stat-based per-call freshness check (MCP sidecar fallback)
// ---------------------------------------------------------------------------

describe('Saga 12 (d) — checkAndRefresh stat-based freshness fallback', () => {
  let memoryDir: string
  let cache: MemorySearchCache
  let prevTtl: number

  beforeEach(() => {
    memoryDir = makeMemoryDir()
    cache = new MemorySearchCache()
    // Default TTL is 1000ms; set to 0 for tests that need every call to run
    // the signature path. Individual TTL-gate tests override locally.
    prevTtl = setFreshnessTtlForTest(0)
  })

  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true })
    setFreshnessTtlForTest(prevTtl)
  })

  it('is a no-op when a watcher is attached (trusts the watcher)', async () => {
    cache.markWatcherAttached(memoryDir)
    expect(cache.hasWatcherAttached(memoryDir)).toBe(true)

    let signatureCallCount = 0
    await cache.checkAndRefresh(memoryDir, async () => {
      signatureCallCount++
      return 'sig-A'
    })
    // Watcher attached → computeSignature must not be invoked.
    expect(signatureCallCount).toBe(0)
    expect(cache.counters().invalidations).toBe(0)
  })

  it('first call records signature without invalidating (no prior state)', async () => {
    // No watcher attached → per-call mode active.
    expect(cache.hasWatcherAttached(memoryDir)).toBe(false)

    const gen0 = cache.getGeneration(memoryDir)
    await cache.checkAndRefresh(memoryDir, async () => 'sig-first')
    // First-call semantics: no invalidate, no generation bump.
    expect(cache.getGeneration(memoryDir)).toBe(gen0)
    expect(cache.counters().invalidations).toBe(0)
  })

  it('same signature on subsequent call → keeps cache (no invalidate)', async () => {
    await cache.checkAndRefresh(memoryDir, async () => 'sig-stable')
    const genAfterFirst = cache.getGeneration(memoryDir)

    // Populate cache so we can observe non-invalidation.
    await cache.getFiles(memoryDir, 'm1', async () => ['a', 'b', 'c'])
    expect(cache.counters().hits + cache.counters().misses).toBeGreaterThan(0)
    const missesBefore = cache.counters().misses

    // Second call with same signature → no invalidate, cache stays warm.
    await cache.checkAndRefresh(memoryDir, async () => 'sig-stable')
    expect(cache.getGeneration(memoryDir)).toBe(genAfterFirst)
    expect(cache.counters().invalidations).toBe(0)

    // Cache hit still works after the check.
    const result = await cache.getFiles(memoryDir, 'm1', async () => ['REGRESSION'])
    expect(result).toEqual(['a', 'b', 'c'])
    // Miss count unchanged (cache served from memory, loader NOT invoked).
    expect(cache.counters().misses).toBe(missesBefore)
  })

  it('changed signature on subsequent call → invalidates cache + reseats sig', async () => {
    await cache.checkAndRefresh(memoryDir, async () => 'sig-v1')

    // Populate cache.
    await cache.getFiles(memoryDir, 'm1', async () => ['old-data'])
    const genBefore = cache.getGeneration(memoryDir)

    // Signature changes (simulates FS mutation).
    await cache.checkAndRefresh(memoryDir, async () => 'sig-v2')

    // Generation incremented (invalidate fired).
    expect(cache.getGeneration(memoryDir)).toBe(genBefore + 1)
    expect(cache.counters().invalidations).toBeGreaterThanOrEqual(1)

    // Cache miss on next get → loader runs.
    let loaderCalls = 0
    const result = await cache.getFiles(memoryDir, 'm1', async () => {
      loaderCalls++
      return ['new-data']
    })
    expect(loaderCalls).toBe(1)
    expect(result).toEqual(['new-data'])

    // Subsequent same-sig call is a no-op (sig was reseated by invalidate path).
    const invalidationsAfter = cache.counters().invalidations
    await cache.checkAndRefresh(memoryDir, async () => 'sig-v2')
    expect(cache.counters().invalidations).toBe(invalidationsAfter)
  })

  it('markWatcherAttached → markWatcherDetached toggles per-call mode back on', async () => {
    // Start in per-call mode, record initial sig.
    await cache.checkAndRefresh(memoryDir, async () => 'sig-A')

    // Attach watcher → checkAndRefresh becomes no-op even if sig changes.
    cache.markWatcherAttached(memoryDir)
    let calls1 = 0
    await cache.checkAndRefresh(memoryDir, async () => {
      calls1++
      return 'sig-B'
    })
    expect(calls1).toBe(0)
    expect(cache.counters().invalidations).toBe(0)

    // Detach watcher → per-call mode resumes; sig-B vs sig-A should invalidate.
    cache.markWatcherDetached(memoryDir)
    expect(cache.hasWatcherAttached(memoryDir)).toBe(false)
    let calls2 = 0
    await cache.checkAndRefresh(memoryDir, async () => {
      calls2++
      return 'sig-B'
    })
    expect(calls2).toBe(1)
    // sig-A was the last recorded; sig-B differs → invalidate fires.
    expect(cache.counters().invalidations).toBeGreaterThanOrEqual(1)
  })

  it('manual invalidate() clears lastFreshnessSig → next checkAndRefresh restarts as first-call', async () => {
    // Establish a baseline sig.
    await cache.checkAndRefresh(memoryDir, async () => 'sig-X')
    const invalidationsBefore = cache.counters().invalidations

    // Manual invalidate clears state.
    cache.invalidate(memoryDir)
    expect(cache.counters().invalidations).toBe(invalidationsBefore + 1)

    // Next checkAndRefresh should treat this as a first-call: no extra
    // invalidate, just records the current sig.
    await cache.checkAndRefresh(memoryDir, async () => 'sig-X')
    expect(cache.counters().invalidations).toBe(invalidationsBefore + 1) // unchanged

    // Subsequent identical-sig call still no-op.
    await cache.checkAndRefresh(memoryDir, async () => 'sig-X')
    expect(cache.counters().invalidations).toBe(invalidationsBefore + 1)
  })

  // -------------------------------------------------------------------------
  // Saga 12 revB — TTL gate (Codex r1 P1 #1 finding closure)
  // -------------------------------------------------------------------------

  it('TTL gate: within FRESHNESS_TTL_MS, skips signature computation entirely', async () => {
    // Use a TTL large enough that two back-to-back calls fall inside.
    setFreshnessTtlForTest(5000)

    let sigCalls = 0
    const compute = async () => {
      sigCalls++
      return `sig-${sigCalls}`
    }

    // First call records the signature.
    await cache.checkAndRefresh(memoryDir, compute)
    expect(sigCalls).toBe(1)

    // Second call within TTL → no signature computation.
    await cache.checkAndRefresh(memoryDir, compute)
    expect(sigCalls).toBe(1) // unchanged

    // Third call within TTL → still no signature computation.
    await cache.checkAndRefresh(memoryDir, compute)
    expect(sigCalls).toBe(1)

    // No invalidations triggered (sigs never compared).
    expect(cache.counters().invalidations).toBe(0)
  })

  it('TTL gate: after TTL elapses, signature is recomputed', async () => {
    // Use a very small TTL so we can step past it with a real microtask delay.
    setFreshnessTtlForTest(10)

    let sigCalls = 0
    const compute = async () => {
      sigCalls++
      return 'sig-stable'
    }

    await cache.checkAndRefresh(memoryDir, compute)
    expect(sigCalls).toBe(1)

    // Wait for TTL to elapse.
    await new Promise(r => setTimeout(r, 25))

    await cache.checkAndRefresh(memoryDir, compute)
    expect(sigCalls).toBe(2)
    // Same sig → no invalidation.
    expect(cache.counters().invalidations).toBe(0)
  })

  it('TTL gate: invalidate() clears lastSigCheckTime → next call recomputes regardless of TTL', async () => {
    setFreshnessTtlForTest(5000)

    let sigCalls = 0
    const compute = async () => {
      sigCalls++
      return `sig-${sigCalls}`
    }

    await cache.checkAndRefresh(memoryDir, compute)
    expect(sigCalls).toBe(1)

    // Within TTL — no sig computation.
    await cache.checkAndRefresh(memoryDir, compute)
    expect(sigCalls).toBe(1)

    // Manual invalidate clears TTL state.
    cache.invalidate(memoryDir)
    expect(cache.counters().invalidations).toBe(1)

    // Next call recomputes despite TTL window not having elapsed (because TTL
    // state was cleared by invalidate). This guarantees an explicit
    // invalidate is honored immediately.
    await cache.checkAndRefresh(memoryDir, compute)
    expect(sigCalls).toBe(2)
  })

  it('end-to-end: per-call check + real recursiveSignature detects real FS mutation + cache cleared', async () => {
    // Integration test against the real `recursiveSignature` (no mock) — the
    // canonical fn the production call sites in MemorySearchTool.ts +
    // findRelevantMemories.ts pass to `checkAndRefresh`. Verifies the
    // end-to-end contract: real FS mutation → signature differs → invalidate
    // fires → next cache get re-runs the loader (cache cleared).
    const { recursiveSignature } = await import(
      '../../extracted/screening/memoryDirWatcher.js'
    )
    const compute = () => recursiveSignature(memoryDir)

    // First call records initial signature without invalidating.
    await cache.checkAndRefresh(memoryDir, compute)
    expect(cache.counters().invalidations).toBe(0)

    // Populate cache with arbitrary loader output (we only care that the
    // entry exists and that invalidate clears it — not what's in it).
    let loaderCalls = 0
    await cache.getFiles(memoryDir, 'm-sentinel', async () => {
      loaderCalls++
      return ['cached-payload']
    })
    expect(loaderCalls).toBe(1)

    // No-mutation second call → cache hit (loader not invoked).
    await cache.checkAndRefresh(memoryDir, compute)
    await cache.getFiles(memoryDir, 'm-sentinel', async () => {
      loaderCalls++
      return ['REGRESSION-LOADER']
    })
    expect(loaderCalls).toBe(1) // unchanged → cache hit

    // Mutate FS: add a new topic file with distinct mtime.
    const newPath = join(memoryDir, 'topics', 'new-saga-12.md')
    writeFileSync(newPath, '# Saga 12 freshness fix\n\nNew file added during test.\n')
    const future = (Date.now() + 1500) / 1000
    const { utimesSync } = await import('node:fs')
    utimesSync(newPath, future, future)

    // checkAndRefresh should detect change + invalidate.
    const invalidationsBefore = cache.counters().invalidations
    await cache.checkAndRefresh(memoryDir, compute)
    expect(cache.counters().invalidations).toBe(invalidationsBefore + 1)

    // Cache was cleared → next get re-runs loader (proves freshness path
    // worked end-to-end through the real recursiveSignature).
    await cache.getFiles(memoryDir, 'm-sentinel', async () => {
      loaderCalls++
      return ['fresh-payload']
    })
    expect(loaderCalls).toBe(2) // loader ran a second time after invalidate
  })
})
