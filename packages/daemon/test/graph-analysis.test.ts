import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  computeDirectLinkEdges,
  computeSourceOverlapEdges,
  computeAdamicAdarEdges,
  combineWeightedEdges,
  buildWeightedGraph,
  louvain,
  summarizeCommunities,
  analyzeTopicForSplit,
  analyzeMemoryGraph,
  DEFAULT_SIGNAL_WEIGHTS,
} from '../../extracted/memory/graphAnalysis.js'
import type { ResidualEntry } from '../../extracted/memory/residualIndex.js'
import type { ConceptGraph } from '../../extracted/memory/conceptGraph.js'

function makeEntry(overrides: Partial<ResidualEntry> = {}): ResidualEntry {
  return {
    id: overrides.id ?? 't_1',
    topic: overrides.topic ?? 't',
    summary: overrides.summary ?? '',
    sources: overrides.sources ?? [],
    concepts: overrides.concepts ?? [],
    updated: overrides.updated ?? '2026-04-21',
    confidence: overrides.confidence ?? 1,
  }
}

const emptyGraph: ConceptGraph = { version: 1, concepts: {} }

// ---------------------------------------------------------------------------
// Signal computation
// ---------------------------------------------------------------------------

describe('computeDirectLinkEdges', () => {
  it('creates undirected edges between concept pairs in an entry', () => {
    const entries = [makeEntry({ concepts: ['a', 'b', 'c'] })]
    const edges = computeDirectLinkEdges(entries)
    expect(edges.get('a')?.get('b')).toBe(1)
    expect(edges.get('b')?.get('a')).toBe(1)
    expect(edges.get('a')?.get('c')).toBe(1)
    expect(edges.get('c')?.get('a')).toBe(1)
  })

  it('accumulates weight across multiple entries', () => {
    const entries = [
      makeEntry({ id: '1', concepts: ['a', 'b'] }),
      makeEntry({ id: '2', concepts: ['a', 'b', 'c'] }),
    ]
    const edges = computeDirectLinkEdges(entries)
    expect(edges.get('a')?.get('b')).toBe(2)
  })

  it('is case-insensitive', () => {
    const entries = [makeEntry({ concepts: ['Bun', 'NPM'] })]
    const edges = computeDirectLinkEdges(entries)
    expect(edges.get('bun')?.get('npm')).toBe(1)
  })
})

describe('computeSourceOverlapEdges', () => {
  it('links concepts via shared sources even in different entries', () => {
    const entries = [
      makeEntry({ id: '1', concepts: ['a'], sources: ['file.md:L10'] }),
      makeEntry({ id: '2', concepts: ['b'], sources: ['file.md:L20'] }),
    ]
    const edges = computeSourceOverlapEdges(entries)
    // Both entries cite file.md → a and b get linked
    expect(edges.get('a')?.get('b')).toBe(1)
  })

  it('ignores line numbers when matching source files', () => {
    const entries = [
      makeEntry({ id: '1', concepts: ['x'], sources: ['log.md:L1'] }),
      makeEntry({ id: '2', concepts: ['y'], sources: ['log.md:L999'] }),
    ]
    const edges = computeSourceOverlapEdges(entries)
    expect(edges.get('x')?.get('y')).toBe(1)
  })
})

describe('computeAdamicAdarEdges', () => {
  it('boosts pairs sharing rare neighbors more than common ones', () => {
    // Graph: a-b, a-c, x-b, x-c, y-c
    // b is shared by {a, x} (deg 2), c is shared by {a, x, y} (deg 3)
    // AA(a,x) via shared b = 1/log(3), via shared c = 1/log(4)
    const base = new Map<string, Map<string, number>>()
    const add = (u: string, v: string) => {
      const mu = base.get(u) ?? new Map()
      mu.set(v, 1)
      base.set(u, mu)
      const mv = base.get(v) ?? new Map()
      mv.set(u, 1)
      base.set(v, mv)
    }
    add('a', 'b'); add('a', 'c'); add('x', 'b'); add('x', 'c'); add('y', 'c')

    const aa = computeAdamicAdarEdges(base)
    const aaAx = aa.get('a')?.get('x') ?? 0
    expect(aaAx).toBeGreaterThan(0)
    // b contributes 1/log(3), c contributes 1/log(4)
    expect(aaAx).toBeCloseTo(1 / Math.log(3) + 1 / Math.log(4), 5)
  })
})

describe('combineWeightedEdges', () => {
  it('sums weighted contributions across signals', () => {
    const direct = new Map([['a', new Map([['b', 1]])], ['b', new Map([['a', 1]])]])
    const source = new Map([['a', new Map([['b', 2]])], ['b', new Map([['a', 2]])]])
    const empty = new Map()
    const combined = combineWeightedEdges(direct, source, empty, empty, DEFAULT_SIGNAL_WEIGHTS)
    // 3.0*1 (direct) + 4.0*2 (source) = 11
    expect(combined.get('a')?.get('b')).toBe(11)
  })
})

// ---------------------------------------------------------------------------
// Louvain
// ---------------------------------------------------------------------------

