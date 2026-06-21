#!/usr/bin/env node
// gen-screening-fixture.mjs — one-shot fixture generator for screening tests.
//
// Run with `npx -p tsx@4 -- tsx scripts/gen-screening-fixture.mjs` so we do
// NOT depend on tsx as a devDependency (the vendored JS port must run on
// plain Node — only this offline generator needs tsx).
//
// Imports the upstream TS module directly, runs the 25 representative cases,
// and serializes the input + expected outcome to JSON. The vendored JS port
// is then verified against the same fixture in screening.test.js.

import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const UPSTREAM_PATH = process.env.RELVETIA_UPSTREAM
  || join(ROOT, '..', 'relvetia', 'relvetia-extracted', 'screening', 'screening.ts')

const upstream = await import(pathToFileURL(UPSTREAM_PATH).href)

let upstreamCommit = 'unknown'
try {
  const upstreamRoot = join(ROOT, '..', 'relvetia')
  upstreamCommit = execSync(`git -C "${upstreamRoot}" rev-parse HEAD`, {
    encoding: 'utf8',
  }).trim()
} catch (e) {
  console.warn(`[gen-fixture] could not read upstream commit: ${e.message}`)
}

// ---------------------------------------------------------------------------
// 25 representative cases (input → expected). Coverage chosen for branch
// diversity: ASCII / pure CJK / mixed / empty / threshold edges / recency /
// N <= 1 / stopwords-only.
// ---------------------------------------------------------------------------

const docCorpus = [
  'Database migration failed in production today',
  'Auth flow uses JWT tokens with 15 minute TTL',
  'Redis cache invalidation on write-through path',
  'Tokyo office on-call rotation for security incidents',
  'Frontend rendering performance regression in modal layout',
  'データベースの認証フローが東京リージョンで失敗した',
  'バックエンドのキャッシュ設定を更新',
  'カスタムフォントのレンダリング問題を修正',
  '監視ダッシュボードのレイテンシ表示が壊れている',
  'チームのオンボーディング資料を作成',
]

const recentTimestamps = [
  Date.now() - 1 * 24 * 3600 * 1000,
  Date.now() - 3 * 24 * 3600 * 1000,
  Date.now() - 10 * 24 * 3600 * 1000,
]

const cases = []

function addCase(id, fn) {
  cases.push({ id, ...fn() })
}

// 1-2: pure ASCII
addCase('ascii-jwt-query', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'jwt tokens', config)
  return {
    description: 'pure ASCII query against mixed corpus',
    input: { items, query: 'jwt tokens', config },
    expected: result,
  }
})

addCase('ascii-rendering-perf', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'rendering performance regression', config)
  return {
    description: 'multi-word ASCII query, perf domain',
    input: { items, query: 'rendering performance regression', config },
    expected: result,
  }
})

// 3-4: pure CJK
addCase('cjk-monitoring', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, '監視ダッシュボード', config)
  return {
    description: 'pure CJK query for monitoring dashboard',
    input: { items, query: '監視ダッシュボード', config },
    expected: result,
  }
})

addCase('cjk-onboarding', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'オンボーディング 資料', config)
  return {
    description: 'CJK katakana + kanji onboarding query',
    input: { items, query: 'オンボーディング 資料', config },
    expected: result,
  }
})

// 5-6: bilingual bridge
addCase('bilingual-database', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'English query expected to match Japanese doc via bilingual bridge',
    input: { items, query: 'database', config },
    expected: result,
  }
})

addCase('bilingual-cache', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'キャッシュ cache invalidation', config)
  return {
    description: 'mixed English+CJK query',
    input: { items, query: 'キャッシュ cache invalidation', config },
    expected: result,
  }
})

// 7-8: empty / stopwords-only
addCase('empty-query', () => {
  const config = { threshold: 0.10, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, '', config)
  return {
    description: 'empty query returns []',
    input: { items, query: '', config },
    expected: result,
  }
})

