// LlmRerankerScoreStrategy — Phase 3-1 skeleton + Phase 3-2 impl tests
// (memory-search-improvement-loop saga).
//
// Coverage:
//   Schema (6): defaults match orchestrator decisions, full config accepted,
//               rejects topNRerank=0, llmWeight>1, mode unknown, diversityCap=0
//   Strategy skeleton (4): instantiate w/ NullLlmAdapter + defaults,
//               injected adapter + partial config override,
//               empty candidates short-circuit,
//               passthrough order + paths under cap-only mode + NullLlmAdapter
//   Strategy impl (9): weighted blend math (explicit numbers),
//               missing adapter index → gate-only blend,
//               tail beyond topNRerank untouched,
//               mode='cap-only' skips adapter,
//               mode='llm-only' skips per-file cap,
//               mode='hybrid' applies both,
//               per-file cap demotes 3rd+ hit,
//               graceful degrade preserves paths on throw,
//               adapter throw emits screening:llm_reranker_fallback event

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  LlmRerankerScoreStrategy,
  LlmRerankerConfigSchema,
  NullLlmAdapter,
  type LlmAdapter,
  type LlmRerankItem,
} from '../../extracted/screening/LlmRerankerScoreStrategy.js'
import type { RetrievalCandidate } from '../../extracted/memory/MemoryRetrievalEngine.js'
import {
  enableScreeningLog,
  isScreeningLogEnabled,
} from '../../extracted/screening/screeningLog.js'

function makeCandidate(
  topicPath: string,
  rawScore: number,
  overrides: Partial<RetrievalCandidate> = {},
): RetrievalCandidate {
  return {
    topicPath,
    filePath: `/tmp/memory/${topicPath}`,
    entryIds: [],
    rawRelevanceScore: rawScore,
    usageAdjustedScore: rawScore,
    source: 'file-bm25',
    concepts: [],
    snippet: '',
    ...overrides,
  }
}

describe('LlmRerankerConfigSchema — defaults & validation', () => {
  it('applies orchestrator-mandated defaults (handoff Q1-Q4)', () => {
    const cfg = LlmRerankerConfigSchema.parse({})
    expect(cfg.topNRerank).toBe(20)
    expect(cfg.llmWeight).toBeCloseTo(0.6, 5)
    expect(cfg.diversityCap).toBe(2)
    expect(cfg.llmModel).toBe('claude-haiku-4-5-20251001')
    expect(cfg.timeoutMs).toBe(5_000)
    expect(cfg.mode).toBe('hybrid')
  })

  it('accepts a fully-populated config', () => {
    const cfg = LlmRerankerConfigSchema.parse({
      topNRerank: 30,
      llmWeight: 0.8,
      diversityCap: 3,
      llmModel: 'claude-sonnet-4-6',
      timeoutMs: 10_000,
      mode: 'llm-only',
    })
    expect(cfg.topNRerank).toBe(30)
    expect(cfg.mode).toBe('llm-only')
  })

  it('rejects topNRerank=0 (must be >= 1)', () => {
    expect(() => LlmRerankerConfigSchema.parse({ topNRerank: 0 })).toThrow()
  })

  it('rejects llmWeight > 1', () => {
    expect(() => LlmRerankerConfigSchema.parse({ llmWeight: 1.5 })).toThrow()
  })

  it('rejects unknown mode values', () => {
    expect(() => LlmRerankerConfigSchema.parse({ mode: 'unknown' })).toThrow()
  })

  it('rejects diversityCap < 1', () => {
    expect(() => LlmRerankerConfigSchema.parse({ diversityCap: 0 })).toThrow()
  })
})

describe('LlmRerankerScoreStrategy — skeleton + instantiation', () => {
  it('instantiates with NullLlmAdapter and parsed defaults by default', () => {
    const strategy = new LlmRerankerScoreStrategy()
    expect(strategy.name).toBe('llm-reranker')
    expect(strategy.adapter).toBeInstanceOf(NullLlmAdapter)
    expect(strategy.config.topNRerank).toBe(20)
    expect(strategy.config.mode).toBe('hybrid')
  })

  it('accepts an injected adapter and partial config override', () => {
    const stubAdapter: LlmAdapter = {
      name: 'stub-adapter',
      async rerank() {
        return []
      },
    }
    const strategy = new LlmRerankerScoreStrategy({
      adapter: stubAdapter,
      config: { topNRerank: 5, mode: 'llm-only' },
    })
    expect(strategy.adapter).toBe(stubAdapter)
    expect(strategy.config.topNRerank).toBe(5)
    expect(strategy.config.mode).toBe('llm-only')
    expect(strategy.config.diversityCap).toBe(2)
  })

  it('returns empty array when given empty candidates (short-circuit)', async () => {
    const strategy = new LlmRerankerScoreStrategy()
    const out = await strategy.score([], 'q')
    expect(out).toEqual([])
  })

  it('preserves order + paths under cap-only mode (passthrough sanity)', async () => {
    const strategy = new LlmRerankerScoreStrategy({
      config: { mode: 'cap-only' },
    })
    const input = [
      makeCandidate('topics/a.md', 1.0),
      makeCandidate('topics/b.md', 0.5),
      makeCandidate('topics/c.md', 0.333),
    ]
    const out = await strategy.score(input, 'q')
    expect(out.map((c) => c.topicPath)).toEqual([
      'topics/a.md',
      'topics/b.md',
      'topics/c.md',
    ])
    expect(out[0]!.rawRelevanceScore).toBeCloseTo(1.0, 5)
    expect(out[1]!.rawRelevanceScore).toBeCloseTo(0.5, 5)
    expect(out[2]!.rawRelevanceScore).toBeCloseTo(0.333, 3)
  })
})

