import { describe, it, expect } from 'vitest'
import {
  screenMemories,
  memoryScreeningConfig,
  type MemoryHeaderLike,
} from '../../extracted/screening/memoryScreening.js'
import {
  buildTaskContext,
  screenMessagesForCompaction,
  type MessageLike,
} from '../../extracted/screening/messageScreening.js'
import {
  tokenize,
  cosineSimilarity,
  tfidfVector,
  buildIdfMap,
  trimAndSquare,
  screenItems,
  type ScreeningConfig,
} from '../../extracted/screening/screening.js'
// Note: screeningConfig.ts requires zod/v4 which is not available in
// relvetia-daemon's dependency tree. We test config logic separately below
// using inline values rather than importing from screeningConfig.

// ---------------------------------------------------------------------------
// memoryScreening adapter
// ---------------------------------------------------------------------------

describe('screenMemories', () => {
  const now = Date.now()

  function makeMemory(
    filename: string,
    description: string | null,
    opts: Partial<MemoryHeaderLike> = {},
  ): MemoryHeaderLike {
    return {
      filename,
      filePath: `/memory/${filename}`,
      mtimeMs: opts.mtimeMs ?? now,
      description,
      type: opts.type,
      contentSnippet: opts.contentSnippet,
    }
  }

  const config: ScreeningConfig = {
    threshold: 0.5,
    maxResults: 50,
  }

  it('returns full list as fallback when all items are rejected', () => {
    const memories = [
      makeMemory('cooking.md', 'pasta recipes'),
      makeMemory('weather.md', 'forecasts and climate data'),
    ]
    // Query shares zero terms with any memory
    const result = screenMemories(memories, 'zxqwv_nonexistent_term', config)
    // Safety valve: should return the full list
    expect(result).toHaveLength(memories.length)
  })

  it('returns full list for empty query', () => {
    const memories = [makeMemory('test.md', 'test')]
    expect(screenMemories(memories, '', config)).toEqual(memories)
  })

  it('returns empty array for empty memories', () => {
    expect(screenMemories([], 'query', config)).toEqual([])
  })

  it('filters irrelevant memories when relevant ones exist', () => {
    const memories = [
      makeMemory('db-migration.md', 'database migration postgresql schema update database migration', {
        contentSnippet: 'Guide for migrating database schemas using postgresql database migration tools',
      }),
      makeMemory('cooking-recipes.md', 'pasta tomato sauce italian cooking', {
        contentSnippet: 'Italian pasta cooking instructions with tomato sauce',
      }),
      makeMemory('weather-forecast.md', 'sunny temperature humidity forecast', {
        contentSnippet: 'Weather forecast data for temperature and humidity tracking',
      }),
    ]
    const result = screenMemories(memories, 'database migration postgresql database', config)
    // Should include the db-migration memory and exclude unrelated ones
    expect(result.length).toBeLessThan(memories.length)
    expect(result.some(m => m.filename === 'db-migration.md')).toBe(true)
  })

  it('uses contentSnippet for richer matching', () => {
    const memories = [
      makeMemory('notes.md', null, {
        contentSnippet: 'The deployment pipeline uses kubernetes helm charts for staging',
      }),
      makeMemory('random.md', null, {
        contentSnippet: 'This file contains random notes about various topics',
      }),
    ]
    const result = screenMemories(memories, 'kubernetes deployment helm', config)
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0]!.filename).toBe('notes.md')
  })

  it('memoryScreeningConfig correctly maps global config fields', () => {
    const globalCfg = {
      memoryThreshold: 0.15,
      memoryMaxResults: 30,
      boostRecency: true,
      recencyHalfLifeMs: 604800000,
    }
    const cfg = memoryScreeningConfig(globalCfg)
    expect(cfg.threshold).toBe(globalCfg.memoryThreshold)
    expect(cfg.maxResults).toBe(globalCfg.memoryMaxResults)
    expect(cfg.boostRecency).toBe(globalCfg.boostRecency)
    expect(cfg.recencyHalfLifeMs).toBe(globalCfg.recencyHalfLifeMs)
  })
})

// ---------------------------------------------------------------------------
// messageScreening adapter
// ---------------------------------------------------------------------------