addCase('whitespace-query', () => {
  const config = { threshold: 0.10, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, '   \t\n  ', config)
  return {
    description: 'whitespace-only query returns []',
    input: { items, query: '   \t\n  ', config },
    expected: result,
  }
})

addCase('stopwords-only', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'the and of for', config)
  return {
    description: 'query made entirely of stopwords yields []',
    input: { items, query: 'the and of for', config },
    expected: result,
  }
})

// 10-11: threshold edges
addCase('threshold-zero', () => {
  const config = { threshold: 0.0, maxResults: 5 }
  const items = docCorpus.slice(0, 3).map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'threshold=0 lets nearly everything through (clamped to r=1.01)',
    input: { items, query: 'database', config },
    expected: result,
  }
})

addCase('threshold-high', () => {
  const config = { threshold: 0.5, maxResults: 5 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'high threshold excludes weak matches',
    input: { items, query: 'database', config },
    expected: result,
  }
})

// 12-14: maxResults cap
addCase('maxresults-one', () => {
  const config = { threshold: 0.0, maxResults: 1 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'maxResults=1 returns at most 1',
    input: { items, query: 'database', config },
    expected: result,
  }
})

addCase('maxresults-zero', () => {
  const config = { threshold: 0.0, maxResults: 0 }
  const items = docCorpus.map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'maxResults=0 returns []',
    input: { items, query: 'database', config },
    expected: result,
  }
})

addCase('maxresults-large', () => {
  const config = { threshold: 0.0, maxResults: 1000 }
  const items = docCorpus.slice(0, 4).map((text, i) => ({ id: i, text }))
  const result = upstream.screenItems(items, x => x.text, 'database auth jwt', config)
  return {
    description: 'maxResults far larger than passing items',
    input: { items, query: 'database auth jwt', config },
    expected: result,
  }
})

// 15-17: N <= 1 safety
addCase('n-zero', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = []
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'zero items returns []',
    input: { items, query: 'database', config },
    expected: result,
  }
})

addCase('n-one-match', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = [{ id: 0, text: 'database migration failed today' }]
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'single-item corpus matching the query',
    input: { items, query: 'database', config },
    expected: result,
  }
})

addCase('n-one-nomatch', () => {
  const config = { threshold: 0.5, maxResults: 5 }
  const items = [{ id: 0, text: 'redis cluster setup notes' }]
  const result = upstream.screenItems(items, x => x.text, 'database migration', config)
  return {
    description: 'single-item corpus that fails threshold',
    input: { items, query: 'database migration', config },
    expected: result,
  }
})

// 18-19: recency
addCase('recency-boost-recent', () => {
  const config = {
    threshold: 0.05, maxResults: 3,
    boostRecency: true, recencyHalfLifeMs: 7 * 24 * 3600 * 1000,
  }
  const items = [
    { id: 0, text: 'database migration failed', age: 1 * 24 * 3600 * 1000 },
    { id: 1, text: 'database tuning workshop notes', age: 30 * 24 * 3600 * 1000 },
    { id: 2, text: 'database backup procedure draft', age: 60 * 24 * 3600 * 1000 },
  ]
  const result = upstream.screenItems(
    items, x => x.text, 'database', config, x => x.age,
  )
  return {
    description: 'recency boost: recent items rank higher',
    input: { items, query: 'database', config },
    expected: result,
  }
})

addCase('recency-without-boost', () => {
  const config = { threshold: 0.05, maxResults: 3 }
  const items = [
    { id: 0, text: 'database migration failed', age: 1 * 24 * 3600 * 1000 },
    { id: 1, text: 'database tuning workshop notes', age: 30 * 24 * 3600 * 1000 },
    { id: 2, text: 'database backup procedure draft', age: 60 * 24 * 3600 * 1000 },
  ]
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'no recency boost: pure TF-IDF order',
    input: { items, query: 'database', config },
    expected: result,
  }
})