describe('louvain', () => {
  it('returns empty map for empty graph', () => {
    expect(louvain(new Map()).size).toBe(0)
  })

  it('places strongly-connected cliques in the same community', () => {
    // Two triangles {a,b,c} and {x,y,z} connected only by a weak a-x edge
    const edges = new Map<string, Map<string, number>>()
    const add = (u: string, v: string, w: number) => {
      const mu = edges.get(u) ?? new Map()
      mu.set(v, w)
      edges.set(u, mu)
    }
    // Triangle 1
    for (const [u, v] of [['a', 'b'], ['b', 'c'], ['a', 'c']]) {
      add(u, v, 10); add(v, u, 10)
    }
    // Triangle 2
    for (const [u, v] of [['x', 'y'], ['y', 'z'], ['x', 'z']]) {
      add(u, v, 10); add(v, u, 10)
    }
    // Weak bridge
    add('a', 'x', 1); add('x', 'a', 1)

    const assignment = louvain(edges)
    // a, b, c should all be in the same community
    const ca = assignment.get('a')
    const cb = assignment.get('b')
    const cc = assignment.get('c')
    const cx = assignment.get('x')
    expect(ca).toBeDefined()
    expect(ca).toBe(cb)
    expect(ca).toBe(cc)
    // x, y, z should be in a different community
    expect(cx).not.toBe(ca)
  })

  it('produces at least one community for a connected graph', () => {
    const edges = new Map<string, Map<string, number>>()
    edges.set('a', new Map([['b', 1]]))
    edges.set('b', new Map([['a', 1]]))
    const assignment = louvain(edges)
    const uniqueCommunities = new Set(assignment.values())
    expect(uniqueCommunities.size).toBeGreaterThanOrEqual(1)
    expect(uniqueCommunities.size).toBeLessThanOrEqual(2)
  })
})

describe('summarizeCommunities', () => {
  it('computes intra/cross weights and cohesion', () => {
    const edges = new Map<string, Map<string, number>>()
    // Community 0: a-b-c (intra=3, cross=1)
    // Community 1: x-y (intra=2, cross=1)
    // Bridge: c-x (cross 1 for each community)
    const set = (u: string, v: string, w: number) => {
      for (const [p, q] of [[u, v], [v, u]]) {
        const m = edges.get(p) ?? new Map()
        m.set(q, w)
        edges.set(p, m)
      }
    }
    set('a', 'b', 1); set('b', 'c', 1); set('a', 'c', 1); set('x', 'y', 2)
    set('c', 'x', 1)

    const assignment = new Map([
      ['a', 0], ['b', 0], ['c', 0], ['x', 1], ['y', 1],
    ])
    const communities = summarizeCommunities(assignment, edges)
    expect(communities.length).toBe(2)
    const c0 = communities.find(c => c.id === 0)!
    expect(c0.intraWeight).toBe(3)
    expect(c0.crossWeight).toBe(1)
    expect(c0.cohesion).toBeCloseTo(3 / 4, 5)
  })
})

// ---------------------------------------------------------------------------
// Topic split analysis
// ---------------------------------------------------------------------------

describe('analyzeTopicForSplit', () => {
  it('does not propose split for small topics', () => {
    const entries = [
      makeEntry({ id: 'a', concepts: ['x'] }),
      makeEntry({ id: 'b', concepts: ['y'] }),
    ]
    const c2c = new Map([['x', 0], ['y', 1]])
    const p = analyzeTopicForSplit('small', entries, c2c)
    expect(p.shouldSplit).toBe(false)
  })

  it('proposes split when entries divide into multiple communities', () => {
    // 5 entries, 3 in community 0 via concept x, 2 in community 1 via concept y
    // dominance = 3/5 = 0.6 < 0.7 threshold
    const entries = [
      makeEntry({ id: 'a', concepts: ['x'] }),
      makeEntry({ id: 'b', concepts: ['x'] }),
      makeEntry({ id: 'c', concepts: ['x'] }),
      makeEntry({ id: 'd', concepts: ['y'] }),
      makeEntry({ id: 'e', concepts: ['y'] }),
    ]
    const c2c = new Map([['x', 0], ['y', 1]])
    const p = analyzeTopicForSplit('big', entries, c2c)
    expect(p.shouldSplit).toBe(true)
    expect(p.communityCount).toBe(2)
    expect(p.proposedSubtopics?.length).toBe(2)
  })

  it('does not propose split when one community dominates', () => {
    const entries = [
      ...Array(9).fill(0).map((_, i) => makeEntry({ id: `a_${i}`, concepts: ['x'] })),
      makeEntry({ id: 'b', concepts: ['y'] }),
    ]
    const c2c = new Map([['x', 0], ['y', 1]])
    const p = analyzeTopicForSplit('uniform', entries, c2c)
    expect(p.dominance).toBeCloseTo(0.9, 5)
    expect(p.shouldSplit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// End-to-end analyzeMemoryGraph
// ---------------------------------------------------------------------------

describe('analyzeMemoryGraph', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-graph-'))
    await mkdir(join(dir, 'concepts'), { recursive: true })
    await mkdir(join(dir, 'topics'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns empty analysis when memory is empty', async () => {
    const a = await analyzeMemoryGraph(dir)
    expect(a.splitProposals).toEqual([])
    expect(a.topicsToSplit).toEqual([])
  })

  it('handles array-format index and produces some analysis', async () => {
    const entries = [
      makeEntry({ id: '1', topic: 'mixed', concepts: ['bun', 'npm', 'package-manager'] }),
      makeEntry({ id: '2', topic: 'mixed', concepts: ['bun', 'package-manager'] }),
      makeEntry({ id: '3', topic: 'mixed', concepts: ['vitest', 'testing'] }),
      makeEntry({ id: '4', topic: 'mixed', concepts: ['vitest', 'jest', 'testing'] }),
      makeEntry({ id: '5', topic: 'mixed', concepts: ['testing', 'jest'] }),
    ]
    await writeFile(join(dir, 'index.json'), JSON.stringify(entries))

    const a = await analyzeMemoryGraph(dir)
    expect(a.conceptToCommunity.size).toBeGreaterThan(0)
    // Bun-related concepts should cluster together, testing-related separately
    const bunCommunity = a.conceptToCommunity.get('bun')
    const vitestCommunity = a.conceptToCommunity.get('vitest')
    expect(bunCommunity).toBeDefined()
    expect(vitestCommunity).toBeDefined()
  })
})
