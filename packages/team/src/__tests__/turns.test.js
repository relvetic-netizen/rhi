import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { recordTurn, resetTurns, setTurnLimit, getTurnCounts } from '../turns.js'
import { createTeam } from '../team.js'
import { writeToMailbox, readMailbox } from '../mailbox.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-turns__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-turns')

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
  await createTeam(TEST_TEAM, [
    { name: 'alice', role: 'worker' },
    { name: 'bob', role: 'worker' },
  ], 'test')
})

describe('recordTurn / getTurnCounts', () => {
  it('increments counter for agent', async () => {
    await recordTurn(TEST_TEAM, 'alice')
    await recordTurn(TEST_TEAM, 'alice')
    await recordTurn(TEST_TEAM, 'bob')
    const counts = await getTurnCounts(TEST_TEAM)
    assert.equal(counts.alice, 2)
    assert.equal(counts.bob, 1)
  })

  it('returns over_limit when exceeding per-agent limit', async () => {
    await setTurnLimit(TEST_TEAM, 'alice', 2)
    const r1 = await recordTurn(TEST_TEAM, 'alice')
    const r2 = await recordTurn(TEST_TEAM, 'alice')
    const r3 = await recordTurn(TEST_TEAM, 'alice')
    assert.equal(r1.over_limit, false)
    assert.equal(r2.over_limit, false)
    assert.equal(r3.over_limit, true)
    assert.equal(r3.count, 3)
    assert.equal(r3.limit, 2)
  })

  it('falls back to team default when no per-agent limit set', async () => {
    await setTurnLimit(TEST_TEAM, null, 1)
    const r1 = await recordTurn(TEST_TEAM, 'alice')
    const r2 = await recordTurn(TEST_TEAM, 'alice')
    assert.equal(r1.over_limit, false)
    assert.equal(r2.over_limit, true)
  })

  it('per-agent limit overrides default', async () => {
    await setTurnLimit(TEST_TEAM, null, 1)
    await setTurnLimit(TEST_TEAM, 'alice', 5)
    await recordTurn(TEST_TEAM, 'alice')
    const r = await recordTurn(TEST_TEAM, 'alice')
    assert.equal(r.over_limit, false, 'alice should use 5 not default 1')
  })
})

describe('resetTurns', () => {
  it('clears a specific agent counter', async () => {
    await recordTurn(TEST_TEAM, 'alice')
    await recordTurn(TEST_TEAM, 'bob')
    await resetTurns(TEST_TEAM, 'alice')
    const counts = await getTurnCounts(TEST_TEAM)
    assert.equal(counts.alice, undefined)
    assert.equal(counts.bob, 1)
  })

  it('clears all when agent_name is null', async () => {
    await recordTurn(TEST_TEAM, 'alice')
    await recordTurn(TEST_TEAM, 'bob')
    await resetTurns(TEST_TEAM, null)
    const counts = await getTurnCounts(TEST_TEAM)
    assert.deepEqual(counts, {})
  })
})

describe('per-agent shard (Step 3a)', () => {
  it('writes a separate file per agent', async () => {
    await recordTurn(TEST_TEAM, 'alice')
    await recordTurn(TEST_TEAM, 'bob')
    const { readdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { getTeamDir } = await import('../paths.js')
    const files = await readdir(join(getTeamDir(TEST_TEAM), 'turn-counts'))
    assert.ok(files.includes('alice.json'))
    assert.ok(files.includes('bob.json'))
  })

  it('migrates legacy turn-counts.json on first call', async () => {
    const { writeFile, mkdir, access } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { getTeamDir } = await import('../paths.js')
    const dir = getTeamDir(TEST_TEAM)
    await mkdir(dir, { recursive: true })
    // Seed legacy file with prior counts
    await writeFile(join(dir, 'turn-counts.json'), JSON.stringify({ alice: 5, bob: 2 }))
    // Force a fresh process-local migration cache for this team
    // (recordTurn itself triggers migration)
    const r = await recordTurn(TEST_TEAM, 'alice')
    assert.equal(r.count, 6, 'legacy 5 + +1 new')
    const counts = await getTurnCounts(TEST_TEAM)
    assert.equal(counts.alice, 6)
    assert.equal(counts.bob, 2)
    // Legacy file should be removed
    await assert.rejects(access(join(dir, 'turn-counts.json')))
  })

  it('parallel recordTurn for different agents does not corrupt counts', async () => {
    // Each agent writes 5 times in interleaved order
    const ops = []
    for (let i = 0; i < 5; i++) {
      ops.push(recordTurn(TEST_TEAM, 'alice'))
      ops.push(recordTurn(TEST_TEAM, 'bob'))
    }
    await Promise.all(ops)
    const counts = await getTurnCounts(TEST_TEAM)
    assert.equal(counts.alice, 5)
    assert.equal(counts.bob, 5)
  })
})

describe('writeToMailbox integration', () => {
  it('blocks and notifies team-lead when sender exceeds limit', async () => {
    await setTurnLimit(TEST_TEAM, 'alice', 1)

    const r1 = await writeToMailbox(TEST_TEAM, 'bob', { from: 'alice', text: 'msg 1' })
    assert.equal(r1.blocked, false)

    const r2 = await writeToMailbox(TEST_TEAM, 'bob', { from: 'alice', text: 'msg 2' })
    assert.equal(r2.blocked, true)
    assert.match(r2.reason, /turn limit/)

    // Only msg 1 should have landed
    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    assert.equal(bobInbox.length, 1)

    // team-lead should have a notice
    const leadInbox = await readMailbox(TEST_TEAM, 'team-lead')
    assert.equal(leadInbox.length, 1)
    assert.equal(leadInbox[0].from, 'turn-limiter')
    assert.match(leadInbox[0].text, /alice exceeded turn limit/)
  })

  it('does not count team-lead messages toward any limit', async () => {
    await setTurnLimit(TEST_TEAM, null, 0) // any send should exceed for non-lead
    const r = await writeToMailbox(TEST_TEAM, 'alice', { from: 'team-lead', text: 'ok' })
    assert.equal(r.blocked, false)
  })
})