// 20: stemming
addCase('stemming-failure', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = [
    { id: 0, text: 'failure detected in production' },
    { id: 1, text: 'failed deploys piling up' },
    { id: 2, text: 'failures from prior incidents' },
    { id: 3, text: 'success rate climbed back' },
  ]
  const result = upstream.screenItems(items, x => x.text, 'failed', config)
  return {
    description: 'stemming groups failure/failed/failures together',
    input: { items, query: 'failed', config },
    expected: result,
  }
})

// 21: tie-breaking deterministic
addCase('identical-docs', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = [
    { id: 0, text: 'database migration ran successfully' },
    { id: 1, text: 'database migration ran successfully' },
    { id: 2, text: 'database migration ran successfully' },
  ]
  const result = upstream.screenItems(items, x => x.text, 'database migration', config)
  return {
    description: 'identical docs all pass; tie-breaking preserves insertion order',
    input: { items, query: 'database migration', config },
    expected: result,
  }
})

// 22: long doc vs short doc
addCase('long-doc-short-doc', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = [
    { id: 0, text: 'database' },
    { id: 1, text: 'database '.repeat(50) },
  ]
  const result = upstream.screenItems(items, x => x.text, 'database', config)
  return {
    description: 'cosine normalization makes short and long doc tie',
    input: { items, query: 'database', config },
    expected: result,
  }
})

// 23: kanji compound negation prefix
addCase('kanji-negation-prefix', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = [
    { id: 0, text: '非対応 のフィーチャー' },
    { id: 1, text: '対応 状況 を 確認' },
  ]
  const result = upstream.screenItems(items, x => x.text, 'handle', config)
  return {
    description: '非対応 should not bridge to handle; 対応 should',
    input: { items, query: 'handle', config },
    expected: result,
  }
})

// 24: bigram boundary
addCase('cjk-bigram-overlap', () => {
  const config = { threshold: 0.05, maxResults: 5 }
  const items = [
    { id: 0, text: '東京 都 心 から リモート' },
    { id: 1, text: '東京 駅 から 出発' },
  ]
  const result = upstream.screenItems(items, x => x.text, '東京', config)
  return {
    description: 'CJK bigram overlap finds both 東京 docs',
    input: { items, query: '東京', config },
    expected: result,
  }
})

// 25: recency decay below threshold
addCase('recency-decay-zeros-out', () => {
  const config = {
    threshold: 0.05, maxResults: 5,
    boostRecency: true, recencyHalfLifeMs: 1 * 24 * 3600 * 1000,
  }
  const items = [
    { id: 0, text: 'database migration', age: 1 * 24 * 3600 * 1000 },
    { id: 1, text: 'database migration', age: 200 * 24 * 3600 * 1000 },
  ]
  const result = upstream.screenItems(
    items, x => x.text, 'database migration', config, x => x.age,
  )
  return {
    description: 'extreme recency decay still keeps both above the 1e-10 floor',
    input: { items, query: 'database migration', config },
    expected: result,
  }
})

// Map<string,number> in expected.* breaks JSON.stringify; the screenItems
// return type only contains { item, score } so serialization is direct.
// We still freeze the Date.now() base so the fixture is reproducible across
// the recency cases — those tests pass `ageMs` as input, not Date.now().

const fixture = {
  _meta: {
    upstream_commit: upstreamCommit,
    upstream_path: UPSTREAM_PATH,
    generated_at: new Date().toISOString(),
    schema_version: 1,
  },
  cases,
}

const outPath = join(ROOT, 'src', '__tests__', 'fixtures', 'screening-golden.json')
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, JSON.stringify(fixture, null, 2) + '\n', 'utf8')

console.log(`[gen-fixture] wrote ${cases.length} cases to ${outPath}`)
console.log(`[gen-fixture] upstream_commit = ${upstreamCommit}`)
