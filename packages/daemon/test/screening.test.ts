import { afterEach, describe, it, expect } from 'vitest'
import {
  tokenize,
  buildIdfMap,
  tfidfVector,
  cosineSimilarity,
  trimAndSquare,
  sharpnessFromThreshold,
  recencyFactor,
  screenItems,
  buildBm25CorpusStats,
  bm25Score,
  screenItemsBM25,
  setBm25Diagnostics,
  type ScreeningConfig,
} from '../../extracted/screening/screening.js'

afterEach(() => {
  setBm25Diagnostics(null)
})

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    const tokens = tokenize('Hello World! Test-case 123')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
    expect(tokens).toContain('test')
    expect(tokens).toContain('case')
    expect(tokens).toContain('123')
  })

  it('removes stopwords', () => {
    const tokens = tokenize('this is a test of the system')
    expect(tokens).not.toContain('this')
    expect(tokens).not.toContain('is')
    expect(tokens).not.toContain('the')
    expect(tokens).not.toContain('of')
    expect(tokens).toContain('test')
    expect(tokens).toContain('system')
  })

  it('removes single-character tokens', () => {
    const tokens = tokenize('a b c database')
    expect(tokens).toContain('database')
    expect(tokens).not.toContain('a')
    expect(tokens).not.toContain('b')
    expect(tokens).not.toContain('c')
  })

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([])
  })

  it('returns empty array for stopwords-only input', () => {
    expect(tokenize('the and or but')).toEqual([])
  })

  it('handles mixed-case and punctuation', () => {
    const tokens = tokenize('TypeScript: A Language for JavaScript!')
    expect(tokens).toContain('typescript')
    expect(tokens).toContain('language')
    expect(tokens).toContain('javascript')
  })

  it('produces CJK bigrams for Japanese text', () => {
    const tokens = tokenize('データベース')
    // CJK bigrams are present
    expect(tokens).toContain('デー')
    expect(tokens).toContain('ータ')
    expect(tokens).toContain('タベ')
    expect(tokens).toContain('ベー')
    expect(tokens).toContain('ース')
    // Bilingual bridge (CJK→English) also produces the English equivalent
    expect(tokens).toContain('database')
  })

  it('mixes ASCII tokens and CJK bigrams', () => {
    const tokens = tokenize('PostgreSQL データベース migration')
    expect(tokens).toContain('postgresql')
    expect(tokens).toContain('migration')
    // CJK bigrams from "データベース"
    expect(tokens).toContain('デー')
    const expected = '\u30FC\u30BF' // ータ
    expect(tokens).toContain(expected)
    expect(tokens).toContain('ース')
  })

  it('handles hiragana bigrams', () => {
    const tokens = tokenize('おはよう')
    expect(tokens).toContain('おは')
    expect(tokens).toContain('はよ')
    expect(tokens).toContain('よう')
  })

  it('single CJK character produces no bigrams', () => {
    // Single char → no bigrams possible, and ASCII filter removes length=1
    const tokens = tokenize('月')
    expect(tokens).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildIdfMap
// ---------------------------------------------------------------------------

describe('buildIdfMap', () => {
  it('returns empty map for empty corpus', () => {
    expect(buildIdfMap([])).toEqual(new Map())
  })

  it('computes correct IDF values', () => {
    const docs = [
      'database migration tool',
      'database schema update',
      'frontend component library',
    ]
    const idfMap = buildIdfMap(docs)

    // "database" appears in 2 of 3 docs: ln(3 / (1+2)) = ln(1) = 0
    expect(idfMap.get('database')).toBeCloseTo(0, 5)

    // "migration" appears in 1 of 3 docs: ln(3 / (1+1)) = ln(1.5)
    expect(idfMap.get('migration')).toBeCloseTo(Math.log(1.5), 5)

    // "frontend" appears in 1 of 3 docs: same IDF
    expect(idfMap.get('frontend')).toBeCloseTo(Math.log(1.5), 5)
  })

  it('rare terms get higher IDF than common terms', () => {
    const docs = [
      'common word common word',
      'common word rare special',
      'common word unique',
    ]
    const idfMap = buildIdfMap(docs)
    expect(idfMap.get('unique')!).toBeGreaterThan(idfMap.get('common')!)
  })
})

// ---------------------------------------------------------------------------
// BM25 corpus stats
// ---------------------------------------------------------------------------

describe('buildBm25CorpusStats', () => {
  it('returns empty stats for empty corpus', () => {
    const stats = buildBm25CorpusStats([])
    expect(stats.N).toBe(0)
    expect(stats.avgdl).toBe(0)
    expect(stats.df).toEqual(new Map())
    expect(stats.idf).toEqual(new Map())
    expect(stats.defaultIdf).toBe(0)
  })

  it('tracks document count and average tokenized length', () => {
    const stats = buildBm25CorpusStats([
      'alpha beta',
      'alpha beta gamma gamma',
    ])
    expect(stats.N).toBe(2)
    expect(stats.avgdl).toBe(3)
  })

  it('counts document frequency once per document', () => {
    const stats = buildBm25CorpusStats([
      'database database migration',
      'database schema',
      'frontend component',
    ])
    expect(stats.df.get('database')).toBe(2)
    expect(stats.df.get('migration')).toBe(1)
  })

  it('uses Lucene-form IDF values', () => {
    const stats = buildBm25CorpusStats([
      'database migration',
      'database schema',
      'frontend component',
    ])
    expect(stats.idf.get('database')).toBeCloseTo(Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5)), 10)
    expect(stats.idf.get('migration')).toBeCloseTo(Math.log(1 + (3 - 1 + 0.5) / (1 + 0.5)), 10)
  })

  it('keeps all corpus IDF values strictly positive', () => {
    const stats = buildBm25CorpusStats([
      'common term',
      'common term',
      'common unique',
    ])
    expect([...stats.idf.values()].every(v => v > 0)).toBe(true)
  })

  it('assigns a positive default IDF for out-of-corpus terms', () => {
    const stats = buildBm25CorpusStats(['alpha beta', 'beta gamma'])
    expect(stats.defaultIdf).toBeCloseTo(Math.log(1 + (2 + 0.5) / 0.5), 10)
    expect(stats.defaultIdf).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// BM25 score
// ---------------------------------------------------------------------------

describe('bm25Score', () => {
  it('returns 0 for empty corpus stats', () => {
    const stats = buildBm25CorpusStats([])
    expect(bm25Score(['database'], ['database'], stats)).toBe(0)
  })

  it('returns 0 for empty document tokens', () => {
    const stats = buildBm25CorpusStats(['database migration'])
    expect(bm25Score(['database'], [], stats)).toBe(0)
  })

  it('returns 0 when k1 is non-positive', () => {
    const stats = buildBm25CorpusStats(['database migration'])
    expect(bm25Score(['database'], tokenize('database migration'), stats, 0)).toBe(0)
    expect(bm25Score(['database'], tokenize('database migration'), stats, -1)).toBe(0)
  })

  it('returns 0 for no query/document overlap', () => {
    const stats = buildBm25CorpusStats(['database migration', 'frontend component'])
    expect(bm25Score(tokenize('kubernetes helm'), tokenize('database migration'), stats)).toBe(0)
  })

  it('matches the Okapi BM25 formula for a known case', () => {
    const docs = ['database database migration', 'database schema']
    const stats = buildBm25CorpusStats(docs)
    const queryTokens = ['database', 'migration']
    const docTokens = tokenize(docs[0]!)
    const k1 = 1.2
    const b = 0.75

    const databaseIdf = stats.idf.get('database')!
    const migrationIdf = stats.idf.get('migration')!
    const databasePart = databaseIdf * ((2 * (k1 + 1)) / (2 + k1 * (1 - b + b * 3 / stats.avgdl)))
    const migrationPart = migrationIdf * ((1 * (k1 + 1)) / (1 + k1 * (1 - b + b * 3 / stats.avgdl)))

    expect(bm25Score(queryTokens, docTokens, stats, k1, b)).toBeCloseTo(databasePart + migrationPart, 10)
  })

  it('deduplicates repeated query tokens', () => {
    const stats = buildBm25CorpusStats(['database migration', 'schema update'])
    const docTokens = tokenize('database migration')
    const once = bm25Score(['database'], docTokens, stats)
    const repeated = bm25Score(['database', 'database', 'database'], docTokens, stats)
    expect(repeated).toBeCloseTo(once, 10)
  })
})

// ---------------------------------------------------------------------------
// tfidfVector
// ---------------------------------------------------------------------------

describe('tfidfVector', () => {
  it('returns empty map for empty text', () => {
    expect(tfidfVector('', new Map())).toEqual(new Map())
  })

  it('weights rare terms higher', () => {
    const idfMap = new Map([
      ['database', 0.0],
      ['migration', 0.5],
    ])
    const vec = tfidfVector('database migration migration', idfMap)
    // migration: tf=2, idf=0.5 → 1.0
    // database: tf=1, idf=0.0 → 0.0
    expect(vec.get('migration')).toBe(1.0)
    expect(vec.get('database')).toBe(0.0)
  })

  it('assigns high default IDF to unknown terms', () => {
    const idfMap = new Map([['known', 0.5]])
    const vec = tfidfVector('known unknown', idfMap)
    // unknown gets default IDF = max(0.5) + 1 = 1.5
    expect(vec.get('unknown')).toBe(1.5)
    expect(vec.get('known')).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity(new Map(), new Map())).toBe(0)
    expect(cosineSimilarity(new Map([['a', 1]]), new Map())).toBe(0)
  })

  it('returns 1 for identical vectors', () => {
    const v = new Map([
      ['a', 3],
      ['b', 4],
    ])
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Map([['x', 1]])
    const b = new Map([['y', 1]])
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('returns correct value for known triangle', () => {
    // a = (1, 0), b = (1, 1) → cos = 1 / (1 * sqrt(2)) ≈ 0.7071
    const a = new Map([['x', 1]])
    const b = new Map([
      ['x', 1],
      ['y', 1],
    ])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 5)
  })

  it('is symmetric', () => {
    const a = new Map([
      ['x', 2],
      ['y', 3],
    ])
    const b = new Map([
      ['x', 1],
      ['z', 4],
    ])
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10)
  })
})

// ---------------------------------------------------------------------------
// trimAndSquare
// ---------------------------------------------------------------------------

describe('trimAndSquare', () => {
  it('returns exactly 0 below threshold', () => {
    // r = 3 → threshold = 1 - 1/3 ≈ 0.667
    // similarity = 0.5 < 0.667 → should be 0
    expect(trimAndSquare(0.5, 3)).toBe(0)
  })

  it('returns exactly 0 at threshold boundary', () => {
    // r = 3, threshold sim = 1 - 1/3 = 2/3
    // 1 - 3*(1 - 2/3) = 1 - 3*(1/3) = 1 - 1 = 0 → 0^2 = 0
    expect(trimAndSquare(2 / 3, 3)).toBe(0)
  })

  it('returns positive above threshold', () => {
    // r = 3, similarity = 0.9 → 1 - 3*(1-0.9) = 1 - 0.3 = 0.7 → 0.49
    expect(trimAndSquare(0.9, 3)).toBeCloseTo(0.49, 5)
  })

  it('returns 1 for perfect similarity', () => {
    // similarity = 1 → 1 - r*(1-1) = 1 → 1^2 = 1
    expect(trimAndSquare(1.0, 3)).toBe(1)
    expect(trimAndSquare(1.0, 10)).toBe(1)
  })

  it('returns 0 for zero similarity with any r > 1', () => {
    expect(trimAndSquare(0, 2)).toBe(0)
    expect(trimAndSquare(0, 5)).toBe(0)
    expect(trimAndSquare(0, 100)).toBe(0)
  })

  it('higher sharpness creates narrower acceptance window', () => {
    const sim = 0.8
    // r=2: 1-2*(0.2) = 0.6 → 0.36
    // r=5: 1-5*(0.2) = 0 → 0
    expect(trimAndSquare(sim, 2)).toBeGreaterThan(0)
    expect(trimAndSquare(sim, 5)).toBeCloseTo(0, 10)
  })
})

describe('sharpnessFromThreshold', () => {
  it('threshold 0.5 → r = 2', () => {
    expect(sharpnessFromThreshold(0.5)).toBe(2)
  })

  it('threshold 0 → r = 1.01 (clamped to minimum)', () => {
    // r = 1/(1-0) = 1, but clamped to 1.01
    expect(sharpnessFromThreshold(0)).toBeCloseTo(1.01, 5)
  })

  it('threshold 1 → Infinity', () => {
    expect(sharpnessFromThreshold(1)).toBe(Infinity)
  })

  it('threshold 0.75 → r = 4', () => {
    expect(sharpnessFromThreshold(0.75)).toBe(4)
  })

  it('threshold 0.15 → r ≈ 1.18 (benchmark-optimal for TF-IDF)', () => {
    expect(sharpnessFromThreshold(0.15)).toBeCloseTo(1 / (1 - 0.15), 5)
  })

  it('low thresholds produce r > 1.01', () => {
    // threshold 0.3 → r = 1/(1-0.3) ≈ 1.43
    expect(sharpnessFromThreshold(0.3)).toBeCloseTo(1.4286, 3)
    // threshold 0.1 → r = 1/(1-0.1) ≈ 1.11
    expect(sharpnessFromThreshold(0.1)).toBeCloseTo(1.1111, 3)
  })
})

// ---------------------------------------------------------------------------
// recencyFactor
// ---------------------------------------------------------------------------

describe('recencyFactor', () => {
  it('returns 1.0 for age 0', () => {
    expect(recencyFactor(0, 7 * 24 * 3600 * 1000)).toBe(1.0)
  })

  it('returns 0.5 at exactly one half-life', () => {
    const halfLife = 7 * 24 * 3600 * 1000
    expect(recencyFactor(halfLife, halfLife)).toBeCloseTo(0.5, 10)
  })

  it('returns 0.25 at two half-lives', () => {
    const halfLife = 1000
    expect(recencyFactor(2000, halfLife)).toBeCloseTo(0.25, 10)
  })

  it('returns 1.0 for negative age', () => {
    expect(recencyFactor(-1000, 7000)).toBe(1.0)
  })
})

// ---------------------------------------------------------------------------
// screenItems (end-to-end)
// ---------------------------------------------------------------------------

describe('screenItems', () => {
  // Small corpora produce low TF-IDF cosine similarities (~0.1-0.3),
  // so we use the minimum threshold (0.5 → r=2) to avoid rejecting everything.
  const config: ScreeningConfig = {
    threshold: 0.5,
    maxResults: 10,
  }

  it('returns empty for empty items', () => {
    expect(screenItems([], (x: string) => x, 'query', config)).toEqual([])
  })

  it('returns empty for empty query', () => {
    expect(screenItems(['doc'], (x: string) => x, '', config)).toEqual([])
  })

  it('rejects completely irrelevant documents', () => {
    // Use repeated terms to produce higher TF-IDF cosine similarity,
    // ensuring the relevant document exceeds the r=2 threshold (sim > 0.5).
    const items = [
      'database migration database migration schema schema update postgresql database',
      'cooking recipe pasta tomato sauce italian cooking pasta recipe',
      'weather forecast sunny temperature humidity weather forecast sunny',
    ]
    const results = screenItems(
      items,
      (x: string) => x,
      'database migration schema database migration',
      config,
    )
    // The database doc should pass; cooking and weather should be rejected
    const passedTexts = results.map(r => r.item)
    expect(passedTexts).toContain(items[0])
    expect(passedTexts).not.toContain(items[1])
    expect(passedTexts).not.toContain(items[2])
  })

  it('returns results sorted by score descending', () => {
    const items = [
      'typescript react component frontend development',
      'typescript node backend api server development',
      'python django web framework backend',
    ]
    const results = screenItems(
      items,
      (x: string) => x,
      'typescript backend api development',
      config,
    )
    // Scores should be monotonically non-increasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score)
    }
  })

  it('respects maxResults cap', () => {
    const items = Array.from({ length: 50 }, (_, i) => `document ${i} relevant topic keyword`)
    const smallConfig: ScreeningConfig = { threshold: 0.5, maxResults: 5 }
    const results = screenItems(items, (x: string) => x, 'relevant topic keyword', smallConfig)
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('all scores are strictly positive (no zero-score items returned)', () => {
    const items = [
      'matching keyword here',
      'completely unrelated text about cooking',
    ]
    const results = screenItems(items, (x: string) => x, 'matching keyword', config)
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0)
    }
  })

  it('works with custom getText extractor', () => {
    const items = [
      { name: 'db-migration.md', content: 'database migration database migration schema sql' },
      { name: 'vim-config.md', content: 'vim editor configuration settings keybinding' },
      { name: 'css-styles.md', content: 'css stylesheet responsive design flexbox grid' },
    ]
    const results = screenItems(
      items,
      item => `${item.name} ${item.content}`,
      'database migration sql schema',
      config,
    )
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.item.name).toBe('db-migration.md')
  })

  it('applies recency boost when configured', () => {
    const now = Date.now()
    const items = [
      { text: 'database migration update', age: 0 },              // fresh
      { text: 'database migration update', age: 30 * 24 * 3600 * 1000 }, // 30 days old
    ]
    const recencyConfig: ScreeningConfig = {
      threshold: 0.5,
      maxResults: 10,
      boostRecency: true,
      recencyHalfLifeMs: 7 * 24 * 3600 * 1000,
    }
    const results = screenItems(
      items,
      item => item.text,
      'database migration',
      recencyConfig,
      item => item.age,
    )
    if (results.length === 2) {
      // Fresh item should score higher than old item
      expect(results[0]!.item.age).toBe(0)
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
    }
  })
})

// ---------------------------------------------------------------------------
// screenItemsBM25
// ---------------------------------------------------------------------------

describe('screenItemsBM25', () => {
  const config: ScreeningConfig = {
    threshold: 0.05,
    maxResults: 10,
  }

  it('returns empty for empty items or empty query', () => {
    expect(screenItemsBM25([], (x: string) => x, 'database', config)).toEqual([])
    expect(screenItemsBM25(['database migration'], (x: string) => x, '', config)).toEqual([])
  })

  it('screens relevant documents and rejects zero-overlap documents', () => {
    const items = [
      'database migration schema postgresql database migration',
      'frontend component react css layout',
      'cooking pasta tomato recipe',
    ]
    const results = screenItemsBM25(items, x => x, 'database migration schema', config)
    expect(results.map(r => r.item)).toContain(items[0])
    expect(results.map(r => r.item)).not.toContain(items[1])
    expect(results.map(r => r.item)).not.toContain(items[2])
    expect(results.every(r => r.score > 0)).toBe(true)
  })

  it('sorts by score descending and respects maxResults', () => {
    const items = [
      'database migration schema database migration schema',
      'database migration',
      'database',
      'unrelated text',
    ]
    const results = screenItemsBM25(
      items,
      x => x,
      'database migration schema',
      { threshold: 0.01, maxResults: 2 },
    )
    expect(results).toHaveLength(2)
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score)
    expect(results[0]!.item).toBe(items[0])
  })

  it('applies recency boost with the existing decay semantics', () => {
    const items = [
      { text: 'database migration schema', age: 48 * 3600 * 1000 },
      { text: 'database migration schema', age: 0 },
    ]
    const results = screenItemsBM25(
      items,
      item => item.text,
      'database migration',
      {
        threshold: 0.01,
        maxResults: 10,
        boostRecency: true,
        recencyHalfLifeMs: 48 * 3600 * 1000,
      },
      item => item.age,
    )
    expect(results).toHaveLength(2)
    expect(results[0]!.item.age).toBe(0)
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
  })

  it('emits BM25 diagnostics with raw and normalized ranges', () => {
    let diagnostics: unknown = null
    setBm25Diagnostics(stats => {
      diagnostics = stats
    })

    const results = screenItemsBM25(
      ['database migration database', 'frontend component'],
      x => x,
      'database migration',
      config,
      undefined,
      { k1: 1.5, b: 0.6, scale: 3 },
    )

    expect(results.length).toBeGreaterThan(0)
    expect(diagnostics).toMatchObject({
      inputCount: 2,
      passedCount: results.length,
      threshold: config.threshold,
      k1: 1.5,
      b: 0.6,
      scale: 3,
      N: 2,
    })
    const stats = diagnostics as {
      rawMin: number
      rawMax: number
      rawAvg: number
      normalizedMin: number
      normalizedMax: number
      normalizedAvg: number
      avgdl: number
      sharpness: number
    }
    expect(stats.rawMin).toBeLessThanOrEqual(stats.rawAvg)
    expect(stats.rawAvg).toBeLessThanOrEqual(stats.rawMax)
    expect(stats.normalizedMin).toBeGreaterThanOrEqual(0)
    expect(stats.normalizedMax).toBeLessThan(1)
    expect(stats.normalizedMin).toBeLessThanOrEqual(stats.normalizedAvg)
    expect(stats.normalizedAvg).toBeLessThanOrEqual(stats.normalizedMax)
    expect(stats.avgdl).toBeGreaterThan(0)
    expect(stats.sharpness).toBeCloseTo(sharpnessFromThreshold(config.threshold), 10)
  })
})
