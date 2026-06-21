import { describe, it, expect } from 'vitest'
import {
  computeHitSignal,
  computeCentralitySignal,
  computeNoveltySignal,
  computeDiversitySignal,
  computeRecencySignal,
  computeBridgeSignal,
  computeRetentionScore,
  totalEdgeWeight,
  type RetentionConfig,
} from '../../extracted/memory/retentionScore.js'
import type { ResidualEntry } from '../../extracted/memory/residualIndex.js'

const DEFAULT_CONFIG: RetentionConfig = {
  threshold: 0.40,
  halfLifeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  weights: {
    hit: 1,
    centrality: 1,
    novelty: 1,
    diversity: 1,
    recency: 1,
    bridge: 1,
  },
}

function makeEntry(overrides: Partial<ResidualEntry> = {}): ResidualEntry {
  return {
    id: 'e_1',
    summary: 'test entry',
    sources: ['logs/2026/04/2026-04-01.md:L10'],
    concepts: ['bun', 'package-manager'],
    topic: 'pref',
    updated: '2026-04-22',
    confidence: 1,
    ...overrides,
  }
}

describe('computeHitSignal', () => {
  it('returns 0 for undefined stats', () => {
    expect(computeHitSignal(undefined)).toBe(0)
  })

  it('returns 0 for zero hits', () => {
    expect(computeHitSignal({ hitCount: 0, lastHitAt: 0, penalty: 0 })).toBe(0)
  })

  it('saturates near 1 at many hits', () => {
    const sig = computeHitSignal({ hitCount: 31, lastHitAt: 0, penalty: 0 })
    expect(sig).toBeGreaterThan(0.99)
  })

  it('reduces score by penalty', () => {
    const full = computeHitSignal({ hitCount: 10, lastHitAt: 0, penalty: 0 })
    const half = computeHitSignal({ hitCount: 10, lastHitAt: 0, penalty: 0.5 })
    expect(half).toBeLessThan(full)
    expect(half).toBeCloseTo(full * 0.5, 3)
  })
})

describe('computeCentralitySignal', () => {
  it('returns 0 for empty graph', () => {
    const sig = computeCentralitySignal(makeEntry(), new Map(), 0)
    expect(sig).toBe(0)
  })

  it('increases with neighbor edge weight', () => {
    const edges = new Map([
      ['bun', new Map([['npm', 5], ['pnpm', 3]])],
      ['npm', new Map([['bun', 5]])],
      ['pnpm', new Map([['bun', 3]])],
    ])
    const total = totalEdgeWeight(edges) // 5+3+5+3 = 16
    const sig = computeCentralitySignal(
      makeEntry({ concepts: ['bun'] }),
      edges,
      total,
    )
    // bun participates in 8 edge-weight units; frac = 8/2/16 = 0.25; scaled x10 → 1.0
    expect(sig).toBeCloseTo(1, 2)
  })
})

describe('computeNoveltySignal', () => {
  it('returns 1.0 for singleton topic', () => {
    expect(computeNoveltySignal(makeEntry(), [makeEntry()])).toBe(1)
  })

  it('scores near 0 for exact duplicate text', () => {
    const a = makeEntry({ id: 'a', summary: 'bun is faster than npm', concepts: ['bun', 'npm'] })
    const b = makeEntry({ id: 'b', summary: 'bun is faster than npm', concepts: ['bun', 'npm'] })
    const sig = computeNoveltySignal(a, [a, b])
    expect(sig).toBeLessThan(0.2)
  })

  it('scores high for disjoint vocabulary', () => {
    const a = makeEntry({ id: 'a', summary: 'bun package manager', concepts: ['bun'] })
    const b = makeEntry({ id: 'b', summary: 'postgres database schema', concepts: ['postgres'] })
    const sig = computeNoveltySignal(a, [a, b])
    expect(sig).toBeGreaterThan(0.7)
  })
})

describe('computeDiversitySignal', () => {
  it('returns 0.2 for one source', () => {
    expect(computeDiversitySignal(makeEntry({
      sources: ['logs/2026/04/2026-04-01.md:L10'],
    }))).toBe(0.2)
  })

  it('saturates at 1.0 for 5+ distinct files', () => {
    const sources = Array.from({ length: 5 }, (_, i) =>
      `logs/2026/04/2026-04-${String(i + 1).padStart(2, '0')}.md:L1`)
    expect(computeDiversitySignal(makeEntry({ sources }))).toBe(1)
  })

  it('deduplicates line refs to same file', () => {
    const sources = ['a.md:L1', 'a.md:L5', 'a.md:L10']
    expect(computeDiversitySignal(makeEntry({ sources }))).toBe(0.2)
  })
})

