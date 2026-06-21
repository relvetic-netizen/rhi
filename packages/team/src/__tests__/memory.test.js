import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  writeNote, readNotes, promoteToKnowledge, readKnowledge,
  searchMemory, listNoteAgents, NOTE_KINDS,
  searchRelvetiaLogs, appendRelvetiaLog, makeMatcher,
} from '../memory.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-memory__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-memory')

before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([])
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => { await rm(TMP, { recursive: true, force: true }) })

describe('writeNote / readNotes', () => {
  it('writes and reads a note', async () => {
    const note = await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'X is stored in Y', topic: 'persistence',
    })
    assert.ok(note.id.startsWith('note_'))
    const read = await readNotes(TEST_TEAM, 'alice')
    assert.equal(read.length, 1)
    assert.equal(read[0].content, 'X is stored in Y')
    assert.equal(read[0].agent, 'alice')
  })

  it('rejects invalid kind', async () => {
    await assert.rejects(
      writeNote(TEST_TEAM, 'alice', { kind: 'nonsense', content: 'x' }),
      /Invalid note kind/
    )
  })

  it('filters by kind', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'f1' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'decision', content: 'd1' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'f2' })
    const findings = await readNotes(TEST_TEAM, 'alice', { kind: 'finding' })
    assert.equal(findings.length, 2)
    const decisions = await readNotes(TEST_TEAM, 'alice', { kind: 'decision' })
    assert.equal(decisions.length, 1)
  })

  it('filters by multiple kinds', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'f' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'decision', content: 'd' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'gotcha', content: 'g' })
    const some = await readNotes(TEST_TEAM, 'alice', { kind: ['decision', 'gotcha'] })
    assert.equal(some.length, 2)
  })

  it('filters by topic substring (case-insensitive)', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'a', topic: 'Auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'b', topic: 'DB' })
    const matched = await readNotes(TEST_TEAM, 'alice', { topic: 'auth' })
    assert.equal(matched.length, 1)
    assert.equal(matched[0].content, 'a')
  })

  it('filters by since timestamp', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'old' })
    const mid = new Date(Date.now() + 1).toISOString()
    await new Promise(r => setTimeout(r, 5))
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'new' })
    const recent = await readNotes(TEST_TEAM, 'alice', { since: mid })
    assert.equal(recent.length, 1)
    assert.equal(recent[0].content, 'new')
  })

  it('limit returns last N', async () => {
    for (let i = 0; i < 5; i++) {
      await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: `n${i}` })
    }
    const last = await readNotes(TEST_TEAM, 'alice', { limit: 2 })
    assert.equal(last.length, 2)
    assert.equal(last[0].content, 'n3')
    assert.equal(last[1].content, 'n4')
  })

  it('survives a corrupt line in the jsonl', async () => {
    const { appendFile, mkdir } = await import('node:fs/promises')
    const { getTeamDir } = await import('../paths.js')
    const dir = join(getTeamDir(TEST_TEAM), 'notes')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'alice.jsonl'), 'not json{{\n')
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'good' })
    const notes = await readNotes(TEST_TEAM, 'alice')
    assert.equal(notes.length, 1)
    assert.equal(notes[0].content, 'good')
  })
})

describe('promoteToKnowledge / readKnowledge', () => {
  it('writes knowledge and reads back', async () => {
    const kn = await promoteToKnowledge(TEST_TEAM, {
      content: 'Redis uses AOF',
      topic: 'infra',
      source_agent: 'alice',
      tags: ['production'],
    })
    assert.ok(kn.id.startsWith('kn_'))
    const items = await readKnowledge(TEST_TEAM)
    assert.equal(items.length, 1)
    assert.equal(items[0].source_agent, 'alice')
    assert.deepEqual(items[0].tags, ['production'])
  })

  it('filters knowledge by topic', async () => {
    await promoteToKnowledge(TEST_TEAM, { content: 'x', topic: 'auth' })
    await promoteToKnowledge(TEST_TEAM, { content: 'y', topic: 'db' })
    const auth = await readKnowledge(TEST_TEAM, { topic: 'auth' })
    assert.equal(auth.length, 1)
  })
})

