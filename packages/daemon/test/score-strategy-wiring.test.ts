// Score-strategy entry-point wiring — Phase 3-3 tests
// (memory-search-improvement-loop saga).
//
// Asserts that the `scoreStrategy` option threads through both
// `executeMemorySearch` (Path A / MemorySearchTool) and `findRelevantMemories`
// (Path C). The opt-in surface mirrors the Phase 2 corpus override pattern —
// callers without the option see legacy behavior (NoopScoreStrategy default),
// while benchmark / opt-in callers can inject any ScoreStrategy.
//
// Coverage:
//   - executeMemorySearch with no scoreStrategy → singleton engine path
//     (legacy compat preserved)
//   - executeMemorySearch with injected scoreStrategy → per-call engine
//     uses the injection (counter increments)
//   - findRelevantMemories with no scoreStrategy → singleton engine path
//   - findRelevantMemories with injected scoreStrategy → per-call engine
//     uses the injection (counter increments)
//   - Injected scoreStrategy does NOT leak into subsequent calls without it

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeMemorySearch } from '../../extracted/tools/MemorySearchTool.js'
import { findRelevantMemories } from '../../extracted/screening/findRelevantMemories.js'
import {
  NoopScoreStrategy,
  type RetrievalCandidate,
  type ScoreStrategy,
} from '../../extracted/memory/MemoryRetrievalEngine.js'

function makeTempMemoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phase3-wiring-'))
  mkdirSync(join(dir, 'topics'), { recursive: true })
  writeFileSync(
    join(dir, 'topics/architecture.md'),
    '# architecture\n\nRelvetia daemon multi-resolution screening pipeline.\n',
  )
  writeFileSync(
    join(dir, 'topics/observability.md'),
    '# observability\n\nLogScreeningEvent emits diagnostic JSON to stderr.\n',
  )
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      entries: {
        arch_001: {
          id: 'arch_001',
          topic: 'architecture',
          summary: 'relvetia daemon multi-resolution screening pipeline',
          sources: ['topics/architecture.md:L1'],
          concepts: ['daemon', 'screening', 'multi-resolution'],
          addedAt: '2026-05-19T09:00:00.000Z',
          confidence: 1,
        },
        obs_001: {
          id: 'obs_001',
          topic: 'observability',
          summary: 'logScreeningEvent emits diagnostic JSON',
          sources: ['topics/observability.md:L1'],
          concepts: ['observability', 'logging', 'diagnostic'],
          addedAt: '2026-05-19T09:01:00.000Z',
          confidence: 1,
        },
      },
    }),
  )
  writeFileSync(
    join(dir, 'stats.json'),
    JSON.stringify({ version: 1, entries: {} }),
  )
  return dir
}

class CountingScoreStrategy implements ScoreStrategy {
  readonly name = 'counting-score'
  scoreCalls = 0
  async score(candidates: RetrievalCandidate[]): Promise<RetrievalCandidate[]> {
    this.scoreCalls++
    return candidates
  }
}

describe('Phase 3-3 entry-point wiring — executeMemorySearch', () => {
  it('singleton engine path: scoreStrategy omitted → no injection observed', async () => {
    const dir = makeTempMemoryDir()
    try {
      // No scoreStrategy → uses getDefaultEngine() singleton (NoopScoreStrategy).
      const out = await executeMemorySearch(
        dir,
        { query: 'daemon multi-resolution screening', maxResults: 5 },
        { recordUsage: false },
      )
      expect(Array.isArray(out.results)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-call engine path: injected scoreStrategy is invoked exactly once', async () => {
    const dir = makeTempMemoryDir()
    const scorer = new CountingScoreStrategy()
    try {
      const out = await executeMemorySearch(
        dir,
        { query: 'daemon multi-resolution screening', maxResults: 5 },
        { recordUsage: false, scoreStrategy: scorer },
      )
      expect(Array.isArray(out.results)).toBe(true)
      expect(scorer.scoreCalls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('injected scoreStrategy does not leak to a subsequent omitted call', async () => {
    const dir = makeTempMemoryDir()
    const scorer = new CountingScoreStrategy()
    try {
      // First call with injection.
      await executeMemorySearch(
        dir,
        { query: 'observability', maxResults: 5 },
        { recordUsage: false, scoreStrategy: scorer },
      )
      expect(scorer.scoreCalls).toBe(1)
      // Second call without injection → singleton path; scorer must not
      // increment (the per-call engine is constructed fresh each invocation).
      await executeMemorySearch(
        dir,
        { query: 'observability', maxResults: 5 },
        { recordUsage: false },
      )
      expect(scorer.scoreCalls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('NoopScoreStrategy as injection is also accepted (round-trip)', async () => {
    const dir = makeTempMemoryDir()
    try {
      const out = await executeMemorySearch(
        dir,
        { query: 'daemon', maxResults: 5 },
        { recordUsage: false, scoreStrategy: new NoopScoreStrategy() },
      )
      expect(Array.isArray(out.results)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Phase 3-3 entry-point wiring — findRelevantMemories', () => {
  it('singleton engine path: scoreStrategy omitted preserves legacy behavior', async () => {
    const dir = makeTempMemoryDir()
    try {
      const out = await findRelevantMemories('observability', dir, {
        enableSonnet: false,
      })
      expect(Array.isArray(out)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-call engine path: injected scoreStrategy is invoked exactly once', async () => {
    const dir = makeTempMemoryDir()
    const scorer = new CountingScoreStrategy()
    try {
      const out = await findRelevantMemories('observability', dir, {
        enableSonnet: false,
        scoreStrategy: scorer,
      })
      expect(Array.isArray(out)).toBe(true)
      // findRelevantMemories invokes the engine once per call.
      expect(scorer.scoreCalls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('injected scoreStrategy does not leak to a subsequent omitted call', async () => {
    const dir = makeTempMemoryDir()
    const scorer = new CountingScoreStrategy()
    try {
      await findRelevantMemories('observability', dir, {
        enableSonnet: false,
        scoreStrategy: scorer,
      })
      expect(scorer.scoreCalls).toBe(1)
      await findRelevantMemories('observability', dir, {
        enableSonnet: false,
      })
      expect(scorer.scoreCalls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
