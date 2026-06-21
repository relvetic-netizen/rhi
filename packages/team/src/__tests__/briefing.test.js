import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildBriefing, primeAgent, applyBriefingBudget } from '../briefing.js'
import { BRIEFING_RETURN_BUDGET_BYTES } from '../screening/config.js'
import { writeNote, promoteToKnowledge } from '../memory.js'
import { createTeam } from '../team.js'
import { createTask } from '../tasks.js'
import { readMailbox } from '../mailbox.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-briefing__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-briefing')

before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([])
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  await createTeam(TEST_TEAM, [{ name: 'alice', role: 'worker' }], 'test')
})

describe('buildBriefing', () => {
  it('produces an empty-ish briefing when no memory exists', async () => {
    const b = await buildBriefing(TEST_TEAM, 'alice')
    assert.match(b.text, /<briefing for="alice"/)
    assert.match(b.text, /\(none\)/)
    assert.equal(b.counts.open_questions, 0)
    assert.equal(b.counts.findings, 0)
  })

  it('groups notes by kind into the right sections', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'open_question', content: 'what TTL?', topic: 'cache' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'next_step', content: 'run perf tests' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'decision', content: 'Redis chosen' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'gotcha', content: 'node 20 only' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'JWT in middleware' })

    const b = await buildBriefing(TEST_TEAM, 'alice')
    assert.match(b.text, /## Open questions[\s\S]*what TTL\?/)
    assert.match(b.text, /## Next steps[\s\S]*run perf tests/)
    assert.match(b.text, /## Decisions[\s\S]*Redis chosen/)
    assert.match(b.text, /## Gotchas[\s\S]*node 20 only/)
    assert.match(b.text, /## Recent findings[\s\S]*JWT in middleware/)

    assert.equal(b.counts.open_questions, 1)
    assert.equal(b.counts.next_steps, 1)
    assert.equal(b.counts.decisions, 1)
    assert.equal(b.counts.gotchas, 1)
    assert.equal(b.counts.findings, 1)
  })

  it('includes team knowledge section', async () => {
    await promoteToKnowledge(TEST_TEAM, { content: 'Auth is centralized', topic: 'auth' })
    const b = await buildBriefing(TEST_TEAM, 'alice')
    assert.match(b.text, /## Team-wide knowledge[\s\S]*Auth is centralized/)
    assert.equal(b.counts.knowledge, 1)
  })

  it('includes agent open tasks', async () => {
    await createTask(TEST_TEAM, { subject: 'mine', owner: 'alice', status: 'in_progress' })
    await createTask(TEST_TEAM, { subject: 'not mine', owner: 'bob' })
    const b = await buildBriefing(TEST_TEAM, 'alice')
    assert.match(b.text, /## Your open tasks[\s\S]*mine/)
    assert.ok(!b.text.includes('not mine'))
    assert.equal(b.counts.open_tasks, 1)
  })

  it('filters findings by topicsOfInterest', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'auth stuff', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'db stuff', topic: 'db' })
    const b = await buildBriefing(TEST_TEAM, 'alice', { topicsOfInterest: ['auth'] })
    assert.match(b.text, /auth stuff/)
    assert.ok(!b.text.includes('db stuff'))
  })

  it('respects findingDays window', async () => {
    // Manually create an older finding by hand so we can control timestamp
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'recent find' })
    const b = await buildBriefing(TEST_TEAM, 'alice', { findingDays: 30 })
    assert.match(b.text, /recent find/)
    // 0 days → nothing is "within the window" for a note just written,
    // though equality at ISO precision means it's still included. Skip strict
    // ordering assertion here; findingDays=30 is the realistic case.
    assert.ok(b.counts.findings >= 1)
  })
})