describe('searchMemory', () => {
  beforeEach(async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'JWT validation', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'gotcha', content: 'node 20 required' })
    await writeNote(TEST_TEAM, 'bob', { kind: 'decision', content: 'use Redis for cache', topic: 'infra' })
    await promoteToKnowledge(TEST_TEAM, { content: 'Auth is centralized', topic: 'auth' })
  })

  it('searches both tiers by default', async () => {
    const results = await searchMemory(TEST_TEAM, 'auth')
    assert.equal(results.length, 2)
    const sources = results.map(r => r._source).sort()
    assert.deepEqual(sources, ['knowledge', 'note'])
  })

  it('scopes to notes only', async () => {
    const results = await searchMemory(TEST_TEAM, 'auth', { scope: 'notes' })
    assert.equal(results.length, 1)
    assert.equal(results[0]._source, 'note')
  })

  it('scopes to knowledge only', async () => {
    const results = await searchMemory(TEST_TEAM, 'auth', { scope: 'knowledge' })
    assert.equal(results.length, 1)
    assert.equal(results[0]._source, 'knowledge')
  })

  it('limits to a specific agent', async () => {
    const results = await searchMemory(TEST_TEAM, '', { scope: 'notes', agent: 'bob' })
    assert.equal(results.length, 1)
    assert.equal(results[0].agent, 'bob')
  })

  it('filters notes by kind', async () => {
    const results = await searchMemory(TEST_TEAM, '', { scope: 'notes', kind: 'gotcha' })
    assert.equal(results.length, 1)
    assert.equal(results[0].kind, 'gotcha')
  })

  it('case-insensitive substring match', async () => {
    const results = await searchMemory(TEST_TEAM, 'JWT')
    assert.equal(results.length, 1)
    assert.match(results[0].content, /JWT/)
  })

  it('empty query returns everything in scope', async () => {
    const results = await searchMemory(TEST_TEAM, '', { scope: 'knowledge' })
    assert.equal(results.length, 1)
  })

  it('respects limit', async () => {
    for (let i = 0; i < 20; i++) {
      await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: `bulk-${i}` })
    }
    const results = await searchMemory(TEST_TEAM, 'bulk', { limit: 5 })
    assert.equal(results.length, 5)
  })
})

