// MemoryRetrievalEngine — Phase H-1 contract self-test.
//
// Asserts the engine instantiates, the 5 stages are pluggable, the Zod
// schemas validate, the default strategies preserve back-compat with the
// existing screening pipeline, and the empty-query short-circuit returns
// a well-formed empty RetrievalResult without invoking the gate.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryRetrievalEngine,
  DefaultBm25ScreeningGate,
  NoopScoreStrategy,
  TopicPathFuseStrategy,
  PipelineEventObserver,
  RetrievalOptionsSchema,
  RetrievalCandidateSchema,
  RetrievalResultSchema,
  type RetrievalCandidate,
  type GateStrategy,
  getDefaultEngine,
} from '../../extracted/memory/MemoryRetrievalEngine.js'

function makeTempMemoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-test-'))
  // Minimal corpus: 1 topic file + 1 residual index entry pointing to it
  mkdirSync(join(dir, 'topics'), { recursive: true })
  writeFileSync(
    join(dir, 'topics/architecture.md'),
    '# architecture\n\nrelvetia daemon multi-resolution screening pipeline.\n',
  )
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'architecture_test_001': {
          id: 'architecture_test_001',
          topic: 'architecture',
          summary: 'relvetia daemon multi-resolution screening pipeline',
          sources: ['topics/architecture.md:L1'],
          concepts: ['daemon', 'screening', 'multi-resolution'],
          addedAt: '2026-05-19T09:00:00.000Z',
          confidence: 1,
        },
      },
    }),
  )
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({ version: 1, entries: {} }))
  return dir
}

describe('MemoryRetrievalEngine — Phase H-1 contract', () => {
  it('instantiates with default strategies', () => {
    const engine = new MemoryRetrievalEngine()
    expect(engine.gate).toBeInstanceOf(DefaultBm25ScreeningGate)
    expect(engine.scorer).toBeInstanceOf(NoopScoreStrategy)
    expect(engine.fuser).toBeInstanceOf(TopicPathFuseStrategy)
    expect(engine.observer).toBeInstanceOf(PipelineEventObserver)
  })

  it('accepts injected strategies (strategy plug points)', () => {
    const stubGate: GateStrategy = {
      name: 'stub-gate',
      async gate() { return [] },
    }
    const engine = new MemoryRetrievalEngine({ gate: stubGate })
    expect(engine.gate).toBe(stubGate)
    expect(engine.gate.name).toBe('stub-gate')
  })

  it('RetrievalOptionsSchema applies Codex P0-1 defaults', () => {
    const parsed = RetrievalOptionsSchema.parse({})
    // Default mode is the tool path (preserves MemorySearchTool semantics).
    expect(parsed.mode).toBe('tool')
    // Default sort is raw — Codex P0-1 fix means popularity is opt-in.
    expect(parsed.sortBy).toBe('raw')
    // observe defaults to false — Codex P1-1 verifier-path philosophy.
    expect(parsed.observe).toBe(false)
    expect(parsed.maxResults).toBe(10)
  })

  it('empty query short-circuits without invoking gate', async () => {
    let gateCalls = 0
    const stubGate: GateStrategy = {
      name: 'count-gate',
      async gate() { gateCalls++; return [] },
    }
    const engine = new MemoryRetrievalEngine({ gate: stubGate })
    const result = await engine.retrieve('/nonexistent', '   ')
    expect(gateCalls).toBe(0)
    expect(result.hits).toHaveLength(0)
    expect(result.diagnostics.totalCandidates).toBe(0)
  })

  it('TopicPathFuseStrategy dedupes by topicPath keeping max score + merging entryIds', () => {
    const fuser = new TopicPathFuseStrategy()
    const a: RetrievalCandidate = {
      topicPath: 'topics/architecture.md',
      filePath: '/m/topics/architecture.md',
      entryIds: ['arch_a'],
      rawRelevanceScore: 1.5,
      usageAdjustedScore: 1.5,
      source: 'entry-bm25',
      concepts: ['daemon'],
      snippet: 'a',
    }
    const b: RetrievalCandidate = {
      ...a,
      entryIds: ['arch_b'],
      rawRelevanceScore: 2.7, // higher
      usageAdjustedScore: 2.7,
      concepts: ['screening'],
    }
    const out = fuser.fuse([a, b])
    expect(out).toHaveLength(1)
    expect(out[0]!.rawRelevanceScore).toBe(2.7)
    expect(out[0]!.entryIds.sort()).toEqual(['arch_a', 'arch_b'])
    expect(out[0]!.concepts.sort()).toEqual(['daemon', 'screening'])
  })

  it('retrieve produces a Zod-valid RetrievalResult on a minimal corpus', async () => {
    const dir = makeTempMemoryDir()
    try {
      const engine = new MemoryRetrievalEngine()
      const result = await engine.retrieve(dir, 'relvetia daemon screening')
      const parsed = RetrievalResultSchema.parse(result)
      expect(parsed.diagnostics.mode).toBe('tool')
      expect(parsed.diagnostics.sortBy).toBe('raw')
      // Min corpus should produce at least one hit.
      expect(parsed.hits.length).toBeGreaterThan(0)
      // Each hit validates against RetrievalCandidateSchema.
      for (const hit of parsed.hits) RetrievalCandidateSchema.parse(hit)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sortBy: usage keeps the legacy popularity-weighted ordering reachable', async () => {
    // Stub gate with two candidates: one wins on raw, the other on usage.
    const stubGate: GateStrategy = {
      name: 'stub-gate',
      async gate() {
        return [
          {
            topicPath: 'topics/low-raw-high-usage.md',
            filePath: '/m/topics/low-raw-high-usage.md',
            entryIds: [],
            rawRelevanceScore: 1.0,
            usageAdjustedScore: 5.0,
            source: 'entry-bm25',
            concepts: [],
            snippet: '',
          },
          {
            topicPath: 'topics/high-raw-low-usage.md',
            filePath: '/m/topics/high-raw-low-usage.md',
            entryIds: [],
            rawRelevanceScore: 3.0,
            usageAdjustedScore: 3.0,
            source: 'entry-bm25',
            concepts: [],
            snippet: '',
          },
        ]
      },
    }
    const engine = new MemoryRetrievalEngine({ gate: stubGate })
    const raw = await engine.retrieve('/m', 'q', { sortBy: 'raw' })
    expect(raw.hits[0]!.topicPath).toBe('topics/high-raw-low-usage.md')
    const usage = await engine.retrieve('/m', 'q', { sortBy: 'usage' })
    expect(usage.hits[0]!.topicPath).toBe('topics/low-raw-high-usage.md')
  })

  it('getDefaultEngine returns a stable singleton', () => {
    const a = getDefaultEngine()
    const b = getDefaultEngine()
    expect(a).toBe(b)
  })
})