describe('computeRecencySignal', () => {
  it('returns 1 for now', () => {
    const now = Date.parse('2026-04-22T00:00:00Z')
    const sig = computeRecencySignal(
      makeEntry({ updated: '2026-04-22' }),
      now,
      30 * 24 * 60 * 60 * 1000,
    )
    expect(sig).toBeCloseTo(1, 3)
  })

  it('returns 0.5 at one half-life', () => {
    const halfLife = 30 * 24 * 60 * 60 * 1000
    const now = Date.parse('2026-05-22T00:00:00Z')
    const sig = computeRecencySignal(
      makeEntry({ updated: '2026-04-22' }),
      now,
      halfLife,
    )
    expect(sig).toBeCloseTo(0.5, 1)
  })

  it('returns 0.5 for unparseable date', () => {
    expect(computeRecencySignal(
      makeEntry({ updated: 'not-a-date' }),
      Date.now(),
      1000,
    )).toBe(0.5)
  })
})

describe('computeBridgeSignal', () => {
  it('returns 0 for single community', () => {
    const map = new Map([['bun', 1], ['npm', 1]])
    expect(computeBridgeSignal(
      makeEntry({ concepts: ['bun', 'npm'] }),
      map,
    )).toBe(0)
  })

  it('returns 1 for concepts across ≥2 communities', () => {
    const map = new Map([['bun', 1], ['postgres', 2]])
    expect(computeBridgeSignal(
      makeEntry({ concepts: ['bun', 'postgres'] }),
      map,
    )).toBe(1)
  })
})

describe('computeRetentionScore', () => {
  it('protects bridge entries regardless of low score', () => {
    const entry = makeEntry({ concepts: ['bun', 'postgres'] })
    const result = computeRetentionScore(entry, {
      stats: { hitCount: 0, lastHitAt: 0, penalty: 0 },
      weightedEdges: new Map(),
      totalEdgeWeight: 0,
      conceptToCommunity: new Map([['bun', 1], ['postgres', 2]]),
      sameTopicEntries: [entry],
      now: Date.now(),
      config: { ...DEFAULT_CONFIG, threshold: 0.95 },
    })
    expect(result.isBridge).toBe(true)
    expect(result.passes).toBe(true)
  })

  it('rejects low-score non-bridge entries', () => {
    const entry = makeEntry({
      concepts: ['obscure'],
      updated: '2020-01-01', // very old
      sources: ['logs/single.md:L1'],
    })
    const result = computeRetentionScore(entry, {
      stats: undefined,
      weightedEdges: new Map(),
      totalEdgeWeight: 0,
      conceptToCommunity: new Map(),
      sameTopicEntries: [entry],
      now: Date.now(),
      config: DEFAULT_CONFIG,
    })
    expect(result.isBridge).toBe(false)
    expect(result.passes).toBe(false)
    expect(result.score).toBeLessThan(DEFAULT_CONFIG.threshold)
  })

  it('handles zero-weight config gracefully', () => {
    const entry = makeEntry()
    const result = computeRetentionScore(entry, {
      stats: undefined,
      weightedEdges: new Map(),
      totalEdgeWeight: 0,
      conceptToCommunity: new Map(),
      sameTopicEntries: [entry],
      now: Date.now(),
      config: {
        ...DEFAULT_CONFIG,
        weights: { hit: 0, centrality: 0, novelty: 0, diversity: 0, recency: 0, bridge: 0 },
      },
    })
    expect(result.score).toBe(0)
  })

  it('all signals in [0, 1]', () => {
    const entry = makeEntry()
    const result = computeRetentionScore(entry, {
      stats: { hitCount: 100, lastHitAt: 0, penalty: 0 },
      weightedEdges: new Map([['bun', new Map([['npm', 5]])]]),
      totalEdgeWeight: 5,
      conceptToCommunity: new Map([['bun', 1]]),
      sameTopicEntries: [entry],
      now: Date.now(),
      config: DEFAULT_CONFIG,
    })
    for (const v of Object.values(result.signals)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(1)
  })
})

describe('totalEdgeWeight', () => {
  it('sums all edge weights (double-counted as expected)', () => {
    const edges = new Map([
      ['a', new Map([['b', 3]])],
      ['b', new Map([['a', 3]])],
    ])
    expect(totalEdgeWeight(edges)).toBe(6)
  })

  it('returns 0 for empty', () => {
    expect(totalEdgeWeight(new Map())).toBe(0)
  })
})