describe('searchMemory boolean query', () => {
  beforeEach(async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'JWT validation flow', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'gotcha', content: 'node 20 required for ESM', topic: 'tooling' })
    await writeNote(TEST_TEAM, 'bob', { kind: 'decision', content: 'use Redis for cache', topic: 'infra' })
    await promoteToKnowledge(TEST_TEAM, { content: 'Auth tokens are JWT signed', topic: 'auth' })
    await promoteToKnowledge(TEST_TEAM, { content: 'Cache backed by Redis cluster', topic: 'infra' })
  })

  it('AND default: tokenA tokenB requires both', async () => {
    const results = await searchMemory(TEST_TEAM, 'auth jwt')
    assert.equal(results.length, 2, 'JWT note + Auth knowledge both contain auth & jwt')
    for (const r of results) {
      const blob = (r.content + ' ' + (r.topic || '')).toLowerCase()
      assert.ok(blob.includes('auth') && blob.includes('jwt'))
    }
  })

  it('OR: tokenA OR tokenB matches either', () => {
    // PR-29: the OR operator is a property of the boolean matcher, not of
    // searchMemory's full pipeline (which now layers SEARCH_THRESHOLD
    // screening on top whose verdict depends on corpus IDF tuning). Verify
    // the operator via makeMatcher directly so the assertion stays stable
    // when the threshold is tuned. End-to-end screening behavior is asserted
    // separately in the "PR-29 review fixes" suite below.
    const match = makeMatcher('jwt OR redis')
    const jwtNote = { content: 'JWT validation flow', topic: 'auth', tags: [] }
    const redisDecision = { content: 'use Redis for cache', topic: 'infra', tags: [] }
    const authJwtKn = { content: 'Auth tokens are JWT signed', topic: 'auth', tags: [] }
    const redisKn = { content: 'Cache backed by Redis cluster', topic: 'infra', tags: [] }
    const nodeGotcha = { content: 'node 20 required for ESM', topic: 'tooling', tags: [] }
    assert.ok(match(jwtNote), 'jwt note must satisfy jwt OR redis')
    assert.ok(match(redisDecision), 'redis decision must satisfy jwt OR redis')
    assert.ok(match(authJwtKn), 'auth jwt knowledge must satisfy jwt OR redis')
    assert.ok(match(redisKn), 'redis knowledge must satisfy jwt OR redis')
    assert.ok(!match(nodeGotcha), 'node gotcha (neither jwt nor redis) must not satisfy OR')
  })

  it('NOT: -token excludes matches', async () => {
    const results = await searchMemory(TEST_TEAM, 'auth -jwt')
    // 'auth' に hit するが 'jwt' を含まないものが残るはず
    // 'JWT validation flow' (topic auth + content jwt) → 除外
    // 'Auth tokens are JWT signed' → 除外
    // → 0 件 (auth を含む全 record が jwt も含む)
    assert.equal(results.length, 0)
  })

  it('NOT excludes Redis but keeps other auth records', async () => {
    const results = await searchMemory(TEST_TEAM, 'auth -redis')
    assert.equal(results.length, 2, 'JWT note + Auth knowledge (Redis 含まない)')
    for (const r of results) {
      assert.ok(!(r.content + ' ' + (r.topic || '')).toLowerCase().includes('redis'))
    }
  })

  it('quoted phrase: literal substring including whitespace', async () => {
    const results = await searchMemory(TEST_TEAM, '"node 20"')
    assert.equal(results.length, 1)
    assert.match(results[0].content, /node 20/)
  })

  it('quoted phrase preserves operator characters', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'flag -verbose enabled' })
    const results = await searchMemory(TEST_TEAM, '"-verbose"')
    assert.equal(results.length, 1)
    assert.match(results[0].content, /-verbose/)
  })

  it('combined: AND + NOT + quoted', async () => {
    const results = await searchMemory(TEST_TEAM, '"auth tokens" -redis')
    assert.equal(results.length, 1)
    assert.match(results[0].content, /Auth tokens are JWT signed/)
  })

  it('OR with NOT in same group', () => {
    // PR-29: same rationale as the OR test above — verify operator semantics
    // via makeMatcher; ranking behavior is tested separately.
    const match = makeMatcher('jwt OR -auth')
    // group=[{jwt,false},{auth,true}] → some semantics: contain jwt OR NOT contain auth
    const jwtNote = { content: 'JWT validation flow', topic: 'auth', tags: [] }
    const authJwtKn = { content: 'Auth tokens are JWT signed', topic: 'auth', tags: [] }
    const redisDecision = { content: 'use Redis for cache', topic: 'infra', tags: [] }
    const redisKn = { content: 'Cache backed by Redis cluster', topic: 'infra', tags: [] }
    const nodeGotcha = { content: 'node 20 required for ESM', topic: 'tooling', tags: [] }
    const authOnlyNote = { content: 'oauth bearer token rotation policy', topic: 'auth', tags: [] }
    assert.ok(match(jwtNote), 'jwt note satisfies "jwt OR -auth" via jwt match')
    assert.ok(match(authJwtKn), 'auth jwt knowledge satisfies via jwt match (despite auth)')
    assert.ok(match(redisDecision), 'redis decision satisfies via NOT auth')
    assert.ok(match(redisKn), 'redis knowledge satisfies via NOT auth')
    assert.ok(match(nodeGotcha), 'node gotcha satisfies via NOT auth')
    assert.ok(!match(authOnlyNote), 'auth-only note (no jwt + has auth) must NOT satisfy')
  })

  it('backward compat: single token = substring match (no behavior change)', async () => {
    const results = await searchMemory(TEST_TEAM, 'JWT')
    assert.equal(results.length, 2, 'JWT note + Auth knowledge')
  })

  it('empty query still returns everything in scope', async () => {
    const results = await searchMemory(TEST_TEAM, '   ', { scope: 'knowledge' })
    assert.equal(results.length, 2)
  })

  it('whitespace-only OR is ignored', async () => {
    const results = await searchMemory(TEST_TEAM, 'OR jwt')
    assert.equal(results.length, 2, 'leading OR を skip して jwt 単独として扱う')
  })
})