describe('LlmRerankerScoreStrategy — Phase 3-2 weighted blend & cap', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('blends LLM semantic with normalized gate score per llmWeight (hybrid)', async () => {
    const explicitAdapter: LlmAdapter = {
      name: 'explicit-adapter',
      async rerank(): Promise<LlmRerankItem[]> {
        return [
          { index: 0, semanticScore: 1.0 },
          { index: 1, semanticScore: 0.2 },
        ]
      },
    }
    const strategy = new LlmRerankerScoreStrategy({
      adapter: explicitAdapter,
      config: { mode: 'hybrid', llmWeight: 0.6, diversityCap: 2 },
    })
    const input = [
      makeCandidate('topics/a.md', 1.0),
      makeCandidate('topics/b.md', 0.5),
    ]
    const out = await strategy.score(input, 'q')
    // index 0: 0.6 * 1.0 + 0.4 * (1.0 / 1.0) = 1.0
    // index 1: 0.6 * 0.2 + 0.4 * (0.5 / 1.0) = 0.32
    const byPath = new Map(out.map((c) => [c.topicPath, c.rawRelevanceScore]))
    expect(byPath.get('topics/a.md')).toBeCloseTo(1.0, 5)
    expect(byPath.get('topics/b.md')).toBeCloseTo(0.32, 5)
  })

  it('missing adapter index falls through to gate-only normalized score', async () => {
    const partialAdapter: LlmAdapter = {
      name: 'partial-adapter',
      async rerank(): Promise<LlmRerankItem[]> {
        return [{ index: 0, semanticScore: 0.9 }]
      },
    }
    const strategy = new LlmRerankerScoreStrategy({
      adapter: partialAdapter,
      config: { mode: 'hybrid', llmWeight: 0.6, topNRerank: 2 },
    })
    const input = [
      makeCandidate('topics/a.md', 0.7),
      makeCandidate('topics/b.md', 0.6),
    ]
    const out = await strategy.score(input, 'q')
    const byPath = new Map(out.map((c) => [c.topicPath, c.rawRelevanceScore]))
    // index 0: 0.6 * 0.9 + 0.4 * (0.7 / 0.7) = 0.94
    expect(byPath.get('topics/a.md')).toBeCloseTo(0.94, 5)
    // index 1 (no semantic): gateNorm only = 0.6 / 0.7
    expect(byPath.get('topics/b.md')).toBeCloseTo(0.6 / 0.7, 5)
  })

  it('leaves tail beyond topNRerank untouched (paths + scores preserved)', async () => {
    const headAdapter: LlmAdapter = {
      name: 'head-adapter',
      async rerank(_q, candidates) {
        return candidates.map((_, index) => ({ index, semanticScore: 0.5 }))
      },
    }
    const strategy = new LlmRerankerScoreStrategy({
      adapter: headAdapter,
      config: { mode: 'hybrid', llmWeight: 0.6, topNRerank: 2, diversityCap: 5 },
    })
    const input = [
      makeCandidate('topics/a.md', 1.0),
      makeCandidate('topics/b.md', 0.5),
      makeCandidate('topics/c.md', 0.333),
      makeCandidate('topics/d.md', 0.25),
    ]
    const out = await strategy.score(input, 'q')
    const byPath = new Map(out.map((c) => [c.topicPath, c.rawRelevanceScore]))
    // Tail (c, d) untouched by the rerank stage.
    expect(byPath.get('topics/c.md')).toBeCloseTo(0.333, 3)
    expect(byPath.get('topics/d.md')).toBeCloseTo(0.25, 5)
  })

  it("'cap-only' mode does not invoke the adapter", async () => {
    let calls = 0
    const countingAdapter: LlmAdapter = {
      name: 'counting',
      async rerank() {
        calls++
        return []
      },
    }
    const strategy = new LlmRerankerScoreStrategy({
      adapter: countingAdapter,
      config: { mode: 'cap-only' },
    })
    await strategy.score(
      [makeCandidate('topics/a.md', 1.0), makeCandidate('topics/b.md', 0.5)],
      'q',
    )
    expect(calls).toBe(0)
  })

  it("'llm-only' mode does not apply per-file diversity cap", async () => {
    const explicitAdapter: LlmAdapter = {
      name: 'explicit',
      async rerank(_q, candidates) {
        return candidates.map((_, index) => ({ index, semanticScore: 0.5 }))
      },
    }
    const strategy = new LlmRerankerScoreStrategy({
      adapter: explicitAdapter,
      config: { mode: 'llm-only', diversityCap: 2 },
    })
    const input = [
      makeCandidate('topics/dom.md', 1.0),
      makeCandidate('topics/dom.md', 0.9, { entryIds: ['x'] }),
      makeCandidate('topics/dom.md', 0.8, { entryIds: ['y'] }),
      makeCandidate('topics/other.md', 0.7),
    ]
    const out = await strategy.score(input, 'q')
    const domEntries = out.filter((c) => c.topicPath === 'topics/dom.md')
    expect(domEntries).toHaveLength(3)
    for (const e of domEntries) {
      // No demote → no -2 offset → all positive after weighted blend.
      expect(e.rawRelevanceScore).toBeGreaterThan(-1)
    }
  })

  it('per-file cap demotes the 3rd+ hit per topicPath (cap-only)', async () => {
    const strategy = new LlmRerankerScoreStrategy({
      config: { mode: 'cap-only', diversityCap: 2 },
    })
    const input = [
      makeCandidate('topics/dom.md', 1.0),
      makeCandidate('topics/dom.md', 0.9, { entryIds: ['x'] }),
      makeCandidate('topics/dom.md', 0.8, { entryIds: ['y'] }),
      makeCandidate('topics/other.md', 0.7),
    ]
    const out = await strategy.score(input, 'q')
    const positive = out.filter((c) => c.rawRelevanceScore > 0)
    const demoted = out.filter((c) => c.rawRelevanceScore < 0)
    expect(positive).toHaveLength(3)
    expect(demoted).toHaveLength(1)
    expect(demoted[0]!.topicPath).toBe('topics/dom.md')
    expect(demoted[0]!.entryIds).toEqual(['y'])
  })

  it("'hybrid' mode applies both LLM blend and per-file cap", async () => {
    const equalAdapter: LlmAdapter = {
      name: 'equal',
      async rerank(_q, candidates) {
        return candidates.map((_, index) => ({ index, semanticScore: 0.5 }))
      },
    }
    const strategy = new LlmRerankerScoreStrategy({
      adapter: equalAdapter,
      config: { mode: 'hybrid', llmWeight: 0.5, diversityCap: 2 },
    })
    const input = [
      makeCandidate('topics/dom.md', 1.0),
      makeCandidate('topics/dom.md', 0.9, { entryIds: ['x'] }),
      makeCandidate('topics/dom.md', 0.8, { entryIds: ['y'] }),
      makeCandidate('topics/other.md', 0.7),
    ]
    const out = await strategy.score(input, 'q')
    expect(out.filter((c) => c.rawRelevanceScore < 0)).toHaveLength(1)
    const demoted = out.find((c) => c.rawRelevanceScore < 0)!
    expect(demoted.topicPath).toBe('topics/dom.md')
  })

  it('preserves all input candidates on adapter throw (graceful degrade)', async () => {
    const throwingAdapter: LlmAdapter = {
      name: 'throwing-adapter',
      async rerank() {
        throw new Error('simulated LLM timeout')
      },
    }
    const strategy = new LlmRerankerScoreStrategy({
      adapter: throwingAdapter,
      config: { mode: 'hybrid' },
    })
    const input = [
      makeCandidate('topics/a.md', 0.7),
      makeCandidate('topics/b.md', 0.6),
    ]
    const out = await strategy.score(input, 'q')
    expect(out.map((c) => c.topicPath).sort()).toEqual([
      'topics/a.md',
      'topics/b.md',
    ])
    for (const c of out) {
      expect(c.rawRelevanceScore).toBeGreaterThan(0)
    }
  })

  it('emits screening:llm_reranker_fallback event on adapter throw', async () => {
    const wasEnabled = isScreeningLogEnabled()
    enableScreeningLog(true)
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    try {
      const throwingAdapter: LlmAdapter = {
        name: 'logging-throwing',
        async rerank() {
          throw new Error('simulated')
        },
      }
      const strategy = new LlmRerankerScoreStrategy({
        adapter: throwingAdapter,
        config: { mode: 'hybrid' },
      })
      await strategy.score([makeCandidate('topics/a.md', 0.5)], 'why')
      const lines = stderrWrite.mock.calls
        .map((args) => String(args[0]))
        .join('')
      expect(lines).toContain('screening:llm_reranker_fallback')
      expect(lines).toContain('logging-throwing')
    } finally {
      stderrWrite.mockRestore()
      enableScreeningLog(wasEnabled)
    }
  })
})