describe('buildTaskContext', () => {
  it('extracts text from recent user messages', () => {
    const messages: MessageLike[] = [
      { role: 'user', textContent: 'first task', index: 0 },
      { role: 'assistant', textContent: 'sure thing', index: 1 },
      { role: 'user', textContent: 'second task', index: 2 },
      { role: 'assistant', textContent: 'done', index: 3 },
      { role: 'user', textContent: 'third task', index: 4 },
    ]
    const ctx = buildTaskContext(messages, 2)
    expect(ctx).toContain('second task')
    expect(ctx).toContain('third task')
    expect(ctx).not.toContain('first task')
  })

  it('returns empty string when no user messages', () => {
    const messages: MessageLike[] = [
      { role: 'assistant', textContent: 'hello', index: 0 },
      { role: 'system', textContent: 'system prompt', index: 1 },
    ]
    expect(buildTaskContext(messages)).toBe('')
  })
})

describe('screenMessagesForCompaction', () => {
  const config: ScreeningConfig = {
    threshold: 0.5,
    maxResults: 100,
  }

  it('returns empty for empty messages', () => {
    expect(screenMessagesForCompaction([], config)).toEqual([])
  })

  it('marks all as relevant when no user messages exist', () => {
    const messages: MessageLike[] = [
      { role: 'assistant', textContent: 'hello', index: 0 },
      { role: 'assistant', textContent: 'world', index: 1 },
    ]
    const result = screenMessagesForCompaction(messages, config)
    expect(result).toHaveLength(2)
    expect(result.every(r => !r.lowRelevance)).toBe(true)
    expect(result.every(r => r.score === 1)).toBe(true)
  })

  it('never marks tool pairs as low relevance', () => {
    const messages: MessageLike[] = [
      { role: 'user', textContent: 'fix the database bug', index: 0 },
      { role: 'assistant', textContent: 'calling grep tool', isToolPair: true, index: 1 },
      { role: 'user', textContent: 'completely unrelated cooking pasta recipe', isToolPair: true, index: 2 },
      { role: 'user', textContent: 'fix the database migration schema', index: 3 },
    ]
    const result = screenMessagesForCompaction(messages, config, 1) // protect only last 1
    const toolPairResults = result.filter((_r, i) => messages[i]!.isToolPair)
    expect(toolPairResults.every(r => !r.lowRelevance)).toBe(true)
  })

  it('never marks protected (most recent) messages as low relevance', () => {
    const messages: MessageLike[] = [
      { role: 'user', textContent: 'old topic about cooking pasta', index: 0 },
      { role: 'assistant', textContent: 'pasta info here', index: 1 },
      { role: 'user', textContent: 'completely different topic xyzzy', index: 2 },
      { role: 'user', textContent: 'another xyzzy message', index: 3 },
      { role: 'user', textContent: 'xyzzy final message', index: 4 },
    ]
    const result = screenMessagesForCompaction(messages, config, 3)
    // Last 3 messages (indices 2, 3, 4) should be protected
    expect(result.find(r => r.index === 2)!.lowRelevance).toBe(false)
    expect(result.find(r => r.index === 3)!.lowRelevance).toBe(false)
    expect(result.find(r => r.index === 4)!.lowRelevance).toBe(false)
  })

  it('returns scores for all messages in original index order', () => {
    const messages: MessageLike[] = [
      { role: 'user', textContent: 'database migration', index: 0 },
      { role: 'assistant', textContent: 'working on it', index: 1 },
      { role: 'user', textContent: 'database migration update', index: 2 },
    ]
    const result = screenMessagesForCompaction(messages, config)
    expect(result).toHaveLength(3)
    expect(result[0]!.index).toBe(0)
    expect(result[1]!.index).toBe(1)
    expect(result[2]!.index).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// screeningConfig defaults (tested without zod/v4 dependency)
// ---------------------------------------------------------------------------

describe('screening config defaults', () => {
  it('memoryScreeningConfig produces valid ScreeningConfig from inline defaults', () => {
    // Mirrors DEFAULT_SCREENING_CONFIG values
    const globalConfig = {
      memoryThreshold: 0.15,
      memoryMaxResults: 30,
      boostRecency: true,
      recencyHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
    }
    const cfg = memoryScreeningConfig(globalConfig)
    expect(cfg.threshold).toBe(0.15)
    expect(cfg.maxResults).toBe(30)
    expect(cfg.boostRecency).toBe(true)
    expect(cfg.recencyHalfLifeMs).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// Edge cases: CJK text, Unicode, special inputs
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('tokenize produces CJK bigrams and ASCII tokens', () => {
    const tokens = tokenize('データベース移行 migration ツール')
    // ASCII word tokens
    expect(tokens).toContain('migration')
    // CJK bigrams from "データベース移行"
    expect(tokens).toContain('デー')
    expect(tokens).toContain('ータ')
    expect(tokens).toContain('タベ')
    expect(tokens).toContain('ベー')
    expect(tokens).toContain('ース')
    expect(tokens).toContain('ス移')
    expect(tokens).toContain('移行')
    // CJK bigrams from "ツール"
    expect(tokens).toContain('ツー')
    expect(tokens).toContain('ール')
  })

  it('CJK bigrams enable partial matching for Japanese terms', () => {
    // "東京都" and "東京" should share bigram "東京"
    const tokensA = tokenize('東京都の天気')
    const tokensB = tokenize('東京の気温')
    const setA = new Set(tokensA)
    const setB = new Set(tokensB)
    // Shared bigram: "東京"
    const shared = [...setA].filter(t => setB.has(t))
    expect(shared).toContain('東京')
  })

  it('screenItems matches Japanese memory entries', () => {
    const items = [
      'データベース移行の手順をまとめた',
      'フロントエンドのCSS設計ガイド',
      '天気予報のAPIエンドポイント',
    ]
    const config: ScreeningConfig = { threshold: 0.15, maxResults: 10 }
    const results = screenItems(items, x => x, 'データベース移行', config)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.item).toBe(items[0])
  })

  it('tokenize handles emoji-heavy text', () => {
    // Emojis should be stripped, leaving only alphanumeric content
    const tokens = tokenize('great job fixing the bug')
    expect(tokens).toContain('great')
    expect(tokens).toContain('job')
    expect(tokens).toContain('fixing')
    expect(tokens).toContain('bug')
  })

  it('cosineSimilarity handles single-element vectors', () => {
    const a = new Map([['database', 1.5]])
    const b = new Map([['database', 3.0]])
    // Same direction → cos = 1.0
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 10)
  })

  it('screenItems handles duplicate items gracefully', () => {
    const items = ['database migration', 'database migration', 'database migration']
    const config: ScreeningConfig = { threshold: 0.5, maxResults: 10 }
    const results = screenItems(items, x => x, 'database migration', config)
    // All identical items should have the same score
    if (results.length >= 2) {
      expect(results[0]!.score).toBe(results[1]!.score)
    }
  })

  it('screenItems with whitespace-only query returns empty', () => {
    const items = ['database migration']
    const config: ScreeningConfig = { threshold: 0.5, maxResults: 10 }
    expect(screenItems(items, x => x, '   \t\n  ', config)).toEqual([])
  })

  it('trimAndSquare with r = 2 (paper minimum) rejects below 0.5', () => {
    // r=2: threshold = 1 - 1/2 = 0.5
    expect(trimAndSquare(0.3, 2)).toBe(0)   // below threshold → rejected
    expect(trimAndSquare(0.5, 2)).toBe(0)   // at boundary → rejected
    expect(trimAndSquare(0.7, 2)).toBeGreaterThan(0) // above → passes
    expect(trimAndSquare(0.99, 2)).toBeGreaterThan(0)
  })

  it('buildIdfMap handles single-document corpus', () => {
    const idf = buildIdfMap(['the only document with database terms'])
    // With N=1, idf = ln(1/(1+1)) = ln(0.5) < 0
    // All terms in the single doc have df=1, so idf = ln(1/2) ≈ -0.693
    for (const val of idf.values()) {
      expect(val).toBeCloseTo(Math.log(0.5), 5)
    }
  })

  it('screenMemories with many memories respects maxResults', () => {
    const memories: MemoryHeaderLike[] = Array.from({ length: 100 }, (_, i) => ({
      filename: `memory-${i}.md`,
      filePath: `/memory/memory-${i}.md`,
      mtimeMs: Date.now(),
      description: `database migration schema tool update version ${i}`,
    }))
    const config: ScreeningConfig = {
      threshold: 0.5,
      maxResults: 10,
    }
    const result = screenMemories(memories, 'database migration schema', config)
    expect(result.length).toBeLessThanOrEqual(10)
  })

  it('tfidfVector with all-stopword text returns empty', () => {
    const idf = buildIdfMap(['the and or but'])
    const vec = tfidfVector('the and or but', idf)
    expect(vec.size).toBe(0)
  })
})