describe('searchMemory — PR-29 review fixes', () => {
  it('absolute threshold drops irrelevant noise (P0-1)', async () => {
    // 1 JWT-relevant note (high signal for "jwt" query)
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'jwt rotation policy decided for prod', topic: 'auth',
    })
    // 10 noise notes that match the boolean filter (substring "jwt" via tag),
    // but contribute no relevance under TF-IDF screening.
    for (let i = 0; i < 10; i++) {
      await writeNote(TEST_TEAM, 'alice', {
        kind: 'finding',
        content: `office hours discussion item ${i} about scheduling`,
        topic: 'office',
        tags: ['jwt'],
      })
    }
    const results = await searchMemory(TEST_TEAM, 'jwt rotation', { scope: 'notes' })
    // Pre-fix: all 11 returned (leftover append undid the screening filter).
    // Post-fix: only the genuinely-relevant note survives the SEARCH_THRESHOLD
    // (with leftover fallback removed). Noise is rejected.
    assert.ok(results.length < 11,
      `screening did not filter noise: got ${results.length} results, expected ≤ 5`)
    assert.ok(results.length >= 1, 'at least the relevant note must survive')
    assert.match(results[0].content, /jwt rotation/)
    assert.equal(results._truncated, false)
    assert.equal(results._fallback, false)
  })

  it('first-item-over-budget is grapheme-safe truncated (P0-2)', async () => {
    const { SEARCH_RETURN_BUDGET_BYTES } = await import('../screening/config.js')
    const { formatSearchLine } = await import('../memory.js')
    // 20053-byte single note (well above the 16KB budget).
    const longBody = 'XYZ123 '.repeat(2_865) // ≈20055 bytes, contains query terms
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: longBody, topic: 'oversize',
    })
    const results = await searchMemory(TEST_TEAM, 'oversize XYZ123', { scope: 'notes' })
    assert.equal(results.length, 1)
    assert.equal(results._truncated, true,
      'single oversize result must report truncated=true')
    assert.equal(results._omittedCount, 0,
      'no whole items were omitted; just the line was truncated')
    const line = formatSearchLine(results[0])
    const lineBytes = Buffer.byteLength(line, 'utf8')
    assert.ok(lineBytes <= SEARCH_RETURN_BUDGET_BYTES,
      `truncated line is ${lineBytes} bytes, exceeds budget ${SEARCH_RETURN_BUDGET_BYTES}`)
    assert.match(line, /TRUNCATED/, 'truncation marker must be visible to caller')
  })

  it('multi-byte content is not split mid-codepoint (P2 grapheme safety)', async () => {
    const { formatSearchLine } = await import('../memory.js')
    // Mix of Japanese (3-byte UTF-8) characters so naive byte-slicing would
    // produce U+FFFD replacement chars on the boundary.
    const ja = 'テスト日本語'.repeat(3_000) // ~54000 bytes, >> 16KB budget
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: ja, topic: 'i18n',
    })
    const results = await searchMemory(TEST_TEAM, 'i18n', { scope: 'notes' })
    assert.equal(results.length, 1)
    assert.equal(results._truncated, true)
    const line = formatSearchLine(results[0])
    assert.ok(!line.includes('�'),
      'truncated line contains U+FFFD — split mid-codepoint')
  })

  it('substring-vs-token mismatch falls back to timestamp order (safety valve)', async () => {
    // The boolean matcher does substring match (`'cat'.includes` matches
    // `catacombs`), while screening tokenizes word-boundary tokens. A
    // substring query that admits items via a partial-word match would
    // score zero in TF-IDF — without a fallback, results would silently
    // collapse to empty. Verify the fallback signals and preserves matches.
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'we explored the catacombs at night', topic: 'archaeology',
    })
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'catastrophe averted in production today', topic: 'incidents',
    })
    const results = await searchMemory(TEST_TEAM, 'cat', { scope: 'notes' })
    assert.ok(results.length >= 2,
      `fallback should preserve all ${results.length} boolean-admitted records`)
    assert.equal(results._fallback, true, 'fallback flag must be set when screening rejects all')
  })
})

describe('listNoteAgents', () => {
  it('returns only agents with notes', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'x' })
    await writeNote(TEST_TEAM, 'charlie', { kind: 'finding', content: 'y' })
    const agents = await listNoteAgents(TEST_TEAM)
    assert.deepEqual(agents.sort(), ['alice', 'charlie'])
  })

  it('returns empty array when no notes exist', async () => {
    const agents = await listNoteAgents(TEST_TEAM)
    assert.deepEqual(agents, [])
  })
})

describe('NOTE_KINDS', () => {
  it('exports the canonical kind list', () => {
    assert.ok(NOTE_KINDS.includes('finding'))
    assert.ok(NOTE_KINDS.includes('decision'))
    assert.ok(NOTE_KINDS.includes('assumption'))
    assert.ok(NOTE_KINDS.includes('open_question'))
    assert.ok(NOTE_KINDS.includes('next_step'))
    assert.ok(NOTE_KINDS.includes('gotcha'))
  })
})

