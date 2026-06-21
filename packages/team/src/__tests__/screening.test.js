// Screening — verifies the vendored TF-IDF port matches the upstream
// reference behavior (golden fixture) and the API contract holds.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { screenItems } from '../screening/screening.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(__dirname, 'fixtures', 'screening-golden.json')

describe('screening — golden fixture parity with upstream', () => {
  it('every case re-runs deep-equal against the stored upstream output', async () => {
    const raw = await readFile(FIXTURE_PATH, 'utf8')
    const fixture = JSON.parse(raw)

    assert.ok(fixture._meta, 'fixture must carry _meta for drift detection')
    assert.equal(typeof fixture._meta.upstream_commit, 'string')
    assert.ok(fixture._meta.upstream_commit.length >= 7,
      `expected git-like upstream_commit, got ${fixture._meta.upstream_commit}`)
    assert.equal(fixture._meta.schema_version, 1)
    assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 20,
      'fixture must cover at least 20 representative cases')

    for (const c of fixture.cases) {
      const { items, query, config } = c.input
      const useAge = c.id.startsWith('recency')
      const actual = useAge
        ? screenItems(items, x => x.text, query, config, x => x.age)
        : screenItems(items, x => x.text, query, config)
      assert.deepEqual(actual, c.expected,
        `case "${c.id}" diverged from upstream (${c.description})`)
    }
  })
})

describe('screening — API safety contracts', () => {
  it('returns [] for an empty query', () => {
    const items = [{ text: 'jwt validation flow' }]
    const out = screenItems(items, x => x.text, '', { threshold: 0.1, maxResults: 5 })
    assert.deepEqual(out, [])
  })

  it('returns [] for a whitespace-only query', () => {
    const items = [{ text: 'jwt validation flow' }]
    const out = screenItems(items, x => x.text, '   \t\n', { threshold: 0.1, maxResults: 5 })
    assert.deepEqual(out, [])
  })

  it('returns [] when items is empty', () => {
    const out = screenItems([], x => x.text, 'jwt', { threshold: 0.1, maxResults: 5 })
    assert.deepEqual(out, [])
  })

  it('honors threshold rejection (high threshold drops weak matches)', () => {
    const items = [
      { text: 'database migration failed' },
      { text: 'completely unrelated topic about cats' },
    ]
    const out = screenItems(items, x => x.text, 'database', { threshold: 0.5, maxResults: 5 })
    for (const s of out) assert.ok(s.score > 0)
    // The unrelated doc must not appear.
    assert.ok(out.every(s => s.item.text !== 'completely unrelated topic about cats'))
  })

  it('respects maxResults cap', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ text: `database entry ${i}` }))
    const out = screenItems(items, x => x.text, 'database', { threshold: 0.05, maxResults: 3 })
    assert.ok(out.length <= 3)
  })

  it('handles N=1 corpus without throwing', () => {
    const items = [{ text: 'jwt' }]
    const out = screenItems(items, x => x.text, 'jwt', { threshold: 0.05, maxResults: 5 })
    // With a single doc + the query, IDF degenerates; we only assert no crash.
    assert.ok(Array.isArray(out))
  })

  it('sorts descending by score', () => {
    const items = [
      { text: 'database' },
      { text: 'database migration database' },
      { text: 'database migration database database' },
    ]
    const out = screenItems(items, x => x.text, 'database migration', { threshold: 0, maxResults: 10 })
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].score >= out[i].score)
    }
  })
})