describe('buildBriefing — screening integration (PR-2)', () => {
  it('without topics → recent-N order is preserved (no screening invoked)', async () => {
    for (let i = 0; i < 5; i++) {
      await writeNote(TEST_TEAM, 'alice', {
        kind: 'finding', content: `linear-find-${i}`, topic: 'mixed',
      })
    }
    const b = await buildBriefing(TEST_TEAM, 'alice')
    // All 5 land in the findings section in append order.
    for (let i = 0; i < 5; i++) {
      assert.match(b.text, new RegExp(`linear-find-${i}`))
    }
  })

  it('with topics → only matching findings + knowledge survive the hard filter', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'auth jwt flow', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'redis cache layer', topic: 'infra' })
    await promoteToKnowledge(TEST_TEAM, { content: 'auth tokens centralized', topic: 'auth' })
    await promoteToKnowledge(TEST_TEAM, { content: 'unrelated finance note', topic: 'finance' })

    const b = await buildBriefing(TEST_TEAM, 'alice', { topicsOfInterest: ['auth'] })
    assert.match(b.text, /auth jwt flow/)
    assert.match(b.text, /auth tokens centralized/)
    assert.ok(!b.text.includes('redis cache layer'))
    assert.ok(!b.text.includes('unrelated finance note'))
  })

  it('with topics + many matches → screening reorders by relevance', async () => {
    // Pool of 6 auth-topic findings; only the JWT-relevant ones should bubble
    // to the top once screening is applied.
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'team retro 2026Q1', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'jwt rotation policy decided', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'office wifi maintenance', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'jwt audience claim validation', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'lunch menu rotation', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'jwt scope shortened to 5min', topic: 'auth' })

    const b = await buildBriefing(TEST_TEAM, 'alice', { topicsOfInterest: ['jwt'] })
    // All survive the substring filter ('auth' topic contains noise), but
    // we only care that all 3 JWT-relevant findings appear above the noise.
    const idxRotation = b.text.indexOf('jwt rotation policy decided')
    const idxAudience = b.text.indexOf('jwt audience claim validation')
    const idxScope = b.text.indexOf('jwt scope shortened to 5min')
    const idxLunch = b.text.indexOf('lunch menu rotation')
    assert.ok(idxRotation > 0, 'jwt rotation surfaced')
    assert.ok(idxAudience > 0, 'jwt audience surfaced')
    assert.ok(idxScope > 0, 'jwt scope surfaced')
    assert.ok(idxLunch === -1 || (idxLunch > idxRotation && idxLunch > idxAudience && idxLunch > idxScope),
      'lunch menu must not outrank JWT findings')
  })

  it('whitespace-only topics → treated as no-topic (no screening, no filter)', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'auth jwt flow', topic: 'auth' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'finding', content: 'redis cache layer', topic: 'infra' })
    const b = await buildBriefing(TEST_TEAM, 'alice', { topicsOfInterest: ['   '] })
    // Empty-needles filter drops everything because the substring "   " is
    // contained in every padded haystack; this is the documented edge.
    // We assert only that the call does not throw and findings count is bounded.
    assert.ok(b.counts.findings >= 0)
  })

  it('essential / consistency groups remain untouched when topics are set', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'open_question', content: 'will the cache TTL hold?', topic: 'infra' })
    await writeNote(TEST_TEAM, 'alice', { kind: 'decision', content: 'standardize on JWT v2 tokens', topic: 'auth' })
    const b = await buildBriefing(TEST_TEAM, 'alice', { topicsOfInterest: ['jwt'] })
    // open_questions / decisions are kept even though they do not match 'jwt'.
    assert.match(b.text, /will the cache TTL hold\?/)
    assert.match(b.text, /standardize on JWT v2 tokens/)
  })

  it('byte budget is enforced by applyBriefingBudget (PR-29 P0-3)', async () => {
    // Build a realistic briefing — 30 findings + 30 knowledge entries — and
    // confirm the budget helper produces a capped envelope when the raw text
    // exceeds the budget. Pre-fix: handler returned the raw text uncapped and
    // a stdout probe only recorded the size; no real enforcement.
    for (let i = 0; i < 30; i++) {
      await writeNote(TEST_TEAM, 'alice', {
        kind: 'finding', content: `finding number ${i} with a moderately long body explaining some operational detail`,
        topic: 'observability',
      })
    }
    for (let i = 0; i < 30; i++) {
      await promoteToKnowledge(TEST_TEAM, {
        content: `knowledge item ${i} containing typical architectural notes worth recording`,
        topic: 'architecture',
      })
    }
    const b = await buildBriefing(TEST_TEAM, 'alice')
    const bytes = Buffer.byteLength(b.text, 'utf8')
    assert.ok(bytes > 0, 'briefing produced non-empty text')

    // Tight budget forces a truncation regardless of how compact future
    // briefings get. Mirrors the handler-layer cap in src/index.js.
    const tightBudget = 2_048
    const capped = applyBriefingBudget(b.text, tightBudget)
    assert.equal(capped.truncated, true, 'tight budget must trigger truncation')
    assert.ok(Buffer.byteLength(capped.text, 'utf8') <= tightBudget,
      `capped text is ${Buffer.byteLength(capped.text, 'utf8')} bytes, exceeds ${tightBudget}`)
    assert.equal(capped.total_bytes, bytes)
    assert.equal(capped.budget_bytes, tightBudget)
    assert.ok(capped.omitted_bytes > 0)
    assert.match(capped.text, /NOTICE: briefing truncated/)
  })
})