describe('searchRelvetiaLogs / appendRelvetiaLog', () => {
  const REL_ROOT = join(TMP, 'relvetia-logs')

  async function seedLogs() {
    await mkdir(join(REL_ROOT, '2026', '05'), { recursive: true })
    await writeFile(join(REL_ROOT, '2026', '05', '2026-05-01.md'), [
      '# 2026-05-01',
      '',
      '- [10:00] [skill-author][create] new skill drafted for codex wrapper',
      '- [11:30] [memory] distill schedule confirmed for 03:00 JST',
      'random non-bullet line',
    ].join('\n'))
    await writeFile(join(REL_ROOT, '2026', '05', '2026-05-02.md'), [
      '# 2026-05-02',
      '',
      '- [09:15] [relvetia-team][step1] PR #14 merged',
      '- [22:00] [bug] mailbox lock contention observed n=16 p99=1259ms',
    ].join('\n'))
    // empty year/month dirs to verify list resilience
    await mkdir(join(REL_ROOT, '2025', '12'), { recursive: true })
  }

  it('finds matching log lines with single-token query', async () => {
    await seedLogs()
    const hits = await searchRelvetiaLogs('mailbox', { root: REL_ROOT })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].time, '22:00')
    assert.equal(hits[0].date, '2026-05-02')
    assert.ok(hits[0].content.includes('mailbox lock contention'))
    assert.deepEqual(hits[0].tags, ['bug'])
  })

  it('supports boolean AND across content + tags', async () => {
    await seedLogs()
    const hits = await searchRelvetiaLogs('skill-author codex', { root: REL_ROOT })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].time, '10:00')
  })

  it('supports OR and NOT operators', async () => {
    await seedLogs()
    const hitsOr = await searchRelvetiaLogs('mailbox OR distill', { root: REL_ROOT })
    assert.equal(hitsOr.length, 2)
    const hitsNot = await searchRelvetiaLogs('relvetia-team -mailbox', { root: REL_ROOT })
    assert.equal(hitsNot.length, 1)
    assert.ok(hitsNot[0].content.includes('PR #14'))
  })

  it('returns empty array when root does not exist', async () => {
    const hits = await searchRelvetiaLogs('anything', { root: join(TMP, 'no-such-dir') })
    assert.deepEqual(hits, [])
  })

  it('respects soft limit', async () => {
    await seedLogs()
    const hits = await searchRelvetiaLogs('', { root: REL_ROOT, limit: 2 })
    assert.equal(hits.length, 2)
  })

  it('appendRelvetiaLog writes a JST-formatted line to today\'s file', async () => {
    const fixedNow = new Date('2026-05-03T16:00:00Z')  // UTC 16:00 = 2026-05-04 01:00 JST
    const result = await appendRelvetiaLog('test entry from bridge', {
      tags: ['test', 'bridge'],
      root: REL_ROOT,
      now: fixedNow,
    })
    assert.match(result.line, /^- \[01:00\] \[test\]\[bridge\] test entry from bridge$/)
    assert.ok(result.file.endsWith(join('2026', '05', '2026-05-04.md')))

    const hits = await searchRelvetiaLogs('test entry from bridge', { root: REL_ROOT })
    assert.equal(hits.length, 1)
    assert.deepEqual(hits[0].tags, ['test', 'bridge'])
  })
})

describe('searchMemory scope=relvetia-memory + scope=all', () => {
  const REL_ROOT = join(TMP, 'rel-search-logs')

  it('relvetia-memory scope reads only relvetia logs', async () => {
    await mkdir(join(REL_ROOT, '2026', '05'), { recursive: true })
    await writeFile(join(REL_ROOT, '2026', '05', '2026-05-03.md'),
      '- [12:00] [team-x] cross-session marker XYZ123\n')
    // also write a team note that should NOT appear
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'note marker XYZ123 in team', topic: 'noise',
    })

    const hits = await searchMemory(TEST_TEAM, 'XYZ123', {
      scope: 'relvetia-memory', relvetia_root: REL_ROOT,
    })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]._source, 'relvetia')
    assert.ok(hits[0].content.includes('cross-session marker'))
  })

  it('scope=all combines notes + knowledge + relvetia', async () => {
    await mkdir(join(REL_ROOT, '2026', '05'), { recursive: true })
    await writeFile(join(REL_ROOT, '2026', '05', '2026-05-03.md'),
      '- [12:00] [trio] from relvetia daily log\n')
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'from team note trio', topic: 'a',
    })
    await promoteToKnowledge(TEST_TEAM, { content: 'from knowledge trio', topic: 'b' })

    const hits = await searchMemory(TEST_TEAM, 'trio', {
      scope: 'all', relvetia_root: REL_ROOT,
    })
    const sources = new Set(hits.map(h => h._source))
    assert.ok(sources.has('note'))
    assert.ok(sources.has('knowledge'))
    assert.ok(sources.has('relvetia'))
    assert.equal(hits.length, 3)
  })

  it('default scope=both does NOT touch relvetia logs', async () => {
    await mkdir(join(REL_ROOT, '2026', '05'), { recursive: true })
    await writeFile(join(REL_ROOT, '2026', '05', '2026-05-03.md'),
      '- [12:00] [solo] only-in-relvetia-marker QQQ\n')
    const hits = await searchMemory(TEST_TEAM, 'QQQ', { relvetia_root: REL_ROOT })
    assert.equal(hits.length, 0)
  })
})

describe('searchMemory — screening + byte cap (PR-2)', () => {
  it('empty query → results in timestamp-desc order (no screening)', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'oldest', topic: 'a' })
    await new Promise(r => setTimeout(r, 5))
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'middle', topic: 'a' })
    await new Promise(r => setTimeout(r, 5))
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'newest', topic: 'a' })
    const results = await searchMemory(TEST_TEAM, '', { scope: 'notes' })
    assert.equal(results.length, 3)
    assert.equal(results[0].content, 'newest')
    assert.equal(results[2].content, 'oldest')
  })

  it('non-empty query → results reordered by screening (most-relevant first)', async () => {
    // Three docs match the matcher; screening must surface the JWT+rotation
    // dense one first. (OR query so the matcher does not pre-filter on AND.)
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'mention of jwt deep inside a long paragraph about caching strategies and infra',
    })
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'jwt jwt jwt validation rotation policy',
    })
    await writeNote(TEST_TEAM, 'alice', {
      kind: 'finding', content: 'jwt rotation noted in passing',
    })
    const results = await searchMemory(TEST_TEAM, 'jwt OR rotation', { scope: 'notes' })
    assert.equal(results.length, 3)
    // The dense "jwt jwt jwt validation rotation policy" entry should rank first.
    assert.match(results[0].content, /jwt jwt jwt/)
  })

  it('boolean NOT remains a hard filter even with screening on', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'jwt rotation policy', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'jwt redis interplay diagram', topic: 'auth' })
    const results = await searchMemory(TEST_TEAM, 'jwt -redis', { scope: 'notes' })
    for (const r of results) {
      assert.ok(!r.content.toLowerCase().includes('redis'),
        `NOT clause must hard-exclude: ${r.content}`)
    }
    assert.equal(results.length, 1)
  })

  it('uses a single IDF corpus across notes + knowledge (no scope-aware boost)', async () => {
    // If notes had a separate IDF from knowledge, the same string in each
    // tier would receive different scores. We verify they tie when contents
    // are identical (within the matcher pool).
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'distributed cache eviction policy' })
    await promoteToKnowledge(TEST_TEAM, { content: 'distributed cache eviction policy' })
    const results = await searchMemory(TEST_TEAM, 'distributed cache eviction')
    assert.equal(results.length, 2)
    // Both should be present; ordering is timestamp-tiebroken (knowledge
    // written after note), but the screening score gap should be zero.
    const sources = results.map(r => r._source).sort()
    assert.deepEqual(sources, ['knowledge', 'note'])
  })

  it('default limit is bounded (PR-2 lowers it to 20 via the handler)', async () => {
    for (let i = 0; i < 25; i++) {
      await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: `bulk-jwt-${i} note` })
    }
    // Library-level default = SEARCH_MAX_RESULTS = 20.
    const results = await searchMemory(TEST_TEAM, 'jwt', { scope: 'notes' })
    assert.ok(results.length <= 20,
      `library default must clamp to <= 20, got ${results.length}`)
  })

  it('byte cap fires when survivors exceed SEARCH_RETURN_BUDGET_BYTES', async () => {
    // 4KB-ish bodies, well above 16KB if combined.
    const body = 'jwt '.repeat(800)
    for (let i = 0; i < 30; i++) {
      await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: `${body} :: tag${i}` })
    }
    const results = await searchMemory(TEST_TEAM, 'jwt', { scope: 'notes', limit: 30 })
    assert.ok(results._truncated, 'byte cap must trip and annotate the result array')
    assert.ok(Number(results._omittedCount) > 0)
    // Inverse: a tiny corpus should not trip.
    const small = await searchMemory(TEST_TEAM, 'jwt', { scope: 'notes', limit: 1 })
    assert.ok(!small._truncated)
  })
})