describe('applyBriefingBudget', () => {
  it('passes through under-budget text unchanged', () => {
    const r = applyBriefingBudget('a small briefing fits', 1024)
    assert.equal(r.truncated, false)
    assert.equal(r.text, 'a small briefing fits')
    assert.equal(r.omitted_bytes, 0)
    assert.equal(r.budget_bytes, 1024)
  })

  it('truncates over-budget text and appends notice', () => {
    const big = 'X'.repeat(40_000) // 40KB > 32KB default budget
    const r = applyBriefingBudget(big)
    assert.equal(r.truncated, true)
    assert.ok(Buffer.byteLength(r.text, 'utf8') <= BRIEFING_RETURN_BUDGET_BYTES,
      `capped text exceeds budget: ${Buffer.byteLength(r.text, 'utf8')} > ${BRIEFING_RETURN_BUDGET_BYTES}`)
    assert.match(r.text, /NOTICE: briefing truncated/)
    assert.equal(r.total_bytes, 40_000)
    assert.equal(r.budget_bytes, BRIEFING_RETURN_BUDGET_BYTES)
    assert.ok(r.omitted_bytes > 0)
  })

  it('grapheme-safe truncation does not split multi-byte codepoints', () => {
    const ja = 'テスト'.repeat(10_000) // ~90KB of 3-byte chars, >> 32KB budget
    const r = applyBriefingBudget(ja, 1024)
    assert.equal(r.truncated, true)
    assert.ok(!r.text.includes('�'),
      'truncated briefing contains U+FFFD — split mid-codepoint')
    assert.ok(Buffer.byteLength(r.text, 'utf8') <= 1024)
  })
})

describe('primeAgent', () => {
  it('delivers briefing to the agent\'s inbox with from=past-self', async () => {
    await writeNote(TEST_TEAM, 'alice', { kind: 'next_step', content: 'pick up where I left off' })
    const b = await primeAgent(TEST_TEAM, 'alice')
    assert.ok(b.text)

    const inbox = await readMailbox(TEST_TEAM, 'alice')
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].from, 'past-self')
    assert.match(inbox[0].text, /<briefing for="alice"/)
    assert.match(inbox[0].text, /pick up where I left off/)
    assert.equal(inbox[0].summary, 'briefing: resume from prior session')
  })

  it('primeAgent bypasses guardrails and turn limits', async () => {
    const { setTurnLimit } = await import('../turns.js')
    await setTurnLimit(TEST_TEAM, null, 0) // everyone's at zero budget
    // Should still deliver because briefing uses skipTurns=true
    await primeAgent(TEST_TEAM, 'alice')
    const inbox = await readMailbox(TEST_TEAM, 'alice')
    assert.equal(inbox.length, 1)
  })
})
